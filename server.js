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

  BATCH_DELAY_MS: 100,

  FOUR_HOUR_LIMIT: 100,

  TWO_HOUR_LIMIT: 100,

  FIFTEEN_MIN_LIMIT: 150,

  LEVEL_LOOKBACK_4H: 30,

  LEVEL_LOOKBACK_2H: 30,

  RETEST_DISTANCE_PERCENT: 0.80,

  MAX_ENTRY_DISTANCE_PERCENT: 0.90,

  RSI_PERIOD: 14,

  RSI_LONG_MIN: 48,

  RSI_LONG_MAX: 68,

  RSI_SHORT_MIN: 32,

  RSI_SHORT_MAX: 52,

  MIN_SIGNAL_SCORE: 75,

  MAX_SIGNALS: 8,

  MAX_PREPARING: 8

};

let marketCache = [];

let lastScan = null;

let scanRunning = false;

let cachedResult = null;

let lastError = null;

let discoveryTime = null;


/*
=========================================================
LOG
=========================================================
*/

function log(message) {

  console.log(
    `[${new Date().toISOString()}] ${message}`
  );

}


function sleep(ms) {

  return new Promise(
    resolve => setTimeout(resolve, ms)
  );

}


function round(value, digits = 6) {

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
BITGET
=========================================================
*/

async function bitget(path, params = {}) {

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
      `Bitget HTTP ${response.status} - ${text.slice(0, 200)}`
    );

  }

  let json;

  try {

    json = JSON.parse(text);

  } catch {

    throw new Error(
      "Bitget JSON parse error"
    );

  }

  if (
    json.code !== "00000"
  ) {

    throw new Error(
      `Bitget ${json.code} - ${json.msg || "Unknown error"}`
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

  if (!Array.isArray(data)) {
    return [];
  }

  return data
    .map(row => {

      return {

        time: Number(row[0]),

        open: Number(row[1]),

        high: Number(row[2]),

        low: Number(row[3]),

        close: Number(row[4]),

        volume: Number(row[5]),

        quoteVolume: Number(
          row[6] || 0
        )

      };

    })
    .filter(
      c =>
        Number.isFinite(c.close)
    )
    .sort(
      (a, b) =>
        a.time - b.time
    );

}


/*
=========================================================
INDICATORS
=========================================================
*/

function sma(values, period) {

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
      (a, b) => a + b,
      0
    ) / period
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

    if (change >= 0) {

      gains += change;

    } else {

      losses += -change;

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
        avgGain * (period - 1) +
        gain
      ) / period;

    avgLoss =
      (
        avgLoss * (period - 1) +
        loss
      ) / period;

  }

  if (avgLoss === 0) {

    return 100;

  }

  const rs =
    avgGain / avgLoss;

  return (
    100 -
    100 / (1 + rs)
  );

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
  ] = await Promise.all([

    bitget(
      "/api/v2/mix/market/contracts",
      {
        productType: PRODUCT_TYPE
      }
    ),

    bitget(
      "/api/v2/mix/market/tickers",
      {
        productType: PRODUCT_TYPE
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

        const volume =
          Number(
            ticker.quoteVolume || 0
          );

        const change =
          Number(
            ticker.change24h || 0
          );

        const changePercent =
          Math.abs(change) <= 1
            ? change * 100
            : change;

        return {

          symbol:
            ticker.symbol,

          price,

          volume24h:
            volume,

          change24h:
            changePercent,

          high24h:
            Number(
              ticker.high24h
            ),

          low24h:
            Number(
              ticker.low24h
            )

        };

      })
      .filter(
        item =>
          item.volume24h >=
          CONFIG.MIN_VOLUME_USDT
      )
      .sort(
        (a, b) =>
          b.volume24h -
          a.volume24h
      );

  marketCache =
    market.slice(
      0,
      CONFIG.MARKET_LIMIT
    );

  discoveryTime =
    new Date().toISOString();

  log(
    `Discovery tamamlandı. ${marketCache.length} uygun coin bulundu.`
  );

  return marketCache;

}


/*
=========================================================
CANDLE GET
=========================================================
*/

async function getCandles(
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

  return parseCandles(data);

}


/*
=========================================================
4H / 2H SEVİYE BULMA
=========================================================
*/

function getLevels(
  candles,
  lookback
) {

  if (
    candles.length <
    lookback + 5
  ) {

    return null;

  }

  /*
  Son açık mumu çıkartıyoruz.
  */

  const closed =
    candles.slice(0, -1);

  const current =
    closed[closed.length - 1];

  const history =
    closed.slice(
      -lookback - 1,
      -1
    );

  if (
    history.length <
    lookback
  ) {

    return null;

  }

  const resistance =
    Math.max(
      ...history.map(
        c => c.high
      )
    );

  const support =
    Math.min(
      ...history.map(
        c => c.low
      )
    );

  return {

    current,

    resistance,

    support,

    previousClose:
      history[history.length - 1]
        .close

  };

}


/*
=========================================================
BREAKOUT KONTROLÜ
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

  const closed =
    candles.slice(0, -1);

  if (
    closed.length < 4
  ) {

    return null;

  }

  const current =
    closed[closed.length - 1];

  const previous =
    closed[closed.length - 2];

  const resistance =
    levels.resistance;

  const support =
    levels.support;

  const longBreakout =
    current.close >
      resistance &&
    previous.close <=
      resistance;

  const shortBreakout =
    current.close <
      support &&
    previous.close >=
      support;

  return {

    resistance,

    support,

    current,

    previous,

    longBreakout,

    shortBreakout

  };

}


/*
=========================================================
RETEST
=========================================================
*/

function isNear(
  price,
  level,
  percent
) {

  if (
    !price ||
    !level
  ) {

    return false;

  }

  const distance =
    Math.abs(
      pct(
        price - level,
        level
      )
    );

  return (
    distance <= percent
  );

}


/*
=========================================================
PRICE FETCH
=========================================================
*/

async function getCurrentPrice(
  symbol
) {

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
    Array.isArray(data)
  ) {

    const item =
      data[0];

    if (item) {

      return Number(
        item.lastPr
      );

    }

  }

  if (data) {

    return Number(
      data.lastPr
    );

  }

  return null;

}


