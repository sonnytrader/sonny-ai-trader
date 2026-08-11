const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

const SYSTEM_NAME = "Sonny AI Signal Scanner V3";
const BITGET_BASE = "https://api.bitget.com";
const PRODUCT_TYPE = "usdt-futures";

/*
=========================================================
YENİ SİSTEM MANTIĞI
=========================================================

1. Bitget'ten tüm USDT perpetual piyasayı keşfet
2. Hacim + hareket + volatilite ile fırsat evreni oluştur
3. Fırsat evrenindeki coinleri çoklu zaman diliminde analiz et
4. 2H bölgesi + 5M momentum + hacim + sıkışma hesapla
5. Henüz kırılmamış ama kırılıma yaklaşmış coinleri ARMED olarak tut
6. Gerçek kırılım olduğunda TRIGGER sinyali üret
7. Sistem otomatik emir VERMEZ

Bu sistem eski "sadece kırıldı mı?" sisteminin kopyası değildir.
Ama 2H breakout mantığını yeni radarın yalnızca bir parçası olarak kullanır.
*/

let lastScan = null;
let scanRunning = false;
let cachedResult = null;
let lastError = null;

let marketCache = [];
let opportunityPool = [];

let lastDiscovery = null;
let discoveryRunning = false;

const CONFIG = {
  DISCOVERY_INTERVAL_MS: 5 * 60 * 1000,
  RADAR_INTERVAL_MS: 60 * 1000,

  MIN_QUOTE_VOLUME_USDT: 3000000,

  DISCOVERY_LIMIT: 100,

  RADAR_CANDIDATES: 70,

  BATCH_SIZE: 8,

  BATCH_DELAY_MS: 120,

  FIVE_MIN_LIMIT: 240,

  TWO_HOUR_LIMIT: 120,

  MIN_SETUP_SCORE: 55,

  SIGNAL_SCORE: 72,

  MAX_SIGNALS: 20,

  MAX_WATCHLIST: 30
};

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function number(value, digits = 2) {
  if (!Number.isFinite(value)) return 0;

  return Number(
    value.toFixed(digits)
  );
}

/*
=========================================================
BITGET API
=========================================================
*/

async function bitget(path, params = {}) {

  const url =
    new URL(BITGET_BASE + path);

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
    await fetch(url.toString());

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

    json = JSON.parse(text);

  } catch (error) {

    throw new Error(
      "Bitget JSON parse error - " +
      path
    );

  }

  if (json.code !== "00000") {

    throw new Error(
      "Bitget API " +
      json.code +
      " - " +
      (json.msg || "Unknown error")
    );

  }

  return json.data;
}

/*
=========================================================
INDICATORS
=========================================================
*/

function ema(values, period) {

  if (
    !values ||
    values.length < period
  ) {
    return null;
  }

  const multiplier =
    2 / (period + 1);

  let result =
    values
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      ) / period;

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
      (sum, value) =>
        sum + value,
      0
    ) / period
  );
}

