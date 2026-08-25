const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const SYSTEM_NAME = "Sonny AI Signal Scanner V6.1 Adaptive";
const BITGET_BASE = "https://api.bitget.com";
const PRODUCT_TYPE = "usdt-futures";
const HISTORY_FILE = path.join(__dirname, "signal_history.json");

/*
=========================================================
SONNY V6.1 ADAPTIVE

ANA STRATEJİ:

4H KIRILIM
    ↓
2H ONAY
    ↓
1H TREND / STRUCTURE
    ↓
15M RETEST + RSI
    ↓
5M RSI + EMA + MOMENTUM
    ↓
BOLLINGER WIDTH
    ↓
HACİM
    ↓
ORDERBOOK
    ↓
MARKET REGIME
    ↓
ADAPTIVE PERFORMANCE
    ↓
SONNY SCORE

V6.1 ÖNEMLİ DÜZELTMELER:

1. 5M verisi artık gerçekten sinyal puanında kullanılır.
2. Bollinger Band Width gerçekten hesaplanır.
3. 5M RSI doğrudan giriş filtresidir.
4. 5M EMA9 / EMA21 yönü değerlendirilir.
5. 5M momentum değerlendirilir.
6. BB sıkışması ve genişlemesi değerlendirilir.
7. 4H / 2H ana yapı korunur.
8. Sinyaller otomatik işlem açmaz.
9. Sinyal performansı kaydedilir.
10. Kaçan sinyal ayrı tutulur.
=========================================================
*/

let lastScan = null;
let lastError = null;
let scanRunning = false;

let marketCache = [];
let opportunityPool = [];

let activeSignals = [];
let preparingSignals = [];

let signalHistory = [];

let marketRegime = {
  direction: "NEUTRAL",
  score: 50,
  btcChange: 0,
  ethChange: 0,
  breadth: 50,
  label: "PİYASA YATAY"
};

const CONFIG = {

  /*
  PİYASA
  */

  DISCOVERY_LIMIT: 600,
  RADAR_CANDIDATES: 90,

  MIN_QUOTE_VOLUME_USDT: 500000,

  /*
  TARAMA
  */

  REFRESH_MS: 60000,

  BATCH_SIZE: 10,
  BATCH_DELAY_MS: 100,

  /*
  TIMEFRAME
  */

  FOUR_HOUR_LIMIT: 120,
  TWO_HOUR_LIMIT: 120,
  ONE_HOUR_LIMIT: 120,
  FIFTEEN_MIN_LIMIT: 160,
  FIVE_MIN_LIMIT: 160,

  /*
  SİNYAL
  */

  MIN_SIGNAL_SCORE: 72,
  MIN_PREPARING_SCORE: 58,

  MAX_ACTIVE_SIGNALS: 12,
  MAX_PREPARING: 5,

  /*
  RETEST
  */

  MAX_RETEST_DISTANCE_PERCENT: 1.20,

  /*
  RSI
  */

  LONG_RSI_MIN: 52,
  LONG_RSI_MAX: 72,

  SHORT_RSI_MIN: 28,
  SHORT_RSI_MAX: 48,

  /*
  5M
  */

  FIVE_MIN_RSI_MIN_LONG: 50,
  FIVE_MIN_RSI_MAX_LONG: 75,

  FIVE_MIN_RSI_MIN_SHORT: 25,
  FIVE_MIN_RSI_MAX_SHORT: 50,

  /*
  HACİM
  */

  MIN_VOLUME_RATIO: 0.80,

  /*
  PERFORMANS
  */

  MAX_HISTORY: 200,

  /*
  SİNYAL TAKİBİ
  */

  SIGNAL_EXPIRY_HOURS: 12,

  /*
  TP / SL
  */

  ATR_STOP_MULTIPLIER: 1.5,

  TP1_RR: 1.4,
  TP2_RR: 2.0,
  TP3_RR: 2.8

};

/*
=========================================================
GENEL YARDIMCILAR
=========================================================
*/

function log(message) {

  console.log(
    "[" +
    new Date().toISOString() +
    "] " +
    message
  );

}

function sleep(ms) {

  return new Promise(
    resolve => setTimeout(resolve, ms)
  );

}

function clamp(value, min, max) {

  return Math.max(
    min,
    Math.min(max, value)
  );

}

function number(value, digits = 4) {

  if (!Number.isFinite(value)) {
    return 0;
  }

  return Number(
    value.toFixed(digits)
  );

}

function percentage(value, base) {

  if (
    !Number.isFinite(value) ||
    !Number.isFinite(base) ||
    base === 0
  ) {
    return 0;
  }

  return (
    value / base
  ) * 100;

}

/*
=========================================================
HISTORY
=========================================================
*/

function loadHistory() {

  try {

    if (!fs.existsSync(HISTORY_FILE)) {

      signalHistory = [];

      return;

    }

    const raw =
      fs.readFileSync(
        HISTORY_FILE,
        "utf8"
      );

    const parsed =
      JSON.parse(raw);

    if (Array.isArray(parsed)) {

      signalHistory =
        parsed.slice(
          -CONFIG.MAX_HISTORY
        );

    }

  } catch (error) {

    log(
      "History yükleme hatası: " +
      error.message
    );

    signalHistory = [];

  }

}

function saveHistory() {

  try {

    signalHistory =
      signalHistory.slice(
        -CONFIG.MAX_HISTORY
      );

    fs.writeFileSync(
      HISTORY_FILE,
      JSON.stringify(
        signalHistory,
        null,
        2
      )
    );

  } catch (error) {

    log(
      "History kayıt hatası: " +
      error.message
    );

  }

}

loadHistory();

/*
=========================================================
BITGET
=========================================================
*/

async function bitget(
  endpoint,
  params = {}
) {

  const url =
    new URL(
      BITGET_BASE + endpoint
    );

  Object.entries(params)
    .forEach(
      ([key, value]) => {

        if (
          value !== undefined &&
          value !== null &&
          value !== ""
        ) {

          url.searchParams.set(
            key,
            String(value)
          );

        }

      }
    );

  const response =
    await fetch(
      url.toString()
    );

  const text =
    await response.text();

  if (!response.ok) {

    throw new Error(
      "Bitget HTTP " +
      response.status +
      " - " +
      endpoint
    );

  }

  let json;

  try {

    json =
      JSON.parse(text);

  } catch {

    throw new Error(
      "Bitget JSON parse error"
    );

  }

  if (
    json.code !== "00000"
  ) {

    throw new Error(
      "Bitget API " +
      json.code +
      " - " +
      (json.msg || "")
    );

  }

  return json.data;

}

/*
=========================================================
CANDLE PARSER
=========================================================
*/

function parseCandles(data) {

  if (
    !Array.isArray(data)
  ) {

    return [];

  }

  return data
    .map(row => {

      return {

        time:
          Number(row[0]),

        open:
          Number(row[1]),

        high:
          Number(row[2]),

        low:
          Number(row[3]),

        close:
          Number(row[4]),

        volume:
          Number(row[5] || 0),

        quoteVolume:
          Number(row[6] || 0)

      };

    })
    .filter(
      candle =>
        Number.isFinite(
          candle.close
        )
    )
    .sort(
      (a, b) =>
        a.time - b.time
    );

}

/*
=========================================================
CANDLES
=========================================================
*/

async function getCandles(
  symbol,
  granularity,
  limit
) {

  const data =
    await bitget(
      "/api/v2/mix/market/candles",
      {
        symbol,
        productType:
          PRODUCT_TYPE,
        granularity,
        limit
      }
    );

  return parseCandles(data);

}

/*
=========================================================
TICKER
=========================================================
*/

async function getTicker(symbol) {

  try {

    const data =
      await bitget(
        "/api/v2/mix/market/ticker",
        {
          symbol,
          productType:
            PRODUCT_TYPE
        }
      );

    if (
      Array.isArray(data) &&
      data.length
    ) {

      return data[0];

    }

    return data;

  } catch {

    return null;

  }

}

/*
=========================================================
EMA
=========================================================
*/

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

  const multiplier =
    2 /
    (period + 1);

  let result =
    values
      .slice(0, period)
      .reduce(
        (sum, value) =>
          sum + value,
        0
      ) /
    period;

  for (
    let i = period;
    i < values.length;
    i++
  ) {

    result =
      (
        values[i] -
        result
      ) *
      multiplier +
      result;

  }

  return result;

}

/*
=========================================================
SMA
=========================================================
*/

