const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

const SYSTEM_NAME = "Sonny AI Signal Scanner V5";

const BITGET_BASE = "https://api.bitget.com";
const PRODUCT_TYPE = "usdt-futures";

/*
=========================================================
V5 STRATEJİ

4H  = ANA SEVİYE + ANA KIRILIM
2H  = KIRILIM DOĞRULAMA
15M = RSI GİRİŞ ZAMANI
PRICE = RETEST KONTROLÜ

ANA STRATEJİ:

4H BREAKOUT
+
2H CONFIRMATION
+
RETEST
+
RSI

Sadece bu strateji kullanılır.
=========================================================
*/

const CONFIG = {

  REFRESH_MS: 60 * 1000,

  MIN_VOLUME_USDT: 3000000,

  MARKET_LIMIT: 100,

  ANALYZE_LIMIT: 70,

  BATCH_SIZE: 8,

  BATCH_DELAY_MS: 120,

  FOUR_HOUR_LIMIT: 120,

  TWO_HOUR_LIMIT: 120,

  FIFTEEN_MIN_LIMIT: 200,

  LEVEL_LOOKBACK_4H: 20,

  LEVEL_LOOKBACK_2H: 20,

  RSI_PERIOD: 14,

  RSI_LONG_MIN: 50,

  RSI_LONG_MAX: 68,

  RSI_SHORT_MIN: 32,

  RSI_SHORT_MAX: 50,

  RETEST_DISTANCE_PERCENT: 0.60,

  MIN_SIGNAL_SCORE: 70,

  MAX_SIGNALS: 15,

  MAX_PREPARING: 12

};

let lastScan = null;

let scanRunning = false;

let cachedResult = null;

let lastError = null;

let marketCache = [];


/*
=========================================================
LOG
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


/*
=========================================================
HELPERS
=========================================================
*/

function sleep(ms) {

  return new Promise(
    resolve => setTimeout(resolve, ms)
  );

}


function round(value, digits = 2) {

  if (!Number.isFinite(value)) {
    return 0;
  }

  return Number(
    value.toFixed(digits)
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
    value / base
  ) * 100;

}


/*
=========================================================
BITGET API
=========================================================
*/

async function bitget(
  path,
  params = {}
) {

  const url =
    new URL(
      BITGET_BASE + path
    );

  Object.entries(params).forEach(
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
      path +
      " - " +
      text.slice(0, 300)
    );

  }

  let json;

  try {

    json =
      JSON.parse(text);

  } catch {

    throw new Error(
      "Bitget JSON parse error - " +
      path
    );

  }

  if (
    json.code !== "00000"
  ) {

    throw new Error(
      "Bitget API " +
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
INDICATORS
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
        (a, b) =>
          a + b,
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
        (values[i] - result) *
        multiplier
      ) +
      result;

  }

  return result;

}


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
    values.slice(-period);

  return (
    slice.reduce(
      (sum, value) =>
        sum + value,
      0
    ) /
    period
  );

}


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
    gains /
    period;

  let avgLoss =
    losses /
    period;

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
          Number(row[5]),

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
MARKET DISCOVERY
=========================================================
*/

