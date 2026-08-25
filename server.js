const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const SYSTEM_NAME = "Sonny AI Signal Scanner V6.0 Adaptive";
const BITGET_BASE = "https://api.bitget.com";
const PRODUCT_TYPE = "usdt-futures";
const HISTORY_FILE = path.join(__dirname, "signal_history.json");

/*
=========================================================
SONNY V6.0 ADAPTIVE

ANA STRATEJİ:
4H kırılım + 2H onay + 1H trend + 15M retest + 5M timing
+ Hacim + Orderbook + Market Regime + Adaptive Performance

Sistem otomatik işlem açmaz.
Sadece sinyal üretir ve sinyali canlı takip eder.
=========================================================
*/

const CONFIG = {
  REFRESH_MS: 60 * 1000,
  UI_REFRESH_MS: 10000,

  MIN_VOLUME_USDT: 1000000,

  // Bitget'teki mümkün olan geniş USDT perpetual evreni
  MARKET_LIMIT: 600,

  // Ön eleme
  FAST_RADAR_LIMIT: 180,

  // Ağır teknik analiz
  ANALYZE_LIMIT: 90,

  // Orderbook sadece güçlü adaylarda
  FINAL_ORDERBOOK_LIMIT: 25,

  BATCH_SIZE: 8,
  BATCH_DELAY_MS: 80,

  FOUR_HOUR_LIMIT: 120,
  TWO_HOUR_LIMIT: 120,
  ONE_HOUR_LIMIT: 120,
  FIFTEEN_MIN_LIMIT: 180,
  FIVE_MIN_LIMIT: 120,

  LEVEL_LOOKBACK_4H: 40,
  LEVEL_LOOKBACK_2H: 40,
  LEVEL_LOOKBACK_1H: 30,

  BREAKOUT_RECENT_BARS: 8,

  RETEST_DISTANCE_PERCENT: 0.80,
  MAX_ENTRY_DISTANCE_PERCENT: 0.40,
  MISSED_BUFFER_PERCENT: 0.25,

  RSI_PERIOD: 14,

  RSI_LONG_MIN: 48,
  RSI_LONG_MAX: 68,

  RSI_SHORT_MIN: 32,
  RSI_SHORT_MAX: 52,

  MIN_SIGNAL_SCORE: 72,

  MAX_SIGNALS: 8,
  MAX_PREPARING: 8,
  MAX_MISSED: 15,

  MAX_HISTORY: 1000,

  VOLUME_STRONG_RATIO: 1.15,
  VOLUME_VERY_STRONG_RATIO: 1.50,

  FAKE_BREAKOUT_PERCENT: 0.20,

  ORDERBOOK_DEPTH: 15,
  ORDERBOOK_MIN_IMBALANCE: 1.20,
  ORDERBOOK_STRONG_IMBALANCE: 1.60,

  HOT_CHANGE_24H: 3.0,
  HOT_VOLUME_MULTIPLIER: 2.0,

  MISSED_COOLDOWN_MS: 15 * 60 * 1000,
  SIGNAL_COOLDOWN_MS: 60 * 60 * 1000
};

let marketCache = [];
let lastScan = null;
let scanRunning = false;
let cachedResult = null;
let lastError = null;
let discoveryTime = null;

const activeSignalStore = new Map();
const missedSignalStore = [];
const cooldowns = new Map();

let signalHistory = loadHistory();

/*
=========================================================
HELPERS
=========================================================
*/

