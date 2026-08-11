const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

const SYSTEM_NAME = "Sonny AI Signal Scanner V5.1";
const BITGET_BASE = "https://api.bitget.com";
const PRODUCT_TYPE = "usdt-futures";

const CONFIG = {
  REFRESH_MS: 60 * 1000,

  MIN_VOLUME_USDT: 3000000,

  DISCOVERY_LIMIT: 100,

  ANALYZE_LIMIT: 70,

  BATCH_SIZE: 8,

  BATCH_DELAY_MS: 100,

  CANDLE_4H: 80,

  CANDLE_2H: 80,

  CANDLE_15M: 160,

  LEVEL_LOOKBACK_4H: 20,

  LEVEL_LOOKBACK_2H: 20,

  MAX_SIGNALS: 10,

  MAX_PREPARING: 8,

  SIGNAL_MIN_SCORE: 72,

  PREPARING_MIN_SCORE: 58,

  RSI_LONG_MIN: 50,

  RSI_LONG_MAX: 70,

  RSI_SHORT_MIN: 30,

  RSI_SHORT_MAX: 50
};


/* =========================================================
   SYSTEM STATE
========================================================= */

let cachedResult = null;

let lastScan = null;

let lastError = null;

let scanRunning = false;

let marketCache = [];

let lastDiscovery = 0;


/* =========================================================
   BASIC HELPERS
========================================================= */

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


function num(value, digits = 4) {

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
    value / base
  ) * 100;

}


/* =========================================================
   BITGET API
========================================================= */

async function bitget(
  path,
  params = {}
) {

  const url =
    new URL(
      BITGET_BASE + path
    );

  for (
    const [key, value]
    of Object.entries(params)
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
          "User-Agent":
            "Sonny-AI-Signal-Scanner/5.1"
        }
      }
    );

  const text =
    await response.text();

  if (!response.ok) {

    throw new Error(
      `Bitget HTTP ${response.status} - ${path} - ${text.slice(0, 250)}`
    );

  }

  let json;

  try {

    json =
      JSON.parse(text);

  } catch {

    throw new Error(
      `Bitget JSON parse error - ${path}`
    );

  }

  if (
    json.code !== "00000"
  ) {

    throw new Error(
      `Bitget API ${json.code} - ${json.msg || "Unknown error"}`
    );

  }

  return json.data;

}


/* =========================================================
   INDICATORS
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

  const k =
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
        values[i] - result
      ) * k + result;

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

  const part =
    values.slice(-period);

  return (
    part.reduce(
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
      ) / period;

    avgLoss =
      (
        avgLoss *
        (period - 1) +
        loss
      ) / period;

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
    100 / (1 + rs)
  );

}


/* =========================================================
   CANDLE DATA
========================================================= */

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


