const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

const SYSTEM_NAME = "Sonny AI Signal Scanner V4";
const BITGET_BASE = "https://api.bitget.com";
const PRODUCT_TYPE = "usdt-futures";

let lastScan = null;
let scanRunning = false;
let cachedResult = null;
let lastError = null;

let marketCache = [];
let opportunityPool = [];
let lastDiscovery = null;

const CONFIG = {
  RADAR_INTERVAL_MS: 60 * 1000,

  DISCOVERY_INTERVAL_MS: 5 * 60 * 1000,

  MIN_QUOTE_VOLUME_USDT: 3000000,

  DISCOVERY_LIMIT: 100,

  RADAR_CANDIDATES: 70,

  BATCH_SIZE: 8,

  BATCH_DELAY_MS: 150,

  FIVE_MIN_LIMIT: 240,

  ONE_HOUR_LIMIT: 160,

  FOUR_HOUR_LIMIT: 100,

  MIN_SIGNAL_SCORE: 76,

  MIN_ARMED_SCORE: 68,

  MAX_SIGNALS: 15,

  MAX_ARMED: 20,

  MAX_WATCHLIST: 25,

  ATR_STOP_MULTIPLIER: 1.2,

  MIN_RR_TP1: 1.4,

  MIN_RR_TP2: 2.0,

  MIN_RR_TP3: 2.8
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

function number(value, digits = 4) {
  if (!Number.isFinite(value)) return 0;

  return Number(value.toFixed(digits));
}

function percentage(value, base) {
  if (
    !Number.isFinite(value) ||
    !Number.isFinite(base) ||
    base === 0
  ) {
    return 0;
  }

  return (value / base) * 100;
}

/*
=========================================================
BITGET
=========================================================
*/

async function bitget(path, params = {}) {
  const url = new URL(BITGET_BASE + path);

  Object.entries(params).forEach(([key, value]) => {
    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      url.searchParams.set(key, String(value));
    }
  });

  const response = await fetch(url.toString());
  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Bitget HTTP ${response.status} - ${path} - ${text.slice(
        0,
        300
      )}`
    );
  }

  let json;

  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `Bitget JSON parse error - ${path}`
    );
  }

  if (json.code !== "00000") {
    throw new Error(
      `Bitget API ${json.code} - ${
        json.msg || "Unknown error"
      }`
    );
  }

  return json.data;
}

/*
=========================================================
INDICATORS
=========================================================
*/

function sma(values, period) {
  if (!values || values.length < period) {
    return null;
  }

  const slice = values.slice(-period);

  return (
    slice.reduce((sum, value) => sum + value, 0) /
    period
  );
}

function ema(values, period) {
  if (!values || values.length < period) {
    return null;
  }

  const multiplier = 2 / (period + 1);

  let result =
    values
      .slice(0, period)
      .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    result =
      (values[i] - result) * multiplier + result;
  }

  return result;
}

function rsi(values, period = 14) {
  if (!values || values.length <= period) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change =
      values[i] - values[i - 1];

    if (change >= 0) {
      gains += change;
    } else {
      losses -= change;
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {
    const change =
      values[i] - values[i - 1];

    const gain =
      change > 0 ? change : 0;

    const loss =
      change < 0 ? -change : 0;

    avgGain =
      (avgGain * (period - 1) + gain) /
      period;

    avgLoss =
      (avgLoss * (period - 1) + loss) /
      period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;

  return 100 - 100 / (1 + rs);
}

function atr(candles, period = 14) {
  if (
    !candles ||
    candles.length <= period
  ) {
    return null;
  }

  const trs = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    const tr = Math.max(
      current.high - current.low,
      Math.abs(
        current.high - previous.close
      ),
      Math.abs(
        current.low - previous.close
      )
    );

    trs.push(tr);
  }

  return sma(trs, period);
}

function highest(candles, count) {
  if (!candles || candles.length === 0) {
    return null;
  }

  const slice = candles.slice(-count);

  return Math.max(
    ...slice.map(candle => candle.high)
  );
}

function lowest(candles, count) {
  if (!candles || candles.length === 0) {
    return null;
  }

  const slice = candles.slice(-count);

  return Math.min(
    ...slice.map(candle => candle.low)
  );
}

/*
=========================================================
CANDLE PARSER
=========================================================
*/

function parseBitgetCandles(data) {
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
      volume: Number(row[5]),
      quoteVolume: Number(row[6] || 0)
    }))
    .filter(
      candle =>
        Number.isFinite(candle.close) &&
        Number.isFinite(candle.high) &&
        Number.isFinite(candle.low)
    )
    .sort(
      (a, b) => a.time - b.time
    );
}

/*
=========================================================
MARKET DISCOVERY
=========================================================
*/

async function discoverMarket() {
  log("Bitget piyasası yeniden keşfediliyor...");

  const [contracts, tickers] =
    await Promise.all([
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

  const validSymbols = new Set(
    contracts
      .filter(contract => {
        return (
          contract.symbolType ===
            "perpetual" &&
          contract.symbolStatus ===
            "normal" &&
          contract.quoteCoin === "USDT"
        );
      })
      .map(
        contract => contract.symbol
      )
  );

  const market = tickers
    .filter(ticker =>
      validSymbols.has(ticker.symbol)
    )
    .map(ticker => {
      const price = Number(
        ticker.lastPr
      );

      const high24h = Number(
        ticker.high24h
      );

      const low24h = Number(
        ticker.low24h
      );

      const volume24h = Number(
        ticker.quoteVolume || 0
      );

      const rawChange = Number(
        ticker.change24h || 0
      );

      const change24h =
        Math.abs(rawChange) <= 1
          ? rawChange * 100
          : rawChange;

      const range24h =
        price > 0
          ? percentage(
              high24h - low24h,
              price
            )
          : 0;

      return {
        symbol: ticker.symbol,
        price,
        change24h,
        volume24h,
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
      let score = 0;

      if (item.volume24h >= 100000000) {
        score += 30;
      } else if (
        item.volume24h >= 30000000
      ) {
        score += 25;
      } else if (
        item.volume24h >= 10000000
      ) {
        score += 18;
      } else {
        score += 10;
      }

      const movement =
        Math.abs(item.change24h);

      if (movement >= 7) {
        score += 30;
      } else if (movement >= 4) {
        score += 25;
      } else if (movement >= 2) {
        score += 18;
      } else {
        score += 8;
      }

      if (item.range24h >= 10) {
        score += 30;
      } else if (
        item.range24h >= 6
      ) {
        score += 25;
      } else if (
        item.range24h >= 3
      ) {
        score += 15;
      }

      return {
        ...item,
        discoveryScore: score
      };
    })
    .sort(
      (a, b) =>
        b.discoveryScore -
        a.discoveryScore
    );

  marketCache = market.slice(
    0,
    CONFIG.DISCOVERY_LIMIT
  );

  lastDiscovery =
    new Date().toISOString();

  log(
    `Discovery tamamlandı. ${market.length} uygun coin bulundu.`
  );

  return marketCache;
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
  const data = await bitget(
    "/api/v2/mix/market/candles",
    {
      symbol,
      productType: PRODUCT_TYPE,
      granularity,
      limit
    }
  );

  return parseBitgetCandles(data);
}

/*
=========================================================
4H ANA YÖN
=========================================================
*/

function analyze4H(candles) {
  if (candles.length < 60) {
    return null;
  }

  const closed = candles.slice(0, -1);

  const current =
    closed[closed.length - 1];

  const closes = closed.map(
    c => c.close
  );

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);

  const currentRsi = rsi(
    closes,
    14
  );

  if (
    ema20 === null ||
    ema50 === null
  ) {
    return null;
  }

  const bullish =
    current.close > ema20 &&
    ema20 > ema50;

  const bearish =
    current.close < ema20 &&
    ema20 < ema50;

  let direction = "NEUTRAL";

  if (bullish) {
    direction = "LONG";
  } else if (bearish) {
    direction = "SHORT";
  }

  return {
    current,
    ema20,
    ema50,
    rsi: currentRsi,
    direction
  };
}

/*
=========================================================
1H KURULUM
=========================================================
*/

function analyze1H(candles) {
  if (candles.length < 70) {
    return null;
  }

  const closed = candles.slice(0, -1);

  const current =
    closed[closed.length - 1];

  const closes = closed.map(
    c => c.close
  );

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);

  const currentRsi = rsi(
    closes,
    14
  );

  const currentAtr = atr(
    closed,
    14
  );

  const avgVolume = sma(
    closed.map(
      c => c.volume
    ),
    30
  );

  const volumeRatio =
    avgVolume > 0
      ? current.volume / avgVolume
      : 0;

  const resistance =
    highest(closed.slice(0, -1), 20);

  const support =
    lowest(closed.slice(0, -1), 20);

  const bullish =
    current.close > ema20 &&
    ema20 > ema50;

  const bearish =
    current.close < ema20 &&
    ema20 < ema50;

  const compression =
    currentAtr &&
    current.close > 0
      ? percentage(
          currentAtr,
          current.close
        ) < 2.5
      : false;

  return {
    current,
    ema20,
    ema50,
    rsi: currentRsi,
    atr: currentAtr,
    volumeRatio,
    resistance,
    support,
    bullish,
    bearish,
    compression
  };
}

/*
=========================================================
5M GİRİŞ TETİĞİ
=========================================================
*/

function analyze5M(candles) {
  if (candles.length < 120) {
    return null;
  }

  const closed = candles.slice(0, -1);

  const current =
    closed[closed.length - 1];

  const previous =
    closed[closed.length - 2];

  const closes = closed.map(
    c => c.close
  );

  const ema9 = ema(closes, 9);
  const ema20 = ema(closes, 20);

  const currentRsi = rsi(
    closes,
    14
  );

  const currentAtr = atr(
    closed,
    14
  );

  const avgVolume = sma(
    closed.map(
      c => c.volume
    ),
    30
  );

  const volumeRatio =
    avgVolume > 0
      ? current.volume / avgVolume
      : 0;

  const resistance =
    highest(closed.slice(0, -1), 12);

  const support =
    lowest(closed.slice(0, -1), 12);

  const bullishMomentum =
    current.close > ema9 &&
    ema9 > ema20;

  const bearishMomentum =
    current.close < ema9 &&
    ema9 < ema20;

  const longBreak =
    current.close > resistance &&
    previous.close <= resistance;

  const shortBreak =
    current.close < support &&
    previous.close >= support;

  return {
    current,
    ema9,
    ema20,
    rsi: currentRsi,
    atr: currentAtr,
    volumeRatio,
    resistance,
    support,
    bullishMomentum,
    bearishMomentum,
    longBreak,
    shortBreak
  };
}

/*
=========================================================
TRADE PLAN
=========================================================
*/

function buildTradePlan(
  direction,
  price,
  atrValue,
  oneHour
) {
  if (
    !Number.isFinite(price) ||
    price <= 0
  ) {
    return null;
  }

  const atrSafe =
    atrValue && atrValue > 0
      ? atrValue
      : price * 0.01;

  let entryLow;
  let entryHigh;
  let stop;
  let risk;

  if (direction === "LONG") {
    entryLow = price * 0.998;
    entryHigh = price * 1.002;

    const structureStop =
      oneHour.support || price - atrSafe;

    stop = Math.min(
      structureStop,
      price - atrSafe * CONFIG.ATR_STOP_MULTIPLIER
    );

    if (stop >= entryLow) {
      stop =
        price -
        atrSafe * CONFIG.ATR_STOP_MULTIPLIER;
    }

    risk =
      price - stop;
  } else {
    entryLow = price * 0.998;
    entryHigh = price * 1.002;

    const structureStop =
      oneHour.resistance || price + atrSafe;

    stop = Math.max(
      structureStop,
      price + atrSafe * CONFIG.ATR_STOP_MULTIPLIER
    );

    if (stop <= entryHigh) {
      stop =
        price +
        atrSafe * CONFIG.ATR_STOP_MULTIPLIER;
    }

    risk =
      stop - price;
  }

  if (
    !Number.isFinite(risk) ||
    risk <= 0
  ) {
    return null;
  }

  const tp1 =
    direction === "LONG"
      ? price + risk * CONFIG.MIN_RR_TP1
      : price - risk * CONFIG.MIN_RR_TP1;

  const tp2 =
    direction === "LONG"
      ? price + risk * CONFIG.MIN_RR_TP2
      : price - risk * CONFIG.MIN_RR_TP2;

  const tp3 =
    direction === "LONG"
      ? price + risk * CONFIG.MIN_RR_TP3
      : price - risk * CONFIG.MIN_RR_TP3;

  return {
    entryLow: number(entryLow, 8),
    entryHigh: number(entryHigh, 8),
    stop: number(stop, 8),
    tp1: number(tp1, 8),
    tp2: number(tp2, 8),
    tp3: number(tp3, 8),
    riskPercent: number(
      percentage(risk, price),
      2
    ),
    rr1: CONFIG.MIN_RR_TP1,
    rr2: CONFIG.MIN_RR_TP2,
    rr3: CONFIG.MIN_RR_TP3
  };
}

/*
=========================================================
SETUP ENGINE
=========================================================
*/

function buildSetup(
  marketItem,
  fourHour,
  oneHour,
  fiveMinute
) {
  if (
    !fourHour ||
    !oneHour ||
    !fiveMinute
  ) {
    return null;
  }

  let longScore = 0;
  let shortScore = 0;

  const reasonsLong = [];
  const reasonsShort = [];

  /*
  4H YÖN
  */

  if (fourHour.direction === "LONG") {
    longScore += 25;
    reasonsLong.push(
      "4H ana yön yükseliş"
    );
  }

  if (fourHour.direction === "SHORT") {
    shortScore += 25;
    reasonsShort.push(
      "4H ana yön düşüş"
    );
  }

  /*
  1H TREND
  */

  if (oneHour.bullish) {
    longScore += 18;
    reasonsLong.push(
      "1H trend yukarı"
    );
  }

  if (oneHour.bearish) {
    shortScore += 18;
    reasonsShort.push(
      "1H trend aşağı"
    );
  }

  /*
  5M MOMENTUM
  */

  if (
    fiveMinute.bullishMomentum
  ) {
    longScore += 15;
    reasonsLong.push(
      "5M momentum yukarı"
    );
  }

  if (
    fiveMinute.bearishMomentum
  ) {
    shortScore += 15;
    reasonsShort.push(
      "5M momentum aşağı"
    );
  }

  /*
  RSI
  */

  if (
    fiveMinute.rsi >= 52 &&
    fiveMinute.rsi <= 70
  ) {
    longScore += 8;
    reasonsLong.push(
      "5M RSI LONG bölgesinde"
    );
  }

  if (
    fiveMinute.rsi <= 48 &&
    fiveMinute.rsi >= 30
  ) {
    shortScore += 8;
    reasonsShort.push(
      "5M RSI SHORT bölgesinde"
    );
  }

  /*
  HACİM
  */

  if (
    fiveMinute.volumeRatio >= 1.2
  ) {
    longScore += 8;
    shortScore += 8;
  }

  if (
    fiveMinute.volumeRatio >= 1.5
  ) {
    longScore += 5;
    shortScore += 5;
  }

  /*
  KIRILIM
  */

  if (fiveMinute.longBreak) {
    longScore += 20;

    reasonsLong.push(
      "5M direnç kırılımı gerçekleşti"
    );
  }

  if (fiveMinute.shortBreak) {
    shortScore += 20;

    reasonsShort.push(
      "5M destek kırılımı gerçekleşti"
    );
  }

  /*
  MARKET DISCOVERY
  */

  const discoveryBonus = Math.min(
    marketItem.discoveryScore * 0.08,
    8
  );

  longScore += discoveryBonus;
  shortScore += discoveryBonus;

  /*
  YÖN
  */

  let direction;
  let rawScore;
  let reasons;
  let trigger = false;

  if (longScore >= shortScore) {
    direction = "LONG";
    rawScore = longScore;
    reasons = reasonsLong;
    trigger = fiveMinute.longBreak;
  } else {
    direction = "SHORT";
    rawScore = shortScore;
    reasons = reasonsShort;
    trigger = fiveMinute.shortBreak;
  }

  /*
  4H TERS YÖNÜ ENGELLEME

  Ana yapı LONG iken güçlü SHORT
  sinyali üretmemek için kalite düşürülür.
  */

  if (
    direction === "LONG" &&
    fourHour.direction === "SHORT"
  ) {
    rawScore -= 15;
  }

  if (
    direction === "SHORT" &&
    fourHour.direction === "LONG"
  ) {
    rawScore -= 15;
  }

  const score = Math.max(
    0,
    Math.min(
      100,
      Math.round(rawScore)
    )
  );

  let state = "WATCH";

  if (
    trigger &&
    score >= CONFIG.MIN_SIGNAL_SCORE
  ) {
    state = "SIGNAL";
  } else {
    const triggerLevel =
      direction === "LONG"
        ? fiveMinute.resistance
        : fiveMinute.support;

    const distance =
      direction === "LONG"
        ? percentage(
            triggerLevel - fiveMinute.current.close,
            fiveMinute.current.close
          )
        : percentage(
            fiveMinute.current.close - triggerLevel,
            fiveMinute.current.close
          );

    if (
      score >= CONFIG.MIN_ARMED_SCORE &&
      distance >= 0 &&
      distance <= 1
    ) {
      state = "ARMED";
    }
  }

  /*
  TRADE PLAN
  */

  const tradePlan =
    buildTradePlan(
      direction,
      fiveMinute.current.close,
      fiveMinute.atr,
      oneHour
    );

  /*
  TETİK SEVİYESİ
  */

  const triggerLevel =
    direction === "LONG"
      ? fiveMinute.resistance
      : fiveMinute.support;

  const distanceToTrigger =
    direction === "LONG"
      ? percentage(
          triggerLevel -
            fiveMinute.current.close,
          fiveMinute.current.close
        )
      : percentage(
          fiveMinute.current.close -
            triggerLevel,
          fiveMinute.current.close
        );

  let strategy =
    "ÇOKLU ZAMAN DİLİMİ";

  if (trigger) {
    strategy =
      direction === "LONG"
        ? "5M YUKARI KIRILIM"
        : "5M AŞAĞI KIRILIM";
  } else if (
    oneHour.compression
  ) {
    strategy =
      "SIKIŞMA + KIRILIM BEKLENTİSİ";
  } else if (
    oneHour.volumeRatio >= 1.5
  ) {
    strategy =
      "HACİM DESTEKLİ HAREKET";
  } else {
    strategy =
      "TREND DEVAMI";
  }

  let statusText = "";

  if (state === "SIGNAL") {
    statusText =
      direction === "LONG"
        ? "Yukarı kırılım gerçekleşti."
        : "Aşağı kırılım gerçekleşti.";
  } else if (state === "ARMED") {
    statusText =
      direction === "LONG"
        ? `${number(triggerLevel, 8)} üzerine çıkarsa LONG tetiklenebilir.`
        : `${number(triggerLevel, 8)} altına inerse SHORT tetiklenebilir.`;
  } else {
    statusText =
      "Henüz giriş için yeterince güçlü değil.";
  }

  return {
    symbol: marketItem.symbol,

    direction,

    state,

    score,

    strategy,

    statusText,

    price: number(
      fiveMinute.current.close,
      8
    ),

    triggerLevel: number(
      triggerLevel,
      8
    ),

    distanceToTrigger: number(
      distanceToTrigger,
      3
    ),

    fourHourDirection:
      fourHour.direction,

    fourHourRsi: number(
      fourHour.rsi,
      1
    ),

    oneHourRsi: number(
      oneHour.rsi,
      1
    ),

    fiveMinuteRsi: number(
      fiveMinute.rsi,
      1
    ),

    volumeRatio: number(
      fiveMinute.volumeRatio,
      2
    ),

    change24h: number(
      marketItem.change24h,
      2
    ),

    volume24h: number(
      marketItem.volume24h /
        1000000,
      2
    ),

    reasons,

    tradePlan,

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
      oneHour,
      fourHour
    ] = await Promise.all([
      getCandles(
        marketItem.symbol,
        "5m",
        CONFIG.FIVE_MIN_LIMIT
      ),

      getCandles(
        marketItem.symbol,
        "1H",
        CONFIG.ONE_HOUR_LIMIT
      ),

      getCandles(
        marketItem.symbol,
        "4H",
        CONFIG.FOUR_HOUR_LIMIT
      )
    ]);

    if (
      fiveMinute.length < 120 ||
      oneHour.length < 70 ||
      fourHour.length < 60
    ) {
      return null;
    }

    const five =
      analyze5M(fiveMinute);

    const one =
      analyze1H(oneHour);

    const four =
      analyze4H(fourHour);

    return buildSetup(
      marketItem,
      four,
      one,
      five
    );
  } catch (error) {
    log(
      `Coin analysis error ${marketItem.symbol}: ${error.message}`
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
  if (scanRunning) {
    return cachedResult;
  }

  scanRunning = true;
  lastError = null;

  const started = Date.now();

  try {
    /*
    Her 5 dakikada piyasa keşfi.
    Fakat teknik radar HER DAKİKA çalışır.
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
    Her dakika fırsat havuzu
    yeniden sıralanıyor.
    */

    opportunityPool =
      marketCache
        .slice()
        .sort(
          (a, b) =>
            b.discoveryScore -
            a.discoveryScore
        )
        .slice(
          0,
          CONFIG.RADAR_CANDIDATES
        );

    log(
      `Radar başladı. ${opportunityPool.length} coin analiz edilecek.`
    );

    const results = [];

    for (
      let i = 0;
      i < opportunityPool.length;
      i += CONFIG.BATCH_SIZE
    ) {
      const batch =
        opportunityPool.slice(
          i,
          i + CONFIG.BATCH_SIZE
        );

      const batchResults =
        await Promise.all(
          batch.map(
            item =>
              analyzeCoin(item)
          )
        );

      batchResults.forEach(result => {
        if (result) {
          results.push(result);
        }
      });

      await sleep(
        CONFIG.BATCH_DELAY_MS
      );
    }

    /*
    EN YÜKSEK PUANLAR
    */

    results.sort(
      (a, b) =>
        b.score - a.score
    );

    const signals =
      results
        .filter(
          item =>
            item.state === "SIGNAL"
        )
        .slice(
          0,
          CONFIG.MAX_SIGNALS
        );

    const armed =
      results
        .filter(
          item =>
            item.state === "ARMED"
        )
        .slice(
          0,
          CONFIG.MAX_ARMED
        );

    const watchlist =
      results
        .filter(
          item =>
            item.state === "WATCH"
        )
        .slice(
          0,
          CONFIG.MAX_WATCHLIST
        );

    const elapsed =
      (
        (Date.now() - started) /
        1000
      ).toFixed(1);

    cachedResult = {
      success: true,

      system:
        SYSTEM_NAME,

      timestamp:
        new Date().toISOString(),

      refreshIntervalSeconds: 60,

      engine: {
        dataSource: "BITGET",
        product:
          "USDT PERPETUAL FUTURES",

        mainTimeframe: "4H",
        setupTimeframe: "1H",
        entryTimeframe: "5M",

        logic:
          "4H YÖN → 1H KURULUM → 5M GİRİŞ",

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
          Number(elapsed),

        analyzed:
          results.length
      },

      signals,

      armed,

      watchlist,

      stats: {
        signals:
          signals.length,

        armed:
          armed.length,

        watchlist:
          watchlist.length
      },

      mode:
        "MANUAL TRADING ONLY"
    };

    lastScan =
      new Date().toISOString();

    log(
      `RADAR tamamlandı | Market: ${marketCache.length} | Analiz: ${results.length} | SIGNAL: ${signals.length} | ARMED: ${armed.length}`
    );

    return cachedResult;
  } catch (error) {
    lastError =
      error.message;

    log(
      `RADAR ERROR: ${error.message}`
    );

    return {
      success: false,
      error: error.message,
      system: SYSTEM_NAME
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
<meta name="viewport" content="width=device-width, initial-scale=1.0">

<title>Sonny AI Signal Scanner V4</title>

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
  width: min(1450px, 94%);
  margin: 28px auto;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 20px;
  margin-bottom: 24px;
}

.title {
  font-size: 29px;
  font-weight: 900;
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
  white-space: nowrap;
}

.grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
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
  font-weight: 900;
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
  color: #9aaacc;
  line-height: 1.7;
}

.engine-flow {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin: 15px 0;
}

.flow {
  padding: 10px 14px;
  background: #1a2540;
  border-radius: 9px;
  font-weight: 800;
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

.status {
  margin-top: 15px;
  background: #0d1527;
  border: 1px solid #2a3a59;
  border-radius: 9px;
  padding: 14px;
  color: #9fb0d0;
}

.signal-card {
  background: #0d1728;
  border: 1px solid #29405f;
  border-radius: 14px;
  padding: 18px;
  margin-bottom: 15px;
}

.signal-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 15px;
  flex-wrap: wrap;
}

.coin {
  font-size: 22px;
  font-weight: 900;
}

.long {
  color: #42e88b;
}

.short {
  color: #ff637d;
}

.score {
  font-size: 20px;
  font-weight: 900;
}

.signal-info {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 10px;
  margin-top: 15px;
}

.info {
  background: #111d32;
  border-radius: 9px;
  padding: 11px;
}

.info-label {
  font-size: 10px;
  color: #7185ac;
  margin-bottom: 5px;
}

.info-value {
  font-weight: 900;
}

.trade-plan {
  margin-top: 15px;
  padding: 15px;
  background: #101b30;
  border-radius: 10px;
}

.trade-title {
  font-weight: 900;
  margin-bottom: 12px;
}

.trade-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 9px;
}

.trade {
  padding: 10px;
  border-radius: 8px;
  background: #17233b;
}

.trade small {
  display: block;
  color: #7185ac;
  margin-bottom: 5px;
}

.reasons {
  margin-top: 14px;
  color: #b7c3d9;
  line-height: 1.7;
}

.armed-card {
  background: #101a2d;
  border: 1px solid #5d5124;
  border-radius: 12px;
  padding: 15px;
  margin-bottom: 12px;
}

.armed-head {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
}

.trigger {
  margin-top: 10px;
  font-weight: 800;
  color: #f7c95c;
}

.watch-row {
  display: grid;
  grid-template-columns: 1.4fr 1fr 1fr 1fr 1fr;
  gap: 8px;
  padding: 12px 5px;
  border-bottom: 1px solid #1d2940;
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
    grid-template-columns: repeat(3, 1fr);
  }

  .signal-info,
  .trade-grid {
    grid-template-columns: repeat(3, 1fr);
  }
}

@media(max-width: 700px) {
  .grid {
    grid-template-columns: repeat(2, 1fr);
  }

  .header {
    display: block;
  }

  .online {
    display: inline-block;
    margin-top: 15px;
  }

  .signal-info,
  .trade-grid {
    grid-template-columns: repeat(2, 1fr);
  }

  .watch-row {
    grid-template-columns: 1fr 1fr;
  }
}

</style>
</head>

<body>

<div class="container">

<div class="header">

<div>
<div class="title">
🚀 Sonny AI Signal Scanner V4
</div>

<div class="subtitle">
4H Ana Yön · 1H Fırsat · 5M Giriş · Her Dakika Yeni Tarama
</div>
</div>

<div class="online">
● BITGET ONLINE
</div>

</div>

<div class="grid">

<div class="card">
<div class="label">Piyasa</div>
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
<div class="label">Sinyal</div>
<div class="value" id="signals">0</div>
</div>

<div class="card">
<div class="label">Hazırlanıyor</div>
<div class="value" id="armed">0</div>
</div>

<div class="card">
<div class="label">Son Tarama</div>
<div class="value" id="last">-</div>
</div>

</div>

<div class="panel">

<h2>🧠 Sistem Nasıl Çalışıyor?</h2>

<p class="muted">
Sistem her dakika Bitget piyasasını yeniden kontrol eder.
Önce 4 saatlik grafikte ana yönü bulur.
Sonra 1 saatlik grafikte fırsatı arar.
Son olarak 5 dakikalık grafikte gerçek giriş tetikleyicisini kontrol eder.
</p>

<div class="engine-flow">
<div class="flow">4H → ANA YÖN</div>
<div class="flow">1H → FIRSAT</div>
<div class="flow">5M → GİRİŞ</div>
<div class="flow">STOP → RİSK</div>
<div class="flow">TP1 / TP2 / TP3 → KÂR</div>
</div>

<button onclick="scan()">
🔎 Şimdi Tara
</button>

<button class="secondary" onclick="loadResult()">
↻ Yenile
</button>

<div class="status" id="status">
Motor hazırlanıyor...
</div>

</div>

<div class="panel">

<h2>🚨 GERÇEK SİNYALLER</h2>

<div id="signalsTable">
<div class="empty">
Henüz güçlü sinyal oluşmadı.
</div>
</div>

</div>

<div class="panel">

<h2>🟡 HAZIRLANAN FIRSATLAR</h2>

<div id="armedTable">
<div class="empty">
Şu anda güçlü bir aday yok.
</div>
</div>

</div>

<div class="panel">

<h2>👀 TAKİP LİSTESİ</h2>

<div id="watchlist">
<div class="empty">
İzlenecek coin bulunamadı.
</div>
</div>

</div>

<div class="small">
Sonny AI Signal Scanner V4 ·
Bitget Futures ·
4H + 1H + 5M ·
Manual Trading Only
</div>

</div>

<script>

function setStatus(text) {
  document.getElementById("status").innerText = text;
}

function directionClass(direction) {
  return direction === "LONG"
    ? "long"
    : "short";
}

function formatNumber(value) {
  if (value === null || value === undefined) {
    return "-";
  }

  return value;
}

function renderSignals(items) {

  const box =
    document.getElementById(
      "signalsTable"
    );

  if (!items || items.length === 0) {
    box.innerHTML =
      '<div class="empty">' +
      'Şu anda tetiklenmiş güçlü sinyal yok.' +
      '</div>';

    return;
  }

  let html = "";

  items.forEach(function(item) {

    const plan =
      item.tradePlan;

    html +=
      '<div class="signal-card">';

    html +=
      '<div class="signal-head">';

    html +=
      '<div class="coin">' +
      item.symbol +
      ' <span class="' +
      directionClass(item.direction) +
      '">' +
      item.direction +
      '</span></div>';

    html +=
      '<div class="score">' +
      'GÜÇ ' +
      item.score +
      '/100' +
      '</div>';

    html += '</div>';

    html +=
      '<div class="muted" style="margin-top:8px">' +
      item.strategy +
      ' · ' +
      item.statusText +
      '</div>';

    html +=
      '<div class="signal-info">';

    html +=
      '<div class="info">' +
      '<div class="info-label">4H ANA YÖN</div>' +
      '<div class="info-value">' +
      item.fourHourDirection +
      '</div></div>';

    html +=
      '<div class="info">' +
      '<div class="info-label">1H RSI</div>' +
      '<div class="info-value">' +
      item.oneHourRsi +
      '</div></div>';

    html +=
      '<div class="info">' +
      '<div class="info-label">5M RSI</div>' +
      '<div class="info-value">' +
      item.fiveMinuteRsi +
      '</div></div>';

    html +=
      '<div class="info">' +
      '<div class="info-label">HACİM</div>' +
      '<div class="info-value">' +
      item.volumeRatio +
      'x</div></div>';

    html +=
      '<div class="info">' +
      '<div class="info-label">24H HAREKET</div>' +
      '<div class="info-value">' +
      item.change24h +
      '%</div></div>';

    html += '</div>';

    if (plan) {

      html +=
        '<div class="trade-plan">';

      html +=
        '<div class="trade-title">' +
        '🎯 İŞLEM PLANI' +
        '</div>';

      html +=
        '<div class="trade-grid">';

      html +=
        '<div class="trade">' +
        '<small>GİRİŞ</small>' +
        plan.entryLow +
        ' - ' +
        plan.entryHigh +
        '</div>';

      html +=
        '<div class="trade">' +
        '<small>STOP</small>' +
        plan.stop +
        '</div>';

      html +=
        '<div class="trade">' +
        '<small>TP1</small>' +
        plan.tp1 +
        '</div>';

      html +=
        '<div class="trade">' +
        '<small>TP2</small>' +
        plan.tp2 +
        '</div>';

      html +=
        '<div class="trade">' +
        '<small>TP3</small>' +
        plan.tp3 +
        '</div>';

      html += '</div>';

      html +=
        '<div class="small" style="margin-top:10px">' +
        'Tahmini risk: %' +
        plan.riskPercent +
        ' · ' +
        'Risk/Getiri: ' +
        plan.rr1 +
        'R / ' +
        plan.rr2 +
        'R / ' +
        plan.rr3 +
        'R' +
        '</div>';

      html += '</div>';
    }

    html +=
      '<div class="reasons">' +
      '<b>Neden?</b> ' +
      item.reasons.join(" · ") +
      '</div>';

    html += '</div>';

  });

  box.innerHTML = html;
}

function renderArmed(items) {

  const box =
    document.getElementById(
      "armedTable"
    );

  if (!items || items.length === 0) {
    box.innerHTML =
      '<div class="empty">' +
      'Şu anda kırılıma yaklaşan güçlü aday yok.' +
      '</div>';

    return;
  }

  let html = "";

  items.forEach(function(item) {

    html +=
      '<div class="armed-card">';

    html +=
      '<div class="armed-head">';

    html +=
      '<div class="coin">' +
      item.symbol +
      ' <span class="' +
      directionClass(item.direction) +
      '">' +
      item.direction +
      '</span></div>';

    html +=
      '<div class="score">' +
      item.score +
      '/100' +
      '</div>';

    html += '</div>';

    html +=
      '<div class="muted" style="margin-top:7px">' +
      'Şu anki fiyat: ' +
      item.price +
      '</div>';

    html +=
      '<div class="trigger">' +
      '🔔 ' +
      item.statusText +
      '</div>';

    html +=
      '<div class="signal-info">';

    html +=
      '<div class="info">' +
      '<div class="info-label">4H YÖN</div>' +
      '<div class="info-value">' +
      item.fourHourDirection +
      '</div></div>';

    html +=
      '<div class="info">' +
      '<div class="info-label">TETİK</div>' +
      '<div class="info-value">' +
      item.triggerLevel +
      '</div></div>';

    html +=
      '<div class="info">' +
      '<div class="info-label">UZAKLIK</div>' +
      '<div class="info-value">' +
      item.distanceToTrigger +
      '%</div></div>';

    html +=
      '<div class="info">' +
      '<div class="info-label">5M RSI</div>' +
      '<div class="info-value">' +
      item.fiveMinuteRsi +
      '</div></div>';

    html +=
      '<div class="info">' +
      '<div class="info-label">HACİM</div>' +
      '<div class="info-value">' +
      item.volumeRatio +
      'x</div></div>';

    html += '</div>';

    if (item.tradePlan) {

      html +=
        '<div class="trade-plan">';

      html +=
        '<div class="trade-title">' +
        'Hazır işlem planı' +
        '</div>';

      html +=
        'Giriş: <b>' +
        item.tradePlan.entryLow +
        ' - ' +
        item.tradePlan.entryHigh +
        '</b> · ';

      html +=
        'Stop: <b>' +
        item.tradePlan.stop +
        '</b> · ';

      html +=
        'TP1: <b>' +
        item.tradePlan.tp1 +
        '</b> · ';

      html +=
        'TP2: <b>' +
        item.tradePlan.tp2 +
        '</b> · ';

      html +=
        'TP3: <b>' +
        item.tradePlan.tp3 +
        '</b>';

      html += '</div>';
    }

    html += '</div>';

  });

  box.innerHTML = html;
}

function renderWatchlist(items) {

  const box =
    document.getElementById(
      "watchlist"
    );

  if (!items || items.length === 0) {
    box.innerHTML =
      '<div class="empty">' +
      'İzlenecek coin bulunamadı.' +
      '</div>';

    return;
  }

  let html =
    '<div class="watch-row" style="font-weight:900;color:#7185ac">' +
    '<div>COIN</div>' +
    '<div>YÖN</div>' +
    '<div>PUAN</div>' +
    '<div>4H</div>' +
    '<div>5M RSI</div>' +
    '</div>';

  items.forEach(function(item) {

    html +=
      '<div class="watch-row">';

    html +=
      '<div><b>' +
      item.symbol +
      '</b></div>';

    html +=
      '<div class="' +
      directionClass(item.direction) +
      '">' +
      item.direction +
      '</div>';

    html +=
      '<div>' +
      item.score +
      '</div>';

    html +=
      '<div>' +
      item.fourHourDirection +
      '</div>';

    html +=
      '<div>' +
      item.fiveMinuteRsi +
      '</div>';

    html += '</div>';
  });

  box.innerHTML = html;
}

function updateDashboard(data) {

  if (!data) return;

  if (data.marketDiscovery) {

    document.getElementById("market")
      .innerText =
      data.marketDiscovery.totalCoins;

    document.getElementById("radar")
      .innerText =
      data.marketDiscovery.opportunityPool;
  }

  if (data.scan) {

    document.getElementById("analyzed")
      .innerText =
      data.scan.analyzed;
  }

  document.getElementById("signals")
    .innerText =
    data.signals
      ? data.signals.length
      : 0;

  document.getElementById("armed")
    .innerText =
    data.armed
      ? data.armed.length
      : 0;

  if (data.timestamp) {

    document.getElementById("last")
      .innerText =
      new Date(
        data.timestamp
      ).toLocaleTimeString(
        "tr-TR"
      );
  }

  renderSignals(data.signals);
  renderArmed(data.armed);
  renderWatchlist(data.watchlist);
}

async function scan() {

  setStatus(
    "Yeni piyasa taraması yapılıyor..."
  );

  try {

    const response =
      await fetch("/api/scan");

    const data =
      await response.json();

    if (!data.success) {

      setStatus(
        "Tarama hatası: " +
        data.error
      );

      return;
    }

    updateDashboard(data);

    setStatus(
      "Tarama tamamlandı. " +
      data.scan.analyzed +
      " coin analiz edildi. Sistem 60 saniye sonra tekrar tarayacak."
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
      await fetch("/api/result");

    const data =
      await response.json();

    if (data.result) {

      updateDashboard(
        data.result
      );

      setStatus(
        "Son radar sonucu yüklendi. Sistem her dakika yenileniyor."
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
      await fetch("/api/status");

    const data =
      await response.json();

    if (data.lastScan) {

      document.getElementById("last")
        .innerText =
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
        "Radar şu anda piyasayı tarıyor..."
      );
    }

  } catch(error) {

    setStatus(
      "Durum alınamadı."
    );
  }
}

loadResult();
loadStatus();

/*
Dashboard her 30 saniyede
son sonucu kontrol eder.
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

app.get("/", (req, res) => {

  res.setHeader(
    "Content-Type",
    "text/html; charset=utf-8"
  );

  res.send(HTML);
});

app.get("/health", (req, res) => {

  res.json({
    success: true,
    status: "healthy",
    system: SYSTEM_NAME,
    dataSource: "BITGET",
    uptime: process.uptime()
  });
});

app.get("/api/status", (req, res) => {

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

    timeframes: {
      main: "4H",
      setup: "1H",
      entry: "5M"
    },

    refresh:
      "60 SECONDS",

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
});

app.get(
  "/api/scan",
  async (req, res) => {

    const result =
      await runRadar();

    res.json(result);
  }
);

app.get(
  "/api/result",
  (req, res) => {

    if (!cachedResult) {

      return res.json({
        success: true,
        message:
          "Henüz radar sonucu oluşmadı.",
        result: null
      });
    }

    res.json(cachedResult);
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
      "Timeframes: 4H + 1H + 5M"
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
    */

    setTimeout(
      () => {
        runRadar();
      },
      5000
    );

    /*
    HER DAKİKA YENİ TARAMA.
    */

    setInterval(
      () => {
        runRadar();
      },
      CONFIG.RADAR_INTERVAL_MS
    );
  }
);