/*
=========================================================
STRATEGY ENGINE
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

  const price =
    market.price;

  /*
  4H BREAKOUT
  */

  const fourLong =
    fourHour.longBreakout;

  const fourShort =
    fourHour.shortBreakout;

  /*
  2H BREAKOUT
  */

  const twoLong =
    twoHour.longBreakout;

  const twoShort =
    twoHour.shortBreakout;

  /*
  RSI
  */

  const closed15 =
    fifteen.slice(0, -1);

  const closes15 =
    closed15.map(
      c => c.close
    );

  const currentRSI =
    rsi(
      closes15,
      CONFIG.RSI_PERIOD
    );

  if (
    currentRSI === null
  ) {

    return null;

  }

  /*
  ========================================================
  LONG
  ========================================================
  */

  if (
    fourLong &&
    twoLong
  ) {

    const level =
      fourHour.resistance;

    const retest =
      isNear(
        price,
        level,
        CONFIG.RETEST_DISTANCE_PERCENT
      );

    const distance =
      Math.abs(
        pct(
          price - level,
          level
        )
      );

    const rsiOK =
      currentRSI >=
        CONFIG.RSI_LONG_MIN &&
      currentRSI <=
        CONFIG.RSI_LONG_MAX;

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

          rsi: currentRSI,

          direction: "LONG"

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
    fourShort &&
    twoShort
  ) {

    const level =
      fourHour.support;

    const retest =
      isNear(
        price,
        level,
        CONFIG.RETEST_DISTANCE_PERCENT
      );

    const distance =
      Math.abs(
        pct(
          price - level,
          level
        )
      );

    const rsiOK =
      currentRSI >=
        CONFIG.RSI_SHORT_MIN &&
      currentRSI <=
        CONFIG.RSI_SHORT_MAX;

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

          rsi: currentRSI,

          direction: "SHORT"

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
SCORE
=========================================================
*/

function calculateScore({
  breakout4H,
  breakout2H,
  retest,
  rsiOK,
  rsi,
  direction
}) {

  let score = 0;

  if (breakout4H) {
    score += 35;
  }

  if (breakout2H) {
    score += 30;
  }

  if (retest) {
    score += 20;
  }

  if (rsiOK) {
    score += 10;
  }

  /*
  RSI'ın aşırı uçta olmaması
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
  rsi,
  score,
  reason
}) {

  const price =
    market.price;

  /*
  Giriş:

  Retest bölgesini kullanıyoruz.
  */

  const entryLow =
    direction === "LONG"
      ? level * 0.998
      : level * 1.002;

  const entryHigh =
    direction === "LONG"
      ? level * 1.004
      : level * 0.996;

  /*
  Stop:

  Kırılan seviyenin biraz arkasında.
  */

  const riskPercent =
    1.8;

  let stop;

  if (
    direction === "LONG"
  ) {

    stop =
      level *
      (1 - riskPercent / 100);

  } else {

    stop =
      level *
      (1 + riskPercent / 100);

  }

  const risk =
    Math.abs(
      price - stop
    );

  /*
  TP seviyeleri.

  1.5R / 2R / 3R
  */

  let tp1;
  let tp2;
  let tp3;

  if (
    direction === "LONG"
  ) {

    tp1 =
      level + risk * 1.5;

    tp2 =
      level + risk * 2;

    tp3 =
      level + risk * 3;

  } else {

    tp1 =
      level - risk * 1.5;

    tp2 =
      level - risk * 2;

    tp3 =
      level - risk * 3;

  }

  return {

    symbol:
      market.symbol,

    direction,

    strategy:
      "4H / 2H BREAKOUT + RETEST + RSI",

    score,

    price:
      round(price, 8),

    entryLow:
      round(entryLow, 8),

    entryHigh:
      round(entryHigh, 8),

    stop:
      round(stop, 8),

    tp1:
      round(tp1, 8),

    tp2:
      round(tp2, 8),

    tp3:
      round(tp3, 8),

    rsi:
      round(rsi, 1),

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
      round(level, 8),

    reason,

    tradingView:
      `https://www.tradingview.com/chart/?symbol=BITGET:${market.symbol}`

  };

}


/*
=========================================================
PREPARING

Kırılım henüz gelmemiş ama
coin seviyeye yaklaşıyorsa göster.
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

  const closed15 =
    fifteen.slice(0, -1);

  const rsiValue =
    rsi(
      closed15.map(
        c => c.close
      ),
      CONFIG.RSI_PERIOD
    );

  if (
    rsiValue === null
  ) {

    return null;

  }

  /*
  LONG hazırlık
  */

  const longLevel =
    fourHour.resistance;

  const longDistance =
    pct(
      longLevel - price,
      price
    );

  const long2H =
    twoHour.resistance;

  const long2HDistance =
    pct(
      long2H - price,
      price
    );

  if (
    longDistance >= 0 &&
    longDistance <= 1.0 &&
    long2HDistance <= 1.5 &&
    rsiValue >= 45 &&
    rsiValue <= 70
  ) {

    return {

      symbol:
        market.symbol,

      direction:
        "LONG",

      price:
        round(price, 8),

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
          rsiValue,
          1
        ),

      message:
        `Fiyat ${round(longDistance, 3)}% uzakta. 4H direncin kırılması bekleniyor.`,

      tradingView:
        `https://www.tradingview.com/chart/?symbol=BITGET:${market.symbol}`

    };

  }


  /*
  SHORT hazırlık
  */

  const shortLevel =
    fourHour.support;

  const shortDistance =
    pct(
      price - shortLevel,
      price
    );

  const short2H =
    twoHour.support;

  const short2HDistance =
    pct(
      price - short2H,
      price
    );

  if (
    shortDistance >= 0 &&
    shortDistance <= 1.0 &&
    short2HDistance <= 1.5 &&
    rsiValue >= 30 &&
    rsiValue <= 55
  ) {

    return {

      symbol:
        market.symbol,

      direction:
        "SHORT",

      price:
        round(price, 8),

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
          rsiValue,
          1
        ),

      message:
        `Fiyat ${round(shortDistance, 3)}% uzakta. 4H desteğin kırılması bekleniyor.`,

      tradingView:
        `https://www.tradingview.com/chart/?symbol=BITGET:${market.symbol}`

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
      fourHour,
      twoHour,
      fifteen
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
      fourHour.length < 40 ||
      twoHour.length < 40 ||
      fifteen.length < 50
    ) {

      return null;

    }

    const fourBreak =
      detectBreakout(
        fourHour,
        CONFIG.LEVEL_LOOKBACK_4H
      );

    const twoBreak =
      detectBreakout(
        twoHour,
        CONFIG.LEVEL_LOOKBACK_2H
      );

    const signal =
      buildSignal({

        market,

        fourHour:
          fourBreak,

        twoHour:
          twoBreak,

        fifteen

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
            fourHour,
            CONFIG.LEVEL_LOOKBACK_4H
          ),

        twoHour:
          getLevels(
            twoHour,
            CONFIG.LEVEL_LOOKBACK_2H
          ),

        fifteen

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
      `Analiz hatası ${market.symbol}: ${error.message}`
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
          "VERİ BEKLENİYOR",

        reason:
          "BTC / ETH verisi bekleniyor."

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
      bullish > bearish
    ) {

      return {

        direction:
          "LONG",

        label:
          "PİYASA YUKARI",

        reason:
          "Ana piyasa göstergeleri yükseliş ağırlıklı."

      };

    }

    if (
      bearish > bullish
    ) {

      return {

        direction:
          "SHORT",

        label:
          "PİYASA AŞAĞI",

        reason:
          "Ana piyasa göstergeleri düşüş ağırlıklı."

      };

    }

    return {

      direction:
        "YATAY",

      label:
        "PİYASA YATAY",

      reason:
        "Piyasa yönü net değil."

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

  if (scanRunning) {

    return {

      success:
        false,

      error:
        "Tarama zaten çalışıyor."

    };

  }

  scanRunning = true;

  lastError = null;

  const started =
    Date.now();

  try {

    /*
    Her dakika piyasayı yeniden keşfet.

    Böylece yeni listelenen / hareketlenen
    coinler de sisteme girebilir.
    */

    await discoverMarket();

    const candidates =
      marketCache.slice(
        0,
        CONFIG.ANALYZE_LIMIT
      );

    log(
      `Radar başladı. ${candidates.length} coin analiz edilecek.`
    );

    const signals = [];

    const preparing = [];

    for (
      let i = 0;
      i < candidates.length;
      i += CONFIG.BATCH_SIZE
    ) {

      const batch =
        candidates.slice(
          i,
          i + CONFIG.BATCH_SIZE
        );

      const batchResults =
        await Promise.all(
          batch.map(
            coin =>
              analyzeCoin(coin)
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
    Güçlü sinyalleri sırala.
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
    Hazırlananları mesafeye göre sırala.
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
      ) / 1000;

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
        "4H / 2H BREAKOUT + RETEST + RSI",

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
          round(elapsed, 1)

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
      `RADAR tamamlandı | Market: ${marketCache.length} | Analiz: ${candidates.length} | SIGNAL: ${finalSignals.length} | PREPARING: ${finalPreparing.length}`
    );

    return cachedResult;

  } catch (error) {

    lastError =
      error.message;

    log(
      `RADAR ERROR: ${error.message}`
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

    scanRunning = false;

  }

}


/*
=========================================================
WEB UI
=========================================================
*/

const HTML = `

<!DOCTYPE html>

<html lang="tr">

<head>

<meta charset="UTF-8">

<meta name="viewport"
content="width=device-width, initial-scale=1.0">

<title>Sonny AI Signal Scanner V5</title>

<style>

* {
  box-sizing: border-box;
}

body {

  margin: 0;

  background:
    #080b12;

  color:
    #f5f7fb;

  font-family:
    Arial, Helvetica, sans-serif;

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
    #7d8799;

  margin-top:
    6px;

}

.online {

  padding:
    9px 14px;

  border-radius:
    20px;

  background:
    #0d2118;

  color:
    #43e58b;

  border:
    1px solid #174d31;

  font-weight:
    800;

}


/*
=========================================================
MARKET
=========================================================
*/

.market-box {

  background:
    #111722;

  border:
    1px solid #202b3b;

  border-radius:
    15px;

  padding:
    20px;

  margin-bottom:
    18px;

}

.market-title {

  color:
    #7d8799;

  font-size:
    11px;

  font-weight:
    800;

  letter-spacing:
    1px;

  margin-bottom:
    8px;

}

.market-direction {

  font-size:
    28px;

  font-weight:
    900;

}

.market-reason {

  margin-top:
    6px;

  color:
    #8d98aa;

}


/*
=========================================================
STATS
=========================================================
*/

.stats {

  display:
    grid;

  grid-template-columns:
    repeat(4, 1fr);

  gap:
    12px;

  margin-bottom:
    18px;

}

.stat {

  background:
    #111722;

  border:
    1px solid #202b3b;

  border-radius:
    13px;

  padding:
    15px;

}

.stat-label {

  color:
    #697587;

  font-size:
    10px;

  text-transform:
    uppercase;

}

.stat-value {

  font-size:
    21px;

  font-weight:
    900;

  margin-top:
    7px;

}


/*
=========================================================
PANELS
=========================================================
*/

.panel {

  background:
    #111722;

  border:
    1px solid #202b3b;

  border-radius:
    15px;

  padding:
    20px;

  margin-bottom:
    18px;

}

.panel h2 {

  margin:
    0 0 5px;

  font-size:
    19px;

}

.panel-description {

  color:
    #7d8799;

  font-size:
    13px;

  margin-bottom:
    18px;

}


/*
=========================================================
SIGNAL CARD
=========================================================
*/

.signal-card {

  background:
    #0c121d;

  border:
    1px solid #26354a;

  border-radius:
    14px;

  padding:
    18px;

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

}

.coin {

  font-size:
    20px;

  font-weight:
    900;

  cursor:
    pointer;

}

.coin:hover {

  text-decoration:
    underline;

}

.long {

  color:
    #45e58d;

}

.short {

  color:
    #ff647a;

}

.score {

  background:
    #1c2635;

  padding:
    6px 9px;

  border-radius:
    7px;

  font-size:
    12px;

  font-weight:
    900;

}

.strategy {

  margin-top:
    8px;

  color:
    #9ba7ba;

  font-size:
    12px;

}

.price-line {

  margin-top:
    15px;

  color:
    #d9e0ea;

}

.price {

  font-size:
    20px;

  font-weight:
    900;

}

.grid-plan {

  display:
    grid;

  grid-template-columns:
    repeat(5, 1fr);

  gap:
    8px;

  margin-top:
    15px;

}

.plan {

  background:
    #151d2a;

  border-radius:
    9px;

  padding:
    10px;

}

.plan-label {

  color:
    #68758a;

  font-size:
    10px;

}

.plan-value {

  margin-top:
    5px;

  font-weight:
    900;

  font-size:
    13px;

}

.reason {

  margin-top:
    15px;

  padding:
    11px;

  border-radius:
    8px;

  background:
    #121a27;

  color:
    #a8b3c5;

  font-size:
    12px;

}

.open-tv {

  display:
    inline-block;

  margin-top:
    13px;

  padding:
    9px 13px;

  background:
    #e9edf4;

  color:
    #0b1018;

  text-decoration:
    none;

  border-radius:
    8px;

  font-size:
    12px;

  font-weight:
    900;

}


/*
=========================================================
PREPARING
=========================================================
*/

.prepare-card {

  display:
    flex;

  justify-content:
    space-between;

  align-items:
    center;

  padding:
    14px;

  border-bottom:
    1px solid #202a39;

}

.prepare-card:last-child {

  border-bottom:
    0;

}

.prepare-coin {

  font-weight:
    900;

}

.prepare-info {

  color:
    #8995a8;

  font-size:
    12px;

  margin-top:
    4px;

}

.trigger {

  text-align:
    right;

}

.trigger-price {

  font-weight:
    900;

}

.distance {

  color:
    #e8c55d;

  font-size:
    12px;

  margin-top:
    4px;

}

.hidden {

  display:
    none;

}

button {

  border:
    0;

  border-radius:
    8px;

  padding:
    11px 15px;

  font-weight:
    900;

  cursor:
    pointer;

  background:
    #e9edf4;

  color:
    #090e16;

}

button.secondary {

  background:
    #252f40;

  color:
    white;

}

.status {

  margin-top:
    12px;

  color:
    #7e8b9e;

  font-size:
    12px;

}


/*
=========================================================
MOBILE
=========================================================
*/

@media(max-width: 800px) {

  .stats {

    grid-template-columns:
      repeat(2, 1fr);

  }

  .grid-plan {

    grid-template-columns:
      repeat(2, 1fr);

  }

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
4H / 2H Breakout · Retest · RSI
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
YÜKLENİYOR...
</div>

<div
id="marketReason"
class="market-reason">
Piyasa analiz ediliyor.
</div>

</div>


<div class="stats">

<div class="stat">

<div class="stat-label">
Piyasa
</div>

<div
id="marketCount"
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
id="signalCount"
class="stat-value">
0
</div>

</div>

<div class="stat">

<div class="stat-label">
Son Tarama
</div>

<div
id="lastScan"
class="stat-value">
-
</div>

</div>

</div>


<div class="panel">

<h2>
🚨 AKTİF SİNYALLER
</h2>

<div class="panel-description">

Sadece 4H/2H kırılımı gerçekleşmiş,
retest yapan ve RSI giriş için uygun
coinler burada görünür.

</div>

<div id="signals">

<div class="panel-description">
Sistem tarama yapıyor...
</div>

</div>

</div>


<div class="panel">

<h2>
🟡 HAZIRLANAN FIRSATLAR
</h2>

<div class="panel-description">

Henüz kırılım gerçekleşmedi.
Seviyeye yaklaşan güçlü adaylar
burada görünür.

</div>

<div id="preparing">

<div class="panel-description">
Şu anda hazırlanan fırsat yok.
</div>

</div>

</div>


<div class="panel">

<button onclick="loadResult()">
↻ Şimdi Yenile
</button>

<button
class="secondary"
onclick="showStrategy()">
ℹ Strateji
</button>

<div
id="status"
class="status">
Sistem başlatılıyor...
</div>

</div>


<div
id="strategyInfo"
class="panel hidden">

<h2>
🧠 V5 Nasıl Karar Veriyor?
</h2>

<div class="panel-description">

<b>1 — 4H:</b>
Ana destek ve direnç bulunur.

<br><br>

<b>2 — 4H KIRILIM:</b>
Sadece mum kapanışıyla gerçekleşen
gerçek kırılım kabul edilir.

<br><br>

<b>3 — 2H:</b>
Kırılımın aynı yönde 2H tarafından
doğrulanması beklenir.

<br><br>

<b>4 — RETEST:</b>
Fiyat kırdığı seviyeye geri gelir.
Sistem burada giriş fırsatı arar.

<br><br>

<b>5 — RSI:</b>
RSI giriş için uygun bölgedeyse
sinyal oluşturulur.

<br><br>

<b>SONUÇ:</b>

<br>

<strong>
COIN → LONG/SHORT → GİRİŞ → STOP → TP
</strong>

</div>

</div>


<div class="status">
Sonny AI Signal Scanner V5 · Bitget Futures ·
Manual Signal Only
</div>

</div>


<script>

function formatPrice(value) {

  if (
    value === undefined ||
    value === null
  ) {

    return "-";

  }

  const number =
    Number(value);

  if (!Number.isFinite(number)) {

    return "-";

  }

  if (
    number >= 100
  ) {

    return number.toFixed(2);

  }

  if (
    number >= 1
  ) {

    return number.toFixed(4);

  }

  if (
    number >= 0.01
  ) {

    return number.toFixed(6);

  }

  return number.toFixed(8);

}


function openTradingView(symbol) {

  const url =
    "https://www.tradingview.com/chart/?symbol=BITGET:" +
    encodeURIComponent(symbol);

  window.open(
    url,
    "_blank"
  );

}


function renderSignals(items) {

  const box =
    document.getElementById(
      "signals"
    );

  if (
    !items ||
    items.length === 0
  ) {

    box.innerHTML = `

      <div class="panel-description">

      Şu anda kurallarımızın tamamını
      karşılayan aktif sinyal yok.

      </div>

    `;

    return;

  }

  let html = "";

  items.forEach(
    item => {

      const directionClass =
        item.direction === "LONG"
          ? "long"
          : "short";

      html += `

      <div class="signal-card">

        <div class="signal-top">

          <div
            class="coin ${directionClass}"
            onclick="openTradingView('${item.symbol}')">

            ${item.symbol}

          </div>

          <div class="score">

            GÜÇ ${item.score}/100

          </div>

        </div>


        <div class="strategy">

          ${item.strategy}

        </div>


        <div class="price-line">

          Anlık fiyat:

          <span class="price">

            ${formatPrice(item.price)}

          </span>

          · RSI:

          <b>${item.rsi}</b>

        </div>


        <div class="grid-plan">

          <div class="plan">

            <div class="plan-label">
              GİRİŞ
            </div>

            <div class="plan-value">
              ${formatPrice(item.entryLow)}
              -
              ${formatPrice(item.entryHigh)}
            </div>

          </div>


          <div class="plan">

            <div class="plan-label">
              STOP
            </div>

            <div class="plan-value">
              ${formatPrice(item.stop)}
            </div>

          </div>


          <div class="plan">

            <div class="plan-label">
              TP1
            </div>

            <div class="plan-value">
              ${formatPrice(item.tp1)}
            </div>

          </div>


          <div class="plan">

            <div class="plan-label">
              TP2
            </div>

            <div class="plan-value">
              ${formatPrice(item.tp2)}
            </div>

          </div>


          <div class="plan">

            <div class="plan-label">
              TP3
            </div>

            <div class="plan-value">
              ${formatPrice(item.tp3)}
            </div>

          </div>

        </div>


        <div class="reason">

          <b>Neden sinyal?</b><br>

          ${item.reason}

        </div>


        <a
          class="open-tv"
          href="${item.tradingView}"
          target="_blank">

          📊 TRADINGVIEW'DE AÇ

        </a>

      </div>

      `;

    }
  );

  box.innerHTML =
    html;

}


function renderPreparing(items) {

  const box =
    document.getElementById(
      "preparing"
    );

  if (
    !items ||
    items.length === 0
  ) {

    box.innerHTML = `

      <div class="panel-description">

      Şu anda hazırlanan güçlü fırsat yok.

      </div>

    `;

    return;

  }

  let html = "";

  items.forEach(
    item => {

      const directionClass =
        item.direction === "LONG"
          ? "long"
          : "short";

      html += `

      <div class="prepare-card">

        <div>

          <div
            class="prepare-coin ${directionClass}"
            onclick="openTradingView('${item.symbol}')">

            ${item.symbol}
            · ${item.direction}

          </div>

          <div class="prepare-info">

            Anlık:
            ${formatPrice(item.price)}

            · RSI:
            ${item.rsi}

          </div>

        </div>


        <div class="trigger">

          <div class="trigger-price">

            Tetik:
            ${formatPrice(item.trigger)}

          </div>

          <div class="distance">

            ${item.distance}%
            uzakta

          </div>

        </div>

      </div>

      `;

    }
  );

  box.innerHTML =
    html;

}


function updateDashboard(data) {

  if (!data) {
    return;
  }

  if (data.market) {

    const direction =
      document.getElementById(
        "marketDirection"
      );

    direction.innerText =
      data.market.label;

    direction.className =
      "market-direction " +
      (
        data.market.direction ===
        "LONG"
          ? "long"
          : data.market.direction ===
            "SHORT"
            ? "short"
            : ""
      );

    document.getElementById(
      "marketReason"
    ).innerText =
      data.market.reason;

  }


  if (data.stats) {

    document.getElementById(
      "marketCount"
    ).innerText =
      data.stats.market;

    document.getElementById(
      "analyzed"
    ).innerText =
      data.stats.analyzed;

    document.getElementById(
      "signalCount"
    ).innerText =
      data.stats.signals;

  }


  if (data.timestamp) {

    document.getElementById(
      "lastScan"
    ).innerText =
      new Date(
        data.timestamp
      ).toLocaleTimeString(
        "tr-TR"
      );

  }


  renderSignals(
    data.signals
  );

  renderPreparing(
    data.preparing
  );

}


async function loadResult() {

  try {

    document.getElementById(
      "status"
    ).innerText =
      "Sistem yeni piyasa verilerini tarıyor...";

    const response =
      await fetch(
        "/api/result"
      );

    const data =
      await response.json();

    if (
      data.result
    ) {

      updateDashboard(
        data.result
      );

      document.getElementById(
        "status"
      ).innerText =
        "Sistem aktif. Her dakika yeni tarama yapılıyor.";

    } else {

      document.getElementById(
        "status"
      ).innerText =
        "İlk tarama bekleniyor...";

    }

  } catch(error) {

    document.getElementById(
      "status"
    ).innerText =
      "Bağlantı hatası: " +
      error.message;

  }

}


function showStrategy() {

  const box =
    document.getElementById(
      "strategyInfo"
    );

  box.classList.toggle(
    "hidden"
  );

}


/*
=========================================================
OTOMATİK YENİLEME

KULLANICININ "ŞİMDİ TARA"
BUTONUNA BASMASINA GEREK YOK.

=========================================================
*/

loadResult();


setInterval(
  loadResult,
  30000
);


/*
Fiyatlar ve sonuçlar 30 saniyede
bir ekrandan yeniden alınır.

Sunucu ise her 60 saniyede
gerçek tarama yapar.
*/

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

      strategy:
        "4H / 2H BREAKOUT + RETEST + RSI",

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

      strategy:
        "4H / 2H BREAKOUT + RETEST + RSI",

      refresh:
        "60 SECONDS",

      lastScan,

      discoveryTime,

      market:
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

        result:
          null,

        message:
          "İlk tarama henüz tamamlanmadı."

      });

    }

    /*
    Ekrana dönen fiyatların
    mümkün olduğunca güncel olması için
    aktif sinyallerin fiyatını tekrar çekiyoruz.
    */

    res.json({

      success:
        true,

      result:
        cachedResult

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
      `${SYSTEM_NAME} started`
    );

    log(
      "Data source: BITGET"
    );

    log(
      "Strategy: 4H / 2H BREAKOUT + RETEST + RSI"
    );

    log(
      "Refresh: Every 60 seconds"
    );

    log(
      `Server listening on port ${PORT}`
    );

    /*
    İlk tarama.
    Kullanıcının butona basmasına gerek yok.
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
    */

    setInterval(
      () => {

        runRadar();

      },
      CONFIG.REFRESH_MS
    );

  }
);
