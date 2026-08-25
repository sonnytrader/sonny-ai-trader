const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

const SYSTEM_NAME = "Sonny AI Signal Scanner V6.1";
const BITGET_BASE = "https://api.bitget.com";
const PRODUCT_TYPE = "usdt-futures";
const HISTORY_FILE = path.join(__dirname, "signal_history.json");

/*
=========================================================
SONNY V6.1

4H KIRILIM
+
2H ONAY
+
1H TREND
+
RETEST
+
15M RSI
+
5M MOMENTUM
+
HACİM
+
BOLLINGER SQUEEZE
+
ORDERBOOK

Otomatik işlem açmaz.
Sadece sinyal üretir ve canlı takip eder.
=========================================================
*/

const CONFIG = {

  REFRESH_MS: 60 * 1000,

  UI_REFRESH_MS: 10 * 1000,

  MIN_VOLUME_USDT: 750000,

  /*
  Bitget'te bulunan uygun USDT perpetual
  piyasalarının tamamına kadar keşif.
  */

  MARKET_LIMIT: 600,

  /*
  Ticker bazlı hızlı ön eleme.
  */

  FAST_RADAR_LIMIT: 300,

  /*
  Ağır OHLCV analizine girecek coin.
  */

  ANALYZE_LIMIT: 180,

  /*
  Orderbook sadece güçlü adaylarda.
  */

  ORDERBOOK_LIMIT: 30,

  BATCH_SIZE: 10,

  BATCH_DELAY_MS: 60,

  /*
  TIMEFRAMES
  */

  FOUR_HOUR_LIMIT: 120,

  TWO_HOUR_LIMIT: 120,

  ONE_HOUR_LIMIT: 100,

  FIFTEEN_MIN_LIMIT: 160,

  FIVE_MIN_LIMIT: 120,

  /*
  LEVELS
  */

  LEVEL_LOOKBACK_4H: 40,

  LEVEL_LOOKBACK_2H: 40,

  LEVEL_LOOKBACK_1H: 30,

  BREAKOUT_RECENT_BARS: 8,

  /*
  ENTRY
  */

  RETEST_DISTANCE_PERCENT: 0.80,

  MAX_ENTRY_DISTANCE_PERCENT: 0.40,

  MISSED_BUFFER_PERCENT: 0.25,

  /*
  RSI
  */

  RSI_PERIOD: 14,

  RSI_LONG_MIN: 48,

  RSI_LONG_MAX: 68,

  RSI_SHORT_MIN: 32,

  RSI_SHORT_MAX: 52,

  /*
  SIGNAL
  */

  MIN_SIGNAL_SCORE: 72,

  MAX_SIGNALS: 8,

  MAX_PREPARING: 8,

  MAX_MISSED: 20,

  MAX_HISTORY: 1000,

  /*
  VOLUME
  */

  VOLUME_STRONG: 1.15,

  VOLUME_VERY_STRONG: 1.50,

  /*
  FAKE BREAKOUT
  */

  FAKE_BREAKOUT_PERCENT: 0.20,

  /*
  ORDERBOOK
  */

  ORDERBOOK_DEPTH: 15,

  ORDERBOOK_MIN: 1.20,

  ORDERBOOK_STRONG: 1.60,

  /*
  COOLDOWN
  */

  SIGNAL_COOLDOWN_MS: 60 * 60 * 1000,

  MISSED_COOLDOWN_MS: 15 * 60 * 1000

};


/*
=========================================================
GLOBAL STATE
=========================================================
*/

let marketCache = [];

let cachedResult = null;

let scanRunning = false;

let lastScan = null;

let lastError = null;

let discoveryTime = null;

const activeSignals = new Map();

const missedSignals = [];

const cooldowns = new Map();

let history = loadHistory();


/*
=========================================================
HELPERS
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


function num(value, digits = 6) {

  const n = Number(value);

  if (!Number.isFinite(n)) {

    return 0;

  }

  return Number(
    n.toFixed(digits)
  );

}


function pct(value, base) {

  if (
    !Number.isFinite(value) ||
    !Number.isFinite(base) ||
    base === 0
  ) {

    return 0;

  }

  return (
    value /
    base
  ) * 100;

}


function avg(values) {

  const valid =
    values.filter(
      Number.isFinite
    );

  if (!valid.length) {

    return 0;

  }

  return (
    valid.reduce(
      (sum, value) =>
        sum + value,
      0
    ) /
    valid.length
  );

}


function arr(value) {

  return Array.isArray(value)
    ? value
    : [];

}


function signalKey(signal) {

  return (
    signal.symbol +
    ":" +
    signal.direction
  );

}


/*
=========================================================
TRADINGVIEW
=========================================================
*/

function tvUrl(symbol) {

  const clean =
    String(symbol || "")
      .replace(/\.P$/i, "");

  return (
    "https://www.tradingview.com/chart/?symbol=BITGET%3A" +
    encodeURIComponent(clean) +
    ".P"
  );

}


/*
=========================================================
HISTORY
=========================================================
*/

function loadHistory() {

  try {

    if (
      !fs.existsSync(
        HISTORY_FILE
      )
    ) {

      return [];

    }

    const data =
      JSON.parse(
        fs.readFileSync(
          HISTORY_FILE,
          "utf8"
        )
      );

    if (
      !Array.isArray(data)
    ) {

      return [];

    }

    return data.slice(
      0,
      CONFIG.MAX_HISTORY
    );

  } catch (error) {

    log(
      "History yüklenemedi: " +
      error.message
    );

    return [];

  }

}


function saveHistory() {

  try {

    fs.writeFileSync(

      HISTORY_FILE,

      JSON.stringify(
        history.slice(
          0,
          CONFIG.MAX_HISTORY
        ),
        null,
        2
      )

    );

  } catch (error) {

    log(
      "History kaydedilemedi: " +
      error.message
    );

  }

}


function addHistory(item) {

  history.unshift(
    item
  );

  history =
    history.slice(
      0,
      CONFIG.MAX_HISTORY
    );

  saveHistory();

}


/*
=========================================================
PERFORMANCE
=========================================================
*/

function performance() {

  const last50 =
    history.slice(
      0,
      50
    );

  const resolved =
    last50.filter(
      item =>
        [
          "TP1",
          "TP2",
          "TP3",
          "STOP"
        ].includes(
          item.result
        )
    );

  const wins =
    resolved.filter(
      item =>
        item.tp1Hit
    ).length;

  const stops =
    resolved.filter(
      item =>
        item.result ===
        "STOP"
    ).length;

  const totalR =
    resolved.reduce(
      (sum, item) =>
        sum +
        Number(
          item.realizedR || 0
        ),
      0
    );

  function rate(
    value,
    total
  ) {

    if (!total) {

      return 0;

    }

    return num(
      value /
      total *
      100,
      1
    );

  }

  return {

    window:
      50,

    total:
      last50.length,

    resolved:
      resolved.length,

    missed:
      last50.filter(
        x =>
          x.result ===
          "MISSED"
      ).length,

    invalid:
      last50.filter(
        x =>
          x.result ===
          "INVALID"
      ).length,

    tp1Rate:
      rate(
        wins,
        resolved.length
      ),

    stopRate:
      rate(
        stops,
        resolved.length
      ),

    totalR:
      num(
        totalR,
        2
      ),

    averageR:
      resolved.length
        ? num(
            totalR /
            resolved.length,
            2
          )
        : 0,

    items:
      last50

  };

}


/*
=========================================================
BITGET API
=========================================================
*/