async function candles(
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


/* =========================================================
   SUPPORT / RESISTANCE
========================================================= */

function level(
  candlesData,
  lookback
) {

  const closed =
    candlesData.slice(
      0,
      -1
    );

  const part =
    closed.slice(
      -lookback
    );

  if (
    part.length <
    Math.floor(
      lookback * 0.8
    )
  ) {

    return null;

  }

  return {

    resistance:
      Math.max(
        ...part.map(
          c => c.high
        )
      ),

    support:
      Math.min(
        ...part.map(
          c => c.low
        )
      ),

    current:
      closed[
        closed.length - 1
      ]

  };

}


/* =========================================================
   TREND
========================================================= */

function trend(data) {

  if (
    !data ||
    data.length < 55
  ) {

    return "NEUTRAL";

  }

  const closed =
    data.slice(
      0,
      -1
    );

  const closes =
    closed.map(
      c => c.close
    );

  const price =
    closes[
      closes.length - 1
    ];

  const e20 =
    ema(
      closes,
      20
    );

  const e50 =
    ema(
      closes,
      50
    );

  if (
    price > e20 &&
    e20 > e50
  ) {

    return "LONG";

  }

  if (
    price < e20 &&
    e20 < e50
  ) {

    return "SHORT";

  }

  return "NEUTRAL";

}


/* =========================================================
   15 MINUTE MOMENTUM
========================================================= */

function latest15m(
  data
) {

  const closed =
    data.slice(
      0,
      -1
    );

  if (
    closed.length < 60
  ) {

    return null;

  }

  const closes =
    closed.map(
      c => c.close
    );

  const current =
    closed[
      closed.length - 1
    ];

  const previous =
    closed[
      closed.length - 2
    ];

  const currentRsi =
    rsi(
      closes,
      14
    );

  const avgVol =
    sma(
      closed.map(
        c => c.volume
      ),
      30
    );

  const volumeRatio =
    avgVol > 0
      ? current.volume /
        avgVol
      : 0;

  return {

    current,

    previous,

    rsi:
      currentRsi,

    volumeRatio,

    ema9:
      ema(
        closes,
        9
      ),

    ema20:
      ema(
        closes,
        20
      )

  };

}


/* =========================================================
   MARKET DISCOVERY SCORE
========================================================= */

function marketScore(
  item
) {

  let score = 0;

  const vol =
    item.volume24h;

  const move =
    Math.abs(
      item.change24h
    );

  const range =
    item.range24h;


  if (
    vol >= 100000000
  ) {

    score += 35;

  } else if (
    vol >= 30000000
  ) {

    score += 28;

  } else if (
    vol >= 10000000
  ) {

    score += 20;

  } else {

    score += 12;

  }


  if (
    move >= 5
  ) {

    score += 25;

  } else if (
    move >= 3
  ) {

    score += 18;

  } else if (
    move >= 1.5
  ) {

    score += 10;

  }


  if (
    range >= 8
  ) {

    score += 25;

  } else if (
    range >= 5
  ) {

    score += 18;

  } else if (
    range >= 3
  ) {

    score += 10;

  }

  return score;

}


/* =========================================================
   MARKET DISCOVERY
========================================================= */

async function discoverMarket() {

  log(
    "Bitget piyasası yeniden keşfediliyor..."
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


  const valid =
    new Set(

      (contracts || [])

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


  const market =
    (tickers || [])

      .filter(
        t =>
          valid.has(
            t.symbol
          )
      )

      .map(t => {

        const price =
          Number(
            t.lastPr
          );

        const high =
          Number(
            t.high24h
          );

        const low =
          Number(
            t.low24h
          );

        const rawChange =
          Number(
            t.change24h || 0
          );

        const change =
          Math.abs(
            rawChange
          ) <= 1
            ? rawChange * 100
            : rawChange;

        const volume =
          Number(
            t.quoteVolume || 0
          );

        return {

          symbol:
            t.symbol,

          price,

          change24h:
            change,

          volume24h:
            volume,

          high24h:
            high,

          low24h:
            low,

          range24h:
            price > 0
              ? pct(
                  high - low,
                  price
                )
              : 0

        };

      })

      .filter(
        x =>
          x.volume24h >=
          CONFIG.MIN_VOLUME_USDT
      )

      .map(x => {

        return {

          ...x,

          discoveryScore:
            marketScore(x)

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
    Date.now();


  log(
    `Discovery tamamlandı. ${market.length} uygun coin bulundu.`
  );


  return marketCache;

}


/* =========================================================
   TRADE PLAN
========================================================= */

function makePlan(
  direction,
  price,
  trigger,
  atrValue
) {

  const riskDistance =
    Math.max(
      atrValue * 1.25,
      price * 0.012
    );


  const entryLow =
    direction === "LONG"
      ? trigger
      : trigger * 0.999;


  const entryHigh =
    direction === "LONG"
      ? trigger * 1.004
      : trigger;


  let stop;

  let tp1;

  let tp2;

  let tp3;


  if (
    direction === "LONG"
  ) {

    stop =
      Math.min(
        trigger -
          riskDistance,

        price -
          riskDistance
      );

    const risk =
      Math.max(
        price - stop,
        price * 0.005
      );

    tp1 =
      price +
      risk * 1.4;

    tp2 =
      price +
      risk * 2;

    tp3 =
      price +
      risk * 2.8;

  } else {

    stop =
      Math.max(
        trigger +
          riskDistance,

        price +
          riskDistance
      );

    const risk =
      Math.max(
        stop - price,
        price * 0.005
      );

    tp1 =
      price -
      risk * 1.4;

    tp2 =
      price -
      risk * 2;

    tp3 =
      price -
      risk * 2.8;

  }


  return {

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

    riskPercent:
      num(
        Math.abs(
          price - stop
        ) /
        price *
        100,
        2
      )

  };

}


/* =========================================================
   MAIN ANALYSIS
========================================================= */

function analyze(
  marketItem,
  c4h,
  c2h,
  c15m
) {

  const l4 =
    level(
      c4h,
      CONFIG.LEVEL_LOOKBACK_4H
    );

  const l2 =
    level(
      c2h,
      CONFIG.LEVEL_LOOKBACK_2H
    );

  const m15 =
    latest15m(
      c15m
    );


  if (
    !l4 ||
    !l2 ||
    !m15
  ) {

    return null;

  }


  const price =
    m15.current.close;


  const trend4 =
    trend(
      c4h
    );


  const trend2 =
    trend(
      c2h
    );


  const rsi15 =
    m15.rsi;


  const atr15 =
    Math.max(
      Math.abs(
        m15.current.high -
        m15.current.low
      ),

      price * 0.005
    );


  /* =====================================================
     4H BREAKOUT
  ===================================================== */

  const long4Break =
    price >
    l4.resistance;

  const short4Break =
    price <
    l4.support;


  /* =====================================================
     2H BREAKOUT
  ===================================================== */

  const long2Break =
    price >
    l2.resistance;

  const short2Break =
    price <
    l2.support;


  /* =====================================================
     RSI
  ===================================================== */

  const longRsi =
    rsi15 >=
      CONFIG.RSI_LONG_MIN &&
    rsi15 <=
      CONFIG.RSI_LONG_MAX;


  const shortRsi =
    rsi15 >=
      CONFIG.RSI_SHORT_MIN &&
    rsi15 <=
      CONFIG.RSI_SHORT_MAX;


  /* =====================================================
     TREND CONFIRMATION
  ===================================================== */

  const longTrend =
    trend4 === "LONG" &&
    (
      trend2 === "LONG" ||
      long2Break
    );


  const shortTrend =
    trend4 === "SHORT" &&
    (
      trend2 === "SHORT" ||
      short2Break
    );


  /* =====================================================
     SCORE
  ===================================================== */

  let longScore = 0;

  let shortScore = 0;


  if (
    long4Break
  ) {

    longScore += 30;

  } else if (
    long2Break
  ) {

    longScore += 20;

  }


  if (
    short4Break
  ) {

    shortScore += 30;

  } else if (
    short2Break
  ) {

    shortScore += 20;

  }


  if (
    longTrend
  ) {

    longScore += 22;

  }


  if (
    shortTrend
  ) {

    shortScore += 22;

  }


  if (
    longRsi
  ) {

    longScore += 22;

  }


  if (
    shortRsi
  ) {

    shortScore += 22;

  }


  if (
    m15.volumeRatio >= 1.2
  ) {

    longScore += 10;

    shortScore += 10;

  }


  if (
    m15.volumeRatio >= 1.5
  ) {

    longScore += 6;

    shortScore += 6;

  }


  if (
    m15.ema9 >
    m15.ema20
  ) {

    longScore += 8;

  }


  if (
    m15.ema9 <
    m15.ema20
  ) {

    shortScore += 8;

  }


  const direction =
    longScore >= shortScore
      ? "LONG"
      : "SHORT";


  const score =
    Math.min(
      100,

      Math.round(
        Math.max(
          longScore,
          shortScore
        ) +
        Math.min(
          marketItem.discoveryScore *
            0.08,

          8
        )
      )
    );


  const isLong =
    direction === "LONG";


  const break4 =
    isLong
      ? long4Break
      : short4Break;


  const break2 =
    isLong
      ? long2Break
      : short2Break;


  const rsiOK =
    isLong
      ? longRsi
      : shortRsi;


  const trendOK =
    isLong
      ? longTrend
      : shortTrend;


  /* =====================================================
     TRIGGER
  ===================================================== */

  const trigger =
    isLong

      ? Math.max(
          l4.resistance,
          l2.resistance
        )

      : Math.min(
          l4.support,
          l2.support
        );


  const distance =
    pct(
      Math.abs(
        trigger -
        price
      ),
      price
    );


  /* =====================================================
     PREPARING
  ===================================================== */

  const preparing =
    !break4 &&
    !break2 &&
    distance <= 1.2 &&
    trendOK;


  /* =====================================================
     REAL SIGNAL
  ===================================================== */

  const signal =
    (
      break4 ||
      break2
    ) &&
    trendOK &&
    rsiOK &&
    score >=
      CONFIG.SIGNAL_MIN_SCORE;


  if (
    !signal &&
    !preparing
  ) {

    return null;

  }


  const plan =
    makePlan(
      direction,

      price,

      signal
        ? price
        : trigger,

      atr15
    );


  const status =
    signal
      ? "SIGNAL"
      : "PREPARING";


  /* =====================================================
     STRATEGY NAME
  ===================================================== */

  let strategy =
    "";


  if (
    break4 &&
    break2
  ) {

    strategy =
      "4H + 2H KIRILIMI + RSI";

  } else if (
    break4
  ) {

    strategy =
      "4H KIRILIMI + 2H ONAY + RSI";

  } else if (
    break2
  ) {

    strategy =
      "2H KIRILIMI + 4H YÖN + RSI";

  } else {

    strategy =
      "4H/2H KIRILIMA YAKIN + RSI BEKLENTİSİ";

  }


  /* =====================================================
     EXPLANATION
  ===================================================== */

  let reason;


  if (
    signal
  ) {

    reason =
      `${break4 ? "4H kırılımı" : "2H kırılımı"}${
        break4 && break2
          ? " ve 2H doğrulaması"
          : ""
      }; ${
        isLong
          ? "LONG"
          : "SHORT"
      } RSI uygun; ${
        trend4 === direction
          ? "4H ana yön uyumlu"
          : "4H yapı destekliyor"
      }.`;

  } else {

    reason =
      `${
        isLong
          ? "Yukarı"
          : "Aşağı"
      } kırılım bölgesine yaklaşıyor. Kırılım + RSI onayı bekleniyor.`;

  }


  return {

    symbol:
      marketItem.symbol,

    direction,

    status,

    score,

    strategy,

    price:
      num(
        price,
        8
      ),

    trigger:
      num(
        trigger,
        8
      ),

    distance:
      num(
        distance,
        3
      ),

    rsi15:
      num(
        rsi15,
        1
      ),

    trend4,

    trend2,

    volumeRatio:
      num(
        m15.volumeRatio,
        2
      ),

    change24h:
      num(
        marketItem.change24h,
        2
      ),

    plan,

    reason,

    tradingView:
      `https://www.tradingview.com/chart/?symbol=BITGET:${encodeURIComponent(
        marketItem.symbol
      )}`,

    updatedAt:
      new Date().toISOString()

  };

}


/* =========================================================
   COIN ANALYSIS
========================================================= */

async function analyzeCoin(
  item
) {

  try {

    const [
      c4h,
      c2h,
      c15m
    ] =
      await Promise.all([

        candles(
          item.symbol,
          "4H",
          CONFIG.CANDLE_4H
        ),

        candles(
          item.symbol,
          "2H",
          CONFIG.CANDLE_2H
        ),

        candles(
          item.symbol,
          "15m",
          CONFIG.CANDLE_15M
        )

      ]);


    return analyze(
      item,
      c4h,
      c2h,
      c15m
    );

  } catch (
    error
  ) {

    log(
      `Analiz hatası ${item.symbol}: ${error.message}`
    );

    return null;

  }

}


/* =========================================================
   GENERAL MARKET DIRECTION
========================================================= */

function calculateMarketDirection(
  items
) {

  const top =
    items.slice(
      0,
      30
    );


  if (
    !top.length
  ) {

    return {

      label:
        "VERİ BEKLENİYOR",

      direction:
        "NEUTRAL",

      strength:
        0

    };

  }


  const positive =
    top.filter(
      x =>
        x.change24h >
        0.8
    ).length;


  const negative =
    top.filter(
      x =>
        x.change24h <
        -0.8
    ).length;


  const total =
    top.length;


  const longPct =
    positive /
    total *
    100;


  const shortPct =
    negative /
    total *
    100;


  if (
    longPct >= 55
  ) {

    return {

      label:
        "PİYASA LONG",

      direction:
        "LONG",

      strength:
        Math.round(
          longPct
        )

    };

  }


  if (
    shortPct >= 55
  ) {

    return {

      label:
        "PİYASA SHORT",

      direction:
        "SHORT",

      strength:
        Math.round(
          shortPct
        )

    };

  }


  return {

    label:
      "PİYASA YATAY",

    direction:
      "NEUTRAL",

    strength:
      Math.round(
        Math.max(
          longPct,
          shortPct
        )
      )

  };

}


/* =========================================================
   RADAR
========================================================= */

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

    /*
      Piyasayı 5 dakikada bir yeniden keşfet.
      Böylece yeni coinler de sisteme girer.
    */

    if (
      !marketCache.length ||
      Date.now() -
        lastDiscovery >
        5 * 60 * 1000
    ) {

      await discoverMarket();

    }


    const pool =
      marketCache.slice(
        0,
        CONFIG.ANALYZE_LIMIT
      );


    const results = [];


    /*
      Coinleri küçük gruplar halinde analiz ediyoruz.
    */

    for (
      let i = 0;
      i < pool.length;
      i +=
        CONFIG.BATCH_SIZE
    ) {

      const batch =
        pool.slice(
          i,
          i +
            CONFIG.BATCH_SIZE
        );


      const found =
        await Promise.all(
          batch.map(
            analyzeCoin
          )
        );


      found
        .filter(Boolean)
        .forEach(
          x =>
            results.push(x)
        );


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
      GERÇEK SİNYALLER
    */

    const signals =
      results

        .filter(
          x =>
            x.status ===
            "SIGNAL"
        )

        .slice(
          0,
          CONFIG.MAX_SIGNALS
        );


    /*
      HAZIRLANAN FIRSATLAR
    */

    const preparing =
      results

        .filter(
          x =>
            x.status ===
              "PREPARING" &&
            x.score >=
              CONFIG.PREPARING_MIN_SCORE
        )

        .slice(
          0,
          CONFIG.MAX_PREPARING
        );


    const elapsed =
      num(
        (
          Date.now() -
          started
        ) / 1000,

        1
      );


    cachedResult = {

      success:
        true,

      system:
        SYSTEM_NAME,

      timestamp:
        new Date().toISOString(),

      market:
        calculateMarketDirection(
          marketCache
        ),

      marketDiscovery: {

        totalCoins:
          marketCache.length,

        analyzed:
          pool.length

      },

      scan: {

        durationSeconds:
          elapsed,

        analyzed:
          results.length

      },

      signals,

      preparing,

      mode:
        "MANUAL TRADING ONLY"

    };


    lastScan =
      cachedResult.timestamp;


    log(
      `RADAR tamamlandı | Market: ${marketCache.length} | Analiz: ${results.length} | SIGNAL: ${signals.length} | PREPARING: ${preparing.length}`
    );


    return cachedResult;


  } catch (
    error
  ) {

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


/* =========================================================
   AUTOMATIC ENGINE
========================================================= */

async function refreshLoop() {

  if (
    scanRunning
  ) {

    return;

  }


  try {

    await runRadar();

  } catch (
    error
  ) {

    log(
      `Refresh error: ${error.message}`
    );

  }

}


/* =========================================================
   WEB INTERFACE
========================================================= */

const HTML = `<!DOCTYPE html>

<html lang="tr">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1.0"
>

<title>
Sonny AI Signal Scanner V5.1
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
    min(1150px,94%);

  margin:
    28px auto;

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
    5px;

}

.online {

  padding:
    9px 14px;

  border-radius:
    20px;

  background:
    #0b291a;

  border:
    1px solid #1b6b40;

  color:
    #48e28c;

  font-weight:
    800;

}

.market {

  display:
    flex;

  justify-content:
    space-between;

  align-items:
    center;

  padding:
    16px 20px;

  border-radius:
    14px;

  background:
    #11182b;

  border:
    1px solid #293854;

  margin-bottom:
    15px;

}

.market-main {

  font-size:
    21px;

  font-weight:
    900;

}

.market-main.long {

  color:
    #42e88b;

}

.market-main.short {

  color:
    #ff637d;

}

.market-main.neutral {

  color:
    #f7c95c;

}

.market small {

  color:
    #8ea0c4;

}

.grid {

  display:
    grid;

  grid-template-columns:
    repeat(4,1fr);

  gap:
    10px;

  margin-bottom:
    15px;

}

.card,
.panel {

  background:
    #11182b;

  border:
    1px solid #23304a;

  border-radius:
    14px;

}

.card {

  padding:
    15px;

}

.label {

  font-size:
    11px;

  color:
    #7185ac;

  text-transform:
    uppercase;

}

.value {

  font-size:
    22px;

  font-weight:
    900;

  margin-top:
    6px;

}

.panel {

  padding:
    18px;

  margin-bottom:
    15px;

}

.panel h2 {

  margin:
    0 0 8px;

  font-size:
    18px;

}

.desc {

  color:
    #8ea0c4;

  font-size:
    13px;

  line-height:
    1.6;

  margin:
    0;

}

.buttons {

  margin-top:
    12px;

}

button {

  border:
    0;

  border-radius:
    9px;

  padding:
    10px 15px;

  font-weight:
    900;

  cursor:
    pointer;

  background:
    #f1f5f9;

  color:
    #08101f;

  margin-right:
    7px;

}

button.secondary {

  background:
    #263551;

  color:
    #fff;

}

.status {

  margin-top:
    11px;

  padding:
    10px;

  border-radius:
    8px;

  background:
    #0d1527;

  color:
    #9fb0d0;

  font-size:
    13px;

}

.signal {

  border:
    1px solid #2c4660;

  background:
    #0e1729;

  border-radius:
    12px;

  padding:
    16px;

  margin-top:
    10px;

}

.signal-head {

  display:
    flex;

  justify-content:
    space-between;

  gap:
    10px;

  align-items:
    center;

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

  font-weight:
    900;

}

.strategy {

  color:
    #b8c7e3;

  font-size:
    13px;

  margin-top:
    4px;

}

.stats {

  display:
    grid;

  grid-template-columns:
    repeat(5,1fr);

  gap:
    8px;

  margin:
    13px 0;

}

.stat {

  background:
    #131f35;

  padding:
    9px;

  border-radius:
    8px;

}

.stat span {

  display:
    block;

  color:
    #7185ac;

  font-size:
    10px;

  text-transform:
    uppercase;

}

.stat b {

  display:
    block;

  margin-top:
    4px;

  font-size:
    14px;

}

.plan {

  background:
    #101c31;

  border-radius:
    9px;

  padding:
    12px;

  margin-top:
    10px;

}

.plan-title {

  font-weight:
    900;

  margin-bottom:
    8px;

}

.plan-grid {

  display:
    grid;

  grid-template-columns:
    repeat(5,1fr);

  gap:
    7px;

}

.plan-item {

  background:
    #16233b;

  padding:
    9px;

  border-radius:
    7px;

}

.plan-item span {

  display:
    block;

  color:
    #7185ac;

  font-size:
    10px;

}

.plan-item b {

  display:
    block;

  margin-top:
    3px;

  font-size:
    13px;

}

.reason {

  color:
    #9fb0d0;

  font-size:
    12px;

  margin-top:
    10px;

}

.tv {

  display:
    inline-block;

  margin-top:
    11px;

  padding:
    8px 11px;

  border-radius:
    8px;

  background:
    #263551;

  color:
    #fff;

  text-decoration:
    none;

  font-size:
    12px;

  font-weight:
    900;

}

.preparing {

  border-color:
    #62521d;

}

.empty {

  text-align:
    center;

  padding:
    28px;

  color:
    #7185ac;

}

.footer {

  color:
    #617293;

  font-size:
    11px;

  margin-top:
    10px;

}

@media(max-width:800px) {

  .grid {

    grid-template-columns:
      repeat(2,1fr);

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

  .stats,
  .plan-grid {

    grid-template-columns:
      repeat(2,1fr);

  }

  .market {

    display:
      block;

  }

}

</style>

</head>

<body>

<div class="container">


<div class="header">

  <div>

    <div class="title">
      🚀 Sonny AI Signal Scanner V5.1
    </div>

    <div class="subtitle">
      4H + 2H Kırılım · RSI Giriş · Her Dakika Yeni Tarama
    </div>

  </div>

  <div class="online">
    ● BITGET ONLINE
  </div>

</div>


<div class="market">

  <div>

    <div
      id="marketDirection"
      class="market-main neutral"
    >
      PİYASA VERİSİ BEKLENİYOR
    </div>

    <small id="marketText">
      Piyasanın genel yönü hesaplanıyor.
    </small>

  </div>

  <div>

    <b>
      Her 60 saniyede yeni tarama
    </b>

  </div>

</div>


<div class="grid">


  <div class="card">

    <div class="label">
      Piyasa
    </div>

    <div
      id="marketCount"
      class="value"
    >
      -
    </div>

  </div>


  <div class="card">

    <div class="label">
      Analiz
    </div>

    <div
      id="analyzed"
      class="value"
    >
      -
    </div>

  </div>


  <div class="card">

    <div class="label">
      Sinyal
    </div>

    <div
      id="signalCount"
      class="value"
    >
      0
    </div>

  </div>


  <div class="card">

    <div class="label">
      Hazırlanan
    </div>

    <div
      id="prepCount"
      class="value"
    >
      0
    </div>

  </div>


</div>


<div class="panel">

  <h2>
    🎯 Sistem ne arıyor?
  </h2>

  <p class="desc">

    <b>4H:</b>
    Ana destek/direnç ve ana yön.

    <b>2H:</b>
    Kırılımı doğruluyor.

    <b>15M:</b>
    RSI ile giriş zamanını kontrol ediyor.

    Kırılım ve RSI aynı yöndeyse
    <b>GERÇEK SİNYAL</b>
    gösterilir.

    Kırılıma yaklaşan ama henüz onaylanmayan
    coinler yalnızca
    <b>HAZIRLANAN FIRSATLAR</b>
    bölümünde görünür.

  </p>


  <div class="buttons">

    <button onclick="manualScan()">
      🔎 Şimdi Tara
    </button>

    <button
      class="secondary"
      onclick="loadResult()"
    >
      ↻ Yenile
    </button>

  </div>


  <div
    id="status"
    class="status"
  >
    Sistem otomatik olarak her dakika tarama yapıyor...
  </div>

</div>


<div class="panel">

  <h2>
    🚨 GERÇEK SİNYALLER
  </h2>

  <div id="signals">

    <div class="empty">
      Henüz güçlü sinyal yok.
    </div>

  </div>

</div>


<div class="panel">

  <h2>
    🟡 HAZIRLANAN FIRSATLAR
  </h2>

  <p class="desc">

    Kırılım bölgesine yaklaşan coinler burada görünür.

    Kırılım ve RSI onayı geldiğinde
    gerçek sinyale dönüşür.

  </p>


  <div id="preparing">

    <div class="empty">
      Şu anda hazırlanan fırsat yok.
    </div>

  </div>

</div>


<div class="footer">

  Sonny AI Signal Scanner V5.1 ·
  Bitget Futures ·
  4H + 2H + 15M ·
  Manual Trading Only

</div>


</div>


<script>


function fmt(v) {

  return (
    v === null ||
    v === undefined
  )
    ? "-"
    : v;

}


function directionClass(
  d
) {

  return d === "LONG"
    ? "long"
    : "short";

}


function renderSignal(
  x,
  preparing = false
) {

  const cls =
    directionClass(
      x.direction
    );


  const title =
    preparing
      ? "🟡 HAZIRLANIYOR"
      : "🚨 SİNYAL";


  const triggerText =
    preparing

      ? (
          x.direction === "LONG"

            ? (
                x.trigger +
                " üzerine çıkarsa LONG tetiklenebilir."
              )

            : (
                x.trigger +
                " altına inerse SHORT tetiklenebilir."
              )
        )

      : "Kırılım gerçekleşti ve RSI girişi onaylandı.";


  return (

    '<div class="signal ' +
    (
      preparing
        ? "preparing"
        : ""
    ) +
    '">' +


    '<div class="signal-head">' +

      '<div>' +

        '<span class="coin">' +
          x.symbol +
        '</span> ' +

        '<span class="' +
          cls +
        '">' +
          x.direction +
        '</span>' +

        '<div class="strategy">' +
          title +
          ' · ' +
          x.strategy +
        '</div>' +

      '</div>' +


      '<div class="score">' +
        'GÜÇ ' +
        x.score +
        '/100' +
      '</div>' +

    '</div>' +


    '<div class="stats">' +


      '<div class="stat">' +

        '<span>Anlık Fiyat</span>' +

        '<b>' +
          fmt(x.price) +
        '</b>' +

      '</div>' +


      '<div class="stat">' +

        '<span>4H Yön</span>' +

        '<b class="' +
          directionClass(
            x.trend4
          ) +
        '">' +

          x.trend4 +

        '</b>' +

      '</div>' +


      '<div class="stat">' +

        '<span>2H Yön</span>' +

        '<b>' +
          x.trend2 +
        '</b>' +

      '</div>' +


      '<div class="stat">' +

        '<span>15M RSI</span>' +

        '<b>' +
          fmt(x.rsi15) +
        '</b>' +

      '</div>' +


      '<div class="stat">' +

        '<span>Hacim</span>' +

        '<b>' +
          fmt(x.volumeRatio) +
          'x' +
        '</b>' +

      '</div>' +


    '</div>' +


    '<div class="plan">' +

      '<div class="plan-title">' +
        '🎯 İŞLEM PLANI' +
      '</div>' +


      '<div class="plan-grid">' +


        '<div class="plan-item">' +

          '<span>GİRİŞ</span>' +

          '<b>' +
            x.plan.entryLow +
            ' - ' +
            x.plan.entryHigh +
          '</b>' +

        '</div>' +


        '<div class="plan-item">' +

          '<span>STOP</span>' +

          '<b>' +
            x.plan.stop +
          '</b>' +

        '</div>' +


        '<div class="plan-item">' +

          '<span>TP1</span>' +

          '<b>' +
            x.plan.tp1 +
          '</b>' +

        '</div>' +


        '<div class="plan-item">' +

          '<span>TP2</span>' +

          '<b>' +
            x.plan.tp2 +
          '</b>' +

        '</div>' +


        '<div class="plan-item">' +

          '<span>TP3</span>' +

          '<b>' +
            x.plan.tp3 +
          '</b>' +

        '</div>' +


      '</div>' +

    '</div>' +


    '<div class="reason">' +

      '<b>' +
        triggerText +
      '</b>' +

      '<br>' +

      x.reason +

      '<br>' +

      'Giriş planındaki fiyatlar tarama anına aittir; anlık fiyat her dakika güncellenir.' +

    '</div>' +


    '<a ' +
      'class="tv" ' +
      'target="_blank" ' +
      'rel="noopener" ' +
      'href="' +
        x.tradingView +
      '">' +

      '📈 TradingView\'de Aç' +

    '</a>' +


    '</div>'

  );

}


function update(
  data
) {

  if (!data) {
    return;
  }


  document.getElementById(
    "marketCount"
  ).innerText =
    fmt(
      data.marketDiscovery
        ?.totalCoins
    );


  document.getElementById(
    "analyzed"
  ).innerText =
    fmt(
      data.scan
        ?.analyzed
    );


  document.getElementById(
    "signalCount"
  ).innerText =
    (
      data.signals || []
    ).length;


  document.getElementById(
    "prepCount"
  ).innerText =
    (
      data.preparing || []
    ).length;


  const m =
    data.market || {};


  const el =
    document.getElementById(
      "marketDirection"
    );


  el.innerText =
    m.label ||
    "PİYASA YATAY";


  el.className =
    "market-main " +
    (
      m.direction === "LONG"
        ? "long"

        : m.direction === "SHORT"
          ? "short"

          : "neutral"
    );


  document.getElementById(
    "marketText"
  ).innerText =

    m.direction === "LONG"

      ? (
          "Son 30 büyük coin içinde " +
          "yükseliş baskısı daha güçlü. " +
          "Güç: %" +
          (m.strength || 0)
        )

      : m.direction === "SHORT"

        ? (
            "Son 30 büyük coin içinde " +
            "düşüş baskısı daha güçlü. " +
            "Güç: %" +
            (m.strength || 0)
          )

        : "Belirgin bir yön üstünlüğü yok. Seçici olmak gerekiyor.";


  document.getElementById(
    "status"
  ).innerText =

    "Son tarama: " +

    new Date(
      data.timestamp
    ).toLocaleTimeString(
      "tr-TR"
    ) +

    " · Sistem otomatik taramaya devam ediyor.";


  const sig =
    data.signals || [];


  document.getElementById(
    "signals"
  ).innerHTML =

    sig.length

      ? sig
          .map(
            x =>
              renderSignal(
                x,
                false
              )
          )
          .join("")

      : '<div class="empty">' +
          'Şu anda güçlü sinyal yok. ' +
          'Sistem yeni fırsatları aramaya devam ediyor.' +
        '</div>';


  const prep =
    data.preparing || [];


  document.getElementById(
    "preparing"
  ).innerHTML =

    prep.length

      ? prep
          .map(
            x =>
              renderSignal(
                x,
                true
              )
          )
          .join("")

      : '<div class="empty">' +
          'Şu anda hazırlanan fırsat yok.' +
        '</div>';

}


/* =========================================================
   LOAD CURRENT RESULT
========================================================= */

async function loadResult() {

  try {

    const response =
      await fetch(
        "/api/result?ts=" +
        Date.now(),
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

      update(
        data.result
      );

    }

  } catch (
    error
  ) {

    document.getElementById(
      "status"
    ).innerText =
      "Sonuç alınırken bağlantı hatası oluştu.";

  }

}


/* =========================================================
   MANUAL SCAN
========================================================= */

async function manualScan() {

  document.getElementById(
    "status"
  ).innerText =
    "Yeni tarama yapılıyor...";


  try {

    const response =
      await fetch(
        "/api/scan?ts=" +
        Date.now(),
        {
          cache:
            "no-store"
        }
      );


    const data =
      await response.json();


    if (
      data.success
    ) {

      update(
        data
      );

    } else {

      document.getElementById(
        "status"
      ).innerText =
        "Tarama hatası: " +
        data.error;

    }

  } catch (
    error
  ) {

    document.getElementById(
      "status"
    ).innerText =
      "Bağlantı hatası: " +
      error.message;

  }

}


/* =========================================================
   PAGE START
========================================================= */

loadResult();


/*
   Arayüz 15 saniyede bir
   son sonucu kontrol eder.

   Sunucu ise her 60 saniyede
   yeni piyasa taraması yapar.
*/

setInterval(
  loadResult,
  15000
);


</script>

</body>

</html>`;


/* =========================================================
   ROUTES
========================================================= */

app.get(
  "/",
  (req, res) => {

    res.setHeader(
      "Content-Type",
      "text/html; charset=utf-8"
    );

    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    res.send(
      HTML
    );

  }
);


/* =========================================================
   HEALTH
========================================================= */

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

      uptime:
        process.uptime()

    });

  }
);


/* =========================================================
   STATUS
========================================================= */

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

      refresh:
        "60 seconds",

      lastScan,

      marketCoins:
        marketCache.length,

      error:
        lastError

    });

  }
);


/* =========================================================
   RESULT
========================================================= */

app.get(
  "/api/result",
  (req, res) => {

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


    res.json({

      success:
        true,

      result:
        cachedResult

    });

  }
);


/* =========================================================
   MANUAL SCAN ENDPOINT
========================================================= */

app.get(
  "/api/scan",
  async (req, res) => {

    res.json(
      await runRadar()
    );

  }
);


/* =========================================================
   404
========================================================= */

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


/* =========================================================
   SERVER
========================================================= */

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
      "Timeframes: 4H + 2H + 15M"
    );

    log(
      "Strategy: 4H/2H Breakout + RSI"
    );

    log(
      "Refresh: Every 60 seconds"
    );

    log(
      `Server listening on port ${PORT}`
    );


    /*
      Render açıldıktan 3 saniye sonra
      ilk otomatik tarama.
    */

    setTimeout(
      () => {

        refreshLoop();

      },
      3000
    );


    /*
      Bundan sonra sürekli
      her 60 saniyede bir.
    */

    setInterval(
      () => {

        refreshLoop();

      },
      CONFIG.REFRESH_MS
    );

  }
);