function sma(
  values,
  period
) {

  if (
    !values ||
    values.length < period
  ) {

    return null;

  }

  const slice =
    values.slice(
      -period
    );

  return (
    slice.reduce(
      (sum, value) =>
        sum + value,
      0
    ) /
    period
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

  let gains = 0;
  let losses = 0;

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

      gains += change;

    } else {

      losses -= change;

    }

  }

  let avgGain =
    gains / period;

  let avgLoss =
    losses / period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {

    const change =
      values[i] -
      values[i - 1];

    const gain =
      change > 0
        ? change
        : 0;

    const loss =
      change < 0
        ? -change
        : 0;

    avgGain =
      (
        avgGain *
        (period - 1) +
        gain
      ) /
      period;

    avgLoss =
      (
        avgLoss *
        (period - 1) +
        loss
      ) /
      period;

  }

  if (
    avgLoss === 0
  ) {

    return 100;

  }

  const rs =
    avgGain /
    avgLoss;

  return (
    100 -
    100 /
    (1 + rs)
  );

}

/*
=========================================================
ATR
=========================================================
*/

function atr(
  candles,
  period = 14
) {

  if (
    !candles ||
    candles.length <= period
  ) {

    return null;

  }

  const trs = [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {

    const current =
      candles[i];

    const previous =
      candles[i - 1];

    const tr =
      Math.max(
        current.high -
          current.low,

        Math.abs(
          current.high -
          previous.close
        ),

        Math.abs(
          current.low -
          previous.close
        )
      );

    trs.push(tr);

  }

  return sma(
    trs,
    period
  );

}

/*
=========================================================
BOLLINGER BAND WIDTH

V6.1'DE GERÇEK OLARAK KULLANILIYOR
=========================================================
*/

function bollinger(
  values,
  period = 20,
  multiplier = 2
) {

  if (
    !values ||
    values.length < period
  ) {

    return null;

  }

  const slice =
    values.slice(
      -period
    );

  const middle =
    slice.reduce(
      (sum, value) =>
        sum + value,
      0
    ) /
    period;

  let variance = 0;

  for (
    const value of slice
  ) {

    variance +=
      Math.pow(
        value - middle,
        2
      );

  }

  variance /=
    period;

  const standardDeviation =
    Math.sqrt(
      variance
    );

  const upper =
    middle +
    standardDeviation *
    multiplier;

  const lower =
    middle -
    standardDeviation *
    multiplier;

  const width =
    middle !== 0
      ? (
          (upper - lower) /
          middle
        ) *
        100
      : 0;

  const widthPercent =
    number(
      width,
      3
    );

  return {

    middle:
      number(
        middle,
        8
      ),

    upper:
      number(
        upper,
        8
      ),

    lower:
      number(
        lower,
        8
      ),

    width:
      widthPercent

  };

}

/*
=========================================================
HIGHEST / LOWEST
=========================================================
*/

function highest(
  candles,
  count
) {

  const slice =
    candles.slice(
      -count
    );

  if (!slice.length) {
    return null;
  }

  return Math.max(
    ...slice.map(
      candle =>
        candle.high
    )
  );

}

function lowest(
  candles,
  count
) {

  const slice =
    candles.slice(
      -count
    );

  if (!slice.length) {
    return null;
  }

  return Math.min(
    ...slice.map(
      candle =>
        candle.low
    )
  );

}

/*
=========================================================
4H STRUCTURE
=========================================================
*/

function analyze4H(
  candles
) {

  if (
    candles.length < 40
  ) {

    return null;

  }

  const closed =
    candles.slice(
      0,
      -1
    );

  const current =
    closed[
      closed.length - 1
    ];

  const previous =
    closed.slice(
      -25,
      -1
    );

  const resistance =
    highest(
      previous,
      previous.length
    );

  const support =
    lowest(
      previous,
      previous.length
    );

  if (
    !resistance ||
    !support
  ) {

    return null;

  }

  const price =
    current.close;

  const range =
    resistance -
    support;

  const position =
    range > 0
      ? (
          price -
          support
        ) /
        range
      : 0.5;

  const ema20 =
    ema(
      closed.map(
        c => c.close
      ),
      20
    );

  const ema50 =
    ema(
      closed.map(
        c => c.close
      ),
      50
    );

  const bullish =
    price >
      ema20 &&
    ema20 >
      ema50;

  const bearish =
    price <
      ema20 &&
    ema20 <
      ema50;

  const longBreak =
    price >
    resistance;

  const shortBreak =
    price <
    support;

  return {

    price,

    resistance,

    support,

    position,

    bullish,

    bearish,

    longBreak,

    shortBreak,

    ema20,

    ema50

  };

}

/*
=========================================================
2H STRUCTURE
=========================================================
*/

function analyze2H(
  candles
) {

  if (
    candles.length < 40
  ) {

    return null;

  }

  const closed =
    candles.slice(
      0,
      -1
    );

  const current =
    closed[
      closed.length - 1
    ];

  const previous =
    closed.slice(
      -25,
      -1
    );

  const resistance =
    highest(
      previous,
      previous.length
    );

  const support =
    lowest(
      previous,
      previous.length
    );

  const closes =
    closed.map(
      c => c.close
    );

  const ema20 =
    ema(
      closes,
      20
    );

  const ema50 =
    ema(
      closes,
      50
    );

  const bullish =
    current.close >
      ema20 &&
    ema20 >
      ema50;

  const bearish =
    current.close <
      ema20 &&
    ema20 <
      ema50;

  const longBreak =
    current.close >
    resistance;

  const shortBreak =
    current.close <
    support;

  return {

    price:
      current.close,

    resistance,

    support,

    bullish,

    bearish,

    longBreak,

    shortBreak,

    ema20,

    ema50

  };

}

/*
=========================================================
1H STRUCTURE
=========================================================
*/

function analyze1H(
  candles
) {

  if (
    candles.length < 50
  ) {

    return null;

  }

  const closed =
    candles.slice(
      0,
      -1
    );

  const closes =
    closed.map(
      c => c.close
    );

  const current =
    closes[
      closes.length - 1
    ];

  const ema20 =
    ema(
      closes,
      20
    );

  const ema50 =
    ema(
      closes,
      50
    );

  const currentRSI =
    rsi(
      closes,
      14
    );

  return {

    price:
      current,

    ema20,

    ema50,

    rsi:
      currentRSI,

    bullish:
      current >
        ema20 &&
      ema20 >
        ema50,

    bearish:
      current <
        ema20 &&
      ema20 <
        ema50

  };

}

/*
=========================================================
15M RETEST
=========================================================
*/

function analyze15M(
  candles,
  direction,
  breakoutLevel
) {

  if (
    candles.length < 50
  ) {

    return null;

  }

  const closed =
    candles.slice(
      0,
      -1
    );

  const current =
    closed[
      closed.length - 1
    ];

  const closes =
    closed.map(
      c => c.close
    );

  const currentRSI =
    rsi(
      closes,
      14
    );

  const ema9 =
    ema(
      closes,
      9
    );

  const ema21 =
    ema(
      closes,
      21
    );

  const distance =
    breakoutLevel !== 0
      ? Math.abs(
          (
            current.close -
            breakoutLevel
          ) /
          breakoutLevel
        ) *
        100
      : 999;

  const retest =
    distance <=
    CONFIG.MAX_RETEST_DISTANCE_PERCENT;

  const bullish =
    current.close >
      ema9 &&
    ema9 >
      ema21;

  const bearish =
    current.close <
      ema9 &&
    ema9 <
      ema21;

  return {

    price:
      current.close,

    rsi:
      currentRSI,

    ema9,

    ema21,

    distance,

    retest,

    bullish,

    bearish

  };

}

/*
=========================================================
5M ANALYSIS

V6.1:
BURASI ARTIK GERÇEK SİNYAL PUANINA GİRİYOR.
=========================================================
*/

function analyze5M(
  candles,
  direction
) {

  if (
    candles.length < 60
  ) {

    return null;

  }

  const closed =
    candles.slice(
      0,
      -1
    );

  const current =
    closed[
      closed.length - 1
    ];

  const previous =
    closed[
      closed.length - 2
    ];

  const closes =
    closed.map(
      c => c.close
    );

  const ema9 =
    ema(
      closes,
      9
    );

  const ema21 =
    ema(
      closes,
      21
    );

  const currentRSI =
    rsi(
      closes,
      14
    );

  const currentATR =
    atr(
      closed,
      14
    );

  const avgVolume =
    sma(
      closed.map(
        c => c.volume
      ),
      30
    );

  const volumeRatio =
    avgVolume > 0
      ? current.volume /
        avgVolume
      : 0;

  /*
  Gerçek Bollinger
  */

  const bb =
    bollinger(
      closes,
      20,
      2
    );

  const priceChange =
    previous.close !== 0
      ? (
          (
            current.close -
            previous.close
          ) /
          previous.close
        ) *
        100
      : 0;

  const bullish =
    current.close >
      ema9 &&
    ema9 >
      ema21;

  const bearish =
    current.close <
      ema9 &&
    ema9 <
      ema21;

  const candleBull =
    current.close >
    current.open;

  const candleBear =
    current.close <
    current.open;

  /*
  Momentum son 3 mum
  */

  const recent =
    closed.slice(
      -3
    );

  const first =
    recent[0];

  const last =
    recent[
      recent.length - 1
    ];

  const momentumPercent =
    first &&
    first.close !== 0
      ? (
          (
            last.close -
            first.close
          ) /
          first.close
        ) *
        100
      : 0;

  /*
  BB DURUMU

  Daralma:
  < 1.0

  Normal:
  1.0 - 2.5

  Genişleme:
  > 2.5
  */

  let bbState =
    "NORMAL";

  if (
    bb &&
    bb.width < 1.0
  ) {

    bbState =
      "SQUEEZE";

  } else if (
    bb &&
    bb.width > 2.5
  ) {

    bbState =
      "EXPANSION";

  }

  /*
  5M yön puanı
  */

  let score = 0;

  if (
    direction === "LONG"
  ) {

    if (bullish) {
      score += 20;
    }

    if (
      currentRSI >=
        CONFIG.FIVE_MIN_RSI_MIN_LONG &&
      currentRSI <=
        CONFIG.FIVE_MIN_RSI_MAX_LONG
    ) {

      score += 20;

    }

    if (
      momentumPercent > 0
    ) {

      score += 10;

    }

    if (candleBull) {

      score += 5;

    }

  } else {

    if (bearish) {

      score += 20;

    }

    if (
      currentRSI >=
        CONFIG.FIVE_MIN_RSI_MIN_SHORT &&
      currentRSI <=
        CONFIG.FIVE_MIN_RSI_MAX_SHORT
    ) {

      score += 20;

    }

    if (
      momentumPercent < 0
    ) {

      score += 10;

    }

    if (candleBear) {

      score += 5;

    }

  }

  /*
  Hacim
  */

  if (
    volumeRatio >= 1.5
  ) {

    score += 10;

  } else if (
    volumeRatio >= 1.0
  ) {

    score += 6;

  } else if (
    volumeRatio >=
    CONFIG.MIN_VOLUME_RATIO
  ) {

    score += 3;

  }

  /*
  BB SQUEEZE / EXPANSION

  Sıkışma kırılım öncesi avantajdır.
  Expansion ise gerçekleşen momentumun
  güçlü olduğunu gösterir.
  */

  if (
    bbState ===
    "SQUEEZE"
  ) {

    score += 5;

  } else if (
    bbState ===
    "EXPANSION"
  ) {

    score += 5;

  }

  return {

    price:
      current.close,

    rsi:
      number(
        currentRSI,
        1
      ),

    ema9:
      number(
        ema9,
        8
      ),

    ema21:
      number(
        ema21,
        8
      ),

    atr:
      currentATR,

    volumeRatio:
      number(
        volumeRatio,
        2
      ),

    momentumPercent:
      number(
        momentumPercent,
        3
      ),

    bullish,

    bearish,

    candleBull,

    candleBear,

    bb,

    bbWidth:
      bb
        ? bb.width
        : 0,

    bbState,

    score

  };

}

/*
=========================================================
MARKET DISCOVERY
=========================================================
*/

async function discoverMarket() {

  log(
    "Bitget piyasası yeniden taranıyor..."
  );

  const [
    contracts,
    tickers
  ] =
    await Promise.all([

      bitget(
        "/api/v2/mix/market/contracts",
        {
          productType:
            PRODUCT_TYPE
        }
      ),

      bitget(
        "/api/v2/mix/market/tickers",
        {
          productType:
            PRODUCT_TYPE
        }
      )

    ]);

  const validSymbols =
    new Set(
      contracts
        .filter(
          contract =>
            contract.symbolType ===
              "perpetual" &&
            contract.symbolStatus ===
              "normal" &&
            contract.quoteCoin ===
              "USDT"
        )
        .map(
          contract =>
            contract.symbol
        )
    );

  const market =
    tickers
      .filter(
        ticker =>
          validSymbols.has(
            ticker.symbol
          )
      )
      .map(
        ticker => {

          const price =
            Number(
              ticker.lastPr
            );

          const volume =
            Number(
              ticker.quoteVolume ||
              0
            );

          const change =
            Number(
              ticker.change24h ||
              0
            );

          const changePercent =
            Math.abs(change) <= 1
              ? change * 100
              : change;

          const high =
            Number(
              ticker.high24h
            );

          const low =
            Number(
              ticker.low24h
            );

          const range =
            price > 0
              ? percentage(
                  high - low,
                  price
                )
              : 0;

          let score = 0;

          if (
            volume >= 100000000
          ) {

            score += 35;

          } else if (
            volume >= 30000000
          ) {

            score += 30;

          } else if (
            volume >= 10000000
          ) {

            score += 25;

          } else if (
            volume >= 3000000
          ) {

            score += 15;

          } else {

            score += 5;

          }

          const movement =
            Math.abs(
              changePercent
            );

          if (
            movement >= 8
          ) {

            score += 30;

          } else if (
            movement >= 5
          ) {

            score += 25;

          } else if (
            movement >= 3
          ) {

            score += 18;

          } else if (
            movement >= 1.5
          ) {

            score += 10;

          }

          if (
            range >= 10
          ) {

            score += 25;

          } else if (
            range >= 7
          ) {

            score += 20;

          } else if (
            range >= 4
          ) {

            score += 15;

          } else {

            score += 5;

          }

          return {

            symbol:
              ticker.symbol,

            price,

            volume24h:
              volume,

            change24h:
              changePercent,

            high24h:
              high,

            low24h:
              low,

            range24h:
              range,

            discoveryScore:
              score

          };

        }
      )
      .filter(
        item =>
          item.volume24h >=
          CONFIG.MIN_QUOTE_VOLUME_USDT
      )
      .sort(
        (a, b) =>
          b.discoveryScore -
          a.discoveryScore
      );

  marketCache =
    market.slice(
      0,
      CONFIG.DISCOVERY_LIMIT
    );

  log(
    "Discovery tamamlandı. " +
    marketCache.length +
    " uygun coin bulundu."
  );

  return marketCache;

}

/*
=========================================================
MARKET REGIME
=========================================================
*/

async function calculateMarketRegime() {

  try {

    const btc =
      await getTicker(
        "BTCUSDT"
      );

    const eth =
      await getTicker(
        "ETHUSDT"
      );

    const btcChange =
      Number(
        btc?.change24h || 0
      );

    const ethChange =
      Number(
        eth?.change24h || 0
      );

    const btcPct =
      Math.abs(
        btcChange
      ) <= 1
        ? btcChange * 100
        : btcChange;

    const ethPct =
      Math.abs(
        ethChange
      ) <= 1
        ? ethChange * 100
        : ethChange;

    /*
    Market breadth
    */

    const sample =
      marketCache.slice(
        0,
        100
      );

    let bullish = 0;
    let bearish = 0;

    for (
      const coin of sample
    ) {

      if (
        coin.change24h > 0
      ) {

        bullish++;

      } else if (
        coin.change24h < 0
      ) {

        bearish++;

      }

    }

    const total =
      bullish +
      bearish;

    const breadth =
      total > 0
        ? (
            bullish /
            total
          ) *
          100
        : 50;

    let score = 50;

    score +=
      clamp(
        btcPct * 4,
        -20,
        20
      );

    score +=
      clamp(
        ethPct * 2,
        -10,
        10
      );

    score +=
      (breadth - 50) *
      0.4;

    score =
      clamp(
        score,
        0,
        100
      );

    let direction =
      "NEUTRAL";

    let label =
      "PİYASA YATAY";

    if (
      score >= 60
    ) {

      direction =
        "LONG";

      label =
        "PİYASA YUKARI";

    } else if (
      score <= 40
    ) {

      direction =
        "SHORT";

      label =
        "PİYASA AŞAĞI";

    }

    marketRegime = {

      direction,

      score:
        number(
          score,
          1
        ),

      btcChange:
        number(
          btcPct,
          2
        ),

      ethChange:
        number(
          ethPct,
          2
        ),

      breadth:
        number(
          breadth,
          1
        ),

      label

    };

    return marketRegime;

  } catch {

    return marketRegime;

  }

}

/*
=========================================================
ORDERBOOK
=========================================================
*/

async function analyzeOrderBook(
  symbol
) {

  try {

    const data =
      await bitget(
        "/api/v2/mix/market/merge-depth",
        {
          symbol,
          productType:
            PRODUCT_TYPE,
          limit: 20
        }
      );

    const bids =
      data?.bids || [];

    const asks =
      data?.asks || [];

    let bidValue = 0;
    let askValue = 0;

    for (
      const row of bids
    ) {

      bidValue +=
        Number(row[0]) *
        Number(row[1]);

    }

    for (
      const row of asks
    ) {

      askValue +=
        Number(row[0]) *
        Number(row[1]);

    }

    const total =
      bidValue +
      askValue;

    const imbalance =
      total > 0
        ? (
            (
              bidValue -
              askValue
            ) /
            total
          ) *
          100
        : 0;

    return {

      bidValue,

      askValue,

      imbalance:
        number(
          imbalance,
          2
        )

    };

  } catch {

    return {

      bidValue: 0,

      askValue: 0,

      imbalance: 0

    };

  }

}

/*
=========================================================
ADAPTIVE PERFORMANCE
=========================================================
*/

function getPerformanceBonus(
  direction
) {

  const completed =
    signalHistory.filter(
      item =>
        item.status ===
          "TP1" ||
        item.status ===
          "TP2" ||
        item.status ===
          "TP3" ||
        item.status ===
          "STOP"
    );

  if (
    completed.length < 10
  ) {

    return 0;

  }

  const recent =
    completed.slice(
      -50
    );

  const wins =
    recent.filter(
      item =>
        item.status ===
          "TP1" ||
        item.status ===
          "TP2" ||
        item.status ===
          "TP3"
    ).length;

  const winRate =
    wins /
    recent.length;

  /*
  Genel performans iyi ise +5.
  Kötü ise -5.
  */

  let bonus = 0;

  if (
    winRate >= 0.60
  ) {

    bonus += 5;

  } else if (
    winRate < 0.40
  ) {

    bonus -= 5;

  }

  const directional =
    recent.filter(
      item =>
        item.direction ===
        direction
    );

  if (
    directional.length >= 8
  ) {

    const directionalWins =
      directional.filter(
        item =>
          item.status ===
            "TP1" ||
          item.status ===
            "TP2" ||
          item.status ===
            "TP3"
      ).length;

    const directionalRate =
      directionalWins /
      directional.length;

    if (
      directionalRate >=
      0.65
    ) {

      bonus += 3;

    } else if (
      directionalRate < 0.35
    ) {

      bonus -= 3;

    }

  }

  return clamp(
    bonus,
    -8,
    8
  );

}

/*
=========================================================
TP / SL
=========================================================
*/

function calculateTPSL(
  entry,
  direction,
  atrValue
) {

  if (
    !entry ||
    !Number.isFinite(entry)
  ) {

    return null;

  }

  let riskDistance;

  if (
    atrValue &&
    atrValue > 0
  ) {

    riskDistance =
      atrValue *
      CONFIG.ATR_STOP_MULTIPLIER;

  } else {

    riskDistance =
      entry *
      0.02;

  }

  /*
  Aşırı dar / geniş stopları sınırla.
  */

  riskDistance =
    clamp(
      riskDistance,
      entry * 0.005,
      entry * 0.06
    );

  let stop;
  let tp1;
  let tp2;
  let tp3;

  if (
    direction ===
    "LONG"
  ) {

    stop =
      entry -
      riskDistance;

    tp1 =
      entry +
      riskDistance *
      CONFIG.TP1_RR;

    tp2 =
      entry +
      riskDistance *
      CONFIG.TP2_RR;

    tp3 =
      entry +
      riskDistance *
      CONFIG.TP3_RR;

  } else {

    stop =
      entry +
      riskDistance;

    tp1 =
      entry -
      riskDistance *
      CONFIG.TP1_RR;

    tp2 =
      entry -
      riskDistance *
      CONFIG.TP2_RR;

    tp3 =
      entry -
      riskDistance *
      CONFIG.TP3_RR;

  }

  return {

    stop,
    tp1,
    tp2,
    tp3,

    riskPercent:
      number(
        (
          riskDistance /
          entry
        ) *
        100,
        2
      )

  };

}

/*
=========================================================
TRADINGVIEW

BITGET PERPETUAL
=========================================================
*/

function getTradingViewLink(
  symbol
) {

  const clean =
    String(symbol)
      .replace(
        /[^A-Z0-9]/gi,
        ""
      )
      .toUpperCase();

  return (
    "https://www.tradingview.com/chart/?symbol=BITGET%3A" +
    encodeURIComponent(
      clean
    )
  );

}

/*
=========================================================
COIN ANALYSIS
=========================================================
*/

async function analyzeCoin(
  marketItem
) {

  try {

    const [
      fourH,
      twoH,
      oneH,
      fifteenM,
      fiveM
    ] =
      await Promise.all([

        getCandles(
          marketItem.symbol,
          "4H",
          CONFIG.FOUR_HOUR_LIMIT
        ),

        getCandles(
          marketItem.symbol,
          "2H",
          CONFIG.TWO_HOUR_LIMIT
        ),

        getCandles(
          marketItem.symbol,
          "1H",
          CONFIG.ONE_HOUR_LIMIT
        ),

        getCandles(
          marketItem.symbol,
          "15m",
          CONFIG.FIFTEEN_MIN_LIMIT
        ),

        getCandles(
          marketItem.symbol,
          "5m",
          CONFIG.FIVE_MIN_LIMIT
        )

      ]);

    if (
      fourH.length < 40 ||
      twoH.length < 40 ||
      oneH.length < 50 ||
      fifteenM.length < 50 ||
      fiveM.length < 60
    ) {

      return null;

    }

    const structure4H =
      analyze4H(
        fourH
      );

    const structure2H =
      analyze2H(
        twoH
      );

    const structure1H =
      analyze1H(
        oneH
      );

    if (
      !structure4H ||
      !structure2H ||
      !structure1H
    ) {

      return null;

    }

    /*
    YÖNÜ 4H belirler.

    Öncelik gerçek kırılım.
    Kırılım yoksa güçlü yapı.
    */

    let direction = null;

    if (
      structure4H.longBreak
    ) {

      direction =
        "LONG";

    } else if (
      structure4H.shortBreak
    ) {

      direction =
        "SHORT";

    } else if (
      structure4H.bullish &&
      structure2H.bullish
    ) {

      direction =
        "LONG";

    } else if (
      structure4H.bearish &&
      structure2H.bearish
    ) {

      direction =
        "SHORT";

    } else {

      return null;

    }

    /*
    2H ONAY
    */

    const twoHourConfirmed =
      direction === "LONG"
        ? structure2H.bullish ||
          structure2H.longBreak
        : structure2H.bearish ||
          structure2H.shortBreak;

    /*
    1H ONAY
    */

    const oneHourConfirmed =
      direction === "LONG"
        ? structure1H.bullish
        : structure1H.bearish;

    /*
    Breakout level
    */

    const breakoutLevel =
      direction === "LONG"
        ? structure4H.resistance
        : structure4H.support;

    /*
    15M
    */

    const fifteen =
      analyze15M(
        fifteenM,
        direction,
        breakoutLevel
      );

    /*
    5M

    ARTIK PUANA GİRİYOR.
    */

    const five =
      analyze5M(
        fiveM,
        direction
      );

    if (
      !fifteen ||
      !five
    ) {

      return null;

    }

    /*
    ANA SKOR
    */

    let score = 0;

    /*
    4H
    */

    if (
      direction === "LONG"
    ) {

      if (
        structure4H.longBreak
      ) {

        score += 25;

      } else if (
        structure4H.bullish
      ) {

        score += 17;

      }

    } else {

      if (
        structure4H.shortBreak
      ) {

        score += 25;

      } else if (
        structure4H.bearish
      ) {

        score += 17;

      }

    }

    /*
    2H
    */

    if (
      twoHourConfirmed
    ) {

      score += 20;

    }

    /*
    1H
    */

    if (
      oneHourConfirmed
    ) {

      score += 12;

    }

    /*
    15M RETEST
    */

    if (
      fifteen.retest
    ) {

      score += 12;

    }

    /*
    15M RSI
    */

    if (
      direction === "LONG" &&
      fifteen.rsi >= 50 &&
      fifteen.rsi <= 72
    ) {

      score += 6;

    }

    if (
      direction === "SHORT" &&
      fifteen.rsi <= 50 &&
      fifteen.rsi >= 28
    ) {

      score += 6;

    }

    /*
    5M

    V6.1'DE DOĞRUDAN PUANA GİRİYOR.
    */

    score +=
      five.score *
      0.20;

    /*
    MARKET REGIME
    */

    if (
      marketRegime.direction ===
      direction
    ) {

      score += 5;

    } else if (
      marketRegime.direction !==
      "NEUTRAL"
    ) {

      score -= 4;

    }

    /*
    ORDERBOOK
    */

    const orderbook =
      await analyzeOrderBook(
        marketItem.symbol
      );

    if (
      direction === "LONG"
    ) {

      if (
        orderbook.imbalance >= 10
      ) {

        score += 5;

      } else if (
        orderbook.imbalance <= -15
      ) {

        score -= 4;

      }

    } else {

      if (
        orderbook.imbalance <= -10
      ) {

        score += 5;

      } else if (
        orderbook.imbalance >= 15
      ) {

        score -= 4;

      }

    }

    /*
    ADAPTIVE PERFORMANCE
    */

    score +=
      getPerformanceBonus(
        direction
      );

    /*
    BB EK KONTROLÜ

    Gerçek BB width.

    */

    if (
      five.bbState ===
      "SQUEEZE"
    ) {

      score += 3;

    }

    if (
      five.bbState ===
      "EXPANSION" &&
      five.volumeRatio >= 1.2
    ) {

      score += 4;

    }

    /*
    100'E SABİTLE
    */

    score =
      clamp(
        Math.round(score),
        0,
        100
      );

    /*
    5M KARŞI YÖNDEYSE
    SİNYALİ ENGELLE.
    */

    const fiveMinuteInvalid =
      direction === "LONG"
        ? (
            five.rsi < 45 ||
            five.bearish
          )
        : (
            five.rsi > 55 ||
            five.bullish
          );

    /*
    15M RETEST YOKSA
    HENÜZ HAZIRLANIYOR.
    */

    const entryReady =
      fifteen.retest &&
      twoHourConfirmed &&
      oneHourConfirmed &&
      !fiveMinuteInvalid;

    /*
    GİRİŞ
    */

    const currentPrice =
      marketItem.price;

    let entryLow;
    let entryHigh;

    if (
      direction === "LONG"
    ) {

      entryLow =
        Math.min(
          currentPrice,
          breakoutLevel
        );

      entryHigh =
        Math.max(
          currentPrice,
          breakoutLevel
        );

    } else {

      entryLow =
        Math.min(
          currentPrice,
          breakoutLevel
        );

      entryHigh =
        Math.max(
          currentPrice,
          breakoutLevel
        );

    }

    const entry =
      currentPrice;

    const tpsl =
      calculateTPSL(
        entry,
        direction,
        five.atr
      );

    if (
      !tpsl
    ) {

      return null;

    }

    /*
    SİNYAL DURUMU
    */

    let state =
      "WATCH";

    if (
      score >=
        CONFIG.MIN_SIGNAL_SCORE &&
      entryReady
    ) {

      state =
        "SIGNAL";

    } else if (
      score >=
        CONFIG.MIN_PREPARING_SCORE
    ) {

      state =
        "PREPARING";

    }

    /*
    4H GERÇEK KIRILIMI
    */

    const realBreakout =
      direction === "LONG"
        ? structure4H.longBreak
        : structure4H.shortBreak;

    /*
    STRATEJİ
    */

    const strategy =
      realBreakout
        ? "4H BREAKOUT + 2H CONFIRMATION + RETEST + RSI + 5M MOMENTUM"
        : "4H STRUCTURE + 2H CONFIRMATION + RETEST + RSI + 5M MOMENTUM";

    return {

      symbol:
        marketItem.symbol,

      direction,

      state,

      score,

      strategy,

      price:
        number(
          currentPrice,
          8
        ),

      entryLow:
        number(
          entryLow,
          8
        ),

      entryHigh:
        number(
          entryHigh,
          8
        ),

      breakoutLevel:
        number(
          breakoutLevel,
          8
        ),

      stop:
        number(
          tpsl.stop,
          8
        ),

      tp1:
        number(
          tpsl.tp1,
          8
        ),

      tp2:
        number(
          tpsl.tp2,
          8
        ),

      tp3:
        number(
          tpsl.tp3,
          8
        ),

      riskPercent:
        tpsl.riskPercent,

      fourHDirection:
        direction,

      twoHConfirmed,

      oneHConfirmed,

      retest:
        fifteen.retest,

      distanceToLevel:
        number(
          fifteen.distance,
          3
        ),

      rsi15m:
        number(
          fifteen.rsi,
          1
        ),

      rsi5m:
        number(
          five.rsi,
          1
        ),

      fiveMinuteScore:
        number(
          five.score,
          1
        ),

      fiveMinuteMomentum:
        five.momentumPercent,

      volumeRatio:
        five.volumeRatio,

      bbWidth:
        five.bbWidth,

      bbState:
        five.bbState,

      orderbookImbalance:
        orderbook.imbalance,

      marketDirection:
        marketRegime.direction,

      marketScore:
        marketRegime.score,

      discoveryScore:
        marketItem.discoveryScore,

      timestamp:
        Date.now(),

      tradingView:
        getTradingViewLink(
          marketItem.symbol
        )

    };

  } catch (error) {

    log(
      "Coin analysis error " +
      marketItem.symbol +
      ": " +
      error.message
    );

    return null;

  }

}

/*
=========================================================
SİNYAL HISTORY ID
=========================================================
*/

function signalKey(
  signal
) {

  return (
    signal.symbol +
    "_" +
    signal.direction +
    "_" +
    Math.floor(
      signal.timestamp /
      300000
    )
  );

}

/*
=========================================================
AKTİF SİNYALİ HISTORY'YE EKLE
=========================================================
*/

function registerSignal(
  signal
) {

  const exists =
    activeSignals.some(
      item =>
        item.key ===
        signal.key
    );

  if (
    exists
  ) {

    return;

  }

  signal.key =
    signalKey(
      signal
    );

  signal.status =
    "ACTIVE";

  signal.createdAt =
    Date.now();

  activeSignals.push(
    signal
  );

  /*
  History'ye ilk kayıt
  */

  signalHistory.push({

    id:
      signal.key,

    symbol:
      signal.symbol,

    direction:
      signal.direction,

    status:
      "ACTIVE",

    entry:
      signal.price,

    tp1:
      signal.tp1,

    tp2:
      signal.tp2,

    tp3:
      signal.tp3,

    stop:
      signal.stop,

    score:
      signal.score,

    createdAt:
      signal.createdAt

  });

  saveHistory();

}

/*
=========================================================
SİNYAL DURUM TAKİBİ
=========================================================
*/

function updateHistoryStatus(
  key,
  status,
  price
) {

  const item =
    signalHistory.find(
      row =>
        row.id === key
    );

  if (
    !item
  ) {

    return;

  }

  item.status =
    status;

  item.lastPrice =
    price;

  item.closedAt =
    Date.now();

  saveHistory();

}

/*
=========================================================
CANLI SİNYAL TAKİBİ
=========================================================
*/

async function monitorActiveSignals() {

  if (
    activeSignals.length === 0
  ) {

    return;

  }

  const remaining = [];

  for (
    const signal of activeSignals
  ) {

    try {

      const ticker =
        await getTicker(
          signal.symbol
        );

      if (
        !ticker
      ) {

        remaining.push(
          signal
        );

        continue;

      }

      const price =
        Number(
          ticker.lastPr
        );

      signal.livePrice =
        number(
          price,
          8
        );

      /*
      EXPIRY
      */

      const ageHours =
        (
          Date.now() -
          signal.createdAt
        ) /
        3600000;

      if (
        ageHours >
        CONFIG.SIGNAL_EXPIRY_HOURS
      ) {

        signal.status =
          "EXPIRED";

        updateHistoryStatus(
          signal.key,
          "EXPIRED",
          price
        );

        continue;

      }

      /*
      LONG
      */

      if (
        signal.direction ===
        "LONG"
      ) {

        if (
          price <=
          signal.stop
        ) {

          signal.status =
            "STOP";

          updateHistoryStatus(
            signal.key,
            "STOP",
            price
          );

          continue;

        }

        if (
          price >=
          signal.tp3
        ) {

          signal.status =
            "TP3";

          updateHistoryStatus(
            signal.key,
            "TP3",
            price
          );

          continue;

        }

        if (
          price >=
          signal.tp2
        ) {

          signal.status =
            "TP2";

          updateHistoryStatus(
            signal.key,
            "TP2",
            price
          );

          continue;

        }

        if (
          price >=
          signal.tp1
        ) {

          signal.status =
            "TP1";

          updateHistoryStatus(
            signal.key,
            "TP1",
            price
          );

          continue;

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
            "STOP";

          updateHistoryStatus(
            signal.key,
            "STOP",
            price
          );

          continue;

        }

        if (
          price <=
          signal.tp3
        ) {

          signal.status =
            "TP3";

          updateHistoryStatus(
            signal.key,
            "TP3",
            price
          );

          continue;

        }

        if (
          price <=
          signal.tp2
        ) {

          signal.status =
            "TP2";

          updateHistoryStatus(
            signal.key,
            "TP2",
            price
          );

          continue;

        }

        if (
          price <=
          signal.tp1
        ) {

          signal.status =
            "TP1";

          updateHistoryStatus(
            signal.key,
            "TP1",
            price
          );

          continue;

        }

      }

      remaining.push(
        signal
      );

    } catch {

      remaining.push(
        signal
      );

    }

  }

  activeSignals =
    remaining;

}

/*
=========================================================
PERFORMANS
=========================================================
*/

function getPerformance() {

  const resolved =
    signalHistory.filter(
      item =>
        item.status ===
          "TP1" ||
        item.status ===
          "TP2" ||
        item.status ===
          "TP3" ||
        item.status ===
          "STOP"
    );

  const recent =
    resolved.slice(
      -50
    );

  const wins =
    recent.filter(
      item =>
        item.status ===
          "TP1" ||
        item.status ===
          "TP2" ||
        item.status ===
          "TP3"
    );

  const stops =
    recent.filter(
      item =>
        item.status ===
        "STOP"
    );

  let totalR = 0;

  for (
    const item of recent
  ) {

    if (
      item.status ===
      "TP1"
    ) {

      totalR +=
        CONFIG.TP1_RR;

    } else if (
      item.status ===
      "TP2"
    ) {

      totalR +=
        CONFIG.TP2_RR;

    } else if (
      item.status ===
      "TP3"
    ) {

      totalR +=
        CONFIG.TP3_RR;

    } else if (
      item.status ===
      "STOP"
    ) {

      totalR -= 1;

    }

  }

  const missed =
    signalHistory.filter(
      item =>
        item.status ===
        "MISSED"
    ).length;

  const invalid =
    signalHistory.filter(
      item =>
        item.status ===
        "INVALID"
    ).length;

  return {

    sample:
      recent.length,

    tp1Success:
      recent.length > 0
        ? number(
            (
              wins.length /
              recent.length
            ) *
            100,
            1
          )
        : 0,

    stopRate:
      recent.length > 0
        ? number(
            (
              stops.length /
              recent.length
            ) *
            100,
            1
          )
        : 0,

    totalR:
      number(
        totalR,
        2
      ),

    resolved:
      recent.length,

    missed,

    invalid

  };

}

/*
=========================================================
RADAR
=========================================================
*/

async function runRadar() {

  if (
    scanRunning
  ) {

    return null;

  }

  scanRunning =
    true;

  const started =
    Date.now();

  try {

    /*
    Discovery her taramada yenileniyor.
    */

    await discoverMarket();

    /*
    Genel piyasa
    */

    await calculateMarketRegime();

    /*
    İlk etapta 90 coin analiz edilir.

    600 coin universe içerisinden
    en hareketli / likit 90 coin.
    */

    opportunityPool =
      marketCache.slice(
        0,
        CONFIG.RADAR_CANDIDATES
      );

    log(
      "Radar başladı. " +
      opportunityPool.length +
      " coin analiz edilecek."
    );

    const results = [];

    for (
      let i = 0;
      i <
      opportunityPool.length;
      i +=
      CONFIG.BATCH_SIZE
    ) {

      const batch =
        opportunityPool.slice(
          i,
          i +
          CONFIG.BATCH_SIZE
        );

      const batchResults =
        await Promise.all(
          batch.map(
            coin =>
              analyzeCoin(
                coin
              )
          )
        );

      for (
        const result
        of batchResults
      ) {

        if (
          result
        ) {

          results.push(
            result
          );

        }

      }

      await sleep(
        CONFIG.BATCH_DELAY_MS
      );

    }

    results.sort(
      (a, b) =>
        b.score -
        a.score
    );

    /*
    ACTIVE SIGNALS
    */

    const candidates =
      results.filter(
        item =>
          item.state ===
          "SIGNAL"
      );

    /*
    Yeni sinyal ekle.
    */

    for (
      const candidate
      of candidates
    ) {

      if (
        activeSignals.length >=
        CONFIG.MAX_ACTIVE_SIGNALS
      ) {

        break;

      }

      /*
      Aynı coin/yön için
      zaten aktif varsa yeniden oluşturma.
      */

      const exists =
        activeSignals.some(
          signal =>
            signal.symbol ===
              candidate.symbol &&
            signal.direction ===
              candidate.direction
        );

      if (
        !exists
      ) {

        registerSignal(
          candidate
        );

      }

    }

    /*
    PREPARING

    En iyi 5.
    */

    preparingSignals =
      results
        .filter(
          item =>
            item.state ===
            "PREPARING"
        )
        .slice(
          0,
          CONFIG.MAX_PREPARING
        );

    /*
    Aktif sinyalleri canlı fiyatla güncelle.
    */

    await monitorActiveSignals();

    const elapsed =
      (
        (
          Date.now() -
          started
        ) /
        1000
      ).toFixed(1);

    lastScan =
      new Date()
        .toISOString();

    const performance =
      getPerformance();

    log(
      "RADAR tamamlandı | " +
      "Market: " +
      marketCache.length +
      " | " +
      "Analiz: " +
      results.length +
      " | " +
      "SIGNAL: " +
      activeSignals.length +
      " | " +
      "PREPARING: " +
      preparingSignals.length +
      " | " +
      "TP1%: " +
      performance.tp1Success
    );

    return {

      success:
        true,

      system:
        SYSTEM_NAME,

      timestamp:
        lastScan,

      market:
        marketCache.length,

      analyzed:
        results.length,

      marketRegime,

      activeSignals,

      preparingSignals,

      performance,

      duration:
        Number(
          elapsed
        )

    };

  } catch (error) {

    lastError =
      error.message;

    log(
      "RADAR ERROR: " +
      error.message
    );

    return {

      success:
        false,

      error:
        error.message

    };

  } finally {

    scanRunning =
      false;

  }

}

/*
=========================================================
BACKGROUND
=========================================================
*/

async function backgroundLoop() {

  /*
  Sistem sürekli aktif.

  Her dakika yeniden tarar.
  */

  while (true) {

    try {

      await runRadar();

    } catch (error) {

      log(
        "Background error: " +
        error.message
      );

    }

    await sleep(
      CONFIG.REFRESH_MS
    );

  }

}

/*
=========================================================
HTML
=========================================================
*/

const HTML = `
<!DOCTYPE html>

<html lang="tr">

<head>

<meta charset="UTF-8">

<meta
name="viewport"
content="width=device-width, initial-scale=1.0">

<title>
Sonny AI Signal Scanner V6.1
</title>

<style>

* {
  box-sizing: border-box;
}

body {

  margin: 0;

  background:
    #070b16;

  color:
    #f4f7fb;

  font-family:
    Arial,
    Helvetica,
    sans-serif;

}

.container {

  width:
    min(1250px, 94%);

  margin:
    25px auto 50px;

}

.header {

  display:
    flex;

  justify-content:
    space-between;

  align-items:
    center;

  margin-bottom:
    18px;

}

.title {

  font-size:
    28px;

  font-weight:
    900;

}

.subtitle {

  color:
    #8795b2;

  margin-top:
    6px;

}

.online {

  background:
    #0c281b;

  color:
    #48e28c;

  border:
    1px solid #1d6841;

  padding:
    9px 14px;

  border-radius:
    20px;

  font-weight:
    800;

}

.market-box {

  background:
    #101728;

  border:
    1px solid #263653;

  border-radius:
    16px;

  padding:
    20px;

  margin-bottom:
    15px;

}

.market-title {

  color:
    #8191b1;

  font-size:
    11px;

  font-weight:
    800;

  letter-spacing:
    .08em;

}

.market-direction {

  font-size:
    28px;

  font-weight:
    900;

  margin-top:
    8px;

}

.market-details {

  color:
    #8e9dbc;

  margin-top:
    8px;

}

.stats {

  display:
    grid;

  grid-template-columns:
    repeat(4, 1fr);

  gap:
    10px;

  margin-bottom:
    15px;

}

.stat {

  background:
    #101728;

  border:
    1px solid #263653;

  border-radius:
    14px;

  padding:
    15px;

}

.stat-label {

  color:
    #71819f;

  font-size:
    10px;

  text-transform:
    uppercase;

}

.stat-value {

  font-size:
    22px;

  font-weight:
    900;

  margin-top:
    6px;

}

.panel {

  background:
    #101728;

  border:
    1px solid #263653;

  border-radius:
    16px;

  padding:
    18px;

  margin-bottom:
    15px;

}

.panel h2 {

  margin:
    0 0 8px;

}

.description {

  color:
    #8594b1;

  font-size:
    13px;

  line-height:
    1.6;

  margin-bottom:
    15px;

}

.signal-card {

  background:
    #0b1322;

  border:
    1px solid #28405c;

  border-radius:
    14px;

  padding:
    17px;

  margin-bottom:
    12px;

}

.signal-header {

  display:
    flex;

  justify-content:
    space-between;

  align-items:
    center;

  gap:
    10px;

}

.coin {

  font-size:
    20px;

  font-weight:
    900;

}

.long {

  color:
    #42e88b;

}

.short {

  color:
    #ff637d;

}

.score {

  background:
    #1b2b43;

  padding:
    7px 10px;

  border-radius:
    8px;

  font-weight:
    900;

}

.strategy {

  color:
    #9caac4;

  font-size:
    12px;

  margin:
    8px 0 13px;

}

.price {

  color:
    #f6c95f;

  font-weight:
    900;

}

.trade-grid {

  display:
    grid;

  grid-template-columns:
    repeat(5, 1fr);

  gap:
    8px;

  margin:
    12px 0;

}

.trade-box {

  background:
    #141e31;

  border-radius:
    9px;

  padding:
    10px;

}

.trade-label {

  color:
    #71819f;

  font-size:
    10px;

}

.trade-value {

  font-weight:
    900;

  margin-top:
    4px;

}

.tp {

  color:
    #42e88b;

}

.stop {

  color:
    #ff637d;

}

.metrics {

  display:
    flex;

  flex-wrap:
    wrap;

  gap:
    8px;

}

.metric {

  background:
    #172239;

  padding:
    7px 9px;

  border-radius:
    7px;

  color:
    #aebbd0;

  font-size:
    11px;

}

.tv {

  display:
    inline-block;

  margin-top:
    12px;

  background:
    #f2f5f9;

  color:
    #07101f;

  padding:
    9px 12px;

  border-radius:
    8px;

  font-weight:
    900;

  text-decoration:
    none;

}

.preparing-card {

  display:
    flex;

  justify-content:
    space-between;

  align-items:
    center;

  background:
    #111c2e;

  border:
    1px solid #2d3a50;

  border-radius:
    11px;

  padding:
    13px;

  margin-bottom:
    8px;

}

.preparing-left {

  display:
    flex;

  gap:
    10px;

  align-items:
    center;

}

.preparing-coin {

  font-weight:
    900;

}

.preparing-info {

  color:
    #8492ab;

  font-size:
    11px;

}

.performance {

  display:
    grid;

  grid-template-columns:
    repeat(5, 1fr);

  gap:
    10px;

}

.performance-box {

  background:
    #131d30;

  border-radius:
    10px;

  padding:
    13px;

}

.performance-label {

  color:
    #7887a3;

  font-size:
    10px;

}

.performance-value {

  font-size:
    20px;

  font-weight:
    900;

  margin-top:
    6px;

}

.good {

  color:
    #42e88b;

}

.bad {

  color:
    #ff637d;

}

.neutral {

  color:
    #f4c95d;

}

.empty {

  text-align:
    center;

  color:
    #687791;

  padding:
    25px;

}

.method {

  display:
    grid;

  grid-template-columns:
    repeat(5, 1fr);

  gap:
    8px;

}

.method-item {

  background:
    #131d30;

  border-radius:
    10px;

  padding:
    12px;

}

.method-number {

  color:
    #f5c85c;

  font-weight:
    900;

}

.method-title {

  font-weight:
    900;

  margin-top:
    5px;

}

.method-text {

  color:
    #7f8da8;

  font-size:
    11px;

  margin-top:
    5px;

  line-height:
    1.4;

}

@media(max-width:900px) {

  .stats,
  .performance {

    grid-template-columns:
      repeat(2, 1fr);

  }

  .trade-grid {

    grid-template-columns:
      repeat(3, 1fr);

  }

  .method {

    grid-template-columns:
      repeat(2, 1fr);

  }

}

@media(max-width:600px) {

  .header {

    display:
      block;

  }

  .online {

    display:
      inline-block;

    margin-top:
      12px;

  }

  .stats {

    grid-template-columns:
      repeat(2, 1fr);

  }

  .trade-grid {

    grid-template-columns:
      repeat(2, 1fr);

  }

  .performance {

    grid-template-columns:
      repeat(2, 1fr);

  }

  .method {

    grid-template-columns:
      1fr;

  }

}

</style>

</head>

<body>

<div class="container">

<div class="header">

<div>

<div class="title">
🚀 Sonny AI Signal Scanner V6.1
</div>

<div class="subtitle">
4H Kırılım · 2H Onay · 1H Yapı · 15M Retest · 5M Giriş · Adaptive AI
</div>

</div>

<div class="online">
● SÜREKLİ AKTİF
</div>

</div>

<div class="market-box">

<div class="market-title">
GENEL PİYASA DURUMU
</div>

<div
id="marketDirection"
class="market-direction">
VERİ BEKLENİYOR
</div>

<div
id="marketDetails"
class="market-details">
Piyasa hesaplanıyor...
</div>

</div>

<div class="stats">

<div class="stat">

<div class="stat-label">
Piyasa
</div>

<div
id="market"
class="stat-value">
-
</div>

</div>

<div class="stat">

<div class="stat-label">
Analiz
</div>

<div
id="analyzed"
class="stat-value">
-
</div>

</div>

<div class="stat">

<div class="stat-label">
Aktif Sinyal
</div>

<div
id="active"
class="stat-value">
0
</div>

</div>

<div class="stat">

<div class="stat-label">
Son Tarama
</div>

<div
id="last"
class="stat-value">
-
</div>

</div>

</div>

<div class="panel">

<h2>
🚨 AKTİF SİNYALLER
</h2>

<div class="description">
Giriş şartları tamamlanan güçlü fırsatlar burada görünür.
Fiyatlar her taramada güncellenir.
</div>

<div id="activeSignals">

<div class="empty">
Sistem tarama yapıyor...
</div>

</div>

</div>

<div class="panel">

<h2>
🟡 HAZIRLANAN FIRSATLAR
</h2>

<div class="description">
Henüz tam sinyal olmayan ancak 4H / 2H yapısı güçlü olan
en iyi adaylar burada görünür.
</div>

<div id="preparing">

<div class="empty">
Hazırlanan fırsat yok.
</div>

</div>

</div>

<div class="panel">

<h2>
📊 GERÇEK PERFORMANS · SON 50 SİNYAL
</h2>

<div class="description">
Performans yalnızca gerçekleşmiş sonuçlardan hesaplanır.
Aktif ve hazırlanan sinyaller başarı oranına dahil edilmez.
</div>

<div
id="performance"
class="performance">

</div>

</div>

<div class="panel">

<h2>
🧠 SONNY NASIL KARAR VERİYOR?
</h2>

<div class="method">

<div class="method-item">

<div class="method-number">
1
</div>

<div class="method-title">
4H Kırılım
</div>

<div class="method-text">
Ana destek / direnç kırılımı ve piyasanın ana yönü.
</div>

</div>

<div class="method-item">

<div class="method-number">
2
</div>

<div class="method-title">
2H Onay
</div>

<div class="method-text">
Kırılımın daha düşük zaman diliminde teyit edilmesi.
</div>

</div>

<div class="method-item">

<div class="method-number">
3
</div>

<div class="method-title">
1H Yapı
</div>

<div class="method-text">
Trendin aynı yönde devam edip etmediği kontrol edilir.
</div>

</div>

<div class="method-item">

<div class="method-number">
4
</div>

<div class="method-title">
15M Retest
</div>

<div class="method-text">
Kırılan seviyeye geri dönüş ve giriş bölgesi kontrol edilir.
</div>

</div>

<div class="method-item">

<div class="method-number">
5
</div>

<div class="method-title">
5M Giriş
</div>

<div class="method-text">
RSI + EMA9/21 + momentum + hacim + Bollinger kontrolü.
</div>

</div>

</div>

</div>

<div
id="status"
class="description">
Sistem başlatılıyor...
</div>

</div>

<script>

function esc(value) {

  return String(
    value ?? ""
  )
  .replace(
    /&/g,
    "&amp;"
  )
  .replace(
    /</g,
    "&lt;"
  )
  .replace(
    />/g,
    "&gt;"
  )
  .replace(
    /"/g,
    "&quot;"
  )
  .replace(
    /'/g,
    "&#039;"
  );

}

function directionClass(
  direction
) {

  return direction === "LONG"
    ? "long"
    : "short";

}

function renderActive(
  signals
) {

  const box =
    document.getElementById(
      "activeSignals"
    );

  if (
    !signals ||
    signals.length === 0
  ) {

    box.innerHTML =
      '<div class="empty">' +
      'Şu anda aktif güçlü sinyal yok.' +
      '</div>';

    return;

  }

  box.innerHTML =
    signals.map(
      signal => {

        return `

<div class="signal-card">

<div class="signal-header">

<div>

<div class="coin ${directionClass(signal.direction)}">

${esc(signal.symbol)}
 ·
${esc(signal.direction)}

</div>

<div class="strategy">

${esc(signal.strategy)}

</div>

</div>

<div class="score">

${esc(signal.score)}/100

</div>

</div>

<div>

Anlık fiyat:

<span class="price">

${esc(signal.livePrice ?? signal.price)}

</span>

</div>

<div class="trade-grid">

<div class="trade-box">

<div class="trade-label">
GİRİŞ
</div>

<div class="trade-value">
${esc(signal.entryLow)}
 -
${esc(signal.entryHigh)}
</div>

</div>

<div class="trade-box">

<div class="trade-label">
STOP
</div>

<div class="trade-value stop">
${esc(signal.stop)}
</div>

</div>

<div class="trade-box">

<div class="trade-label">
TP1
</div>

<div class="trade-value tp">
${esc(signal.tp1)}
</div>

</div>

<div class="trade-box">

<div class="trade-label">
TP2
</div>

<div class="trade-value tp">
${esc(signal.tp2)}
</div>

</div>

<div class="trade-box">

<div class="trade-label">
TP3
</div>

<div class="trade-value tp">
${esc(signal.tp3)}
</div>

</div>

</div>

<div class="metrics">

<span class="metric">
4H: ${esc(signal.fourHDirection)}
</span>

<span class="metric">
2H: ${signal.twoHConfirmed ? "ONAY" : "BEKLE"}
</span>

<span class="metric">
1H: ${signal.oneHConfirmed ? "ONAY" : "BEKLE"}
</span>

<span class="metric">
15M RSI: ${esc(signal.rsi15m)}
</span>

<span class="metric">
5M RSI: ${esc(signal.rsi5m)}
</span>

<span class="metric">
5M Momentum: ${esc(signal.fiveMinuteMomentum)}%
</span>

<span class="metric">
Hacim: ${esc(signal.volumeRatio)}x
</span>

<span class="metric">
BB: ${esc(signal.bbWidth)}%
</span>

<span class="metric">
BB Durumu: ${esc(signal.bbState)}
</span>

</div>

<a
class="tv"
href="${esc(signal.tradingView)}"
target="_blank"
rel="noopener noreferrer">
📊 TRADINGVIEW AÇ
</a>

</div>

`;

      }
    )
    .join("");

}

function renderPreparing(
  items
) {

  const box =
    document.getElementById(
      "preparing"
    );

  if (
    !items ||
    items.length === 0
  ) {

    box.innerHTML =
      '<div class="empty">' +
      'Şu anda hazırlanan güçlü fırsat yok.' +
      '</div>';

    return;

  }

  box.innerHTML =
    items.map(
      item => {

        return `

<div class="preparing-card">

<div class="preparing-left">

<div>

<div class="preparing-coin ${directionClass(item.direction)}">

${esc(item.symbol)}
 ·
${esc(item.direction)}

</div>

<div class="preparing-info">

Anlık:
${esc(item.price)}

 · RSI:
${esc(item.rsi5m)}

 · BB:
${esc(item.bbWidth)}%

</div>

</div>

</div>

<div class="preparing-info">

PUAN
<b>
${esc(item.score)}
</b>

</div>

</div>

`;

      }
    )
    .join("");

}

function renderPerformance(
  performance
) {

  const box =
    document.getElementById(
      "performance"
    );

  if (
    !performance
  ) {

    return;

  }

  box.innerHTML = `

<div class="performance-box">

<div class="performance-label">
TP1 BAŞARI
</div>

<div class="performance-value good">
${esc(performance.tp1Success)}%
</div>

</div>

<div class="performance-box">

<div class="performance-label">
STOP
</div>

<div class="performance-value bad">
${esc(performance.stopRate)}%
</div>

</div>

<div class="performance-box">

<div class="performance-label">
TOPLAM R
</div>

<div class="performance-value">
${esc(performance.totalR)}R
</div>

</div>

<div class="performance-box">

<div class="performance-label">
ÇÖZÜLEN
</div>

<div class="performance-value">
${esc(performance.resolved)}
</div>

</div>

<div class="performance-box">

<div class="performance-label">
KAÇAN
</div>

<div class="performance-value neutral">
${esc(performance.missed)}
</div>

</div>

`;

}

function updateDashboard(
  data
) {

  if (
    !data ||
    !data.success
  ) {

    return;

  }

  document.getElementById(
    "market"
  ).innerText =
    data.market ?? "-";

  document.getElementById(
    "analyzed"
  ).innerText =
    data.analyzed ?? "-";

  document.getElementById(
    "active"
  ).innerText =
    data.activeSignals
      ? data.activeSignals.length
      : 0;

  document.getElementById(
    "last"
  ).innerText =
    data.timestamp
      ? new Date(
          data.timestamp
        ).toLocaleTimeString(
          "tr-TR"
        )
      : "-";

  if (
    data.marketRegime
  ) {

    const regime =
      data.marketRegime;

    const direction =
      document.getElementById(
        "marketDirection"
      );

    direction.innerText =
      regime.label;

    direction.className =
      "market-direction " +
      (
        regime.direction ===
        "LONG"
          ? "long"
          : regime.direction ===
            "SHORT"
            ? "short"
            : "neutral"
      );

    document.getElementById(
      "marketDetails"
    ).innerText =
      "BTC " +
      regime.btcChange +
      "% · ETH " +
      regime.ethChange +
      "% · Piyasa genişliği " +
      regime.breadth +
      "% · Güç " +
      regime.score +
      "/100";

  }

  renderActive(
    data.activeSignals
  );

  renderPreparing(
    data.preparingSignals
  );

  renderPerformance(
    data.performance
  );

}

async function loadResult() {

  try {

    const response =
      await fetch(
        "/api/result"
      );

    const data =
      await response.json();

    updateDashboard(
      data
    );

    document.getElementById(
      "status"
    ).innerText =
      "Son tarama otomatik olarak güncelleniyor.";

  } catch (error) {

    document.getElementById(
      "status"
    ).innerText =
      "Sunucu bağlantısı bekleniyor...";

  }

}

/*
Sayfa da otomatik yenilenir.

Sunucu zaten her dakika tarama yapıyor.
*/

loadResult();

setInterval(
  loadResult,
  10000
);

</script>

</body>

</html>
`;

/*
=========================================================
ROUTES
=========================================================
*/

app.get(
  "/",
  (req, res) => {

    res.setHeader(
      "Content-Type",
      "text/html; charset=utf-8"
    );

    res.send(
      HTML
    );

  }
);

app.get(
  "/health",
  (req, res) => {

    res.json({

      success:
        true,

      status:
        "healthy",

      system:
        SYSTEM_NAME,

      uptime:
        process.uptime()

    });

  }
);

app.get(
  "/api/status",
  (req, res) => {

    res.json({

      success:
        true,

      system:
        SYSTEM_NAME,

      status:
        scanRunning
          ? "SCANNING"
          : "ONLINE",

      market:
        marketCache.length,

      active:
        activeSignals.length,

      preparing:
        preparingSignals.length,

      marketRegime,

      lastScan,

      error:
        lastError

    });

  }
);

app.get(
  "/api/result",
  (req, res) => {

    res.json({

      success:
        true,

      system:
        SYSTEM_NAME,

      timestamp:
        lastScan,

      market:
        marketCache.length,

      analyzed:
        marketCache.length
          ? CONFIG.RADAR_CANDIDATES
          : 0,

      marketRegime,

      activeSignals,

      preparingSignals,

      performance:
        getPerformance()

    });

  }
);

app.get(
  "/api/scan",
  async (req, res) => {

    const result =
      await runRadar();

    res.json(
      result ||
      {
        success:
          true,
        message:
          "Tarama zaten çalışıyor."
      }
    );

  }
);

app.get(
  "/api/history",
  (req, res) => {

    res.json({

      success:
        true,

      performance:
        getPerformance(),

      history:
        signalHistory.slice(
          -50
        )

    });

  }
);

app.use(
  (req, res) => {

    res.status(
      404
    ).json({

      success:
        false,

      error:
        "Endpoint not found"

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
  "0.0.0.0",
  () => {

    log(
      SYSTEM_NAME +
      " started"
    );

    log(
      "Data source: BITGET"
    );

    log(
      "Strategy: 4H BREAKOUT + 2H CONFIRMATION + 1H STRUCTURE + 15M RETEST + 5M RSI/MOMENTUM + BB"
    );

    log(
      "Refresh: Every " +
      (
        CONFIG.REFRESH_MS /
        1000
      ) +
      " seconds"
    );

    log(
      "Universe: " +
      CONFIG.DISCOVERY_LIMIT +
      " coins"
    );

    log(
      "Radar candidates: " +
      CONFIG.RADAR_CANDIDATES
    );

    log(
      "Signal history: " +
      signalHistory.length +
      " kayıt"
    );

    /*
    Render portu hemen açıldıktan sonra
    arka plan motoru başlar.
    */

    setTimeout(
      () => {

        backgroundLoop();

      },
      3000
    );

  }
);