function rsi(values, period = 14) {

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
      ) / period;

    avgLoss =
      (
        avgLoss *
        (period - 1) +
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

function highest(
  candles,
  count
) {

  if (
    !candles ||
    candles.length === 0
  ) {
    return null;
  }

  const slice =
    candles.slice(-count);

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

  if (
    !candles ||
    candles.length === 0
  ) {
    return null;
  }

  const slice =
    candles.slice(-count);

  return Math.min(
    ...slice.map(
      candle =>
        candle.low
    )
  );
}

function percentage(
  value,
  base
) {

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
CANDLE PARSER
=========================================================
*/

function parseBitgetCandles(data) {

  if (
    !Array.isArray(data)
  ) {
    return [];
  }

  const candles =
    data
      .map(row => {

        return {
          time: Number(row[0]),
          open: Number(row[1]),
          high: Number(row[2]),
          low: Number(row[3]),
          close: Number(row[4]),
          volume: Number(row[5]),
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

  return candles;
}

/*
=========================================================
MARKET DISCOVERY
=========================================================
*/

async function discoverMarket() {

  log(
    "Bitget market discovery başlıyor..."
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

        const quoteVolume =
          Number(
            ticker.quoteVolume ||
            0
          );

        const change24h =
          Number(
            ticker.change24h ||
            0
          );

        const change24hPercent =
          Math.abs(
            change24h
          ) <= 1
            ? change24h * 100
            : change24h;

        const range24h =
          price > 0
            ? percentage(
                high24h -
                  low24h,
                price
              )
            : 0;

        return {

          symbol:
            ticker.symbol,

          price,

          change24h:
            change24hPercent,

          volume24h:
            quoteVolume,

          high24h,

          low24h,

          range24h

        };

      })
      .filter(
        item =>
          item.volume24h >=
          CONFIG.MIN_QUOTE_VOLUME_USDT
      )
      .map(item => {

        /*
        MARKET DISCOVERY SCORE

        Burada henüz teknik sinyal yok.
        Sadece hangi coinlerin dikkate
        değer olduğunu belirliyoruz.
        */

        let score = 0;

        if (
          item.volume24h >=
          100000000
        ) {
          score += 25;
        } else if (
          item.volume24h >=
          30000000
        ) {
          score += 20;
        } else if (
          item.volume24h >=
          10000000
        ) {
          score += 15;
        } else {
          score += 10;
        }

        const movement =
          Math.abs(
            item.change24h
          );

        if (
          movement >= 5
        ) {
          score += 25;
        } else if (
          movement >= 3
        ) {
          score += 20;
        } else if (
          movement >= 1.5
        ) {
          score += 12;
        }

        if (
          item.range24h >= 8
        ) {
          score += 25;
        } else if (
          item.range24h >= 5
        ) {
          score += 20;
        } else if (
          item.range24h >= 3
        ) {
          score += 12;
        }

        return {
          ...item,
          discoveryScore:
            score
        };

      })
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

  lastDiscovery =
    new Date().toISOString();

  log(
    "Bitget discovery tamamlandı. " +
    market.length +
    " uygun perpetual coin bulundu."
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

  return parseBitgetCandles(
    data
  );
}

/*
=========================================================
5M MOMENTUM
=========================================================
*/

function calculateMomentum(
  candles
) {

  if (
    candles.length < 100
  ) {
    return null;
  }

  /*
  Son mum tamamlanmamış olabilir.
  Bu nedenle son mumu trigger hesabından
  çıkartıyoruz.
  */

  const closed =
    candles.slice(0, -1);

  const current =
    closed[closed.length - 1];

  const closes =
    closed.map(
      candle =>
        candle.close
    );

  const ema9 =
    ema(closes, 9);

  const ema20 =
    ema(closes, 20);

  const ema50 =
    ema(closes, 50);

  const currentRsi =
    rsi(
      closes,
      14
    );

  const currentAtr =
    atr(
      closed,
      14
    );

  const avgVolume =
    sma(
      closed.map(
        candle =>
          candle.volume
      ),
      30
    );

  const volumeRatio =
    avgVolume > 0
      ? current.volume /
        avgVolume
      : 0;

  const bullish =
    current.close >
      ema9 &&
    ema9 >
      ema20 &&
    ema20 >
      ema50;

  const bearish =
    current.close <
      ema9 &&
    ema9 <
      ema20 &&
    ema20 <
      ema50;

  const recent20 =
    closed.slice(-20);

  const range20 =
    percentage(
      Math.max(
        ...recent20.map(
          candle =>
            candle.high
        )
      ) -
      Math.min(
        ...recent20.map(
          candle =>
            candle.low
        )
      ),
      current.close
    );

  const atrPercent =
    percentage(
      currentAtr || 0,
      current.close
    );

  return {

    current,

    ema9,

    ema20,

    ema50,

    rsi:
      currentRsi,

    atr:
      currentAtr,

    atrPercent,

    volumeRatio,

    bullish,

    bearish,

    range20

  };
}

/*
=========================================================
2H STRUCTURE
=========================================================
*/

function calculateTwoHourStructure(
  candles
) {

  if (
    candles.length < 30
  ) {
    return null;
  }

  const closed =
    candles.slice(0, -1);

  const current =
    closed[closed.length - 1];

  const previous24 =
    closed.slice(-25, -1);

  if (
    previous24.length < 20
  ) {
    return null;
  }

  const resistance =
    Math.max(
      ...previous24.map(
        candle =>
          candle.high
      )
    );

  const support =
    Math.min(
      ...previous24.map(
        candle =>
          candle.low
      )
    );

  const range =
    resistance -
    support;

  if (range <= 0) {
    return null;
  }

  const position =
    (
      current.close -
      support
    ) / range;

  return {

    current,

    resistance,

    support,

    range,

    position

  };
}

/*
=========================================================
SETUP ENGINE
=========================================================
*/

function buildSetup(
  marketItem,
  momentum,
  structure
) {

  if (
    !momentum ||
    !structure
  ) {
    return null;
  }

  const price =
    momentum.current.close;

  const resistance =
    structure.resistance;

  const support =
    structure.support;

  const distanceLong =
    percentage(
      resistance - price,
      price
    );

  const distanceShort =
    percentage(
      price - support,
      price
    );

  const breakoutLong =
    price >
    resistance;

  const breakoutShort =
    price <
    support;

  /*
  -------------------------------------------------------
  LONG SETUP
  -------------------------------------------------------
  */

  let longScore = 0;

  if (
    momentum.bullish
  ) {
    longScore += 22;
  }

  if (
    momentum.rsi >= 52 &&
    momentum.rsi <= 72
  ) {
    longScore += 14;
  }

  if (
    momentum.volumeRatio >= 1.20
  ) {
    longScore += 14;
  }

  if (
    momentum.volumeRatio >= 1.50
  ) {
    longScore += 8;
  }

  if (
    structure.position >= 0.70
  ) {
    longScore += 12;
  }

  if (
    distanceLong >= 0 &&
    distanceLong <= 0.60
  ) {
    longScore += 18;
  }

  if (
    breakoutLong
  ) {
    longScore += 18;
  }

  /*
  Sıkışma:

  Çok büyük rastgele mum yerine
  kontrollü daralma arıyoruz.
  */

  if (
    momentum.range20 <= 3.5
  ) {
    longScore += 8;
  }

  /*
  -------------------------------------------------------
  SHORT SETUP
  -------------------------------------------------------
  */

  let shortScore = 0;

  if (
    momentum.bearish
  ) {
    shortScore += 22;
  }

  if (
    momentum.rsi <= 48 &&
    momentum.rsi >= 28
  ) {
    shortScore += 14;
  }

  if (
    momentum.volumeRatio >= 1.20
  ) {
    shortScore += 14;
  }

  if (
    momentum.volumeRatio >= 1.50
  ) {
    shortScore += 8;
  }

  if (
    structure.position <= 0.30
  ) {
    shortScore += 12;
  }

  if (
    distanceShort >= 0 &&
    distanceShort <= 0.60
  ) {
    shortScore += 18;
  }

  if (
    breakoutShort
  ) {
    shortScore += 18;
  }

  if (
    momentum.range20 <= 3.5
  ) {
    shortScore += 8;
  }

  /*
  -------------------------------------------------------
  EN İYİ YÖN
  -------------------------------------------------------
  */

  let direction = null;
  let setupScore = 0;
  let trigger = false;
  let setupState = "NEUTRAL";
  let triggerLevel = null;
  let distanceToTrigger = null;

  if (
    longScore >= shortScore
  ) {

    direction = "LONG";

    setupScore =
      longScore;

    trigger =
      breakoutLong;

    triggerLevel =
      resistance;

    distanceToTrigger =
      distanceLong;

    if (
      breakoutLong
    ) {
      setupState =
        "TRIGGERED";
    } else if (
      distanceLong <= 0.60
    ) {
      setupState =
        "ARMED";
    } else {
      setupState =
        "WATCH";
    }

  } else {

    direction = "SHORT";

    setupScore =
      shortScore;

    trigger =
      breakoutShort;

    triggerLevel =
      support;

    distanceToTrigger =
      distanceShort;

    if (
      breakoutShort
    ) {
      setupState =
        "TRIGGERED";
    } else if (
      distanceShort <= 0.60
    ) {
      setupState =
        "ARMED";
    } else {
      setupState =
        "WATCH";
    }

  }

  /*
  -------------------------------------------------------
  STRATEGY CLASSIFICATION
  -------------------------------------------------------
  */

  let strategy =
    "MULTI-TIMEFRAME RADAR";

  if (
    trigger
  ) {

    strategy =
      "2H BREAKOUT TRIGGER";

  } else if (
    momentum.volumeRatio >= 1.5 &&
    distanceToTrigger <= 0.60
  ) {

    strategy =
      "VOLUME BREAKOUT SETUP";

  } else if (
    momentum.range20 <= 3.5 &&
    distanceToTrigger <= 0.60
  ) {

    strategy =
      "COMPRESSION BREAKOUT";

  } else if (
    momentum.bullish ||
    momentum.bearish
  ) {

    strategy =
      "TREND CONTINUATION";

  }

  /*
  -------------------------------------------------------
  FINAL SCORE
  -------------------------------------------------------
  */

  let finalScore =
    setupScore;

  /*
  Market discovery etkisi
  */

  finalScore +=
    Math.min(
      marketItem.discoveryScore *
      0.10,
      10
    );

  finalScore =
    Math.min(
      100,
      Math.round(
        finalScore
      )
    );

  /*
  Trigger için ekstra kalite kontrolü
  */

  let signalQuality =
    "WATCH";

  if (
    setupState ===
      "TRIGGERED" &&
    finalScore >=
      CONFIG.SIGNAL_SCORE
  ) {

    signalQuality =
      "SIGNAL";

  } else if (
    setupState ===
      "ARMED" &&
    finalScore >=
      CONFIG.MIN_SETUP_SCORE
  ) {

    signalQuality =
      "ARMED";

  }

  return {

    symbol:
      marketItem.symbol,

    price:
      number(
        price,
        8
      ),

    direction,

    setupState,

    signalQuality,

    score:
      finalScore,

    strategy,

    trigger,

    triggerLevel:
      number(
        triggerLevel,
        8
      ),

    distanceToTrigger:
      number(
        distanceToTrigger,
        3
      ),

    resistance:
      number(
        resistance,
        8
      ),

    support:
      number(
        support,
        8
      ),

    rsi:
      number(
        momentum.rsi,
        1
      ),

    volumeRatio:
      number(
        momentum.volumeRatio,
        2
      ),

    atrPercent:
      number(
        momentum.atrPercent,
        3
      ),

    range20:
      number(
        momentum.range20,
        3
      ),

    change24h:
      number(
        marketItem.change24h,
        2
      ),

    volume24h:
      number(
        marketItem.volume24h /
        1000000,
        2
      ),

    discoveryScore:
      marketItem.discoveryScore

  };
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
      fiveMinute,
      twoHour
    ] = await Promise.all([

      getCandles(
        marketItem.symbol,
        "5m",
        CONFIG.FIVE_MIN_LIMIT
      ),

      getCandles(
        marketItem.symbol,
        "2H",
        CONFIG.TWO_HOUR_LIMIT
      )

    ]);

    if (
      fiveMinute.length < 100 ||
      twoHour.length < 30
    ) {

      return null;

    }

    const momentum =
      calculateMomentum(
        fiveMinute
      );

    const structure =
      calculateTwoHourStructure(
        twoHour
      );

    return buildSetup(
      marketItem,
      momentum,
      structure
    );

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
RADAR
=========================================================
*/

async function runRadar() {

  if (
    scanRunning
  ) {
    return cachedResult;
  }

  scanRunning = true;
  lastError = null;

  const started =
    Date.now();

  try {

    /*
    -----------------------------------------------------
    DISCOVERY

    Her 5 dakikada piyasa yeniden keşfediliyor.
    -----------------------------------------------------
    */

    if (
      marketCache.length === 0 ||
      !lastDiscovery ||
      Date.now() -
        new Date(
          lastDiscovery
        ).getTime() >=
        CONFIG.DISCOVERY_INTERVAL_MS
    ) {

      await discoverMarket();

    }

    /*
    -----------------------------------------------------
    OPPORTUNITY POOL

    Discovery'den gelen coinleri
    teknik radar için seçiyoruz.
    -----------------------------------------------------
    */

    opportunityPool =
      marketCache
        .slice(
          0,
          CONFIG.RADAR_CANDIDATES
        );

    log(
      "Radar başladı. " +
      opportunityPool.length +
      " coin çoklu zaman diliminde analiz edilecek."
    );

    const results = [];

    /*
    Rate limit dostu batch sistemi
    */

    for (
      let i = 0;
      i < opportunityPool.length;
      i += CONFIG.BATCH_SIZE
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
            item =>
              analyzeCoin(item)
          )
        );

      for (
        const result of batchResults
      ) {

        if (result) {
          results.push(result);
        }

      }

      await sleep(
        CONFIG.BATCH_DELAY_MS
      );

    }

    /*
    -----------------------------------------------------
    SIRALAMA
    -----------------------------------------------------
    */

    results.sort(
      (a, b) =>
        b.score -
        a.score
    );

    /*
    GERÇEK SİNYALLER
    */

    const signals =
      results
        .filter(item => {

          return (
            item.signalQuality ===
              "SIGNAL"
          );

        })
        .slice(
          0,
          CONFIG.MAX_SIGNALS
        );

    /*
    ARMED

    Henüz kırılmamış ama
    tetik bölgesine yaklaşmış coinler.
    */

    const armed =
      results
        .filter(item => {

          return (
            item.signalQuality ===
              "ARMED"
          );

        })
        .slice(
          0,
          CONFIG.MAX_WATCHLIST
        );

    /*
    WATCH

    Daha uzakta olan ama
    sistem tarafından izlenmeye
    değer görülen coinler.
    */

    const watchlist =
      results
        .filter(item => {

          return (
            item.signalQuality ===
            "WATCH"
          );

        })
        .slice(
          0,
          CONFIG.MAX_WATCHLIST
        );

    const elapsed =
      (
        (Date.now() -
          started) /
        1000
      ).toFixed(1);

    cachedResult = {

      success: true,

      system:
        SYSTEM_NAME,

      timestamp:
        new Date().toISOString(),

      engine: {

        dataSource:
          "BITGET",

        product:
          "USDT PERPETUAL FUTURES",

        discovery:
          "DYNAMIC",

        analysis:
          "MULTI-TIMEFRAME",

        primaryTimeframe:
          "5M",

        structureTimeframe:
          "2H",

        mode:
          "MANUAL TRADING ONLY"

      },

      marketDiscovery: {

        totalCoins:
          marketCache.length,

        opportunityPool:
          opportunityPool.length

      },

      scan: {

        durationSeconds:
          Number(
            elapsed
          ),

        analyzed:
          results.length

      },

      signals,

      armed,

      watchlist,

      stats: {

        triggered:
          signals.length,

        armed:
          armed.length,

        watching:
          watchlist.length

      },

      mode:
        "MANUAL TRADING ONLY"

    };

    lastScan =
      new Date().toISOString();

    log(
      "RADAR tamamlandı | " +
      "Market: " +
      marketCache.length +
      " | " +
      "Analiz: " +
      results.length +
      " | " +
      "SIGNAL: " +
      signals.length +
      " | " +
      "ARMED: " +
      armed.length
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

      success: false,

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
BACKGROUND ENGINE
=========================================================
*/

async function backgroundRadar() {

  if (
    discoveryRunning
  ) {
    return;
  }

  discoveryRunning =
    true;

  try {

    await runRadar();

  } catch (error) {

    log(
      "Background radar error: " +
      error.message
    );

  } finally {

    discoveryRunning =
      false;

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

<title>Sonny AI Signal Scanner V3</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #080d1d;
  color: #f1f5f9;
  font-family: Arial, Helvetica, sans-serif;
}

.container {
  width: min(1400px, 94%);
  margin: 30px auto;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 25px;
}

.title {
  font-size: 28px;
  font-weight: 800;
}

.subtitle {
  color: #8ea0c4;
  margin-top: 7px;
}

.online {
  background: #0c2a1b;
  border: 1px solid #1c6b40;
  color: #48e28c;
  padding: 10px 15px;
  border-radius: 20px;
  font-weight: bold;
}

.grid {
  display: grid;
  grid-template-columns:
    repeat(6, 1fr);
  gap: 12px;
  margin-bottom: 20px;
}

.card {
  background: #11182b;
  border: 1px solid #23304a;
  border-radius: 14px;
  padding: 17px;
}

.label {
  color: #7f92b8;
  font-size: 11px;
  text-transform: uppercase;
  margin-bottom: 8px;
}

.value {
  font-size: 22px;
  font-weight: 800;
}

.panel {
  background: #11182b;
  border: 1px solid #23304a;
  border-radius: 14px;
  padding: 20px;
  margin-bottom: 20px;
}

.panel h2 {
  margin-top: 0;
}

.muted {
  color: #8ea0c4;
}

button {
  background: #f1f5f9;
  color: #08101f;
  border: 0;
  padding: 12px 18px;
  border-radius: 9px;
  font-weight: 800;
  cursor: pointer;
  margin-right: 8px;
}

button.secondary {
  background: #263551;
  color: white;
}

button:hover {
  opacity: 0.85;
}

.status {
  margin-top: 15px;
  background: #0d1527;
  border: 1px solid #2a3a59;
  border-radius: 9px;
  padding: 14px;
  color: #9fb0d0;
}

table {
  width: 100%;
  border-collapse: collapse;
}

th {
  color: #7185ac;
  font-size: 11px;
  text-align: left;
  padding: 11px 8px;
  border-bottom: 1px solid #26334d;
}

td {
  padding: 13px 8px;
  border-bottom: 1px solid #1d2940;
}

.signal-long {
  color: #42e88b;
  font-weight: 900;
}

.signal-short {
  color: #ff637d;
  font-weight: 900;
}

.signal {
  color: #42e88b;
  font-weight: 900;
}

.armed {
  color: #f7c95c;
  font-weight: 900;
}

.watch {
  color: #7f92b8;
  font-weight: 700;
}

.score {
  font-weight: 900;
}

.good {
  color: #42e88b;
}

.medium {
  color: #f7c95c;
}

.bad {
  color: #ff637d;
}

.empty {
  text-align: center;
  padding: 35px;
  color: #7185ac;
}

.small {
  font-size: 12px;
  color: #7185ac;
}

.badge {
  display: inline-block;
  padding: 5px 8px;
  border-radius: 7px;
  background: #1c2941;
  font-size: 11px;
  font-weight: 800;
}

@media(max-width: 1100px) {

  .grid {
    grid-template-columns:
      repeat(3, 1fr);
  }

}

@media(max-width: 700px) {

  .grid {
    grid-template-columns:
      repeat(2, 1fr);
  }

  .header {
    display: block;
  }

  .online {
    display: inline-block;
    margin-top: 15px;
  }

  table {
    font-size: 11px;
  }

  .panel {
    overflow-x: auto;
  }

}

</style>

</head>

<body>

<div class="container">

<div class="header">

<div>

<div class="title">
🚀 Sonny AI Signal Scanner V3
</div>

<div class="subtitle">
Dynamic Market Discovery · Setup Radar · Multi-Timeframe Engine
</div>

</div>

<div class="online">
● BITGET ONLINE
</div>

</div>

<div class="grid">

<div class="card">
<div class="label">Market</div>
<div class="value" id="market">-</div>
</div>

<div class="card">
<div class="label">Radar</div>
<div class="value" id="radar">-</div>
</div>

<div class="card">
<div class="label">Analiz</div>
<div class="value" id="analyzed">-</div>
</div>

<div class="card">
<div class="label">Signal</div>
<div class="value" id="signals">0</div>
</div>

<div class="card">
<div class="label">Armed</div>
<div class="value" id="armed">0</div>
</div>

<div class="card">
<div class="label">Son Tarama</div>
<div class="value" id="last">-</div>
</div>

</div>

<div class="panel">

<h2>🧠 Yeni Fırsat Motoru</h2>

<p class="muted">

Sistem Bitget piyasasını dinamik olarak keşfeder.
Önce likidite ve hareketlilik açısından fırsat evrenini oluşturur.
Daha sonra 5 dakikalık momentum ile 2 saatlik yapıyı birlikte analiz eder.

Henüz kırılmamış ancak tetik bölgesine yaklaşan coinler
<b>ARMED</b> olarak izlenir.

Gerçek tetik gerçekleştiğinde
<b>SIGNAL</b> oluşur.

</p>

<button onclick="scan()">
🔎 Şimdi Tara
</button>

<button class="secondary"
onclick="loadResult()">
↻ Sonucu Yenile
</button>

<div class="status" id="status">
Motor hazırlanıyor...
</div>

</div>

<div class="panel">

<h2>🚨 GERÇEK SİNYALLER</h2>

<div id="signalsTable">

<div class="empty">
Henüz sinyal oluşmadı.
</div>

</div>

</div>

<div class="panel">

<h2>🟡 ARMED — KIRILIMA YAKLAŞANLAR</h2>

<div id="armedTable">

<div class="empty">
Henüz ARMED aday bulunmuyor.
</div>

</div>

</div>

<div class="panel">

<h2>👀 WATCHLIST</h2>

<div id="watchlist">

<div class="empty">
Henüz izleme verisi yok.
</div>

</div>

</div>

<div class="small">

Sonny AI Signal Scanner V3 ·
Bitget Futures ·
5M + 2H ·
Manual Trading Only

</div>

</div>

<script>

function setStatus(text) {

  document.getElementById(
    "status"
  ).innerText = text;

}

function scoreClass(score) {

  if (score >= 80) {
    return "good";
  }

  if (score >= 65) {
    return "medium";
  }

  return "bad";

}

function directionClass(direction) {

  if (direction === "LONG") {
    return "signal-long";
  }

  return "signal-short";

}

function renderSignals(items) {

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
      'Şu anda tetiklenmiş güçlü sinyal yok.' +
      '</div>';

    return;

  }

  let html = "";

  html += "<table>";

  html += "<tr>";

  html += "<th>COIN</th>";
  html += "<th>YÖN</th>";
  html += "<th>PUAN</th>";
  html += "<th>STRATEJİ</th>";
  html += "<th>2H TETİK</th>";
  html += "<th>MESAFE</th>";
  html += "<th>RSI</th>";
  html += "<th>VOL</th>";
  html += "<th>24H</th>";
  html += "<th>FİYAT</th>";

  html += "</tr>";

  items.forEach(function(item) {

    html += "<tr>";

    html +=
      "<td><b>" +
      item.symbol +
      "</b></td>";

    html +=
      '<td class="' +
      directionClass(
        item.direction
      ) +
      '">' +
      item.direction +
      "</td>";

    html +=
      '<td class="score ' +
      scoreClass(
        item.score
      ) +
      '">' +
      item.score +
      "</td>";

    html +=
      "<td>" +
      item.strategy +
      "</td>";

    html +=
      "<td>" +
      item.triggerLevel +
      "</td>";

    html +=
      "<td>" +
      item.distanceToTrigger +
      "%</td>";

    html +=
      "<td>" +
      item.rsi +
      "</td>";

    html +=
      "<td>" +
      item.volumeRatio +
      "x</td>";

    html +=
      "<td>" +
      item.change24h +
      "%</td>";

    html +=
      "<td>" +
      item.price +
      "</td>";

    html += "</tr>";

  });

  html += "</table>";

  box.innerHTML =
    html;

}

function renderArmed(items) {

  const box =
    document.getElementById(
      "armedTable"
    );

  if (
    !items ||
    items.length === 0
  ) {

    box.innerHTML =
      '<div class="empty">' +
      'Şu anda kırılıma yaklaşan güçlü aday yok.' +
      '</div>';

    return;

  }

  let html = "";

  html += "<table>";

  html += "<tr>";

  html += "<th>COIN</th>";
  html += "<th>YÖN</th>";
  html += "<th>PUAN</th>";
  html += "<th>STRATEJİ</th>";
  html += "<th>TETİK</th>";
  html += "<th>MESAFE</th>";
  html += "<th>RSI</th>";
  html += "<th>VOL</th>";
  html += "<th>24H</th>";

  html += "</tr>";

  items.forEach(function(item) {

    html += "<tr>";

    html +=
      "<td><b>" +
      item.symbol +
      "</b></td>";

    html +=
      '<td class="' +
      directionClass(
        item.direction
      ) +
      '">' +
      item.direction +
      "</td>";

    html +=
      '<td class="score ' +
      scoreClass(
        item.score
      ) +
      '">' +
      item.score +
      "</td>";

    html +=
      "<td>" +
      item.strategy +
      "</td>";

    html +=
      "<td>" +
      item.triggerLevel +
      "</td>";

    html +=
      "<td>" +
      item.distanceToTrigger +
      "%</td>";

    html +=
      "<td>" +
      item.rsi +
      "</td>";

    html +=
      "<td>" +
      item.volumeRatio +
      "x</td>";

    html +=
      "<td>" +
      item.change24h +
      "%</td>";

    html += "</tr>";

  });

  html += "</table>";

  box.innerHTML =
    html;

}

function renderWatchlist(items) {

  const box =
    document.getElementById(
      "watchlist"
    );

  if (
    !items ||
    items.length === 0
  ) {

    box.innerHTML =
      '<div class="empty">' +
      'İzlenecek coin bulunamadı.' +
      '</div>';

    return;

  }

  let html = "";

  html += "<table>";

  html += "<tr>";

  html += "<th>COIN</th>";
  html += "<th>YÖN</th>";
  html += "<th>PUAN</th>";
  html += "<th>STRATEJİ</th>";
  html += "<th>MESAFE</th>";
  html += "<th>RSI</th>";
  html += "<th>VOL</th>";
  html += "<th>24H</th>";

  html += "</tr>";

  items.forEach(function(item) {

    html += "<tr>";

    html +=
      "<td><b>" +
      item.symbol +
      "</b></td>";

    html +=
      '<td class="' +
      directionClass(
        item.direction
      ) +
      '">' +
      item.direction +
      "</td>";

    html +=
      "<td>" +
      item.score +
      "</td>";

    html +=
      "<td>" +
      item.strategy +
      "</td>";

    html +=
      "<td>" +
      item.distanceToTrigger +
      "%</td>";

    html +=
      "<td>" +
      item.rsi +
      "</td>";

    html +=
      "<td>" +
      item.volumeRatio +
      "x</td>";

    html +=
      "<td>" +
      item.change24h +
      "%</td>";

    html += "</tr>";

  });

  html += "</table>";

  box.innerHTML =
    html;

}

function updateDashboard(data) {

  if (!data) {
    return;
  }

  if (
    data.marketDiscovery
  ) {

    document.getElementById(
      "market"
    ).innerText =
      data.marketDiscovery.totalCoins;

    document.getElementById(
      "radar"
    ).innerText =
      data.marketDiscovery.opportunityPool;

  }

  if (data.scan) {

    document.getElementById(
      "analyzed"
    ).innerText =
      data.scan.analyzed;

  }

  document.getElementById(
    "signals"
  ).innerText =
    data.signals
      ? data.signals.length
      : 0;

  document.getElementById(
    "armed"
  ).innerText =
    data.armed
      ? data.armed.length
      : 0;

  if (data.timestamp) {

    document.getElementById(
      "last"
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

  renderArmed(
    data.armed
  );

  renderWatchlist(
    data.watchlist
  );

}

async function scan() {

  setStatus(
    "Bitget piyasası keşfediliyor ve radar çalışıyor..."
  );

  try {

    const response =
      await fetch(
        "/api/scan"
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
      "Tarama tamamlandı. " +
      data.marketDiscovery.totalCoins +
      " coin keşfedildi, " +
      data.marketDiscovery.opportunityPool +
      " coin radara alındı, " +
      data.scan.analyzed +
      " coin analiz edildi."
    );

  } catch(error) {

    setStatus(
      "Sunucu bağlantı hatası: " +
      error.message
    );

  }

}

async function loadResult() {

  try {

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

      setStatus(
        "Son kayıtlı radar sonucu yüklendi."
      );

    } else {

      setStatus(
        "Henüz tarama sonucu yok."
      );

    }

  } catch(error) {

    setStatus(
      "Sonuç alınamadı: " +
      error.message
    );

  }

}

async function loadStatus() {

  try {

    const response =
      await fetch(
        "/api/status"
      );

    const data =
      await response.json();

    if (
      data.lastScan
    ) {

      document.getElementById(
        "last"
      ).innerText =
        new Date(
          data.lastScan
        ).toLocaleTimeString(
          "tr-TR"
        );

    }

    if (
      data.status ===
      "SCANNING"
    ) {

      setStatus(
        "Radar şu anda çalışıyor..."
      );

    }

  } catch(error) {

    setStatus(
      "Durum alınamadı."
    );

  }

}

/*
İlk açılışta sonucu yükle.
*/

loadResult();

loadStatus();

/*
Her 30 saniyede dashboard'u yenile.
*/

setInterval(
  loadResult,
  30000
);

setInterval(
  loadStatus,
  30000
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

      success: true,

      status:
        "healthy",

      system:
        SYSTEM_NAME,

      dataSource:
        "BITGET",

      uptime:
        process.uptime()

    });

  }
);

app.get(
  "/api/status",
  (req, res) => {

    res.json({

      success: true,

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

      mode:
        "MANUAL TRADING ONLY",

      lastScan,

      lastDiscovery,

      marketCoins:
        marketCache.length,

      opportunityPool:
        opportunityPool.length,

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

        success: true,

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

      success: false,

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
      "Product: " +
      PRODUCT_TYPE
    );

    log(
      "Server listening on port " +
      PORT
    );

    /*
    Render ayağa kalktıktan kısa süre sonra
    ilk radar çalışır.
    */

    setTimeout(
      () => {

        backgroundRadar();

      },
      5000
    );

    /*
    Her dakika radar.

    Discovery gerektiğinde kendi içinde
    5 dakikalık kontrol yapar.
    */

    setInterval(
      () => {

        backgroundRadar();

      },
      CONFIG.RADAR_INTERVAL_MS
    );

  }
);