async function bitget(
  endpoint,
  params = {}
) {

  const url =
    new URL(
      BITGET_BASE +
      endpoint
    );

  Object.entries(
    params
  ).forEach(
    ([key, value]) => {

      if (
        value !==
          undefined &&
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
      url,
      {
        headers: {
          Accept:
            "application/json"
        }
      }
    );

  const text =
    await response.text();

  if (
    !response.ok
  ) {

    throw new Error(
      "Bitget HTTP " +
      response.status +
      " - " +
      text.slice(
        0,
        200
      )
    );

  }

  let json;

  try {

    json =
      JSON.parse(
        text
      );

  } catch {

    throw new Error(
      "Bitget JSON parse error"
    );

  }

  if (
    json.code !==
    "00000"
  ) {

    throw new Error(
      "Bitget " +
      json.code +
      " - " +
      (
        json.msg ||
        "Unknown error"
      )
    );

  }

  return json.data;

}


/*
=========================================================
CANDLES
=========================================================
*/

function parseCandles(
  data
) {

  return arr(data)

    .map(
      row => ({

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
          Number(
            row[5] ||
            0
          ),

        quoteVolume:
          Number(
            row[6] ||
            0
          )

      })
    )

    .filter(
      candle =>
        Number.isFinite(
          candle.close
        )
    )

    .sort(
      (a, b) =>
        a.time -
        b.time
    );

}


async function candles(
  symbol,
  timeframe,
  limit
) {

  const data =
    await bitget(
      "/api/v2/mix/market/candles",
      {
        symbol,
        productType:
          PRODUCT_TYPE,
        granularity:
          timeframe,
        limit
      }
    );

  return parseCandles(
    data
  );

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
    values.length <
      period
  ) {

    return null;

  }

  let result =
    avg(
      values.slice(
        0,
        period
      )
    );

  const multiplier =
    2 /
    (
      period +
      1
    );

  for (
    let i = period;
    i < values.length;
    i++
  ) {

    result =
      values[i] *
      multiplier +
      result *
      (
        1 -
        multiplier
      );

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
    values.length <
      period
  ) {

    return null;

  }

  return avg(
    values.slice(
      -period
    )
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
    values.length <=
      period
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
    gains /
    period;

  let avgLoss =
    losses /
    period;

  for (
    let i =
      period + 1;
    i <
      values.length;
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
        (
          period -
          1
        ) +
        gain
      ) /
      period;

    avgLoss =
      (
        avgLoss *
        (
          period -
          1
        ) +
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
    (
      1 +
      rs
    )
  );

}


/*
=========================================================
BOLLINGER BAND
=========================================================
*/

function bollinger(
  candlesData,
  period = 20,
  multiplier = 2
) {

  if (
    !candlesData ||
    candlesData.length <
      period
  ) {

    return null;

  }

  const closes =
    candlesData
      .slice(
        -period
      )
      .map(
        candle =>
          candle.close
      );

  const middle =
    avg(
      closes
    );

  const variance =
    avg(
      closes.map(
        value =>
          (
            value -
            middle
          ) ** 2
      )
    );

  const deviation =
    Math.sqrt(
      variance
    );

  const upper =
    middle +
    multiplier *
    deviation;

  const lower =
    middle -
    multiplier *
    deviation;

  const width =
    middle !== 0
      ? (
          (
            upper -
            lower
          ) /
          middle
        ) *
        100
      : 0;

  return {

    middle,

    upper,

    lower,

    width

  };

}


/*
=========================================================
VOLUME RATIO
=========================================================
*/

function volumeRatio(
  candlesData,
  period = 20
) {

  if (
    !candlesData ||
    candlesData.length <
      period + 1
  ) {

    return 1;

  }

  const closed =
    candlesData.slice(
      0,
      -1
    );

  const current =
    closed[
      closed.length -
      1
    ];

  const previous =
    closed.slice(
      -period - 1,
      -1
    );

  const averageVolume =
    avg(
      previous.map(
        candle =>
          candle.quoteVolume ||
          candle.volume
      )
    );

  if (
    averageVolume <= 0
  ) {

    return 1;

  }

  return (
    (
      current.quoteVolume ||
      current.volume
    ) /
    averageVolume
  );

}


/*
=========================================================
MARKET LEVELS
=========================================================
*/

function getLevels(
  candlesData,
  lookback
) {

  if (
    !candlesData ||
    candlesData.length <
      lookback + 5
  ) {

    return null;

  }

  const closed =
    candlesData.slice(
      0,
      -1
    );

  const current =
    closed[
      closed.length -
      1
    ];

  const historyCandles =
    closed.slice(
      -lookback - 1,
      -1
    );

  return {

    current,

    resistance:
      Math.max(
        ...historyCandles.map(
          candle =>
            candle.high
        )
      ),

    support:
      Math.min(
        ...historyCandles.map(
          candle =>
            candle.low
        )
      )

  };

}


/*
=========================================================
BREAKOUT
=========================================================
*/

function detectBreakout(
  candlesData,
  lookback
) {

  const levels =
    getLevels(
      candlesData,
      lookback
    );

  if (!levels) {

    return null;

  }

  const closed =
    candlesData.slice(
      0,
      -1
    );

  const start =
    Math.max(
      1,
      closed.length -
        CONFIG.BREAKOUT_RECENT_BARS
    );

  let direction =
    null;

  let breakoutIndex =
    -1;

  let breakoutVolumeRatio =
    1;

  for (
    let i = start;
    i < closed.length;
    i++
  ) {

    const current =
      closed[i];

    const previous =
      closed[i - 1];

    const averageVolume =
      avg(
        closed
          .slice(
            Math.max(
              0,
              i - 20
            ),
            i
          )
          .map(
            candle =>
              candle.quoteVolume ||
              candle.volume
          )
      );

    const ratio =
      averageVolume > 0
        ? (
            (
              current.quoteVolume ||
              current.volume
            ) /
            averageVolume
          )
        : 1;

    if (
      current.close >
        levels.resistance &&
      previous.close <=
        levels.resistance
    ) {

      direction =
        "LONG";

      breakoutIndex =
        i;

      breakoutVolumeRatio =
        ratio;

    }

    if (
      current.close <
        levels.support &&
      previous.close >=
        levels.support
    ) {

      direction =
        "SHORT";

      breakoutIndex =
        i;

      breakoutVolumeRatio =
        ratio;

    }

  }

  let fake =
    false;

  if (
    breakoutIndex >= 0
  ) {

    const latest =
      closed[
        closed.length -
        1
      ];

    if (
      direction ===
        "LONG" &&
      latest.close <
        levels.resistance *
        (
          1 -
          CONFIG.FAKE_BREAKOUT_PERCENT /
          100
        )
    ) {

      fake = true;

    }

    if (
      direction ===
        "SHORT" &&
      latest.close >
        levels.support *
        (
          1 +
          CONFIG.FAKE_BREAKOUT_PERCENT /
          100
        )
    ) {

      fake = true;

    }

  }

  return {

    resistance:
      levels.resistance,

    support:
      levels.support,

    current:
      levels.current,

    direction,

    breakoutIndex,

    volumeRatio:
      breakoutVolumeRatio,

    fake

  };

}


/*
=========================================================
MARKET STRUCTURE
=========================================================
*/

function detectStructure(
  candlesData
) {

  if (
    !candlesData ||
    candlesData.length <
      8
  ) {

    return "YATAY";

  }

  const sample =
    candlesData.slice(
      -6
    );

  const highs =
    sample.map(
      candle =>
        candle.high
    );

  const lows =
    sample.map(
      candle =>
        candle.low
    );

  const higherHigh =
    highs[
      highs.length -
      1
    ] >
    highs[0];

  const higherLow =
    lows[
      lows.length -
      1
    ] >
    lows[0];

  const lowerHigh =
    highs[
      highs.length -
      1
    ] <
    highs[0];

  const lowerLow =
    lows[
      lows.length -
      1
    ] <
    lows[0];

  if (
    higherHigh &&
    higherLow
  ) {

    return "LONG";

  }

  if (
    lowerHigh &&
    lowerLow
  ) {

    return "SHORT";

  }

  return "YATAY";

}


/*
=========================================================
MARKET DIRECTION
=========================================================
*/

function calculateMarketDirection() {

  const btc =
    marketCache.find(
      item =>
        item.symbol ===
        "BTCUSDT"
    );

  const eth =
    marketCache.find(
      item =>
        item.symbol ===
        "ETHUSDT"
    );

  const targets =
    [
      btc,
      eth
    ].filter(Boolean);

  if (
    !targets.length
  ) {

    return {

      direction:
        "YATAY",

      label:
        "PİYASA YATAY",

      reason:
        "BTC / ETH verisi bekleniyor."

    };

  }

  let bullish =
    0;

  let bearish =
    0;

  targets.forEach(
    item => {

      if (
        item.change24h >
        0.8
      ) {

        bullish++;

      }

      if (
        item.change24h <
        -0.8
      ) {

        bearish++;

      }

    }
  );

  let direction =
    "YATAY";

  if (
    bullish >
    bearish
  ) {

    direction =
      "LONG";

  }

  if (
    bearish >
    bullish
  ) {

    direction =
      "SHORT";

  }

  return {

    direction,

    label:
      direction ===
        "LONG"
        ? "PİYASA YUKARI"
        : direction ===
            "SHORT"
          ? "PİYASA AŞAĞI"
          : "PİYASA YATAY",

    reason:
      direction ===
        "LONG"
        ? "BTC / ETH yükseliş ağırlıklı."
        : direction ===
            "SHORT"
          ? "BTC / ETH düşüş ağırlıklı."
          : "BTC / ETH yönü karışık."

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

      arr(contracts)

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

  marketCache =
    arr(tickers)

      .filter(
        ticker =>
          validSymbols.has(
            ticker.symbol
          )
      )

      .map(
        ticker => {

          const rawChange =
            Number(
              ticker.change24h ||
              0
            );

          const change24h =
            Math.abs(
              rawChange
            ) <= 1
              ? rawChange * 100
              : rawChange;

          return {

            symbol:
              ticker.symbol,

            price:
              Number(
                ticker.lastPr
              ),

            volume24h:
              Number(
                ticker.quoteVolume ||
                0
              ),

            change24h,

            high24h:
              Number(
                ticker.high24h ||
                0
              ),

            low24h:
              Number(
                ticker.low24h ||
                0
              )

          };

        }
      )

      .filter(
        item =>
          Number.isFinite(
            item.price
          ) &&
          item.volume24h >=
            CONFIG.MIN_VOLUME_USDT
      )

      .sort(
        (a, b) =>
          b.volume24h -
          a.volume24h
      )

      .slice(
        0,
        CONFIG.MARKET_LIMIT
      );

  discoveryTime =
    new Date().toISOString();

  log(
    "Discovery tamamlandı. " +
    marketCache.length +
    " uygun coin bulundu."
  );

  return marketCache;

}


/*
=========================================================
QUALITY
=========================================================
*/

function qualityLabel(
  score
) {

  if (
    score >= 90
  ) {

    return "A+ · ÇOK GÜÇLÜ";

  }

  if (
    score >= 82
  ) {

    return "A · GÜÇLÜ";

  }

  if (
    score >= 72
  ) {

    return "B · UYGUN";

  }

  return "C · ZAYIF";

}


/*
=========================================================
SIGNAL SCORE

5M MOMENTUM ARTIK GERÇEKTEN PUANA GİRİYOR.

BOLLINGER WIDTH ARTIK GERÇEKTEN
HESAPLANIYOR VE PUANA GİRİYOR.
=========================================================
*/

function calculateScore(
  data
) {

  let score =
    0;

  if (
    data.breakout4H
  ) {

    score += 25;

  }

  if (
    data.breakout2H
  ) {

    score += 15;

  }

  if (
    data.trend1H
  ) {

    score += 12;

  }

  if (
    data.retest
  ) {

    score += 14;

  }

  if (
    data.rsiOK
  ) {

    score += 8;

  }

  /*
  5M MOMENTUM
  */

  if (
    data.momentum5M
  ) {

    score += 8;

  }

  /*
  HACİM
  */

  if (
    data.volumeRatio >=
    CONFIG.VOLUME_VERY_STRONG
  ) {

    score += 8;

  } else if (
    data.volumeRatio >=
    CONFIG.VOLUME_STRONG
  ) {

    score += 5;

  } else if (
    data.volumeRatio >=
    0.90
  ) {

    score += 2;

  }

  /*
  GENEL PİYASA
  */

  if (
    data.marketDirection ===
    data.direction
  ) {

    score += 4;

  }

  /*
  BOLLINGER SQUEEZE

  Dar bant = potansiyel enerji birikimi.
  */

  if (
    data.bbWidth !== null &&
    data.bbWidth <= 4
  ) {

    score += 3;

  }

  /*
  MARKET STRUCTURE
  */

  if (
    data.structure ===
    data.direction
  ) {

    score += 3;

  }

  /*
  ORDERBOOK
  */

  if (
    data.orderbookAligned
  ) {

    score +=
      data.orderbookStrong
        ? 5
        : 3;

  }

  /*
  AŞIRI RSI CEZASI
  */

  if (
    data.rsi > 70 &&
    data.direction ===
      "LONG"
  ) {

    score -= 6;

  }

  if (
    data.rsi < 30 &&
    data.direction ===
      "SHORT"
  ) {

    score -= 6;

  }

  return Math.max(
    0,
    Math.min(
      100,
      Math.round(score)
    )
  );

}


/*
=========================================================
TRADE PLAN
=========================================================
*/

function createTradePlan(
  market,
  direction,
  level,
  rsiValue,
  score,
  volumeRatio,
  bbWidth,
  reason
) {

  const entryLow =
    direction ===
      "LONG"
      ? level * 0.998
      : level * 0.996;

  const entryHigh =
    direction ===
      "LONG"
      ? level * 1.004
      : level * 1.002;

  const stop =
    direction ===
      "LONG"
      ? level * 0.982
      : level * 1.018;

  const risk =
    Math.abs(
      level -
      stop
    );

  const tp1 =
    direction ===
      "LONG"
      ? level +
        risk * 1.5
      : level -
        risk * 1.5;

  const tp2 =
    direction ===
      "LONG"
      ? level +
        risk * 2
      : level -
        risk * 2;

  const tp3 =
    direction ===
      "LONG"
      ? level +
        risk * 3
      : level -
        risk * 3;

  return {

    id:
      market.symbol +
      ":" +
      direction +
      ":" +
      Date.now() +
      ":" +
      Math.random()
        .toString(36)
        .slice(
          2,
          7
        ),

    symbol:
      market.symbol,

    direction,

    strategy:
      "4H KIRILIM + 2H ONAY + RETEST + RSI + 5M MOMENTUM",

    score,

    quality:
      qualityLabel(
        score
      ),

    price:
      num(
        market.price,
        8
      ),

    entryLow:
      num(
        Math.min(
          entryLow,
          entryHigh
        ),
        8
      ),

    entryHigh:
      num(
        Math.max(
          entryLow,
          entryHigh
        ),
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

    rsi:
      num(
        rsiValue,
        1
      ),

    volumeRatio:
      num(
        volumeRatio,
        2
      ),

    bbWidth:
      num(
        bbWidth,
        2
      ),

    level:
      num(
        level,
        8
      ),

    change24h:
      num(
        market.change24h,
        2
      ),

    reason,

    tradingView:
      tvUrl(
        market.symbol
      ),

    createdAt:
      new Date().toISOString()

  };

}


/*
=========================================================
BUILD SIGNAL
=========================================================
*/

function buildSignal(
  market,
  context,
  marketDirection,
  orderbook
) {

  const rsiValue =
    context.rsi15;

  const directions =
    [
      "LONG",
      "SHORT"
    ];

  for (
    const direction of directions
  ) {

    const breakout4H =
      context.breakout4H.direction ===
      direction;

    const breakout2H =
      context.breakout2H.direction ===
      direction;

    const trend1H =
      context.trend1H ===
      direction;

    const level =
      direction ===
        "LONG"
        ? context.breakout4H.resistance
        : context.breakout4H.support;

    /*
    RETEST
    */

    const retest =
      direction ===
        "LONG"

        ? market.price >=
            level *
            (
              1 -
              CONFIG.RETEST_DISTANCE_PERCENT /
              100
            ) &&
          market.price <=
            level *
            (
              1 +
              CONFIG.MAX_ENTRY_DISTANCE_PERCENT /
              100
            )

        : market.price <=
            level *
            (
              1 +
              CONFIG.RETEST_DISTANCE_PERCENT /
              100
            ) &&
          market.price >=
            level *
            (
              1 -
              CONFIG.MAX_ENTRY_DISTANCE_PERCENT /
              100
            );

    /*
    15M RSI
    */

    const rsiOK =
      direction ===
        "LONG"

        ? rsiValue >=
            CONFIG.RSI_LONG_MIN &&
          rsiValue <=
            CONFIG.RSI_LONG_MAX

        : rsiValue >=
            CONFIG.RSI_SHORT_MIN &&
          rsiValue <=
            CONFIG.RSI_SHORT_MAX;

    /*
    5M MOMENTUM

    ARTIK GERÇEKTEN SİNYALE
    DAHİL.
    */

    const momentum5M =
      direction ===
        "LONG"

        ? context.trend5M ===
            "LONG" &&
          context.rsi5 >= 48 &&
          context.rsi5 <= 72

        : context.trend5M ===
            "SHORT" &&
          context.rsi5 >= 28 &&
          context.rsi5 <= 52;

    /*
    ORDERBOOK
    */

    const orderbookAligned =
      orderbook.direction ===
        "NEUTRAL" ||
      orderbook.direction ===
        direction;

    /*
    TEMEL ŞARTLAR
    */

    if (
      !breakout4H ||
      !breakout2H ||
      !trend1H ||
      !retest ||
      !rsiOK ||
      !momentum5M
    ) {

      continue;

    }

    /*
    FAKE BREAKOUT ENGELİ
    */

    if (
      context.breakout4H.fake ||
      context.breakout2H.fake
    ) {

      continue;

    }

    /*
    ORDERBOOK TERS İSE ENGEL
    */

    if (
      !orderbookAligned
    ) {

      continue;

    }

    const score =
      calculateScore({

        breakout4H,

        breakout2H,

        trend1H,

        retest,

        rsiOK,

        momentum5M,

        volumeRatio:
          context.volumeRatio,

        marketDirection:
          marketDirection.direction,

        direction,

        bbWidth:
          context.bbWidth,

        structure:
          context.structure1H,

        rsi:
          rsiValue,

        orderbookAligned:
          orderbook.direction ===
          direction,

        orderbookStrong:
          orderbook.ratio >=
          CONFIG.ORDERBOOK_STRONG

      });

    if (
      score <
      CONFIG.MIN_SIGNAL_SCORE
    ) {

      continue;

    }

    const reason =
      (
        direction ===
          "LONG"
          ? "4H direnç kırılımı"
          : "4H destek kırılımı"
      ) +
      " + 2H onay + 1H trend + retest + 15M RSI + 5M momentum + hacim.";

    return createTradePlan(

      market,

      direction,

      level,

      rsiValue,

      score,

      context.volumeRatio,

      context.bbWidth,

      reason

    );

  }

  return null;

}


/*
=========================================================
PREPARING
=========================================================
*/

function buildPreparing(
  market,
  context
) {

  const candidates =
    [];

  const longDistance =
    pct(
      context.breakout4H.resistance -
      market.price,
      market.price
    );

  const shortDistance =
    pct(
      market.price -
      context.breakout4H.support,
      market.price
    );

  /*
  LONG
  */

  if (
    longDistance >=
      0 &&
    longDistance <=
      1.2 &&
    context.trend1H ===
      "LONG" &&
    context.rsi15 >=
      45 &&
    context.rsi15 <=
      68
  ) {

    candidates.push({

      symbol:
        market.symbol,

      direction:
        "LONG",

      price:
        num(
          market.price,
          8
        ),

      trigger:
        num(
          context.breakout4H.resistance,
          8
        ),

      distance:
        num(
          longDistance,
          3
        ),

      rsi:
        num(
          context.rsi15,
          1
        ),

      tradingView:
        tvUrl(
          market.symbol
        ),

      reason:
        "4H direnç yaklaşıyor; 2H onay ve 5M momentum bekleniyor."

    });

  }

  /*
  SHORT
  */

  if (
    shortDistance >=
      0 &&
    shortDistance <=
      1.2 &&
    context.trend1H ===
      "SHORT" &&
    context.rsi15 >=
      32 &&
    context.rsi15 <=
      55
  ) {

    candidates.push({

      symbol:
        market.symbol,

      direction:
        "SHORT",

      price:
        num(
          market.price,
          8
        ),

      trigger:
        num(
          context.breakout4H.support,
          8
        ),

      distance:
        num(
          shortDistance,
          3
        ),

      rsi:
        num(
          context.rsi15,
          1
        ),

      tradingView:
        tvUrl(
          market.symbol
        ),

      reason:
        "4H destek yaklaşıyor; 2H onay ve 5M momentum bekleniyor."

    });

  }

  candidates.sort(
    (
      a,
      b
    ) =>
      a.distance -
      b.distance
  );

  return (
    candidates[0] ||
    null
  );

}


/*
=========================================================
COIN ANALYSIS

5 TIMEFRAME:

4H
2H
1H
15M
5M
=========================================================
*/

async function analyzeCoin(
  market,
  marketDirection
) {

  try {

    const [
      candles4H,
      candles2H,
      candles1H,
      candles15M,
      candles5M
    ] =
      await Promise.all([

        candles(
          market.symbol,
          "4H",
          CONFIG.FOUR_HOUR_LIMIT
        ),

        candles(
          market.symbol,
          "2H",
          CONFIG.TWO_HOUR_LIMIT
        ),

        candles(
          market.symbol,
          "1H",
          CONFIG.ONE_HOUR_LIMIT
        ),

        candles(
          market.symbol,
          "15m",
          CONFIG.FIFTEEN_MIN_LIMIT
        ),

        candles(
          market.symbol,
          "5m",
          CONFIG.FIVE_MIN_LIMIT
        )

      ]);

    if (
      candles4H.length <
        50 ||
      candles2H.length <
        50 ||
      candles1H.length <
        60 ||
      candles15M.length <
        60 ||
      candles5M.length <
        60
    ) {

      return null;

    }

    const breakout4H =
      detectBreakout(
        candles4H,
        CONFIG.LEVEL_LOOKBACK_4H
      );

    const breakout2H =
      detectBreakout(
        candles2H,
        CONFIG.LEVEL_LOOKBACK_2H
      );

    if (
      !breakout4H ||
      !breakout2H
    ) {

      return null;

    }

    /*
    1H TREND
    */

    const closed1H =
      candles1H.slice(
        0,
        -1
      );

    const closes1H =
      closed1H.map(
        candle =>
          candle.close
      );

    const ema20 =
      ema(
        closes1H,
        20
      );

    const ema50 =
      ema(
        closes1H,
        50
      );

    let trend1H =
      "YATAY";

    if (
      ema20 >
      ema50
    ) {

      trend1H =
        "LONG";

    }

    if (
      ema20 <
      ema50
    ) {

      trend1H =
        "SHORT";

    }

    /*
    1H STRUCTURE
    */

    const structure1H =
      detectStructure(
        closed1H
      );

    /*
    15M RSI
    */

    const closed15M =
      candles15M.slice(
        0,
        -1
      );

    const rsi15 =
      rsi(
        closed15M.map(
          candle =>
            candle.close
        ),
        CONFIG.RSI_PERIOD
      );

    /*
    5M
    */

    const closed5M =
      candles5M.slice(
        0,
        -1
      );

    const closes5M =
      closed5M.map(
        candle =>
          candle.close
      );

    const ema5_9 =
      ema(
        closes5M,
        9
      );

    const ema5_20 =
      ema(
        closes5M,
        20
      );

    const rsi5 =
      rsi(
        closes5M,
        CONFIG.RSI_PERIOD
      );

    let trend5M =
      "YATAY";

    if (
      ema5_9 >
      ema5_20
    ) {

      trend5M =
        "LONG";

    }

    if (
      ema5_9 <
      ema5_20
    ) {

      trend5M =
        "SHORT";

    }

    /*
    BOLLINGER

    BURASI V6'DA EKSİKTİ.
    ARTIK GERÇEKTEN HESAPLANIYOR.
    */

    const bb4H =
      bollinger(
        candles4H.slice(
          0,
          -1
        )
      );

    const bbWidth =
      bb4H
        ? bb4H.width
        : null;

    /*
    HACİM

    4H + 2H + 1H + 15M + 5M
    */

    const volumeRatioValue =
      Math.max(

        breakout4H.volumeRatio ||
          1,

        breakout2H.volumeRatio ||
          1,

        volumeRatio(
          candles1H
        ),

        volumeRatio(
          candles15M
        ),

        volumeRatio(
          candles5M
        )

      );

    const context = {

      breakout4H,

      breakout2H,

      trend1H,

      structure1H,

      rsi15,

      trend5M,

      rsi5,

      bbWidth,

      volumeRatio:
        volumeRatioValue

    };

    /*
    İlk etapta orderbook neutral.
    Güçlü adaylar daha sonra orderbook'a gider.
    */

    const neutralOrderbook = {

      ratio:
        1,

      direction:
        "NEUTRAL"

    };

    const signal =
      buildSignal(
        market,
        context,
        marketDirection,
        neutralOrderbook
      );

    if (
      signal
    ) {

      return {

        type:
          "SIGNAL",

        signal

      };

    }

    const preparing =
      buildPreparing(
        market,
        context
      );

    if (
      preparing
    ) {

      return {

        type:
          "PREPARING",

        preparing

      };

    }

    return null;

  } catch (error) {

    log(
      "Analiz hatası " +
      market.symbol +
      ": " +
      error.message
    );

    return null;

  }

}


/*
=========================================================
ORDERBOOK
=========================================================
*/

async function getOrderbook(
  symbol
) {

  try {

    const data =
      await bitget(
        "/api/v2/mix/market/orderbook",
        {

          symbol,

          productType:
            PRODUCT_TYPE,

          limit:
            CONFIG.ORDERBOOK_DEPTH

        }
      );

    const bids =
      arr(
        data?.bids
      )

        .map(
          row =>
            [
              Number(row[0]),
              Number(row[1])
            ]
        )

        .filter(
          row =>
            row[0] > 0 &&
            row[1] > 0
        );

    const asks =
      arr(
        data?.asks
      )

        .map(
          row =>
            [
              Number(row[0]),
              Number(row[1])
            ]
        )

        .filter(
          row =>
            row[0] > 0 &&
            row[1] > 0
        );

    const bidUsd =
      bids.reduce(
        (
          sum,
          row
        ) =>
          sum +
          row[0] *
          row[1],
        0
      );

    const askUsd =
      asks.reduce(
        (
          sum,
          row
        ) =>
          sum +
          row[0] *
          row[1],
        0
      );

    const ratio =
      askUsd > 0
        ? bidUsd /
          askUsd
        : 1;

    let direction =
      "NEUTRAL";

    if (
      ratio >=
      CONFIG.ORDERBOOK_MIN
    ) {

      direction =
        "LONG";

    }

    if (
      ratio <=
      1 /
      CONFIG.ORDERBOOK_MIN
    ) {

      direction =
        "SHORT";

    }

    return {

      ratio:
        num(
          ratio,
          2
        ),

      direction,

      bidUsd:
        num(
          bidUsd,
          0
        ),

      askUsd:
        num(
          askUsd,
          0
        )

    };

  } catch (error) {

    return {

      ratio:
        1,

      direction:
        "NEUTRAL",

      error:
        error.message

    };

  }

}


/*
=========================================================
SIGNAL LIFECYCLE
=========================================================

WAITING
↓
ACTIVE
↓
TP1 / TP2 / TP3 / STOP

WAITING
↓
MISSED / INVALID
=========================================================
*/

function isInsideEntry(
  signal,
  price
) {

  return (

    price >=
      Number(
        signal.entryLow
      ) &&

    price <=
      Number(
        signal.entryHigh
      )

  );

}


function moveToHistory(
  key,
  signal,
  result,
  reason,
  realizedR = 0
) {

  activeSignals.delete(
    key
  );

  const item = {

    ...signal,

    result,

    status:
      result,

    closedAt:
      new Date().toISOString(),

    reason,

    realizedR:
      num(
        realizedR,
        2
      ),

    entryPrice:
      signal.entryPrice
        ? num(
            signal.entryPrice,
            8
          )
        : 0,

    tp1Hit:
      Boolean(
        signal.tp1Hit
      ),

    tp2Hit:
      Boolean(
        signal.tp2Hit
      ),

    tp3Hit:
      Boolean(
        signal.tp3Hit
      ),

    tradingView:
      tvUrl(
        signal.symbol
      )

  };

  if (
    result ===
      "MISSED" ||
    result ===
      "INVALID"
  ) {

    missedSignals.unshift(
      item
    );

    while (
      missedSignals.length >
      CONFIG.MAX_MISSED
    ) {

      missedSignals.pop();

    }

    cooldowns.set(

      key,

      Date.now() +
      CONFIG.MISSED_COOLDOWN_MS

    );

  }

  addHistory(
    item
  );

  log(
    "SIGNAL " +
    signal.symbol +
    " " +
    signal.direction +
    " -> " +
    result +
    " | " +
    reason
  );

}


function updateSignal(
  signal,
  livePrice
) {

  const next = {

    ...signal,

    price:
      num(
        livePrice,
        8
      )

  };

  /*
  Henüz giriş olmadı.
  */

  if (
    !next.entered
  ) {

    /*
    GİRİŞ BÖLGESİNE GİRDİ
    */

    if (
      isInsideEntry(
        next,
        livePrice
      )
    ) {

      next.entered =
        true;

      next.status =
        "ACTIVE";

      next.entryPrice =
        livePrice;

      next.enteredAt =
        new Date().toISOString();

      return next;

    }

    /*
    LONG KAÇTI
    */

    if (
      next.direction ===
      "LONG"
    ) {

      if (
        livePrice >
        Number(
          next.entryHigh
        ) *
        (
          1 +
          CONFIG.MISSED_BUFFER_PERCENT /
          100
        )
      ) {

        return {

          ...next,

          lifecycleResult:
            "MISSED",

          lifecycleReason:
            "Giriş bölgesi yukarıda kaldı; fırsat kaçtı."

        };

      }

      /*
      Giriş olmadan TP1'e gitti.
      */

      if (
        livePrice >=
        Number(
          next.tp1
        )
      ) {

        return {

          ...next,

          lifecycleResult:
            "MISSED",

          lifecycleReason:
            "Fiyat giriş yapılmadan TP1 seviyesini geçti; fırsat kaçtı."

        };

      }

      /*
      Giriş olmadan stop.
      */

      if (
        livePrice <=
        Number(
          next.stop
        )
      ) {

        return {

          ...next,

          lifecycleResult:
            "INVALID",

          lifecycleReason:
            "Giriş gerçekleşmeden yapı bozuldu."

        };

      }

    }

    /*
    SHORT KAÇTI
    */

    else {

      if (
        livePrice <
        Number(
          next.entryLow
        ) *
        (
          1 -
          CONFIG.MISSED_BUFFER_PERCENT /
          100
        )
      ) {

        return {

          ...next,

          lifecycleResult:
            "MISSED",

          lifecycleReason:
            "Giriş bölgesi aşağıda kaldı; fırsat kaçtı."

        };

      }

      if (
        livePrice <=
        Number(
          next.tp1
        )
      ) {

        return {

          ...next,

          lifecycleResult:
            "MISSED",

          lifecycleReason:
            "Fiyat giriş yapılmadan TP1 seviyesini geçti; fırsat kaçtı."

        };

      }

      if (
        livePrice >=
        Number(
          next.stop
        )
      ) {

        return {

          ...next,

          lifecycleResult:
            "INVALID",

          lifecycleReason:
            "Giriş gerçekleşmeden yapı bozuldu."

        };

      }

    }

    return next;

  }


  /*
  GİRİŞ GERÇEKLEŞTİ.
  */

  if (
    next.direction ===
    "LONG"
  ) {

    if (
      livePrice >=
      Number(
        next.tp1
      )
    ) {

      next.tp1Hit =
        true;

    }

    if (
      livePrice >=
      Number(
        next.tp2
      )
    ) {

      next.tp2Hit =
        true;

    }

    if (
      livePrice >=
      Number(
        next.tp3
      )
    ) {

      next.tp3Hit =
        true;

    }

    if (
      livePrice <=
      Number(
        next.stop
      )
    ) {

      return {

        ...next,

        lifecycleResult:
          "STOP",

        lifecycleReason:
          next.tp1Hit
            ? "TP1 görüldü, ardından stop geldi."
            : "Stop seviyesi görüldü.",

        realizedR:
          next.tp1Hit
            ? 1.5
            : -1

      };

    }

    if (
      next.tp3Hit
    ) {

      return {

        ...next,

        lifecycleResult:
          "TP3",

        lifecycleReason:
          "TP3 görüldü.",

        realizedR:
          3

      };

    }

  }

  else {

    if (
      livePrice <=
      Number(
        next.tp1
      )
    ) {

      next.tp1Hit =
        true;

    }

    if (
      livePrice <=
      Number(
        next.tp2
      )
    ) {

      next.tp2Hit =
        true;

    }

    if (
      livePrice <=
      Number(
        next.tp3
      )
    ) {

      next.tp3Hit =
        true;

    }

    if (
      livePrice >=
      Number(
        next.stop
      )
    ) {

      return {

        ...next,

        lifecycleResult:
          "STOP",

        lifecycleReason:
          next.tp1Hit
            ? "TP1 görüldü, ardından stop geldi."
            : "Stop seviyesi görüldü.",

        realizedR:
          next.tp1Hit
            ? 1.5
            : -1

      };

    }

    if (
      next.tp3Hit
    ) {

      return {

        ...next,

        lifecycleResult:
          "TP3",

        lifecycleReason:
          "TP3 görüldü.",

        realizedR:
          3

      };

    }

  }

  next.status =
    "ACTIVE";

  return next;

}


/*
=========================================================
SYNC ACTIVE SIGNALS
=========================================================
*/

function syncActiveSignals(
  newSignals,
  priceMap
) {

  const now =
    Date.now();

  /*
  Yeni sinyaller
  */

  for (
    const signal of newSignals
  ) {

    const key =
      signalKey(
        signal
      );

    const cooldownUntil =
      cooldowns.get(
        key
      ) || 0;

    if (
      cooldownUntil >
      now
    ) {

      continue;

    }

    if (
      cooldownUntil &&
      cooldownUntil <=
        now
    ) {

      cooldowns.delete(
        key
      );

    }

    const previous =
      activeSignals.get(
        key
      );

    if (
      previous
    ) {

      activeSignals.set(
        key,
        {

          ...previous,

          score:
            signal.score,

          quality:
            signal.quality,

          price:
            signal.price,

          rsi:
            signal.rsi,

          volumeRatio:
            signal.volumeRatio,

          bbWidth:
            signal.bbWidth,

          reason:
            signal.reason,

          entryLow:
            signal.entryLow,

          entryHigh:
            signal.entryHigh,

          stop:
            signal.stop,

          tp1:
            signal.tp1,

          tp2:
            signal.tp2,

          tp3:
            signal.tp3,

          tradingView:
            signal.tradingView

        }
      );

    } else {

      activeSignals.set(
        key,
        {

          ...signal,

          status:
            "WAITING",

          entered:
            false,

          tp1Hit:
            false,

          tp2Hit:
            false,

          tp3Hit:
            false

        }
      );

    }

  }

  /*
  Tüm aktif sinyalleri
  canlı fiyatla kontrol et.
  */

  for (
    const [
      key,
      signal
    ]
    of Array.from(
      activeSignals.entries()
    )
  ) {

    const livePrice =
      priceMap.get(
        signal.symbol
      );

    if (
      !Number.isFinite(
        livePrice
      )
    ) {

      continue;

    }

    const updated =
      updateSignal(
        signal,
        livePrice
      );

    if (
      updated.lifecycleResult
    ) {

      moveToHistory(

        key,

        updated,

        updated.lifecycleResult,

        updated.lifecycleReason ||
          "Sinyal tamamlandı.",

        Number(
          updated.realizedR ||
          0
        )

      );

      continue;

    }

    activeSignals.set(
      key,
      updated
    );

  }

  return Array.from(
    activeSignals.values()
  )
    .sort(
      (a, b) =>
        b.score -
        a.score
    )
    .slice(
      0,
      CONFIG.MAX_SIGNALS
    );

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

    return cachedResult;

  }

  scanRunning =
    true;

  lastError =
    null;

  const started =
    Date.now();

  try {

    await discoverMarket();

    const marketDirection =
      calculateMarketDirection();

    /*
    HIZLI RADAR

    Tüm universe içinden
    en hareketli / likit adayları seç.
    */

    const fastCandidates =
      marketCache

        .map(
          item => ({

            ...item,

            hotScore:
              Math.abs(
                item.change24h
              ) *
              5 +

              Math.log10(
                Math.max(
                  item.volume24h,
                  1
                )
              ) +

              (
                Math.abs(
                  item.change24h
                ) >= 3
                  ? 15
                  : 0
              )

          })
        )

        .sort(
          (a, b) =>
            b.hotScore -
            a.hotScore
        )

        .slice(
          0,
          CONFIG.FAST_RADAR_LIMIT
        );

    /*
    DERİN ANALİZ

    V6.1'de 180 coin.
    */

    const candidates =
      fastCandidates.slice(
        0,
        CONFIG.ANALYZE_LIMIT
      );

    const rawSignals =
      [];

    const preparing =
      [];

    log(
      "Radar başladı. " +
      "Universe=" +
      marketCache.length +
      ", FastRadar=" +
      fastCandidates.length +
      ", OHLCV=" +
      candidates.length
    );

    /*
    BATCH ANALİZ
    */

    for (
      let i = 0;
      i < candidates.length;
      i +=
        CONFIG.BATCH_SIZE
    ) {

      const batch =
        candidates.slice(
          i,
          i +
            CONFIG.BATCH_SIZE
        );

      const results =
        await Promise.all(

          batch.map(
            coin =>
              analyzeCoin(
                coin,
                marketDirection
              )
          )

        );

      for (
        const result
        of results
      ) {

        if (
          !result
        ) {

          continue;

        }

        if (
          result.type ===
          "SIGNAL"
        ) {

          rawSignals.push(
            result.signal
          );

        }

        if (
          result.type ===
          "PREPARING"
        ) {

          preparing.push(
            result.preparing
          );

        }

      }

      await sleep(
        CONFIG.BATCH_DELAY_MS
      );

    }

    /*
    Güçlü adayları sırala.
    */

    rawSignals.sort(
      (a, b) =>
        b.score -
        a.score
    );

    /*
    ORDERBOOK

    Sadece en güçlü adaylara.
    */

    const orderbookCandidates =
      rawSignals.slice(
        0,
        CONFIG.ORDERBOOK_LIMIT
      );

    const confirmedSignals =
      [];

    for (
      const signal
      of orderbookCandidates
    ) {

      const orderbook =
        await getOrderbook(
          signal.symbol
        );

      /*
      Ters orderbook varsa
      sinyali ele.
      */

      if (
        orderbook.direction !==
          "NEUTRAL" &&
        orderbook.direction !==
          signal.direction
      ) {

        continue;

      }

      signal.orderbook =
        orderbook;

      if (
        orderbook.direction ===
        signal.direction
      ) {

        signal.score =
          Math.min(
            100,

            signal.score +
            (
              orderbook.ratio >=
              CONFIG.ORDERBOOK_STRONG
                ? 5
                : 3
            )
          );

        signal.quality =
          qualityLabel(
            signal.score
          );

      }

      confirmedSignals.push(
        signal
      );

      await sleep(
        30
      );

    }

    /*
    EN İYİ SİNYALLER
    */

    confirmedSignals.sort(
      (a, b) =>
        b.score -
        a.score
    );

    const prices =
      new Map(
        marketCache.map(
          item =>
            [
              item.symbol,
              item.price
            ]
        )
      );

    const finalSignals =
      syncActiveSignals(

        confirmedSignals.slice(
          0,
          CONFIG.MAX_SIGNALS
        ),

        prices

      );

    /*
    PREPARING

    Tek coin/yön.
    */

    const uniquePreparing =
      new Map();

    preparing

      .sort(
        (a, b) =>
          a.distance -
          b.distance
      )

      .forEach(
        item => {

          uniquePreparing.set(

            item.symbol +
            ":" +
            item.direction,

            item

          );

        }
      );

    const finalPreparing =
      Array.from(
        uniquePreparing.values()
      )
      .slice(
        0,
        CONFIG.MAX_PREPARING
      );

    const elapsed =
      (
        Date.now() -
        started
      ) /
      1000;

    /*
    SONUÇ
    */

    cachedResult = {

      success:
        true,

      system:
        SYSTEM_NAME,

      timestamp:
        new Date().toISOString(),

      market:
        marketDirection,

      strategy:
        "4H BREAKOUT + 2H CONFIRMATION + 1H TREND + RETEST + 15M RSI + 5M MOMENTUM + VOLUME + BOLLINGER + ORDERBOOK",

      stats: {

        market:
          marketCache.length,

        fastRadar:
          fastCandidates.length,

        analyzed:
          candidates.length,

        signals:
          finalSignals.length,

        preparing:
          finalPreparing.length,

        duration:
          num(
            elapsed,
            1
          )

      },

      signals:
        finalSignals,

      missed:
        missedSignals.slice(
          0,
          CONFIG.MAX_MISSED
        ),

      preparing:
        finalPreparing,

      performance:
        performance(),

      mode:
        "MANUAL SIGNAL ONLY"

    };

    lastScan =
      cachedResult.timestamp;

    log(
      "RADAR tamamlandı | " +
      "Universe=" +
      marketCache.length +
      " | OHLCV=" +
      candidates.length +
      " | SIGNAL=" +
      finalSignals.length +
      " | MISSED=" +
      missedSignals.length +
      " | PREPARING=" +
      finalPreparing.length
    );

    return cachedResult;

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
        error.message,

      system:
        SYSTEM_NAME

    };

  } finally {

    scanRunning =
      false;

  }

}


/*
=========================================================
HTML

BURADA BACKTICK KULLANILMIYOR.

Önceki "Unexpected token class" hatasının
önüne geçiyoruz.
=========================================================
*/

function createHTML() {

  return [

    "<!doctype html>",

    '<html lang="tr">',

    "<head>",

    '<meta charset="utf-8">',

    '<meta name="viewport" content="width=device-width,initial-scale=1">',

    "<title>Sonny AI Signal Scanner V6.1</title>",

    "<style>",

    "*{box-sizing:border-box}",

    "body{margin:0;background:#080b12;color:#f5f7fb;font-family:Arial,Helvetica,sans-serif}",

    ".wrap{width:min(1180px,94%);margin:22px auto 50px}",

    ".top{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}",

    ".title{font-size:27px;font-weight:900}",

    ".sub,.desc,.muted{color:#7d8799}",

    ".online{padding:8px 13px;border-radius:20px;background:#0d2118;color:#43e58b;border:1px solid #174d31;font-weight:800}",

    ".market,.panel,.stat{background:#111722;border:1px solid #202b3b;border-radius:14px}",

    ".market{padding:18px;margin-bottom:14px}",

    ".label{color:#738096;font-size:10px;font-weight:800;letter-spacing:1px;text-transform:uppercase}",

    ".marketdir{font-size:27px;font-weight:900;margin-top:5px}",

    ".stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px}",

    ".stat{padding:14px}",

    ".val{font-size:20px;font-weight:900;margin-top:6px}",

    ".panel{padding:17px;margin-bottom:14px}",

    ".panel h2{font-size:18px;margin:0 0 5px}",

    ".desc{font-size:12px;margin-bottom:14px}",

    ".signal-card{background:#0c121d;border:1px solid #26354a;border-radius:13px;padding:15px;margin-bottom:10px}",

    ".topline{display:flex;justify-content:space-between;align-items:center}",

    ".coin{font-size:19px;font-weight:900;text-decoration:none}",

    ".long{color:#45e58d}",

    ".short{color:#ff647a}",

    ".score{background:#1c2635;padding:6px 9px;border-radius:7px;font-size:11px;font-weight:900}",

    ".strategy{margin-top:7px;color:#9ba7ba;font-size:12px}",

    ".plan{display:grid;grid-template-columns:repeat(5,1fr);gap:7px;margin-top:12px}",

    ".box{background:#151d2a;border-radius:8px;padding:9px}",

    ".box small{color:#68758a;display:block;font-size:9px}",

    ".box b{display:block;margin-top:4px;font-size:12px}",

    ".reason{margin-top:12px;padding:10px;border-radius:8px;background:#121a27;color:#a8b3c5;font-size:11px}",

    ".tv{display:inline-block;margin-top:11px;padding:8px 11px;background:#e9edf4;color:#0b1018;text-decoration:none;border-radius:8px;font-size:11px;font-weight:900}",

    ".prepare{display:flex;justify-content:space-between;padding:12px;border-bottom:1px solid #202a39}",

    ".prepare:last-child{border-bottom:0}",

    ".missed{background:#17131a;border:1px solid #3b2b3f;border-radius:9px;padding:11px;margin-bottom:8px}",

    ".performance{display:grid;grid-template-columns:repeat(5,1fr);gap:8px}",

    ".hidden{display:none}",

    ".history{display:grid;grid-template-columns:1.1fr .7fr .9fr .9fr .7fr;gap:6px;padding:8px 0;border-bottom:1px solid #202a39;font-size:11px}",

    "@media(max-width:800px){.stats,.performance{grid-template-columns:repeat(2,1fr)}.plan{grid-template-columns:repeat(2,1fr)}.top{display:block}.online{display:inline-block;margin-top:10px}.history{grid-template-columns:1fr 1fr 1fr}}",

    "</style>",

    "</head>",

    "<body>",

    '<div class="wrap">',

    '<div class="top">',

    "<div>",

    '<div class="title">🚀 Sonny AI Signal Scanner V6.1</div>',

    '<div class="sub">4H Kırılım · 2H Onay · 1H Trend · Retest · 15M RSI · 5M Momentum · Hacim · Bollinger · Orderbook</div>',

    "</div>",

    '<div class="online">● SÜREKLİ AKTİF</div>',

    "</div>",

    '<div class="market">',

    '<div class="label">GENEL PİYASA DURUMU</div>',

    '<div id="marketDirection" class="marketdir">VERİ BEKLENİYOR</div>',

    '<div id="marketReason" class="desc">Piyasa hesaplanıyor...</div>',

    "</div>",

    '<div class="stats">',

    '<div class="stat"><div class="label">Piyasa</div><div id="marketCount" class="val">-</div></div>',

    '<div class="stat"><div class="label">Derin Analiz</div><div id="analyzed" class="val">-</div></div>',

    '<div class="stat"><div class="label">Aktif Sinyal</div><div id="signalCount" class="val">0</div></div>',

    '<div class="stat"><div class="label">Son Tarama</div><div id="lastScan" class="val">-</div></div>',

    "</div>",

    '<div class="panel">',

    "<h2>🚨 AKTİF SİNYALLER</h2>",

    '<div class="desc">Giriş fırsatı devam eden sinyaller burada görünür. Fiyatlar canlı güncellenir.</div>',

    '<div id="signals"><div class="muted">Sistem tarama yapıyor...</div></div>',

    "</div>",

    '<div id="missedPanel" class="panel hidden">',

    "<h2>⚠️ KAÇAN / GEÇERSİZ</h2>",

    '<div class="desc">Giriş yapılmadan fırsatı geçen veya yapısı bozulan sinyaller.</div>',

    '<div id="missed"></div>',

    "</div>",

    '<div class="panel">',

    "<h2>🟡 HAZIRLANAN FIRSATLAR</h2>",

    '<div class="desc">Kırılıma yaklaşan en iyi adaylar. Şartlar tamamlanınca aktif sinyale dönüşür.</div>',

    '<div id="preparing"><div class="muted">Şu anda hazırlanan güçlü fırsat yok.</div></div>',

    "</div>",

    '<div class="panel">',

    "<h2>📊 GERÇEK PERFORMANS · SON 50</h2>",

    '<div class="desc">Performans yalnızca giriş yapılmış ve sonucu belli olmuş sinyallerden hesaplanır.</div>',

    '<div class="performance">',

    '<div class="box"><small>TP1 BAŞARI</small><b id="tp1Rate">0%</b></div>',

    '<div class="box"><small>STOP</small><b id="stopRate">0%</b></div>',

    '<div class="box"><small>TOPLAM R</small><b id="totalR">0R</b></div>',

    '<div class="box"><small>ÇÖZÜLEN</small><b id="resolved">0</b></div>',

    '<div class="box"><small>KAÇAN</small><b id="missedCount">0</b></div>',

    "</div>",

    '<div id="historyRows"></div>',

    "</div>",

    '<div class="panel">',

    "<h2>🧠 Sonny nasıl karar veriyor?</h2>",

    '<div class="desc">',

    "<b>1.</b> 4H destek/direnç bulunur.<br><br>",

    "<b>2.</b> 4H gerçek kapanış kırılımı aranır.<br><br>",

    "<b>3.</b> 2H aynı yönde onay verir.<br><br>",

    "<b>4.</b> Kırılan seviye retest edilir.<br><br>",

    "<b>5.</b> 1H trend yönü doğrular.<br><br>",

    "<b>6.</b> 15M RSI giriş zamanını kontrol eder.<br><br>",

    "<b>7.</b> 5M momentum giriş hızını kontrol eder.<br><br>",

    "<b>8.</b> Hacim ve Bollinger sıkışması sinyal kalitesini etkiler.<br><br>",

    "<b>9.</b> Güçlü adaylarda orderbook kontrol edilir.<br><br>",

    "<b>10.</b> Sinyal canlı fiyatla takip edilir; giriş fırsatı kaçarsa aktif bölümden çıkar.<br><br>",

    "<b>11.</b> Sonuçlar kaydedilir ve gerçek performans hesaplanır.",

    "</div>",

    "</div>",

    '<div id="status" class="muted">Sistem başlatılıyor...</div>',

    "</div>",

    "<script>",

    "function formatPrice(value){",

    "value=Number(value);",

    "if(!Number.isFinite(value))return '-';",

    "if(value>=100)return value.toFixed(2);",

    "if(value>=1)return value.toFixed(4);",

    "if(value>=0.01)return value.toFixed(6);",

    "return value.toFixed(8);",

    "}",

    "",

    "function renderSignals(items){",

    "const box=document.getElementById('signals');",

    "if(!items||!items.length){",

    "box.innerHTML='<div class=\"muted\">Aktif sinyal yok. Sonny yeni fırsat arıyor.</div>';",

    "return;",

    "}",

    "",

    "box.innerHTML=items.map(function(x){",

    "const directionClass=x.direction==='LONG'?'long':'short';",

    "return '<div class=\"signal-card\">'+",

    "'<div class=\"topline\">'+",

    "'<a class=\"coin '+directionClass+'\" href=\"'+x.tradingView+'\" target=\"_blank\" rel=\"noopener\">'+x.symbol+' · '+x.direction+'</a>'+",

    "'<div class=\"score\">'+x.score+'/100</div>'+",

    "</div>"+

    "'<div class=\"strategy\">'+x.strategy+' · Anlık: <b>'+formatPrice(x.price)+'</b> · RSI: <b>'+x.rsi+'</b> · 5M momentum: <b>'+x.volumeRatio+'x</b></div>'+",

    "'<div class=\"plan\">'+",

    "'<div class=\"box\"><small>GİRİŞ</small><b>'+formatPrice(x.entryLow)+' - '+formatPrice(x.entryHigh)+'</b></div>'+",

    "'<div class=\"box\"><small>STOP</small><b>'+formatPrice(x.stop)+'</b></div>'+",

    "'<div class=\"box\"><small>TP1</small><b>'+formatPrice(x.tp1)+'</b></div>'+",

    "'<div class=\"box\"><small>TP2</small><b>'+formatPrice(x.tp2)+'</b></div>'+",

    "'<div class=\"box\"><small>TP3</small><b>'+formatPrice(x.tp3)+'</b></div>'+"+

    "</div>"+

    "'<div class=\"reason\">'+",

    "(x.entered?'🟢 GİRİŞ BÖLGESİNE GİRDİ':'🟡 GİRİŞ BEKLENİYOR')+'<br>'+x.reason+",

    "'</div>"+

    "'<a class=\"tv\" href=\"'+x.tradingView+'\" target=\"_blank\" rel=\"noopener\">📊 TRADINGVIEW AÇ</a>'+",

    "</div>";

    "}).join('');",

    "}",

    "",

    "function renderMissed(items){",

    "const panel=document.getElementById('missedPanel');",

    "const box=document.getElementById('missed');",

    "if(!items||!items.length){",

    "panel.classList.add('hidden');",

    "return;",

    "}",

    "panel.classList.remove('hidden');",

    "box.innerHTML=items.map(function(x){",

    "return '<div class=\"missed\"><b>'+x.symbol+' · '+x.direction+' · '+x.result+'</b><br><span class=\"muted\">'+(x.reason||'Giriş fırsatı kaçtı.')+'</span></div>';",

    "}).join('');",

    "}",

    "",

    "function renderPreparing(items){",

    "const box=document.getElementById('preparing');",

    "if(!items||!items.length){",

    "box.innerHTML='<div class=\"muted\">Şu anda hazırlanan güçlü fırsat yok.</div>';",

    "return;",

    "}",

    "box.innerHTML=items.map(function(x){",

    "const c=x.direction==='LONG'?'long':'short';",

    "return '<div class=\"prepare\">'+",

    "'<div><a class=\"'+c+'\" href=\"'+x.tradingView+'\" target=\"_blank\" rel=\"noopener\"><b>'+x.symbol+' · '+x.direction+'</b></a><div class=\"muted\">Anlık: '+formatPrice(x.price)+' · RSI: '+x.rsi+'</div></div>'+",

    "'<div><b>Tetik: '+formatPrice(x.trigger)+'</b><div class=\"muted\">%'+x.distance+' uzakta</div></div>'+"+

    "'</div>';",

    "}).join('');",

    "}",

    "",

    "function renderPerformance(p){",

    "if(!p)return;",

    "document.getElementById('tp1Rate').textContent=p.tp1Rate+'%';",

    "document.getElementById('stopRate').textContent=p.stopRate+'%';",

    "document.getElementById('totalR').textContent=p.totalR+'R';",

    "document.getElementById('resolved').textContent=p.resolved;",

    "document.getElementById('missedCount').textContent=p.missed;",

    "const box=document.getElementById('historyRows');",

    "if(!p.items||!p.items.length){",

    "box.innerHTML='<div class=\"muted\" style=\"margin-top:12px\">Henüz geçmiş sinyal yok.</div>';",

    "return;",

    "}",

    "box.innerHTML=p.items.slice(0,10).map(function(x){",

    "return '<div class=\"history\"><div>'+x.symbol+'</div><div>'+x.direction+'</div><div>'+x.result+'</div><div>'+formatPrice(x.entryPrice)+'</div><div>'+Number(x.realizedR||0).toFixed(2)+'R</div></div>';",

    "}).join('');",

    "}",

    "",

    "function updateDashboard(data){",

    "if(!data)return;",

    "document.getElementById('marketDirection').textContent=data.market?data.market.label:'PİYASA YATAY';",

    "document.getElementById('marketReason').textContent=data.market?data.market.reason:'';",

    "if(data.stats){",

    "document.getElementById('marketCount').textContent=data.stats.market;",

    "document.getElementById('analyzed').textContent=data.stats.analyzed;",

    "document.getElementById('signalCount').textContent=data.stats.signals;",

    "}",

    "if(data.timestamp){",

    "document.getElementById('lastScan').textContent=new Date(data.timestamp).toLocaleTimeString('tr-TR');",

    "}",

    "renderSignals(data.signals);",

    "renderMissed(data.missed);",

    "renderPreparing(data.preparing);",

    "renderPerformance(data.performance);",

    "}",

    "",

    "async function loadResult(){",

    "try{",

    "const response=await fetch('/api/result?_='+Date.now(),{cache:'no-store'});",

    "const data=await response.json();",

    "if(data.result){",

    "updateDashboard(data.result);",

    "document.getElementById('status').textContent='Sistem aktif · 600 coin universe · 180 derin analiz · canlı fiyat · her dakika yeni tarama.';",

    "}else{",

    "document.getElementById('status').textContent='İlk tarama devam ediyor...';",

    "}",

    "}catch(error){",

    "document.getElementById('status').textContent='Bağlantı hatası: '+error.message;",

    "}",

    "}",

    "",

    "loadResult();",

    "setInterval(loadResult,10000);",

    "</script>",

    "</body>",

    "</html>"

  ].join(
    "\n"
  );

}


const HTML =
  createHTML();


/*
=========================================================
ROUTES
=========================================================
*/

app.get(
  "/",
  (
    req,
    res
  ) => {

    res.setHeader(
      "Content-Type",
      "text/html; charset=utf-8"
    );

    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate"
    );

    res.setHeader(
      "Pragma",
      "no-cache"
    );

    res.setHeader(
      "Expires",
      "0"
    );

    res.send(
      HTML
    );

  }
);


app.get(
  "/health",
  (
    req,
    res
  ) => {

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
  (
    req,
    res
  ) => {

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
        activeSignals.size,

      history:
        history.length,

      lastScan,

      discoveryTime,

      error:
        lastError

    });

  }
);