function log(message) {
  console.log(
    `[${new Date().toISOString()}] ${message}`
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function round(value, digits = 6) {
  if (!Number.isFinite(Number(value))) return 0;

  return Number(
    Number(value).toFixed(digits)
  );
}

function pct(value, base) {
  if (
    !Number.isFinite(Number(value)) ||
    !Number.isFinite(Number(base)) ||
    Number(base) === 0
  ) {
    return 0;
  }

  return (
    Number(value) /
    Number(base)
  ) * 100;
}

function safeArray(value) {
  return Array.isArray(value)
    ? value
    : [];
}

function signalKey(signal) {
  return `${signal.symbol}:${signal.direction}`;
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
    "https://www.tradingview.com/chart/" +
    "?symbol=BITGET%3A" +
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

    const parsed =
      JSON.parse(
        fs.readFileSync(
          HISTORY_FILE,
          "utf8"
        )
      );

    return Array.isArray(parsed)
      ? parsed.slice(
          0,
          CONFIG.MAX_HISTORY
        )
      : [];

  } catch (error) {

    log(
      `History yüklenemedi: ${error.message}`
    );

    return [];
  }
}

function saveHistory() {

  try {

    signalHistory =
      signalHistory.slice(
        0,
        CONFIG.MAX_HISTORY
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
      `History kaydedilemedi: ${error.message}`
    );

  }
}

function addHistory(item) {

  signalHistory.unshift(item);

  signalHistory =
    signalHistory.slice(
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

function performanceStats() {

  const last50 =
    signalHistory.slice(
      0,
      50
    );

  const tradeResults =
    last50.filter(
      x =>
        [
          "TP1",
          "TP2",
          "TP3",
          "STOP"
        ].includes(
          x.result
        )
    );

  const tp1Hits =
    tradeResults.filter(
      x =>
        x.tp1Hit
    ).length;

  const stops =
    tradeResults.filter(
      x =>
        x.result === "STOP"
    ).length;

  const missed =
    last50.filter(
      x =>
        x.result === "MISSED"
    ).length;

  const invalid =
    last50.filter(
      x =>
        x.result === "INVALID"
    ).length;

  const longTrades =
    tradeResults.filter(
      x =>
        x.direction === "LONG"
    );

  const shortTrades =
    tradeResults.filter(
      x =>
        x.direction === "SHORT"
    );

  const sumR =
    tradeResults.reduce(
      (sum, x) =>
        sum +
        Number(
          x.realizedR || 0
        ),
      0
    );

  const avgR =
    tradeResults.length
      ? sumR /
        tradeResults.length
      : 0;

  const rate =
    (n, d) =>
      d
        ? round(
            (n / d) * 100,
            1
          )
        : 0;

  const strategyStats = {};

  for (
    const x of tradeResults
  ) {

    const key =
      x.strategy ||
      "UNKNOWN";

    if (
      !strategyStats[key]
    ) {

      strategyStats[key] = {
        total: 0,
        wins: 0,
        totalR: 0
      };

    }

    strategyStats[key].total++;

    if (
      Number(
        x.realizedR || 0
      ) > 0
    ) {
      strategyStats[key].wins++;
    }

    strategyStats[key].totalR +=
      Number(
        x.realizedR || 0
      );
  }

  Object.values(
    strategyStats
  ).forEach(v => {

    v.winRate =
      rate(
        v.wins,
        v.total
      );

    v.totalR =
      round(
        v.totalR,
        2
      );

  });

  return {

    window: 50,

    total:
      last50.length,

    resolved:
      tradeResults.length,

    missed,

    invalid,

    tp1Rate:
      rate(
        tp1Hits,
        tradeResults.length
      ),

    stopRate:
      rate(
        stops,
        tradeResults.length
      ),

    totalR:
      round(
        sumR,
        2
      ),

    averageR:
      round(
        avgR,
        2
      ),

    long: {

      total:
        longTrades.length,

      tp1Rate:
        rate(
          longTrades.filter(
            x => x.tp1Hit
          ).length,
          longTrades.length
        ),

      totalR:
        round(
          longTrades.reduce(
            (s, x) =>
              s +
              Number(
                x.realizedR || 0
              ),
            0
          ),
          2
        )

    },

    strategyStats,

    short: {

      total:
        shortTrades.length,

      tp1Rate:
        rate(
          shortTrades.filter(
            x => x.tp1Hit
          ).length,
          shortTrades.length
        ),

      totalR:
        round(
          shortTrades.reduce(
            (s, x) =>
              s +
              Number(
                x.realizedR || 0
              ),
            0
          ),
          2
        )

    },

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

  for (
    const [
      key,
      value
    ] of Object.entries(
      params
    )
  ) {

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

  const response =
    await fetch(
      url.toString(),
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
      `Bitget HTTP ${response.status} - ${text.slice(0, 200)}`
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
      `Bitget ${json.code} - ${json.msg || "Unknown error"}`
    );

  }

  return json.data;
}

function parseCandles(data) {

  return safeArray(
    data
  )
    .map(row => ({

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
        Number(
          row[6] || 0
        )

    }))
    .filter(
      c =>
        Number.isFinite(
          c.close
        )
    )
    .sort(
      (a, b) =>
        a.time -
        b.time
    );
}

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

  return parseCandles(
    data
  );
}

/*
=========================================================
INDICATORS
=========================================================
*/

function average(values) {

  const valid =
    values.filter(
      Number.isFinite
    );

  if (
    !valid.length
  ) {
    return 0;
  }

  return (
    valid.reduce(
      (a, b) =>
        a + b,
      0
    ) /
    valid.length
  );
}

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

  const k =
    2 /
    (period + 1);

  let value =
    average(
      values.slice(
        0,
        period
      )
    );

  for (
    let i = period;
    i < values.length;
    i++
  ) {

    value =
      values[i] * k +
      value *
        (1 - k);

  }

  return value;
}

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

      losses +=
        -change;

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

      safeArray(
        contracts
      )
        .filter(
          c =>
            c.symbolType ===
              "perpetual" &&
            c.symbolStatus ===
              "normal" &&
            c.quoteCoin ===
              "USDT"
        )
        .map(
          c =>
            c.symbol
        )

    );

  marketCache =
    safeArray(
      tickers
    )
      .filter(
        t =>
          validSymbols.has(
            t.symbol
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

            price,

            volume24h:
              volume,

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
        x =>
          Number.isFinite(
            x.price
          ) &&
          x.volume24h >=
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
    `Discovery tamamlandı. ${marketCache.length} uygun coin bulundu.`
  );

  return marketCache;
}

/*
=========================================================
LEVELS / BREAKOUT
=========================================================
*/

function getLevels(
  candles,
  lookback
) {

  if (
    !candles ||
    candles.length <
      lookback + 5
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

  return {

    current,

    resistance:
      Math.max(
        ...history.map(
          c =>
            c.high
        )
      ),

    support:
      Math.min(
        ...history.map(
          c =>
            c.low
        )
      ),

    previousClose:
      history[
        history.length - 1
      ].close

  };
}

function detectBreakout(
  candles,
  lookback,
  recentBars =
    CONFIG.BREAKOUT_RECENT_BARS
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
    candles.slice(
      0,
      -1
    );

  const resistance =
    levels.resistance;

  const support =
    levels.support;

  const start =
    Math.max(
      1,
      closed.length -
        recentBars
    );

  let longBreakout =
    false;

  let shortBreakout =
    false;

  let breakoutIndex =
    -1;

  let breakoutDirection =
    null;

  let volumeRatio =
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

    const avgVol =
      average(
        closed
          .slice(
            Math.max(
              0,
              i - 20
            ),
            i
          )
          .map(
            c =>
              c.quoteVolume ||
              c.volume
          )
      );

    const ratio =
      avgVol > 0
        ? (
            current.quoteVolume ||
            current.volume
          ) /
          avgVol
        : 1;

    if (
      current.close >
        resistance &&
      previous.close <=
        resistance
    ) {

      longBreakout =
        true;

      shortBreakout =
        false;

      breakoutIndex =
        i;

      breakoutDirection =
        "LONG";

      volumeRatio =
        ratio;

    }

    if (
      current.close <
        support &&
      previous.close >=
        support
    ) {

      shortBreakout =
        true;

      longBreakout =
        false;

      breakoutIndex =
        i;

      breakoutDirection =
        "SHORT";

      volumeRatio =
        ratio;

    }

  }

  let fakeBreakout =
    false;

  if (
    breakoutIndex >= 0 &&
    breakoutIndex <
      closed.length - 1
  ) {

    const breakoutCandle =
      closed[
        breakoutIndex
      ];

    const next =
      closed[
        closed.length - 1
      ];

    if (
      breakoutDirection ===
        "LONG" &&
      next.close <
        resistance *
          (
            1 -
            CONFIG.FAKE_BREAKOUT_PERCENT /
              100
          )
    ) {

      fakeBreakout =
        true;

    }

    if (
      breakoutDirection ===
        "SHORT" &&
      next.close >
        support *
          (
            1 +
            CONFIG.FAKE_BREAKOUT_PERCENT /
              100
          )
    ) {

      fakeBreakout =
        true;

    }

    if (
      !breakoutCandle
    ) {
      fakeBreakout =
        false;
    }

  }

  return {

    resistance,
    support,

    current:
      closed[
        closed.length - 1
      ],

    previous:
      closed[
        closed.length - 2
      ],

    longBreakout,
    shortBreakout,

    breakoutIndex,

    breakoutDirection,

    volumeRatio,

    fakeBreakout

  };
}

/*
=========================================================
MARKET DIRECTION
=========================================================
*/

function calculateMarketDirection() {

  const btc =
    marketCache.find(
      x =>
        x.symbol ===
        "BTCUSDT"
    );

  const eth =
    marketCache.find(
      x =>
        x.symbol ===
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
        "BTC / ETH verisi bekleniyor.",

      regime:
        "UNKNOWN"

    };

  }

  let bullish = 0;
  let bearish = 0;

  for (
    const item of targets
  ) {

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

  let direction =
    "YATAY";

  if (
    bullish > bearish
  ) {
    direction =
      "LONG";
  }

  if (
    bearish > bullish
  ) {
    direction =
      "SHORT";
  }

  const avgAbsMove =
    average(
      targets.map(
        x =>
          Math.abs(
            x.change24h
          )
      )
    );

  const regime =
    avgAbsMove >= 4
      ? "HIGH_VOL"
      : avgAbsMove >= 1.5
        ? "TRENDING"
        : "SIDEWAYS";

  const label =
    direction ===
      "LONG"
      ? "PİYASA YUKARI"
      : direction ===
        "SHORT"
        ? "PİYASA AŞAĞI"
        : "PİYASA YATAY";

  const reason =
    direction ===
      "LONG"

      ? "BTC / ETH hareketi yükseliş ağırlıklı."

      : direction ===
        "SHORT"

        ? "BTC / ETH hareketi düşüş ağırlıklı."

        : "BTC / ETH yönü karışık; seçici davranılıyor.";

  return {

    direction,

    label,

    reason,

    regime,

    avgAbsMove:
      round(
        avgAbsMove,
        2
      )

  };
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

function adaptivePerformanceBonus({
  strategy,
  direction,
  regime
}) {

  const resolved =
    signalHistory.filter(
      x =>
        [
          "TP1",
          "TP2",
          "TP3",
          "STOP"
        ].includes(
          x.result
        )
    );

  const relevant =
    resolved
      .filter(
        x =>
          (!strategy ||
            x.strategy ===
              strategy) &&

          (!direction ||
            x.direction ===
              direction) &&

          (!regime ||
            !x.marketRegime ||
            x.marketRegime ===
              regime)
      )
      .slice(
        0,
        50
      );

  const wins =
    relevant.filter(
      x =>
        Number(
          x.realizedR || 0
        ) > 0
    ).length;

  const n =
    relevant.length;

  const posterior =
    (
      wins + 5
    ) /
    (
      n + 10
    );

  return round(
    (
      posterior -
      0.5
    ) * 10,
    2
  );
}

/*
=========================================================
SCORE
=========================================================
*/

function calculateScore({
  direction,
  breakout4H,
  breakout2H,
  trend1H,
  retest,
  rsiOK,
  rsiValue,
  volumeRatio,
  marketDirection,
  orderbookScore,
  structureScore,
  squeezeScore,
  strategy,
  marketRegime
}) {

  let score = 0;

  if (
    breakout4H
  ) {
    score += 25;
  }

  if (
    breakout2H
  ) {
    score += 15;
  }

  if (
    trend1H
  ) {
    score += 15;
  }

  if (
    retest
  ) {
    score += 15;
  }

  if (
    rsiOK
  ) {
    score += 8;
  }

  if (
    volumeRatio >=
      CONFIG.VOLUME_VERY_STRONG_RATIO
  ) {

    score += 8;

  } else if (
    volumeRatio >=
      CONFIG.VOLUME_STRONG_RATIO
  ) {

    score += 5;

  } else if (
    volumeRatio >=
      0.9
  ) {

    score += 2;

  }

  if (
    marketDirection ===
    direction
  ) {

    score += 4;

  }

  score +=
    Math.max(
      -3,
      Math.min(
        5,
        orderbookScore || 0
      )
    );

  score +=
    Math.max(
      -2,
      Math.min(
        3,
        structureScore || 0
      )
    );

  score +=
    Math.max(
      -2,
      Math.min(
        3,
        squeezeScore || 0
      )
    );

  score +=
    adaptivePerformanceBonus({
      strategy,
      direction,
      regime:
        marketRegime
    });

  if (
    direction ===
      "LONG" &&
    rsiValue > 70
  ) {

    score -= 6;

  }

  if (
    direction ===
      "SHORT" &&
    rsiValue < 30
  ) {

    score -= 6;

  }

  return Math.max(
    0,
    Math.min(
      100,
      Math.round(
        score
      )
    )
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
  rsi: rsiValue,
  score,
  reason,
  volumeRatio,
  marketDirection,
  marketRegime,
  orderbook,
  strategy =
    "4H BREAKOUT + 2H CONFIRM + 1H TREND + RETEST"
}) {

  const entryLow =
    direction === "LONG"
      ? level * 0.998
      : level * 0.996;

  const entryHigh =
    direction === "LONG"
      ? level * 1.004
      : level * 1.002;

  const riskPercent =
    1.8;

  const stop =
    direction === "LONG"
      ? level *
        (
          1 -
          riskPercent / 100
        )
      : level *
        (
          1 +
          riskPercent / 100
        );

  const risk =
    Math.abs(
      level - stop
    );

  const tp1 =
    direction === "LONG"
      ? level +
        risk * 1.5
      : level -
        risk * 1.5;

  const tp2 =
    direction === "LONG"
      ? level +
        risk * 2
      : level -
        risk * 2;

  const tp3 =
    direction === "LONG"
      ? level +
        risk * 3
      : level -
        risk * 3;

  return {

    id:
      `${market.symbol}:${direction}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,

    symbol:
      market.symbol,

    direction,

    strategy,

    score,

    quality:
      qualityLabel(score),

    price:
      round(
        market.price,
        8
      ),

    entryLow:
      round(
        Math.min(
          entryLow,
          entryHigh
        ),
        8
      ),

    entryHigh:
      round(
        Math.max(
          entryLow,
          entryHigh
        ),
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
        rsiValue,
        1
      ),

    level:
      round(
        level,
        8
      ),

    volumeRatio:
      round(
        volumeRatio,
        2
      ),

    marketDirection,

    marketRegime,

    orderbook,

    change24h:
      round(
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
SIGNAL ENGINE
=========================================================
*/

function buildSignal({
  market,
  fourHour,
  twoHour,
  oneHour,
  fifteen,
  fiveMinute,
  marketDirection,
  orderbook
}) {

  if (
    !fourHour ||
    !twoHour ||
    !oneHour ||
    !fifteen
  ) {

    return null;

  }

  const closed15 =
    fifteen.slice(
      0,
      -1
    );

  const closes15 =
    closed15.map(
      c =>
        c.close
    );

  const rsiValue =
    rsi(
      closes15,
      CONFIG.RSI_PERIOD
    );

  if (
    rsiValue ===
    null
  ) {

    return null;

  }

  const strategy =
    "4H BREAKOUT + 2H CONFIRM + 1H TREND + RETEST";

  const marketRegime =
    marketDirection.regime;

  const orderRatio =
    orderbook?.ratio ||
    1;

  const obDirection =
    orderbook?.direction ||
    "NEUTRAL";

  const volumeRatio =
    Math.max(
      fourHour.volumeRatio || 1,
      twoHour.volumeRatio || 1,
      oneHour.volumeRatio || 1
    );

  const tryDirection =
    direction => {

      const breakout4H =
        direction ===
          "LONG"
          ? fourHour.longBreakout
          : fourHour.shortBreakout;

      const breakout2H =
        direction ===
          "LONG"
          ? twoHour.longBreakout
          : twoHour.shortBreakout;

      const trend1H =
        direction ===
          "LONG"
          ? oneHour.trend ===
            "LONG"
          : oneHour.trend ===
            "SHORT";

      const level =
        direction ===
          "LONG"
          ? fourHour.resistance
          : fourHour.support;

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

      if (
        !breakout4H ||
        !breakout2H ||
        !trend1H ||
        !retest ||
        !rsiOK
      ) {

        return null;

      }

      if (
        fourHour.fakeBreakout ||
        twoHour.fakeBreakout
      ) {

        return null;

      }

      if (
        obDirection !==
          "NEUTRAL" &&
        obDirection !==
          direction
      ) {

        return null;

      }

      const orderbookScore =
        obDirection ===
          direction

          ? (
              orderRatio >=
                CONFIG.ORDERBOOK_STRONG_IMBALANCE
                ? 5
                : orderRatio >=
                    CONFIG.ORDERBOOK_MIN_IMBALANCE
                  ? 3
                  : 1
            )

          : -3;

      const structureScore =
        oneHour.structure ===
          direction
          ? 3
          : 0;

      const squeezeScore =
        (
          fourHour.bbWidth !==
            null &&
          fourHour.bbWidth <=
            4
        )
          ? 3
          : 0;

      const score =
        calculateScore({

          direction,

          breakout4H,

          breakout2H,

          trend1H,

          retest,

          rsiOK,

          rsiValue,

          volumeRatio,

          marketDirection:
            marketDirection.direction,

          orderbookScore,

          structureScore,

          squeezeScore,

          strategy,

          marketRegime

        });

      if (
        score <
        CONFIG.MIN_SIGNAL_SCORE
      ) {

        return null;

      }

      const reason =
        `${
          direction === "LONG"
            ? "4H direnç"
            : "4H destek"
        } kırılımı + 2H onay + 1H ${direction} trend + retest + RSI ${round(rsiValue,1)} + hacim ${round(volumeRatio,2)}x` +
        `${
          orderbook
            ? ` + orderbook ${round(orderRatio,2)}x`
            : ""
        }.`;

      return createTradePlan({

        market,

        direction,

        level,

        rsi:
          rsiValue,

        score,

        volumeRatio,

        marketDirection:
          marketDirection.direction,

        marketRegime,

        orderbook,

        reason,

        strategy

      });

    };

  return (
    tryDirection(
      "LONG"
    ) ||
    tryDirection(
      "SHORT"
    )
  );
}

/*
=========================================================
PREPARING
=========================================================
*/

function buildPreparing({
  market,
  fourHour,
  twoHour,
  oneHour,
  fifteen,
  marketDirection
}) {

  if (
    !fourHour ||
    !twoHour ||
    !oneHour ||
    !fifteen
  ) {

    return null;

  }

  const closed15 =
    fifteen.slice(
      0,
      -1
    );

  const rsiValue =
    rsi(
      closed15.map(
        c =>
          c.close
      ),
      CONFIG.RSI_PERIOD
    );

  if (
    rsiValue ===
    null
  ) {

    return null;

  }

  const candidates = [];

  const longDistance =
    pct(
      fourHour.resistance -
        market.price,
      market.price
    );

  const shortDistance =
    pct(
      market.price -
        fourHour.support,
      market.price
    );

  if (
    longDistance >= 0 &&
    longDistance <= 1.2 &&
    oneHour.trend ===
      "LONG" &&
    rsiValue >= 45 &&
    rsiValue <= 68
  ) {

    candidates.push({

      symbol:
        market.symbol,

      direction:
        "LONG",

      price:
        round(
          market.price,
          8
        ),

      trigger:
        round(
          fourHour.resistance,
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

      marketDirection:
        marketDirection.direction,

      tradingView:
        tvUrl(
          market.symbol
        ),

      reason:
        "4H direnç yaklaşıyor; 1H trend LONG. Kırılım + 2H onayı bekleniyor."

    });

  }

  if (
    shortDistance >= 0 &&
    shortDistance <= 1.2 &&
    oneHour.trend ===
      "SHORT" &&
    rsiValue >= 32 &&
    rsiValue <= 55
  ) {

    candidates.push({

      symbol:
        market.symbol,

      direction:
        "SHORT",

      price:
        round(
          market.price,
          8
        ),

      trigger:
        round(
          fourHour.support,
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

      marketDirection:
        marketDirection.direction,

      tradingView:
        tvUrl(
          market.symbol
        ),

      reason:
        "4H destek yaklaşıyor; 1H trend SHORT. Kırılım + 2H onayı bekleniyor."

    });

  }

  return (
    candidates.sort(
      (a, b) =>
        a.distance -
        b.distance
    )[0] ||
    null
  );
}

/*
=========================================================
STRUCTURE
=========================================================
*/

function detectStructure(
  candles
) {

  if (
    !candles ||
    candles.length < 8
  ) {

    return "YATAY";

  }

  const a =
    candles.slice(
      -6
    );

  const highs =
    a.map(
      x =>
        x.high
    );

  const lows =
    a.map(
      x =>
        x.low
    );

  const hh =
    highs[
      highs.length - 1
    ] >
    highs[0];

  const hl =
    lows[
      lows.length - 1
    ] >
    lows[0];

  const lh =
    highs[
      highs.length - 1
    ] <
    highs[0];

  const ll =
    lows[
      lows.length - 1
    ] <
    lows[0];

  if (
    hh &&
    hl
  ) {

    return "LONG";

  }

  if (
    lh &&
    ll
  ) {

    return "SHORT";

  }

  return "YATAY";
}

/*
=========================================================
COIN ANALYSIS
=========================================================
*/

async function analyzeCoin(
  market,
  marketDirection
) {

  try {

    const [
      fourHour,
      twoHour,
      oneHour,
      fifteen,
      fiveMinute
    ] =
      await Promise.all([

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
          "1H",
          CONFIG.ONE_HOUR_LIMIT
        ),

        getCandles(
          market.symbol,
          "15m",
          CONFIG.FIFTEEN_MIN_LIMIT
        ),

        getCandles(
          market.symbol,
          "5m",
          CONFIG.FIVE_MIN_LIMIT
        )

      ]);

    if (
      fourHour.length < 50 ||
      twoHour.length < 50 ||
      oneHour.length < 40 ||
      fifteen.length < 60
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

    const oneBreak =
      detectBreakout(
        oneHour,
        CONFIG.LEVEL_LOOKBACK_1H
      );

    const oneHourClosed =
      oneHour.slice(
        0,
        -1
      );

    const oneCloses =
      oneHourClosed.map(
        c =>
          c.close
      );

    const oneEMA20 =
      ema(
        oneCloses,
        20
      );

    const oneEMA50 =
      ema(
        oneCloses,
        50
      );

    const trend =
      oneEMA20 !== null &&
      oneEMA50 !== null

        ? (
            oneEMA20 >
              oneEMA50
              ? "LONG"
              : oneEMA20 <
                  oneEMA50
                ? "SHORT"
                : "YATAY"
          )

        : "YATAY";

    const structure =
      detectStructure(
        oneHourClosed
      );

    const oneInfo = {

      ...(oneBreak || {}),

      trend,

      structure

    };

    const signal =
      buildSignal({

        market,

        fourHour:
          fourBreak,

        twoHour:
          twoBreak,

        oneHour:
          oneInfo,

        fifteen,

        fiveMinute,

        marketDirection,

        orderbook:
          null

      });

    if (
      signal
    ) {

      return {

        type:
          "ORDERBOOK_CANDIDATE",

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

        oneHour:
          oneInfo,

        fifteen,

        marketDirection

      });

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
      `Analiz hatası ${market.symbol}: ${error.message}`
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
      safeArray(
        data?.bids
      )
        .map(
          x =>
            [
              Number(x[0]),
              Number(x[1])
            ]
        )
        .filter(
          x =>
            x[0] > 0 &&
            x[1] > 0
        );

    const asks =
      safeArray(
        data?.asks
      )
        .map(
          x =>
            [
              Number(x[0]),
              Number(x[1])
            ]
        )
        .filter(
          x =>
            x[0] > 0 &&
            x[1] > 0
        );

    const bidUsd =
      bids.reduce(
        (s, x) =>
          s +
          x[0] *
            x[1],
        0
      );

    const askUsd =
      asks.reduce(
        (s, x) =>
          s +
          x[0] *
            x[1],
        0
      );

    const ratio =
      askUsd > 0
        ? bidUsd /
          askUsd
        : 1;

    const direction =
      ratio >=
        CONFIG.ORDERBOOK_MIN_IMBALANCE

        ? "LONG"

        : ratio <=
            1 /
              CONFIG.ORDERBOOK_MIN_IMBALANCE

          ? "SHORT"

          : "NEUTRAL";

    return {

      ratio:
        round(
          ratio,
          2
        ),

      direction,

      bidUsd:
        round(
          bidUsd,
          0
        ),

      askUsd:
        round(
          askUsd,
          0
        )

    };

  } catch (e) {

    return {

      ratio:
        1,

      direction:
        "NEUTRAL",

      bidUsd:
        0,

      askUsd:
        0,

      error:
        e.message

    };

  }
}

/*
=========================================================
ORDERBOOK CONFIRMATION
=========================================================
*/

function addOrderbookToSignal(
  signal,
  orderbook
) {

  if (!signal) {
    return null;
  }

  const aligned =
    orderbook.direction ===
    signal.direction;

  const opposed =
    orderbook.direction !==
      "NEUTRAL" &&
    !aligned;

  if (
    opposed
  ) {

    return null;

  }

  const orderbookScore =
    aligned

      ? (
          orderbook.ratio >=
            CONFIG.ORDERBOOK_STRONG_IMBALANCE
            ? 5
            : 3
        )

      : 0;

  const finalScore =
    Math.max(
      0,
      Math.min(
        100,
        signal.score +
          orderbookScore
      )
    );

  if (
    finalScore <
    CONFIG.MIN_SIGNAL_SCORE
  ) {

    return null;

  }

  return {

    ...signal,

    score:
      finalScore,

    quality:
      qualityLabel(
        finalScore
      ),

    orderbook,

    reason:
      `${signal.reason} Orderbook ${orderbook.ratio}x ${orderbook.direction}.`

  };
}

/*
=========================================================
SIGNAL LIFECYCLE
=========================================================

WAITING
   ↓
ACTIVE
   ↓
TP1 / TP2 / TP3
   ↓
STOP

VEYA

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

  activeSignalStore.delete(
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
      round(
        realizedR,
        2
      ),

    entryPrice:
      signal.entryPrice
        ? round(
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

    maxAdverseR:
      round(
        signal.maxAdverseR || 0,
        2
      ),

    tradingView:
      tvUrl(
        signal.symbol
      )

  };

  if (
    result === "MISSED" ||
    result === "INVALID"
  ) {

    missedSignalStore.unshift(
      item
    );

    while (
      missedSignalStore.length >
      CONFIG.MAX_MISSED
    ) {

      missedSignalStore.pop();

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
    `SIGNAL ${signal.symbol} ${signal.direction} -> ${result} | ${reason}`
  );
}

function updateOneSignal(
  key,
  signal,
  livePrice
) {

  const next = {

    ...signal,

    price:
      round(
        livePrice,
        8
      ),

    tradingView:
      tvUrl(
        signal.symbol
      )

  };

  /*
  Giriş henüz gerçekleşmedi
  */

  if (
    !next.entered
  ) {

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

      next.maxAdverseR =
        0;

      log(
        `ENTRY ${signal.symbol} ${signal.direction} -> giriş bölgesine girdi @ ${livePrice}`
      );

      return next;

    }

    /*
    LONG giriş fırsatı kaçtı
    */

    if (
      signal.direction ===
      "LONG"
    ) {

      if (
        livePrice >
        Number(
          signal.entryHigh
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
            "Fiyat giriş bölgesinin üzerine çıktı; LONG giriş fırsatı kaçtı."

        };

      }

      if (
        livePrice <=
        Number(
          signal.stop
        )
      ) {

        return {

          ...next,

          lifecycleResult:
            "INVALID",

          lifecycleReason:
            "Giriş gerçekleşmeden stop seviyesi bozuldu."

        };

      }

      if (
        livePrice >=
        Number(
          signal.tp1
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

    }

    /*
    SHORT giriş fırsatı kaçtı
    */

    else {

      if (
        livePrice <
        Number(
          signal.entryLow
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
            "Fiyat giriş bölgesinin altına indi; SHORT giriş fırsatı kaçtı."

        };

      }

      if (
        livePrice >=
        Number(
          signal.stop
        )
      ) {

        return {

          ...next,

          lifecycleResult:
            "INVALID",

          lifecycleReason:
            "Giriş gerçekleşmeden stop seviyesi bozuldu."

        };

      }

      if (
        livePrice <=
        Number(
          signal.tp1
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

    }

    next.status =
      "WAITING";

    return next;
  }

  /*
  Giriş gerçekleşti
  */

  const entry =
    Number(
      next.entryPrice
    );

  const stop =
    Number(
      next.stop
    );

  const riskUnit =
    Math.abs(
      entry -
        stop
    ) ||
    1e-12;

  if (
    next.direction ===
    "LONG"
  ) {

    const adverseR =
      Math.max(
        0,
        (
          entry -
          livePrice
        ) /
        riskUnit
      );

    next.maxAdverseR =
      Math.max(
        Number(
          next.maxAdverseR || 0
        ),
        adverseR
      );

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
      stop
    ) {

      const realizedR =
        next.tp3Hit
          ? 3
          : next.tp2Hit
            ? 2
            : next.tp1Hit
              ? 1.5
              : -1;

      return {

        ...next,

        lifecycleResult:
          "STOP",

        lifecycleReason:
          next.tp1Hit
            ? "TP1 görüldü, ardından stop geldi."
            : "Giriş sonrası stop seviyesi görüldü.",

        realizedR

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

  } else {

    const adverseR =
      Math.max(
        0,
        (
          livePrice -
          entry
        ) /
        riskUnit
      );

    next.maxAdverseR =
      Math.max(
        Number(
          next.maxAdverseR || 0
        ),
        adverseR
      );

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
      stop
    ) {

      const realizedR =
        next.tp3Hit
          ? 3
          : next.tp2Hit
            ? 2
            : next.tp1Hit
              ? 1.5
              : -1;

      return {

        ...next,

        lifecycleResult:
          "STOP",

        lifecycleReason:
          next.tp1Hit
            ? "TP1 görüldü, ardından stop geldi."
            : "Giriş sonrası stop seviyesi görüldü.",

        realizedR

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

function syncActiveSignals(
  newSignals,
  priceMap
) {

  const now =
    Date.now();

  /*
  Yeni sinyalleri ekle
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
      activeSignalStore.get(
        key
      );

    if (
      previous
    ) {

      /*
      Eski sinyalin yaşam döngüsünü
      bozma. Sadece güncel teknik verileri al.
      */

      activeSignalStore.set(
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

          marketDirection:
            signal.marketDirection,

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

          level:
            signal.level,

          tradingView:
            signal.tradingView

        }
      );

    } else {

      activeSignalStore.set(
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
  canlı fiyatla kontrol et
  */

  for (
    const [
      key,
      signal
    ] of Array.from(
      activeSignalStore.entries()
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
      updateOneSignal(
        key,
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

    activeSignalStore.set(
      key,
      updated
    );

  }

  return Array.from(
    activeSignalStore.values()
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

function getPriceMap() {

  return new Map(

    marketCache

      .filter(
        x =>
          x.symbol &&
          Number.isFinite(
            x.price
          )
      )

      .map(
        x =>
          [
            x.symbol,
            x.price
          ]
      )

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

    return (
      cachedResult ||
      {
        success:
          true,

        scanning:
          true
      }
    );

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
    600 coin universe.

    Ağır OHLCV analizi sadece
    en hareketli adaylarda.
    */

    const fastCandidates =
      marketCache

        .map(
          x => ({

            ...x,

            hotScore:

              Math.abs(
                x.change24h
              ) * 5 +

              Math.log10(
                Math.max(
                  x.volume24h,
                  1
                )
              ) +

              (
                Math.abs(
                  x.change24h
                ) >=
                CONFIG.HOT_CHANGE_24H
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

    const candidates =
      fastCandidates.slice(
        0,
        CONFIG.ANALYZE_LIMIT
      );

    const rawSignals = [];
    const preparing = [];

    let analyzed = 0;

    log(
      `Radar başladı. Universe=${marketCache.length}, FastRadar=${fastCandidates.length}, OHLCV=${candidates.length}`
    );

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

      analyzed +=
        batch.length;

      for (
        const result of results
      ) {

        if (
          !result
        ) {
          continue;
        }

        if (
          result.type ===
          "ORDERBOOK_CANDIDATE"
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
    Orderbook sadece güçlü adaylarda
    */

    rawSignals.sort(
      (a, b) =>
        b.score -
        a.score
    );

    const orderbookCandidates =
      rawSignals.slice(
        0,
        CONFIG.FINAL_ORDERBOOK_LIMIT
      );

    const confirmedSignals = [];

    for (
      const signal of
        orderbookCandidates
    ) {

      const ob =
        await getOrderbook(
          signal.symbol
        );

      const confirmed =
        addOrderbookToSignal(
          signal,
          ob
        );

      if (
        confirmed
      ) {

        confirmedSignals.push(
          confirmed
        );

      }

      await sleep(
        60
      );

    }

    confirmedSignals.sort(
      (a, b) =>
        b.score -
        a.score
    );

    const finalSignals =
      syncActiveSignals(

        confirmedSignals.slice(
          0,
          CONFIG.MAX_SIGNALS
        ),

        getPriceMap()

      );

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
        "4H BREAKOUT + 2H CONFIRM + 1H TREND + 15M RETEST + 5M TIMING + ORDERBOOK + ADAPTIVE PERFORMANCE",

      market:
        marketDirection,

      stats: {

        market:
          marketCache.length,

        fastRadar:
          fastCandidates.length,

        analyzed,

        orderbookChecked:
          orderbookCandidates.length,

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

      missed:
        missedSignalStore.slice(
          0,
          CONFIG.MAX_MISSED
        ),

      preparing:
        finalPreparing,

      performance:
        performanceStats(),

      mode:
        "MANUAL SIGNAL ONLY"

    };

    lastScan =
      new Date().toISOString();

    log(
      `RADAR tamamlandı | Universe=${marketCache.length} | OHLCV=${analyzed} | OB=${orderbookCandidates.length} | SIGNAL=${finalSignals.length}`
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

    scanRunning =
      false;

  }
}

/*
=========================================================
WEB UI
=========================================================
*/

const HTML = `<!doctype html>

<html lang="tr">

<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>
${SYSTEM_NAME}
</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #080b12;
  color: #f5f7fb;
  font-family: Arial, Helvetica, sans-serif;
}

.container {
  width: min(1180px, 94%);
  margin: 22px auto 50px;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.title {
  font-size: 27px;
  font-weight: 900;
}

.subtitle {
  color: #7d8799;
  margin-top: 5px;
}

.online {
  padding: 8px 13px;
  border-radius: 20px;
  background: #0d2118;
  color: #43e58b;
  border: 1px solid #174d31;
  font-weight: 800;
}

.market-box,
.panel,
.stat {
  background: #111722;
  border: 1px solid #202b3b;
  border-radius: 14px;
}

.market-box {
  padding: 18px;
  margin-bottom: 14px;
}

.market-title,
.stat-label {
  color: #738096;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 1px;
  text-transform: uppercase;
}

.market-direction {
  font-size: 27px;
  font-weight: 900;
  margin-top: 5px;
}

.market-reason {
  color: #909bad;
  margin-top: 4px;
}

.stats {
  display: grid;
  grid-template-columns:
    repeat(4, 1fr);
  gap: 10px;
  margin-bottom: 14px;
}

.stat {
  padding: 14px;
}

.stat-value {
  font-size: 20px;
  font-weight: 900;
  margin-top: 6px;
}

.panel {
  padding: 17px;
  margin-bottom: 14px;
}

.panel h2 {
  font-size: 18px;
  margin: 0 0 5px;
}

.panel-description {
  color: #7d8799;
  font-size: 12px;
  margin-bottom: 14px;
}

.signal-card {
  background: #0c121d;
  border: 1px solid #26354a;
  border-radius: 13px;
  padding: 15px;
  margin-bottom: 10px;
}

.signal-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.coin {
  font-size: 19px;
  font-weight: 900;
  cursor: pointer;
}

.coin:hover {
  text-decoration: underline;
}

.long {
  color: #45e58d;
}

.short {
  color: #ff647a;
}

.score {
  background: #1c2635;
  padding: 6px 9px;
  border-radius: 7px;
  font-size: 11px;
  font-weight: 900;
}

.quality {
  color: #e8c55d;
  font-size: 11px;
  font-weight: 900;
  margin-top: 6px;
}

.strategy {
  margin-top: 7px;
  color: #9ba7ba;
  font-size: 12px;
}

.price-line {
  margin-top: 12px;
  color: #d9e0ea;
}

.grid-plan {
  display: grid;
  grid-template-columns:
    repeat(5, 1fr);
  gap: 7px;
  margin-top: 12px;
}

.plan {
  background: #151d2a;
  border-radius: 8px;
  padding: 9px;
}

.plan-label {
  color: #68758a;
  font-size: 9px;
}

.plan-value {
  margin-top: 4px;
  font-weight: 900;
  font-size: 12px;
}

.reason {
  margin-top: 12px;
  padding: 10px;
  border-radius: 8px;
  background: #121a27;
  color: #a8b3c5;
  font-size: 11px;
}

.open-tv {
  display: inline-block;
  margin-top: 11px;
  padding: 8px 11px;
  background: #e9edf4;
  color: #0b1018;
  text-decoration: none;
  border-radius: 8px;
  font-size: 11px;
  font-weight: 900;
}

.prepare-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px;
  border-bottom: 1px solid #202a39;
}

.prepare-card:last-child {
  border-bottom: 0;
}

.prepare-coin {
  font-weight: 900;
  cursor: pointer;
}

.prepare-info {
  color: #8995a8;
  font-size: 11px;
  margin-top: 4px;
}

.trigger {
  text-align: right;
}

.trigger-price {
  font-weight: 900;
}

.distance {
  color: #e8c55d;
  font-size: 11px;
  margin-top: 3px;
}

.missed-card {
  background: #17131a;
  border: 1px solid #3b2b3f;
  border-radius: 9px;
  padding: 11px;
  margin-bottom: 8px;
}

.missed-title {
  color: #f0b65c;
  font-weight: 900;
}

.missed-info,
.missed-reason {
  color: #a897a9;
  font-size: 11px;
  margin-top: 4px;
}

.performance-grid {
  display: grid;
  grid-template-columns:
    repeat(5, 1fr);
  gap: 8px;
}

.perf-box {
  background: #151d2a;
  border-radius: 8px;
  padding: 10px;
}

.perf-label {
  color: #68758a;
  font-size: 9px;
  text-transform: uppercase;
}

.perf-value {
  font-size: 17px;
  font-weight: 900;
  margin-top: 4px;
}

.history-row {
  display: grid;
  grid-template-columns:
    1.1fr
    .7fr
    .9fr
    .9fr
    .7fr;
  gap: 6px;
  padding: 8px 0;
  border-bottom: 1px solid #202a39;
  font-size: 11px;
}

.history-head {
  color: #68758a;
  font-weight: 800;
}

.muted {
  color: #7d8799;
}

.hidden {
  display: none;
}

.status {
  margin-top: 10px;
  color: #7e8b9e;
  font-size: 11px;
}

@media(max-width:800px) {

  .stats {
    grid-template-columns:
      repeat(2,1fr);
  }

  .grid-plan {
    grid-template-columns:
      repeat(2,1fr);
  }

  .performance-grid {
    grid-template-columns:
      repeat(2,1fr);
  }

  .header {
    display: block;
  }

  .online {
    display: inline-block;
    margin-top: 10px;
  }

  .history-row {
    grid-template-columns:
      1fr 1fr 1fr;
  }

  .container {
    width: 96%;
  }

}

</style>

</head>

<body>

<div class="container">

<div class="header">

<div>

<div class="title">
🚀 Sonny AI Signal Scanner V6.0 Adaptive
</div>

<div class="subtitle">
4H Kırılım · 2H Onay · 1H Trend · 15M Retest ·
5M Timing · Orderbook · Adaptive Performance
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
  class="market-direction"
>
VERİ BEKLENİYOR
</div>

<div
  id="marketReason"
  class="market-reason"
>
Piyasa hesaplanıyor...
</div>

</div>

<div class="stats">

<div class="stat">

<div class="stat-label">
Piyasa
</div>

<div
  id="marketCount"
  class="stat-value"
>
-
</div>

</div>

<div class="stat">

<div class="stat-label">
Analiz
</div>

<div
  id="analyzed"
  class="stat-value"
>
-
</div>

</div>

<div class="stat">

<div class="stat-label">
Aktif Sinyal
</div>

<div
  id="signalCount"
  class="stat-value"
>
0
</div>

</div>

<div class="stat">

<div class="stat-label">
Son Tarama
</div>

<div
  id="lastScan"
  class="stat-value"
>
-
</div>

</div>

</div>

<div class="panel">

<h2>
🚨 AKTİF SİNYALLER
</h2>

<div class="panel-description">

Giriş bölgesinde olan sinyaller burada kalır.

Giriş fırsatı kaçarsa aynı anda bu bölümden çıkar
ve aşağıdaki KAÇAN bölümüne geçer.

Fiyatlar canlı güncellenir.

</div>

<div id="signals">

<div class="panel-description">
Sistem tarama yapıyor...
</div>

</div>

</div>

<div
  class="panel hidden"
  id="missedPanel"
>

<h2>
⚠️ KAÇAN / GEÇERSİZ SİNYALLER
</h2>

<div class="panel-description">

Giriş yapılmadan fırsatı geçen
veya yapısı bozulan son sinyaller.

</div>

<div id="missed">
</div>

</div>

<div class="panel">

<h2>
🟡 HAZIRLANAN FIRSATLAR
</h2>

<div class="panel-description">

Kırılıma yaklaşan en iyi 5 aday.
Kırılım ve RSI şartları tamamlanınca
aktif sinyale dönüşür.

</div>

<div id="preparing">

<div class="panel-description">
Şu anda hazırlanan güçlü fırsat yok.
</div>

</div>

</div>

<div class="panel">

<h2>
📊 GERÇEK PERFORMANS · SON 50 SİNYAL
</h2>

<div class="panel-description">

TP1 başarı oranı yalnızca gerçekten giriş yapılmış
sinyallerden hesaplanır.

KAÇAN ve GEÇERSİZ sonuçlar ayrı tutulur.

</div>

<div class="performance-grid">

<div class="perf-box">

<div class="perf-label">
TP1 Başarı
</div>

<div
  id="tp1Rate"
  class="perf-value"
>
0%
</div>

</div>

<div class="perf-box">

<div class="perf-label">
STOP
</div>

<div
  id="stopRate"
  class="perf-value"
>
0%
</div>

</div>

<div class="perf-box">

<div class="perf-label">
Toplam R
</div>

<div
  id="totalR"
  class="perf-value"
>
0R
</div>

</div>

<div class="perf-box">

<div class="perf-label">
Çözülen
</div>

<div
  id="resolved"
  class="perf-value"
>
0
</div>

</div>

<div class="perf-box">

<div class="perf-label">
Kaçan
</div>

<div
  id="missedCount"
  class="perf-value"
>
0
</div>

</div>

</div>

<div
  id="performanceRows"
  style="margin-top:12px"
>
</div>

</div>

<div class="panel">

<h2>
🧠 Sonny nasıl karar veriyor?
</h2>

<div class="panel-description">

<b>1.</b>
4H destek/direnç seviyesi bulunur.

<br><br>

<b>2.</b>
4H kapanışıyla gerçek kırılım aranır.

<br><br>

<b>3.</b>
2H aynı yönde onay verir.

<br><br>

<b>4.</b>
Kırılan seviye retest edilir.

<br><br>

<b>5.</b>
1H trend ve market structure yönü doğrular.

<br><br>

<b>6.</b>
15M RSI + 5M timing giriş kalitesini kontrol eder.

<br><br>

<b>7.</b>
Hacim, Bollinger squeeze ve fake breakout filtreleri uygulanır.

<br><br>

<b>8.</b>
Güçlü adaylarda Orderbook imbalance kontrol edilir.

<br><br>

<b>9.</b>
Son 50 gerçek sonuçtan strateji/yön/piyasa rejimi
performans bonusu hesaplanır.

<br><br>

<b>10.</b>
Sinyal oluştuktan sonra radar tekrar üretmese bile
Sonny onu canlı fiyatla takip eder.

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

function formatPrice(v) {

  v = Number(v);

  if (
    !Number.isFinite(v)
  ) {
    return "-";
  }

  if (
    v >= 100
  ) {
    return v.toFixed(2);
  }

  if (
    v >= 1
  ) {
    return v.toFixed(4);
  }

  if (
    v >= 0.01
  ) {
    return v.toFixed(6);
  }

  return v.toFixed(8);
}

function tv(symbol) {

  const clean =
    String(symbol || "")
      .replace(/\\.P$/i, "");

  const url =
    "https://www.tradingview.com/chart/?symbol=BITGET%3A" +
    encodeURIComponent(clean) +
    ".P";

  window.open(
    url,
    "_blank",
    "noopener,noreferrer"
  );

}

function renderSignals(items) {

  const box =
    document.getElementById(
      "signals"
    );

  if (
    !items ||
    !items.length
  ) {

    box.innerHTML =
      '<div class="panel-description">' +
      'Şu anda aktif sinyal yok. Sonny yeni fırsatları arıyor.' +
      '</div>';

    return;

  }

  box.innerHTML =
    items
      .map(
        x => {

          const c =
            x.direction ===
            "LONG"
              ? "long"
              : "short";

          return (

            '<div class="signal-card">' +

              '<div class="signal-top">' +

                '<div class="coin ' +
                  c +
                  '" onclick="tv(\'' +
                  x.symbol +
                  '\')">' +

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

              '<div class="quality">' +

                (
                  x.quality ||
                  ""
                ) +

              '</div>' +

              '<div class="strategy">' +

                x.strategy +

                ' · Anlık: <b>' +

                formatPrice(
                  x.price
                ) +

                '</b> · RSI: <b>' +

                x.rsi +

                '</b> · Hacim: <b>' +

                x.volumeRatio +

                'x</b>' +

              '</div>' +

              '<div class="grid-plan">' +

                '<div class="plan">' +

                  '<div class="plan-label">GİRİŞ</div>' +

                  '<div class="plan-value">' +

                    formatPrice(
                      x.entryLow
                    ) +

                    ' - ' +

                    formatPrice(
                      x.entryHigh
                    ) +

                  '</div>' +

                '</div>' +

                '<div class="plan">' +

                  '<div class="plan-label">STOP</div>' +

                  '<div class="plan-value">' +

                    formatPrice(
                      x.stop
                    ) +

                  '</div>' +

                '</div>' +

                '<div class="plan">' +

                  '<div class="plan-label">TP1</div>' +

                  '<div class="plan-value">' +

                    formatPrice(
                      x.tp1
                    ) +

                  '</div>' +

                '</div>' +

                '<div class="plan">' +

                  '<div class="plan-label">TP2</div>' +

                  '<div class="plan-value">' +

                    formatPrice(
                      x.tp2
                    ) +

                  '</div>' +

                '</div>' +

                '<div class="plan">' +

                  '<div class="plan-label">TP3</div>' +

                  '<div class="plan-value">' +

                    formatPrice(
                      x.tp3
                    ) +

                  '</div>' +

                '</div>' +

              '</div>' +

              '<div class="reason">' +

                '<b>' +

                (
                  x.entered
                    ? "🟢 GİRİŞ AKTİF"
                    : "🟡 GİRİŞ BEKLENİYOR"
                ) +

                '</b><br>' +

                x.reason +

              '</div>' +

              '<a class="open-tv" href="' +

                x.tradingView +

                '" target="_blank" rel="noopener">' +

                '📊 TRADINGVIEW AÇ' +

              '</a>' +

            '</div>'

          );

        }
      )
      .join("");

}

function renderMissed(items) {

  const panel =
    document.getElementById(
      "missedPanel"
    );

  const box =
    document.getElementById(
      "missed"
    );

  if (
    !items ||
    !items.length
  ) {

    panel.classList.add(
      "hidden"
    );

    return;

  }

  panel.classList.remove(
    "hidden"
  );

  box.innerHTML =
    items
      .map(
        x =>

          '<div class="missed-card">' +

            '<div class="missed-title">' +

              x.symbol +
              ' · ' +
              x.direction +
              ' · ' +
              x.result +

            '</div>' +

            '<div class="missed-info">' +

              'Son fiyat: <b>' +

              formatPrice(
                x.price
              ) +

              '</b> · Giriş: ' +

              formatPrice(
                x.entryLow
              ) +

              ' - ' +

              formatPrice(
                x.entryHigh
              ) +

            '</div>' +

            '<div class="missed-reason">' +

              '⚠️ ' +

              (
                x.reason ||
                "Giriş fırsatı kaçtı."
              ) +

            '</div>' +

          '</div>'

      )
      .join("");

}

function renderPreparing(items) {

  const box =
    document.getElementById(
      "preparing"
    );

  if (
    !items ||
    !items.length
  ) {

    box.innerHTML =
      '<div class="panel-description">' +
      'Şu anda hazırlanan güçlü fırsat yok.' +
      '</div>';

    return;

  }

  box.innerHTML =
    items
      .map(
        x => {

          const c =
            x.direction ===
            "LONG"
              ? "long"
              : "short";

          return (

            '<div class="prepare-card">' +

              '<div>' +

                '<div class="prepare-coin ' +
                  c +
                  '" onclick="tv(\'' +
                  x.symbol +
                  '\')">' +

                  x.symbol +
                  ' · ' +
                  x.direction +

                '</div>' +

                '<div class="prepare-info">' +

                  'Anlık: ' +

                  formatPrice(
                    x.price
                  ) +

                  ' · RSI: ' +

                  x.rsi +

                '</div>' +

              '</div>' +

              '<div class="trigger">' +

                '<div class="trigger-price">' +

                  'Tetik: ' +

                  formatPrice(
                    x.trigger
                  ) +

                '</div>' +

                '<div class="distance">' +

                  '%' +
                  x.distance +
                  ' uzakta' +

                '</div>' +

              '</div>' +

            '</div>'

          );

        }
      )
      .join("");

}

function renderPerformance(p) {

  if (!p) {
    return;
  }

  document.getElementById(
    "tp1Rate"
  ).textContent =
    p.tp1Rate +
    "%";

  document.getElementById(
    "stopRate"
  ).textContent =
    p.stopRate +
    "%";

  document.getElementById(
    "totalR"
  ).textContent =
    p.totalR +
    "R";

  document.getElementById(
    "resolved"
  ).textContent =
    p.resolved;

  document.getElementById(
    "missedCount"
  ).textContent =
    p.missed;

  const rows =
    document.getElementById(
      "performanceRows"
    );

  if (
    !p.items ||
    !p.items.length
  ) {

    rows.innerHTML =
      '<div class="muted">' +
      'Henüz yeterli geçmiş sinyal yok.' +
      '</div>';

    return;

  }

  rows.innerHTML =

    '<div class="history-row history-head">' +

      '<div>COIN</div>' +
      '<div>YÖN</div>' +
      '<div>SONUÇ</div>' +
      '<div>GİRİŞ</div>' +
      '<div>R</div>' +

    '</div>' +

    p.items
      .slice(
        0,
        10
      )
      .map(
        x =>

          '<div class="history-row">' +

            '<div>' +
              x.symbol +
            '</div>' +

            '<div>' +
              x.direction +
            '</div>' +

            '<div>' +

              x.result +

              (
                x.tp1Hit
                  ? ' · TP1 ✓'
                  : ''
              ) +

            '</div>' +

            '<div>' +

              formatPrice(
                x.entryPrice
              ) +

            '</div>' +

            '<div>' +

              Number(
                x.realizedR ||
                0
              ).toFixed(2) +

              'R' +

            '</div>' +

          '</div>'

      )
      .join("");

}

function updateDashboard(r) {

  if (!r) {
    return;
  }

  const md =
    document.getElementById(
      "marketDirection"
    );

  md.textContent =
    r.market
      ? r.market.label
      : "PİYASA YATAY";

  md.className =
    "market-direction " +

    (
      r.market &&
      r.market.direction ===
        "LONG"

        ? "long"

        : r.market &&
          r.market.direction ===
            "SHORT"

          ? "short"

          : ""
    );

  document.getElementById(
    "marketReason"
  ).textContent =
    r.market
      ? r.market.reason
      : "";

  if (
    r.stats
  ) {

    document.getElementById(
      "marketCount"
    ).textContent =
      r.stats.market;

    document.getElementById(
      "analyzed"
    ).textContent =
      r.stats.analyzed;

    document.getElementById(
      "signalCount"
    ).textContent =
      r.stats.signals;

  }

  if (
    r.timestamp
  ) {

    document.getElementById(
      "lastScan"
    ).textContent =
      new Date(
        r.timestamp
      ).toLocaleTimeString(
        "tr-TR"
      );

  }

  renderSignals(
    r.signals
  );

  renderMissed(
    r.missed
  );

  renderPreparing(
    r.preparing
  );

  renderPerformance(
    r.performance
  );

}

async function load() {

  try {

    const res =
      await fetch(
        "/api/result?_=" +
        Date.now(),
        {
          cache:
            "no-store"
        }
      );

    const data =
      await res.json();

    if (
      data.result
    ) {

      updateDashboard(
        data.result
      );

      document.getElementById(
        "status"
      ).textContent =

        data.scanning

          ? "Sistem tarama yapıyor..."

          : "Sistem aktif · geniş coin universe · hızlı radar + seçici OHLCV + orderbook · fiyatlar canlı güncelleniyor.";

    } else {

      document.getElementById(
        "status"
      ).textContent =
        data.message ||
        "İlk tarama bekleniyor...";

    }

  } catch (e) {

    document.getElementById(
      "status"
    ).textContent =
      "Sunucu bağlantı hatası: " +
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

      strategy:
        "4H BREAKOUT + 2H CONFIRMATION + RETEST + RSI + VOLUME",

      refresh:
        "60 SECONDS",

      lastScan,

      discoveryTime,

      market:
        marketCache.length,

      active:
        activeSignalStore.size,

      history:
        signalHistory.length,

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
  async (req, res) => {

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

    try {

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
      Canlı fiyatları tekrar al.
      */

      const tickers =
        await bitget(
          "/api/v2/mix/market/tickers",
          {
            productType:
              PRODUCT_TYPE
          }
        );

      const priceMap =
        new Map();

      for (
        const ticker of
          safeArray(
            tickers
          )
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

          priceMap.set(
            ticker.symbol,
            price
          );

        }

      }

      /*
      Aktif sinyalleri canlı fiyatla kontrol et.
      */

      const liveSignals =
        syncActiveSignals(
          [],
          priceMap
        );

      cachedResult.signals =
        liveSignals;

      cachedResult.missed =
        missedSignalStore.slice(
          0,
          CONFIG.MAX_MISSED
        );

      cachedResult.performance =
        performanceStats();

      cachedResult.stats.signals =
        liveSignals.length;

      cachedResult.timestamp =
        new Date().toISOString();

      /*
      Hazırlanan fırsatların
      fiyatlarını da canlı güncelle.
      */

      cachedResult.preparing =
        safeArray(
          cachedResult.preparing
        ).map(
          item => {

            const live =
              priceMap.get(
                item.symbol
              );

            return Number.isFinite(
              live
            )

              ? {
                  ...item,
                  price:
                    round(
                      live,
                      8
                    )
                }

              : item;

          }
        );

      return res.json({

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

      return res
        .status(500)
        .json({

          success:
            false,

          scanning:
            scanRunning,

          result:
            cachedResult,

          error:
            error.message

        });

    }

  }
);

app.use(
  (req, res) => {

    res
      .status(404)
      .json({

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
      "Strategy: 4H BREAKOUT + 2H CONFIRMATION + RETEST + RSI + VOLUME"
    );

    log(
      "Refresh: Every 60 seconds"
    );

    log(
      `Server listening on port ${PORT}`
    );

    log(
      `Signal history: ${signalHistory.length} kayıt`
    );

    /*
    İlk tarama
    */

    setTimeout(
      () => {
        runRadar();
      },
      3000
    );

    /*
    Her dakika yeni radar
    */

    setInterval(
      () => {
        runRadar();
      },
      CONFIG.REFRESH_MS
    );

  }
);