async function discoverMarket() {

  log(
    "Bitget piyasası yeniden keşfediliyor..."
  );

  const [
    contracts,
    tickers
  ] = await Promise.all([

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
        .filter(contract => {

          return (

            contract.symbolType ===
              "perpetual" &&

            contract.symbolStatus ===
              "normal" &&

            contract.quoteCoin ===
              "USDT"

          );

        })
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

      .map(ticker => {

        const price =
          Number(
            ticker.lastPr
          );

        const high24h =
          Number(
            ticker.high24h
          );

        const low24h =
          Number(
            ticker.low24h
          );

        const volume24h =
          Number(
            ticker.quoteVolume ||
            0
          );

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

        const range24h =
          price > 0
            ? pct(
                high24h -
                  low24h,
                price
              )
            : 0;

        return {

          symbol:
            ticker.symbol,

          price,

          high24h,

          low24h,

          volume24h,

          change24h,

          range24h

        };

      })

      .filter(
        item =>
          item.volume24h >=
          CONFIG.MIN_VOLUME_USDT
      )

      .map(item => {

        let marketScore = 0;

        const volume =
          item.volume24h;

        const movement =
          Math.abs(
            item.change24h
          );

        if (
          volume >= 100000000
        ) {

          marketScore += 30;

        } else if (
          volume >= 30000000
        ) {

          marketScore += 25;

        } else if (
          volume >= 10000000
        ) {

          marketScore += 20;

        } else {

          marketScore += 10;

        }

        if (
          movement >= 5
        ) {

          marketScore += 30;

        } else if (
          movement >= 3
        ) {

          marketScore += 25;

        } else if (
          movement >= 1.5
        ) {

          marketScore += 15;

        }

        if (
          item.range24h >= 8
        ) {

          marketScore += 25;

        } else if (
          item.range24h >= 5
        ) {

          marketScore += 20;

        } else if (
          item.range24h >= 3
        ) {

          marketScore += 12;

        }

        return {

          ...item,

          marketScore

        };

      })

      .sort(
        (a, b) =>
          b.marketScore -
          a.marketScore
      );

  marketCache =
    market.slice(
      0,
      CONFIG.MARKET_LIMIT
    );

  log(
    "Discovery tamamlandı. " +
    market.length +
    " uygun coin bulundu."
  );

  return marketCache;

}


/*
=========================================================
GET CANDLES
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

  return parseCandles(
    data
  );

}


/*
=========================================================
LEVELS
=========================================================
*/

function getLevels(
  candles,
  lookback
) {

  if (
    !candles ||
    candles.length <
      lookback + 2
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
      -lookback - 1,
      -1
    );

  if (
    previous.length <
    lookback
  ) {

    return null;

  }

  const resistance =
    Math.max(
      ...previous.map(
        candle =>
          candle.high
      )
    );

  const support =
    Math.min(
      ...previous.map(
        candle =>
          candle.low
      )
    );

  return {

    current,

    resistance,

    support

  };

}


/*
=========================================================
BREAKOUT
=========================================================
*/

function detectBreakout(
  candles,
  lookback
) {

  const levels =
    getLevels(
      candles,
      lookback
    );

  if (!levels) {
    return null;
  }

  const current =
    levels.current;

  const resistance =
    levels.resistance;

  const support =
    levels.support;

  const breakoutLong =
    current.close >
    resistance;

  const breakoutShort =
    current.close <
    support;

  return {

    ...levels,

    breakoutLong,

    breakoutShort

  };

}


/*
=========================================================
RSI
=========================================================
*/

function getCurrentRSI(
  candles
) {

  if (
    !candles ||
    candles.length <
      CONFIG.RSI_PERIOD + 5
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
      candle =>
        candle.close
    );

  return rsi(
    closes,
    CONFIG.RSI_PERIOD
  );

}


/*
=========================================================
VOLUME
=========================================================
*/

function getVolumeRatio(
  candles
) {

  if (
    !candles ||
    candles.length < 35
  ) {

    return 0;

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
      -31,
      -1
    );

  const average =
    sma(
      previous.map(
        candle =>
          candle.volume
      ),
      30
    );

  if (
    !average ||
    average <= 0
  ) {

    return 0;

  }

  return (
    current.volume /
    average
  );

}


/*
=========================================================
SCORE
=========================================================
*/

function calculateScore({

  breakout4H,

  breakout2H,

  retest,

  rsiOK,

  rsi,

  direction,

  volumeConfirm

}) {

  let score = 0;

  /*
  4H kırılımı ana sinyal.
  */

  if (
    breakout4H
  ) {

    score += 35;

  }

  /*
  2H doğrulaması.
  */

  if (
    breakout2H
  ) {

    score += 30;

  }

  /*
  Retest.
  */

  if (
    retest
  ) {

    score += 20;

  }

  /*
  RSI uygunluğu.
  */

  if (
    rsiOK
  ) {

    score += 10;

  }

  /*
  Hacim.
  */

  if (
    volumeConfirm
  ) {

    score += 5;

  }

  /*
  RSI ideal bölgedeyse
  ekstra kalite.
  */

  if (
    direction === "LONG" &&
    rsi >= 52 &&
    rsi <= 63
  ) {

    score += 5;

  }

  if (
    direction === "SHORT" &&
    rsi >= 37 &&
    rsi <= 48
  ) {

    score += 5;

  }

  return Math.min(
    100,
    score
  );

}


/*
=========================================================
TRADE PLAN
=========================================================
*/

function createTradePlan({

  market,

  direction,

  level,

  rsi: currentRSI,

  score,

  reason

}) {

  const price =
    market.price;

  /*
  Giriş bölgesi:

  Kırılan seviyenin
  hemen çevresi.
  */

  let entryLow;

  let entryHigh;

  if (
    direction === "LONG"
  ) {

    entryLow =
      level * 0.998;

    entryHigh =
      level * 1.004;

  } else {

    entryLow =
      level * 0.996;

    entryHigh =
      level * 1.002;

  }

  /*
  Stop:

  Kırılan seviyenin
  arkasında.
  */

  const riskPercent =
    1.8;

  let stop;

  if (
    direction === "LONG"
  ) {

    stop =
      level *
      (
        1 -
        riskPercent / 100
      );

  } else {

    stop =
      level *
      (
        1 +
        riskPercent / 100
      );

  }

  /*
  Risk mesafesi.
  */

  const risk =
    Math.abs(
      level -
      stop
    );

  /*
  TP.

  1.5R
  2R
  3R
  */

  let tp1;

  let tp2;

  let tp3;

  if (
    direction === "LONG"
  ) {

    tp1 =
      level +
      risk * 1.5;

    tp2 =
      level +
      risk * 2;

    tp3 =
      level +
      risk * 3;

  } else {

    tp1 =
      level -
      risk * 1.5;

    tp2 =
      level -
      risk * 2;

    tp3 =
      level -
      risk * 3;

  }

  return {

    symbol:
      market.symbol,

    direction,

    strategy:
      "4H BREAKOUT + 2H CONFIRMATION + RETEST + RSI",

    score,

    price:
      round(
        price,
        8
      ),

    entryLow:
      round(
        entryLow,
        8
      ),

    entryHigh:
      round(
        entryHigh,
        8
      ),

    stop:
      round(
        stop,
        8
      ),

    tp1:
      round(
        tp1,
        8
      ),

    tp2:
      round(
        tp2,
        8
      ),

    tp3:
      round(
        tp3,
        8
      ),

    rsi:
      round(
        currentRSI,
        1
      ),

    change24h:
      round(
        market.change24h,
        2
      ),

    volume24h:
      round(
        market.volume24h /
        1000000,
        2
      ),

    level:
      round(
        level,
        8
      ),

    reason,

    tradingView:
      "https://www.tradingview.com/chart/?symbol=BITGET:" +
      market.symbol

  };

}


/*
=========================================================
SIGNAL ENGINE
=========================================================
*/

function buildSignal({

  market,

  fourHour,

  twoHour,

  fifteen

}) {

  if (
    !fourHour ||
    !twoHour ||
    !fifteen
  ) {

    return null;

  }

  const currentPrice =
    market.price;

  const currentRSI =
    getCurrentRSI(
      fifteen
    );

  if (
    currentRSI === null
  ) {

    return null;

  }

  const volumeRatio =
    getVolumeRatio(
      fifteen
    );

  /*
  ========================================================
  LONG
  ========================================================
  */

  if (
    fourHour.breakoutLong &&
    twoHour.breakoutLong
  ) {

    const level =
      fourHour.resistance;

    const distance =
      Math.abs(
        pct(
          currentPrice -
          level,
          level
        )
      );

    const retest =
      distance <=
      CONFIG.RETEST_DISTANCE_PERCENT;

    const rsiOK =
      currentRSI >=
        CONFIG.RSI_LONG_MIN &&
      currentRSI <=
        CONFIG.RSI_LONG_MAX;

    const volumeConfirm =
      volumeRatio >= 1.0;

    if (
      retest &&
      rsiOK
    ) {

      const score =
        calculateScore({

          breakout4H: true,

          breakout2H: true,

          retest: true,

          rsiOK: true,

          rsi:
            currentRSI,

          direction:
            "LONG",

          volumeConfirm

        });

      if (
        score <
        CONFIG.MIN_SIGNAL_SCORE
      ) {

        return null;

      }

      return createTradePlan({

        market,

        direction:
          "LONG",

        level,

        rsi:
          currentRSI,

        score,

        reason:
          "4H direnç kırıldı + 2H kırılımı doğruladı + fiyat retest bölgesinde + RSI LONG için uygun."

      });

    }

  }


  /*
  ========================================================
  SHORT
  ========================================================
  */

  if (
    fourHour.breakoutShort &&
    twoHour.breakoutShort
  ) {

    const level =
      fourHour.support;

    const distance =
      Math.abs(
        pct(
          currentPrice -
          level,
          level
        )
      );

    const retest =
      distance <=
      CONFIG.RETEST_DISTANCE_PERCENT;

    const rsiOK =
      currentRSI >=
        CONFIG.RSI_SHORT_MIN &&
      currentRSI <=
        CONFIG.RSI_SHORT_MAX;

    const volumeConfirm =
      volumeRatio >= 1.0;

    if (
      retest &&
      rsiOK
    ) {

      const score =
        calculateScore({

          breakout4H: true,

          breakout2H: true,

          retest: true,

          rsiOK: true,

          rsi:
            currentRSI,

          direction:
            "SHORT",

          volumeConfirm

        });

      if (
        score <
        CONFIG.MIN_SIGNAL_SCORE
      ) {

        return null;

      }

      return createTradePlan({

        market,

        direction:
          "SHORT",

        level,

        rsi:
          currentRSI,

        score,

        reason:
          "4H destek kırıldı + 2H kırılımı doğruladı + fiyat retest bölgesinde + RSI SHORT için uygun."

      });

    }

  }

  return null;

}


/*
=========================================================
PREPARING
=========================================================

Kırılım henüz gelmemiş fakat fiyat
4H seviyesine yaklaşmışsa burada gösterilir.

Bu bölüm gerçek sinyal değildir.

Sadece "hazırlanıyor" listesidir.
=========================================================
*/

function buildPreparing({

  market,

  fourHour,

  twoHour,

  fifteen

}) {

  if (
    !fourHour ||
    !twoHour ||
    !fifteen
  ) {

    return null;

  }

  const price =
    market.price;

  const currentRSI =
    getCurrentRSI(
      fifteen
    );

  if (
    currentRSI === null
  ) {

    return null;

  }


  /*
  ========================================================
  LONG HAZIRLIK
  ========================================================
  */

  const longLevel =
    fourHour.resistance;

  const longDistance =
    pct(
      longLevel -
      price,
      price
    );

  const long2H =
    twoHour.resistance;

  const long2HDistance =
    pct(
      long2H -
      price,
      price
    );

  if (
    longDistance >= 0 &&
    longDistance <= 1.0 &&
    long2HDistance <= 1.5 &&
    currentRSI >= 45 &&
    currentRSI <= 70
  ) {

    return {

      symbol:
        market.symbol,

      direction:
        "LONG",

      price:
        round(
          price,
          8
        ),

      trigger:
        round(
          longLevel,
          8
        ),

      distance:
        round(
          longDistance,
          3
        ),

      rsi:
        round(
          currentRSI,
          1
        ),

      message:
        "4H direncin kırılması bekleniyor.",

      tradingView:
        "https://www.tradingview.com/chart/?symbol=BITGET:" +
        market.symbol

    };

  }


  /*
  ========================================================
  SHORT HAZIRLIK
  ========================================================
  */

  const shortLevel =
    fourHour.support;

  const shortDistance =
    pct(
      price -
      shortLevel,
      price
    );

  const short2H =
    twoHour.support;

  const short2HDistance =
    pct(
      price -
      short2H,
      price
    );

  if (
    shortDistance >= 0 &&
    shortDistance <= 1.0 &&
    short2HDistance <= 1.5 &&
    currentRSI >= 30 &&
    currentRSI <= 55
  ) {

    return {

      symbol:
        market.symbol,

      direction:
        "SHORT",

      price:
        round(
          price,
          8
        ),

      trigger:
        round(
          shortLevel,
          8
        ),

      distance:
        round(
          shortDistance,
          3
        ),

      rsi:
        round(
          currentRSI,
          1
        ),

      message:
        "4H desteğin kırılması bekleniyor.",

      tradingView:
        "https://www.tradingview.com/chart/?symbol=BITGET:" +
        market.symbol

    };

  }

  return null;

}


/*
=========================================================
COIN ANALYSIS
=========================================================
*/

async function analyzeCoin(
  market
) {

  try {

    const [
      fourHourCandles,

      twoHourCandles,

      fifteenCandles

    ] = await Promise.all([

      getCandles(
        market.symbol,
        "4H",
        CONFIG.FOUR_HOUR_LIMIT
      ),

      getCandles(
        market.symbol,
        "2H",
        CONFIG.TWO_HOUR_LIMIT
      ),

      getCandles(
        market.symbol,
        "15m",
        CONFIG.FIFTEEN_MIN_LIMIT
      )

    ]);

    if (
      fourHourCandles.length < 40 ||
      twoHourCandles.length < 40 ||
      fifteenCandles.length < 50
    ) {

      return null;

    }

    const fourBreak =
      detectBreakout(
        fourHourCandles,
        CONFIG.LEVEL_LOOKBACK_4H
      );

    const twoBreak =
      detectBreakout(
        twoHourCandles,
        CONFIG.LEVEL_LOOKBACK_2H
      );

    const signal =
      buildSignal({

        market,

        fourHour:
          fourBreak,

        twoHour:
          twoBreak,

        fifteen:
          fifteenCandles

      });

    if (signal) {

      return {

        type:
          "SIGNAL",

        signal

      };

    }

    const preparing =
      buildPreparing({

        market,

        fourHour:
          getLevels(
            fourHourCandles,
            CONFIG.LEVEL_LOOKBACK_4H
          ),

        twoHour:
          getLevels(
            twoHourCandles,
            CONFIG.LEVEL_LOOKBACK_2H
          ),

        fifteen:
          fifteenCandles

      });

    if (preparing) {

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
GENEL PİYASA DURUMU
=========================================================
*/

async function calculateMarketDirection() {

  try {

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
      [btc, eth]
        .filter(Boolean);

    if (
      targets.length === 0
    ) {

      return {

        direction:
          "YATAY",

        label:
          "PİYASA YATAY",

        reason:
          "BTC ve ETH verisi bekleniyor."

      };

    }

    let bullish = 0;

    let bearish = 0;

    targets.forEach(
      item => {

        if (
          item.change24h > 1
        ) {

          bullish++;

        }

        if (
          item.change24h < -1
        ) {

          bearish++;

        }

      }
    );

    if (
      bullish >
      bearish
    ) {

      return {

        direction:
          "LONG",

        label:
          "PİYASA YUKARI",

        reason:
          "BTC / ETH günlük hareketi yükseliş ağırlıklı."

      };

    }

    if (
      bearish >
      bullish
    ) {

      return {

        direction:
          "SHORT",

        label:
          "PİYASA AŞAĞI",

        reason:
          "BTC / ETH günlük hareketi düşüş ağırlıklı."

      };

    }

    return {

      direction:
        "YATAY",

      label:
        "PİYASA YATAY",

      reason:
        "Ana piyasa göstergelerinde net yön yok."

    };

  } catch {

    return {

      direction:
        "YATAY",

      label:
        "PİYASA YATAY",

      reason:
        "Piyasa yönü hesaplanamadı."

    };

  }

}


/*
=========================================================
RADAR
=========================================================
*/

async function runRadar() {

  if (
    scanRunning &&
    cachedResult
  ) {

    return cachedResult;

  }

  if (
    scanRunning
  ) {

    return {

      success:
        false,

      error:
        "Tarama zaten çalışıyor."

    };

  }

  scanRunning =
    true;

  lastError =
    null;

  const started =
    Date.now();

  try {

    /*
    Her dakika piyasayı yeniden keşfet.

    Böylece yeni coinler,
    yeni hacimler ve yeni fırsatlar
    sisteme dahil olabilir.
    */

    await discoverMarket();

    const candidates =
      marketCache.slice(
        0,
        CONFIG.ANALYZE_LIMIT
      );

    log(
      "Radar başladı. " +
      candidates.length +
      " coin analiz edilecek."
    );

    const signals = [];

    const preparing = [];

    /*
    Coinleri küçük gruplar
    halinde analiz et.
    */

    for (
      let i = 0;
      i < candidates.length;
      i += CONFIG.BATCH_SIZE
    ) {

      const batch =
        candidates.slice(
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

      batchResults.forEach(
        result => {

          if (!result) {

            return;

          }

          if (
            result.type ===
            "SIGNAL"
          ) {

            signals.push(
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
      );

      await sleep(
        CONFIG.BATCH_DELAY_MS
      );

    }

    /*
    Sinyalleri puana göre sırala.
    */

    signals.sort(
      (a, b) =>
        b.score -
        a.score
    );

    const finalSignals =
      signals.slice(
        0,
        CONFIG.MAX_SIGNALS
      );

    /*
    Hazırlananları seviyeye
    en yakın olandan sırala.
    */

    preparing.sort(
      (a, b) =>
        a.distance -
        b.distance
    );

    const finalPreparing =
      preparing.slice(
        0,
        CONFIG.MAX_PREPARING
      );

    const marketDirection =
      await calculateMarketDirection();

    const elapsed =
      (
        Date.now() -
        started
      ) /
      1000;

    cachedResult = {

      success:
        true,

      system:
        SYSTEM_NAME,

      timestamp:
        new Date().toISOString(),

      refresh:
        "EVERY 60 SECONDS",

      strategy:
        "4H BREAKOUT + 2H CONFIRMATION + RETEST + RSI",

      timeframes: {

        main:
          "4H",

        confirmation:
          "2H",

        entry:
          "15M"

      },

      market: {

        direction:
          marketDirection.direction,

        label:
          marketDirection.label,

        reason:
          marketDirection.reason

      },

      stats: {

        market:
          marketCache.length,

        analyzed:
          candidates.length,

        signals:
          finalSignals.length,

        preparing:
          finalPreparing.length,

        duration:
          round(
            elapsed,
            1
          )

      },

      signals:
        finalSignals,

      preparing:
        finalPreparing,

      mode:
        "MANUAL SIGNAL ONLY"

    };

    lastScan =
      new Date().toISOString();

    log(
      "RADAR tamamlandı | " +
      "Market: " +
      marketCache.length +
      " | Analiz: " +
      candidates.length +
      " | SIGNAL: " +
      finalSignals.length +
      " | PREPARING: " +
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
=========================================================
*/

const HTML = `<!DOCTYPE html>

<html lang="tr">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
>

<title>
Sonny AI Signal Scanner V5
</title>

<style>

* {
  box-sizing: border-box;
}

body {

  margin: 0;

  background:
    #080d1d;

  color:
    #f1f5f9;

  font-family:
    Arial,
    Helvetica,
    sans-serif;

}

.container {

  width:
    min(1250px, 94%);

  margin:
    25px auto;

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
    27px;

  font-weight:
    900;

}

.subtitle {

  color:
    #8ea0c4;

  margin-top:
    6px;

}

.market-banner {

  display:
    flex;

  align-items:
    center;

  justify-content:
    space-between;

  padding:
    18px 20px;

  border-radius:
    14px;

  margin-bottom:
    18px;

  background:
    #11182b;

  border:
    1px solid #23304a;

}

.market-left {

  display:
    flex;

  align-items:
    center;

  gap:
    14px;

}

.market-direction {

  font-size:
    22px;

  font-weight:
    900;

}

.market-reason {

  color:
    #8ea0c4;

  font-size:
    13px;

}

.market-long {

  color:
    #42e88b;

}

.market-short {

  color:
    #ff637d;

}

.market-flat {

  color:
    #f7c95c;

}

.online {

  background:
    #0c2a1b;

  border:
    1px solid #1c6b40;

  color:
    #48e28c;

  padding:
    9px 14px;

  border-radius:
    20px;

  font-weight:
    800;

  font-size:
    13px;

}

.grid {

  display:
    grid;

  grid-template-columns:
    repeat(4, 1fr);

  gap:
    12px;

  margin-bottom:
    18px;

}

.card {

  background:
    #11182b;

  border:
    1px solid #23304a;

  border-radius:
    13px;

  padding:
    15px;

}

.label {

  color:
    #7185ac;

  font-size:
    11px;

  text-transform:
    uppercase;

  margin-bottom:
    7px;

}

.value {

  font-size:
    21px;

  font-weight:
    900;

}

.panel {

  background:
    #11182b;

  border:
    1px solid #23304a;

  border-radius:
    14px;

  padding:
    19px;

  margin-bottom:
    18px;

}

.panel h2 {

  margin-top:
    0;

  font-size:
    19px;

}

.panel-description {

  color:
    #8ea0c4;

  font-size:
    13px;

  line-height:
    1.6;

}

button {

  background:
    #f1f5f9;

  color:
    #08101f;

  border:
    0;

  padding:
    11px 16px;

  border-radius:
    9px;

  font-weight:
    900;

  cursor:
    pointer;

  margin-right:
    7px;

}

button.secondary {

  background:
    #263551;

  color:
    white;

}

.status {

  margin-top:
    12px;

  background:
    #0d1527;

  border:
    1px solid #2a3a59;

  border-radius:
    9px;

  padding:
    12px;

  color:
    #9fb0d0;

  font-size:
    13px;

}

.signal-card {

  background:
    #0d1527;

  border:
    1px solid #263858;

  border-radius:
    13px;

  padding:
    17px;

  margin-bottom:
    12px;

}

.signal-top {

  display:
    flex;

  justify-content:
    space-between;

  align-items:
    center;

  margin-bottom:
    12px;

}

.coin {

  font-size:
    19px;

  font-weight:
    900;

}

.direction {

  font-weight:
    900;

  font-size:
    16px;

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

  padding:
    5px 8px;

  border-radius:
    7px;

  background:
    #1d2b45;

  font-weight:
    900;

}

.signal-info {

  display:
    grid;

  grid-template-columns:
    repeat(4, 1fr);

  gap:
    8px;

  margin-bottom:
    12px;

}

.info-box {

  background:
    #111b31;

  border-radius:
    8px;

  padding:
    9px;

}

.info-label {

  color:
    #7185ac;

  font-size:
    10px;

  margin-bottom:
    4px;

}

.info-value {

  font-weight:
    800;

  font-size:
    13px;

}

.trade-plan {

  border-top:
    1px solid #26334d;

  padding-top:
    13px;

}

.trade-title {

  font-size:
    12px;

  color:
    #8ea0c4;

  margin-bottom:
    8px;

  font-weight:
    800;

}

.trade-grid {

  display:
    grid;

  grid-template-columns:
    repeat(5, 1fr);

  gap:
    7px;

}

.trade-box {

  padding:
    10px;

  border-radius:
    8px;

  background:
    #151f35;

}

.trade-label {

  font-size:
    10px;

  color:
    #7185ac;

  margin-bottom:
    4px;

}

.trade-value {

  font-size:
    13px;

  font-weight:
    900;

}

.entry {

  color:
    #f1f5f9;

}

.stop {

  color:
    #ff637d;

}

.tp {

  color:
    #42e88b;

}

.reason {

  color:
    #9fb0d0;

  font-size:
    12px;

  margin-top:
    11px;

  line-height:
    1.5;

}

.tradingview {

  display:
    inline-block;

  margin-top:
    10px;

  color:
    #7db4ff;

  text-decoration:
    none;

  font-weight:
    800;

  font-size:
    12px;

}

.prepare-card {

  background:
    #111b31;

  border:
    1px solid #514522;

  border-radius:
    11px;

  padding:
    14px;

  margin-bottom:
    10px;

}

.prepare-top {

  display:
    flex;

  justify-content:
    space-between;

  align-items:
    center;

  margin-bottom:
    8px;

}

.prepare-trigger {

  color:
    #f7c95c;

  font-weight:
    900;

}

.prepare-message {

  color:
    #9fb0d0;

  font-size:
    12px;

  margin-top:
    7px;

}

table {

  width:
    100%;

  border-collapse:
    collapse;

}

th {

  color:
    #7185ac;

  font-size:
    10px;

  text-align:
    left;

  padding:
    10px 7px;

  border-bottom:
    1px solid #26334d;

}

td {

  padding:
    11px 7px;

  border-bottom:
    1px solid #1d2940;

  font-size:
    12px;

}

.empty {

  text-align:
    center;

  padding:
    28px;

  color:
    #7185ac;

}

.small {

  font-size:
    11px;

  color:
    #7185ac;

  margin-top:
    12px;

}

.hidden {

  display:
    none;

}

@media(max-width: 900px) {

  .grid {

    grid-template-columns:
      repeat(2, 1fr);

  }

  .signal-info {

    grid-template-columns:
      repeat(2, 1fr);

  }

  .trade-grid {

    grid-template-columns:
      repeat(2, 1fr);

  }

}

@media(max-width: 650px) {

  .header {

    display:
      block;

  }

  .online {

    display:
      inline-block;

    margin-top:
      10px;

  }

  .market-banner {

    display:
      block;

  }

  .market-left {

    margin-bottom:
      10px;

  }

  .grid {

    grid-template-columns:
      repeat(2, 1fr);

  }

}

</style>

</head>

<body>

<div class="container">

<div class="header">

<div>

<div class="title">
🚀 Sonny AI Signal Scanner V5
</div>

<div class="subtitle">
4H + 2H Kırılım · Retest · RSI Giriş Sistemi
</div>

</div>

<div class="online">
● BITGET ONLINE
</div>

</div>


<div class="market-banner">

<div class="market-left">

<div
  id="marketDirection"
  class="market-direction market-flat"
>
PİYASA YATAY
</div>

<div
  id="marketReason"
  class="market-reason"
>
Piyasa verisi hazırlanıyor...
</div>

</div>

<div>
4H / 2H BREAKOUT
</div>

</div>


<div class="grid">

<div class="card">

<div class="label">
Piyasa
</div>

<div
  class="value"
  id="market"
>
-
</div>

</div>


<div class="card">

<div class="label">
Analiz
</div>

<div
  class="value"
  id="analyzed"
>
-
</div>

</div>


<div class="card">

<div class="label">
Sinyal
</div>

<div
  class="value"
  id="signals"
>
0
</div>

</div>


<div class="card">

<div class="label">
Son Tarama
</div>

<div
  class="value"
  id="last"
>
-
</div>

</div>

</div>


<div class="panel">

<h2>
🎯 Sonny V5 Nasıl Çalışıyor?
</h2>

<div class="panel-description">

<b>4H:</b>
Destek / direnç seviyesini belirler.

<br>

<b>2H:</b>
4H kırılımını doğrular.

<br>

<b>15M:</b>
RSI ile giriş zamanını kontrol eder.

<br>

<b>RETEST:</b>
Kırılan seviyenin tekrar test edilmesini bekler.

<br>

<b>SİNYAL:</b>
Tüm şartlar birlikte oluştuğunda gelir.

<br><br>

Sistem otomatik işlem açmaz.
Sadece sana anlaşılır bir işlem fırsatı gösterir.

</div>

<br>

<button onclick="scan()">
🔎 Şimdi Tara
</button>

<button
  class="secondary"
  onclick="loadResult()"
>
↻ Yenile
</button>

<div
  class="status"
  id="status"
>
Sistem otomatik olarak her dakika tarama yapıyor...
</div>

</div>


<div class="panel">

<h2>
🚨 GERÇEK SİNYALLER
</h2>

<div
  id="signalsTable"
>

<div class="empty">
Henüz güçlü sinyal yok.
</div>

</div>

</div>


<div
  class="panel"
  id="preparingPanel"
>

<h2>
🟡 HAZIRLANAN FIRSATLAR
</h2>

<div
  class="panel-description"
>
Henüz kırılım gelmedi.
Fiyat 4H seviyesine yaklaşınca burada görünür.
</div>

<br>

<div
  id="preparingTable"
>

<div class="empty">
Şu anda hazırlanan fırsat yok.
</div>

</div>

</div>


<div class="panel">

<h2>
📊 STRATEJİ
</h2>

<div class="panel-description">

<b>Tek strateji:</b>

4H BREAKOUT
→
2H CONFIRMATION
→
RETEST
→
RSI

<br><br>

Bu sistem onlarca farklı indikatörü
aynı anda kullanarak ekranı kalabalıklaştırmaz.

Amaç:
<strong>
Kırılım gerçekleştiğinde,
uygun giriş bölgesini sana açıkça göstermek.
</strong>

</div>

</div>


<div class="small">

Sonny AI Signal Scanner V5 ·
Bitget Futures ·
4H + 2H + 15M ·
Manual Signal Only ·
Automatic Refresh 60 Seconds

</div>

</div>


<script>

function setStatus(text) {

  document.getElementById(
    "status"
  ).innerText =
    text;

}


function setMarketDirection(
  market
) {

  if (!market) {

    return;

  }

  const box =
    document.getElementById(
      "marketDirection"
    );

  const reason =
    document.getElementById(
      "marketReason"
    );

  box.innerText =
    market.label ||
    "PİYASA YATAY";

  reason.innerText =
    market.reason ||
    "";

  box.className =
    "market-direction";

  if (
    market.direction ===
    "LONG"
  ) {

    box.classList.add(
      "market-long"
    );

  } else if (
    market.direction ===
    "SHORT"
  ) {

    box.classList.add(
      "market-short"
    );

  } else {

    box.classList.add(
      "market-flat"
    );

  }

}


function renderSignals(
  items
) {

  const box =
    document.getElementById(
      "signalsTable"
    );

  if (
    !items ||
    items.length === 0
  ) {

    box.innerHTML =
      '<div class="empty">' +
      'Şu anda güçlü sinyal yok.' +
      '</div>';

    return;

  }

  let html = "";

  items.forEach(
    item => {

      const directionClass =
        item.direction ===
        "LONG"
          ? "long"
          : "short";

      html +=
        '<div class="signal-card">';

      html +=
        '<div class="signal-top">';

      html +=
        '<div>' +
        '<div class="coin">' +
        item.symbol +
        '</div>' +
        '<div class="direction ' +
        directionClass +
        '">' +
        item.direction +
        '</div>' +
        '</div>';

      html +=
        '<div class="score">' +
        'GÜÇ ' +
        item.score +
        '/100' +
        '</div>';

      html +=
        '</div>';


      html +=
        '<div class="signal-info">';

      html +=
        '<div class="info-box">' +
        '<div class="info-label">' +
        'STRATEJİ' +
        '</div>' +
        '<div class="info-value">' +
        '4H + 2H + RETEST + RSI' +
        '</div>' +
        '</div>';

      html +=
        '<div class="info-box">' +
        '<div class="info-label">' +
        'GÜNCEL FİYAT' +
        '</div>' +
        '<div class="info-value">' +
        item.price +
        '</div>' +
        '</div>';

      html +=
        '<div class="info-box">' +
        '<div class="info-label">' +
        'RSI' +
        '</div>' +
        '<div class="info-value">' +
        item.rsi +
        '</div>' +
        '</div>';

      html +=
        '<div class="info-box">' +
        '<div class="info-label">' +
        '24H' +
        '</div>' +
        '<div class="info-value">' +
        item.change24h +
        '%' +
        '</div>' +
        '</div>';

      html +=
        '</div>';


      html +=
        '<div class="trade-plan">';

      html +=
        '<div class="trade-title">' +
        '🎯 İŞLEM PLANI' +
        '</div>';

      html +=
        '<div class="trade-grid">';

      html +=
        '<div class="trade-box">' +
        '<div class="trade-label">' +
        'GİRİŞ' +
        '</div>' +
        '<div class="trade-value entry">' +
        item.entryLow +
        ' - ' +
        item.entryHigh +
        '</div>' +
        '</div>';

      html +=
        '<div class="trade-box">' +
        '<div class="trade-label">' +
        'STOP' +
        '</div>' +
        '<div class="trade-value stop">' +
        item.stop +
        '</div>' +
        '</div>';

      html +=
        '<div class="trade-box">' +
        '<div class="trade-label">' +
        'TP1' +
        '</div>' +
        '<div class="trade-value tp">' +
        item.tp1 +
        '</div>' +
        '</div>';

      html +=
        '<div class="trade-box">' +
        '<div class="trade-label">' +
        'TP2' +
        '</div>' +
        '<div class="trade-value tp">' +
        item.tp2 +
        '</div>' +
        '</div>';

      html +=
        '<div class="trade-box">' +
        '<div class="trade-label">' +
        'TP3' +
        '</div>' +
        '<div class="trade-value tp">' +
        item.tp3 +
        '</div>' +
        '</div>';

      html +=
        '</div>';

      html +=
        '<div class="reason">' +
        '<b>Neden?</b> ' +
        item.reason +
        '</div>';

      html +=
        '<a class="tradingview" ' +
        'href="' +
        item.tradingView +
        '" ' +
        'target="_blank">' +
        '📈 TradingView\'de aç →' +
        '</a>';

      html +=
        '</div>';

      html +=
        '</div>';

    }
  );

  box.innerHTML =
    html;

}


function renderPreparing(
  items
) {

  const box =
    document.getElementById(
      "preparingTable"
    );

  if (
    !items ||
    items.length === 0
  ) {

    box.innerHTML =
      '<div class="empty">' +
      'Şu anda hazırlanan fırsat yok.' +
      '</div>';

    return;

  }

  let html = "";

  items.forEach(
    item => {

      const directionClass =
        item.direction ===
        "LONG"
          ? "long"
          : "short";

      html +=
        '<div class="prepare-card">';

      html +=
        '<div class="prepare-top">';

      html +=
        '<div>' +
        '<div class="coin">' +
        item.symbol +
        '</div>' +
        '<div class="direction ' +
        directionClass +
        '">' +
        item.direction +
        '</div>' +
        '</div>';

      html +=
        '<div class="prepare-trigger">' +
        'TETİK: ' +
        item.trigger +
        '</div>';

      html +=
        '</div>';

      html +=
        '<div>' +
        'Güncel fiyat: <b>' +
        item.price +
        '</b>' +
        ' · RSI: <b>' +
        item.rsi +
        '</b>' +
        ' · Mesafe: <b>' +
        item.distance +
        '%</b>' +
        '</div>';

      html +=
        '<div class="prepare-message">' +
        '🔔 ' +
        item.message +
        '</div>';

      html +=
        '<a class="tradingview" ' +
        'href="' +
        item.tradingView +
        '" ' +
        'target="_blank">' +
        '📈 TradingView\'de kontrol et →' +
        '</a>';

      html +=
        '</div>';

    }
  );

  box.innerHTML =
    html;

}


function updateDashboard(
  data
) {

  if (!data) {

    return;

  }

  if (
    data.stats
  ) {

    document.getElementById(
      "market"
    ).innerText =
      data.stats.market;

    document.getElementById(
      "analyzed"
    ).innerText =
      data.stats.analyzed;

    document.getElementById(
      "signals"
    ).innerText =
      data.stats.signals;

  }

  if (
    data.timestamp
  ) {

    document.getElementById(
      "last"
    ).innerText =
      new Date(
        data.timestamp
      ).toLocaleTimeString(
        "tr-TR"
      );

  }

  setMarketDirection(
    data.market
  );

  renderSignals(
    data.signals
  );

  renderPreparing(
    data.preparing
  );

}


async function loadResult() {

  try {

    const response =
      await fetch(
        "/api/result",
        {
          cache:
            "no-store"
        }
      );

    const data =
      await response.json();

    if (
      data.result
    ) {

      updateDashboard(
        data.result
      );

      setStatus(
        "Son otomatik tarama sonucu güncel."
      );

    }

  } catch(error) {

    setStatus(
      "Sonuç alınamadı."
    );

  }

}


async function scan() {

  setStatus(
    "Yeni piyasa taraması yapılıyor..."
  );

  try {

    const response =
      await fetch(
        "/api/scan",
        {
          cache:
            "no-store"
        }
      );

    const data =
      await response.json();

    if (
      !data.success
    ) {

      setStatus(
        "Tarama hatası: " +
        data.error
      );

      return;

    }

    updateDashboard(
      data
    );

    setStatus(
      "Tarama tamamlandı. Sistem bir sonraki dakikada yeniden tarayacak."
    );

  } catch(error) {

    setStatus(
      "Sunucu bağlantı hatası: " +
      error.message
    );

  }

}


/*
İlk açılış.
*/

loadResult();


/*
Sayfa kendi kendine
30 saniyede bir sonucu alır.

Asıl radar server tarafında
60 saniyede bir çalışır.
*/

setInterval(
  loadResult,
  30000
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

      dataSource:
        "BITGET",

      strategy:
        "4H BREAKOUT + 2H CONFIRMATION + RETEST + RSI",

      refresh:
        "EVERY 60 SECONDS",

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

      dataSource:
        "BITGET",

      product:
        PRODUCT_TYPE,

      strategy:
        "4H BREAKOUT + 2H CONFIRMATION + RETEST + RSI",

      refresh:
        "EVERY 60 SECONDS",

      lastScan,

      marketCoins:
        marketCache.length,

      error:
        lastError

    });

  }
);


app.get(
  "/api/scan",
  async (req, res) => {

    const result =
      await runRadar();

    res.json(
      result
    );

  }
);


app.get(
  "/api/result",
  (req, res) => {

    if (
      !cachedResult
    ) {

      return res.json({

        success:
          true,

        message:
          "Henüz radar sonucu oluşmadı.",

        result:
          null

      });

    }

    res.json(
      cachedResult
    );

  }
);


app.use(
  (req, res) => {

    res.status(404).json({

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
      "Timeframes: 4H + 2H + 15M"
    );

    log(
      "Strategy: 4H Breakout + 2H Confirmation + Retest + RSI"
    );

    log(
      "Refresh: Every 60 seconds"
    );

    log(
      "Product: " +
      PRODUCT_TYPE
    );

    log(
      "Server listening on port " +
      PORT
    );

    /*
    İlk tarama.

    Kullanıcının butona basmasına
    gerek yok.
    */

    setTimeout(
      () => {

        runRadar();

      },
      3000
    );

    /*
    ANA MOTOR

    Her 60 saniyede bir tamamen
    yeni tarama.

    Yeni coin,
    yeni fiyat,
    yeni kırılım,
    yeni fırsat
    aranır.
    */

    setInterval(
      () => {

        runRadar();

      },
      CONFIG.REFRESH_MS
    );

  }
);