app.get(
  "/api/scan",
  async (
    req,
    res
  ) => {

    const result =
      await runRadar();

    res.json(
      result
    );

  }
);


app.get(
  "/api/result",
  async (
    req,
    res
  ) => {

    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate"
    );

    try {

      /*
      İlk açılış.
      */

      if (
        !cachedResult &&
        !scanRunning
      ) {

        await runRadar();

      }

      if (
        !cachedResult
      ) {

        return res.json({

          success:
            true,

          scanning:
            true,

          result:
            null,

          message:
            "İlk tarama devam ediyor..."

        });

      }

      /*
      CANLI FİYAT

      Her UI isteğinde ticker yenilenir.
      */

      const tickers =
        await bitget(
          "/api/v2/mix/market/tickers",
          {
            productType:
              PRODUCT_TYPE
          }
        );

      const prices =
        new Map();

      for (
        const ticker
        of arr(tickers)
      ) {

        const price =
          Number(
            ticker.lastPr
          );

        if (
          ticker.symbol &&
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

      /*
      Aktif sinyalleri
      canlı fiyatla kontrol et.
      */

      const liveSignals =
        syncActiveSignals(
          [],
          prices
        );

      cachedResult.signals =
        liveSignals;

      cachedResult.missed =
        missedSignals.slice(
          0,
          CONFIG.MAX_MISSED
        );

      cachedResult.performance =
        performance();

      cachedResult.stats.signals =
        liveSignals.length;

      cachedResult.timestamp =
        new Date().toISOString();

      /*
      Preparing fiyatlarını
      da güncelle.
      */

      cachedResult.preparing =
        arr(
          cachedResult.preparing
        ).map(
          item => {

            const live =
              prices.get(
                item.symbol
              );

            if (
              Number.isFinite(
                live
              )
            ) {

              return {

                ...item,

                price:
                  num(
                    live,
                    8
                  )

              };

            }

            return item;

          }
        );

      res.json({

        success:
          true,

        scanning:
          scanRunning,

        result:
          cachedResult

      });

    } catch (error) {

      lastError =
        error.message;

      res.status(
        500
      ).json({

        success:
          false,

        error:
          error.message,

        result:
          cachedResult

      });

    }

  }
);


app.use(
  (
    req,
    res
  ) => {

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
      "Strategy: 4H BREAKOUT + 2H CONFIRMATION + RETEST + 15M RSI + 5M MOMENTUM + BB + ORDERBOOK"
    );

    log(
      "Universe: up to 600 | Deep analysis: 180"
    );

    log(
      "Refresh: Every 60 seconds"
    );

    log(
      "Server listening on port " +
      PORT
    );

    log(
      "Signal history: " +
      history.length +
      " kayıt"
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
      CONFIG.REFRESH_MS
    );

  }
);
