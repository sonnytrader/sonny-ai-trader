const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 10000;

const BYBIT_REST_ENDPOINTS = [
  "https://api.bybit.com",
  "https://api.bytick.com"
];

const BYBIT_WS_URL =
  "wss://stream.bybit.com/v5/public/linear";

const SYMBOLS = [
  "EURUSDUSDT",
  "GBPUSDUSDT",
  "USDJPYUSDT",
  "XAUUSDT"
];

const TIMEFRAMES = ["1", "5", "15"];

const CONFIG = {

  ENTRY_SCORE: 82,

  STRONG_SCORE: 88,

  EMA_FAST: 21,

  EMA_SLOW: 50,

  ATR_PERIOD: 14,

  STRUCTURE_LOOKBACK: 12,

  LIQUIDITY_LOOKBACK: 20,

  RETEST_ATR: 0.40,

  SL_ATR: {
    EURUSDUSDT: 1.20,
    GBPUSDUSDT: 1.20,
    USDJPYUSDT: 1.20,
    XAUUSDT: 1.35
  },

  TP1_R: 1,
  TP2_R: 2,
  TP3_R: 3,

  SIGNAL_COOLDOWN: 15 * 60 * 1000,

  MAX_SIGNALS: 100,

  HISTORY_LIMIT: 300
};


// ============================================================
// STATE
// ============================================================

const state = {

  candles: {},

  ticker: {},

  trades: {},

  signals: [],

  cooldowns: {},

  wsClients: new Set(),

  wsConnected: false,

  lastRESTSuccess: null,

  lastRESTError: null,

  lastScan: null,

  startedAt: Date.now()
};


for (const symbol of SYMBOLS) {

  state.candles[symbol] = {};

  for (const tf of TIMEFRAMES) {

    state.candles[symbol][tf] = [];

  }

  state.trades[symbol] = [];

}


// ============================================================
// HTTP HELPER
// ============================================================

async function bybitRequest(path, params = {}) {

  const query =
    new URLSearchParams(params).toString();

  let lastError = null;

  for (
    const endpoint of BYBIT_REST_ENDPOINTS
  ) {

    try {

      const url =
        `${endpoint}${path}?${query}`;

      const response =
        await fetch(url, {
          method: "GET",
          headers: {
            "User-Agent":
              "SonnyTrader/1.0",
            "Accept":
              "application/json"
          }
        });

      const text =
        await response.text();

      if (!response.ok) {

        lastError =
          new Error(
            `HTTP ${response.status} ${endpoint} ${text.slice(0, 200)}`
          );

        continue;
      }

      const json =
        JSON.parse(text);

      if (json.retCode !== 0) {

        lastError =
          new Error(
            `Bybit ${json.retCode}: ${json.retMsg}`
          );

        continue;
      }

      state.lastRESTSuccess =
        Date.now();

      return json;

    } catch (err) {

      lastError = err;

    }
  }

  state.lastRESTError = {
    time: Date.now(),
    message: lastError?.message || "Unknown"
  };

  throw lastError ||
    new Error("Bybit request failed");
}


// ============================================================
// BYBIT SERVER TIME TEST
// ============================================================

async function testBybit() {

  try {

    const result =
      await bybitRequest(
        "/v5/market/time"
      );

    console.log(
      "✅ BYBIT REST CONNECTED"
    );

    console.log(
      "Bybit time:",
      result.time
    );

    return true;

  } catch (err) {

    console.error(
      "❌ BYBIT REST FAILED:",
      err.message
    );

    return false;
  }
}


// ============================================================
// LOAD KLINES
// ============================================================

async function loadKlines(
  symbol,
  interval,
  limit = CONFIG.HISTORY_LIMIT
) {

  const result =
    await bybitRequest(
      "/v5/market/kline",
      {
        category: "linear",
        symbol,
        interval,
        limit: String(limit)
      }
    );

  const rows =
    result.result?.list || [];

  return rows
    .slice()
    .reverse()
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
        Number(row[5]),

      turnover:
        Number(row[6]),

      closed: true
    }));
}


// ============================================================
// INITIAL HISTORY
// ============================================================

async function loadInitialHistory() {

  console.log(
    "\n--- BYBIT HISTORY LOADING ---"
  );

  for (const symbol of SYMBOLS) {

    for (const tf of TIMEFRAMES) {

      try {

        const candles =
          await loadKlines(
            symbol,
            tf
          );

        state.candles[symbol][tf] =
          candles;

        console.log(
          `${symbol} ${tf}m -> ${candles.length} candles`
        );

      } catch (err) {

        console.error(
          `${symbol} ${tf}m ERROR:`,
          err.message
        );
      }
    }
  }

  console.log(
    "--- HISTORY COMPLETE ---\n"
  );
}


// ============================================================
// EMA
// ============================================================

function EMA(candles, period) {

  if (
    candles.length < period
  ) {
    return null;
  }

  const k =
    2 / (period + 1);

  let value =
    candles
      .slice(0, period)
      .reduce(
        (sum, c) =>
          sum + c.close,
        0
      ) / period;

  for (
    let i = period;
    i < candles.length;
    i++
  ) {

    value =
      candles[i].close * k +
      value * (1 - k);
  }

  return value;
}


// ============================================================
// ATR
// ============================================================

function ATR(
  candles,
  period = 14
) {

  if (
    candles.length <
    period + 1
  ) {
    return null;
  }

  const trs = [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {

    const c =
      candles[i];

    const p =
      candles[i - 1];

    const tr =
      Math.max(

        c.high - c.low,

        Math.abs(
          c.high - p.close
        ),

        Math.abs(
          c.low - p.close
        )
      );

    trs.push(tr);
  }

  const values =
    trs.slice(-period);

  return (
    values.reduce(
      (a, b) => a + b,
      0
    ) /
    values.length
  );
}


// ============================================================
// TREND
// ============================================================

function getTrend(candles) {

  const e21 =
    EMA(
      candles,
      CONFIG.EMA_FAST
    );

  const e50 =
    EMA(
      candles,
      CONFIG.EMA_SLOW
    );

  if (
    !e21 ||
    !e50
  ) {
    return "NEUTRAL";
  }

  const close =
    candles[
      candles.length - 1
    ].close;

  if (
    close > e21 &&
    e21 > e50
  ) {

    return "BULLISH";
  }

  if (
    close < e21 &&
    e21 < e50
  ) {

    return "BEARISH";
  }

  return "NEUTRAL";
}


// ============================================================
// LIQUIDITY SWEEP
// ============================================================

function getLiquiditySweep(
  candles
) {

  if (
    candles.length <
    CONFIG.LIQUIDITY_LOOKBACK + 2
  ) {

    return {
      bullish: false,
      bearish: false,
      low: null,
      high: null
    };
  }

  const current =
    candles[
      candles.length - 1
    ];

  const previous =
    candles.slice(
      -CONFIG.LIQUIDITY_LOOKBACK - 1,
      -1
    );

  const high =
    Math.max(
      ...previous.map(
        c => c.high
      )
    );

  const low =
    Math.min(
      ...previous.map(
        c => c.low
      )
    );

  return {

    bullish:
      current.low < low &&
      current.close > low,

    bearish:
      current.high > high &&
      current.close < high,

    low,
    high
  };
}


// ============================================================
// STRUCTURE BREAK
// ============================================================

function getStructureBreak(
  candles,
  direction
) {

  if (
    candles.length <
    CONFIG.STRUCTURE_LOOKBACK + 2
  ) {

    return false;
  }

  const current =
    candles[
      candles.length - 1
    ];

  const previous =
    candles.slice(
      -CONFIG.STRUCTURE_LOOKBACK - 1,
      -1
    );

  const high =
    Math.max(
      ...previous.map(
        c => c.high
      )
    );

  const low =
    Math.min(
      ...previous.map(
        c => c.low
      )
    );

  if (
    direction === "LONG"
  ) {

    return (
      current.close > high
    );
  }

  if (
    direction === "SHORT"
  ) {

    return (
      current.close < low
    );
  }

  return false;
}


// ============================================================
// CANDLE MOMENTUM
// ============================================================

function getMomentum(
  candle
) {

  const range =
    candle.high -
    candle.low;

  if (range <= 0) {

    return {
      bullish: false,
      bearish: false,
      ratio: 0
    };
  }

  const body =
    Math.abs(
      candle.close -
      candle.open
    );

  const ratio =
    body / range;

  return {

    bullish:
      candle.close >
        candle.open &&
      ratio >= 0.55,

    bearish:
      candle.close <
        candle.open &&
      ratio >= 0.55,

    ratio
  };
}


// ============================================================
// VOLUME
// ============================================================

function volumeConfirm(
  candles
) {

  if (
    candles.length < 10
  ) {
    return false;
  }

  const current =
    candles[
      candles.length - 1
    ];

  const previous =
    candles.slice(
      -9,
      -1
    );

  const average =
    previous.reduce(
      (sum, c) =>
        sum + c.volume,
      0
    ) /
    previous.length;

  return (
    current.volume >=
    average * 1.15
  );
}


// ============================================================
// RETEST
// ============================================================

function validRetest(
  price,
  level,
  atr
) {

  if (
    !level ||
    !atr
  ) {
    return false;
  }

  return (
    Math.abs(
      price - level
    ) <=
    atr *
    CONFIG.RETEST_ATR
  );
}


// ============================================================
// SCORE
// ============================================================

function calculateScore(
  data
) {

  let score = 0;

  if (
    data.trend
  ) {
    score += 20;
  }

  if (
    data.sweep
  ) {
    score += 20;
  }

  if (
    data.bos
  ) {
    score += 20;
  }

  if (
    data.retest
  ) {
    score += 15;
  }

  if (
    data.momentum5
  ) {
    score += 10;
  }

  if (
    data.momentum1
  ) {
    score += 10;
  }

  if (
    data.volume
  ) {
    score += 5;
  }

  return Math.min(
    100,
    score
  );
}


// ============================================================
// PRICE PRECISION
// ============================================================

function precision(
  symbol,
  value
) {

  if (
    symbol === "XAUUSDT"
  ) {

    return Number(
      value.toFixed(2)
    );
  }

  if (
    symbol === "USDJPYUSDT"
  ) {

    return Number(
      value.toFixed(3)
    );
  }

  return Number(
    value.toFixed(5)
  );
}


// ============================================================
// TRADE PLAN
// ============================================================

function createTradePlan({
  symbol,
  direction,
  entry,
  atr,
  score,
  reason
}) {

  const slMultiplier =
    CONFIG.SL_ATR[symbol];

  const risk =
    atr * slMultiplier;

  let stop;
  let tp1;
  let tp2;
  let tp3;

  if (
    direction === "LONG"
  ) {

    stop =
      entry - risk;

    tp1 =
      entry +
      risk *
      CONFIG.TP1_R;

    tp2 =
      entry +
      risk *
      CONFIG.TP2_R;

    tp3 =
      entry +
      risk *
      CONFIG.TP3_R;

  } else {

    stop =
      entry + risk;

    tp1 =
      entry -
      risk *
      CONFIG.TP1_R;

    tp2 =
      entry -
      risk *
      CONFIG.TP2_R;

    tp3 =
      entry -
      risk *
      CONFIG.TP3_R;
  }

  return {

    id:
      `SONNY-${symbol}-${Date.now()}`,

    symbol,

    exchange:
      "BYBIT",

    market:
      "TRADFI_PERPETUAL",

    direction,

    stage:
      "ENTRY",

    score,

    entry:
      precision(
        symbol,
        entry
      ),

    stop:
      precision(
        symbol,
        stop
      ),

    tp1:
      precision(
        symbol,
        tp1
      ),

    tp2:
      precision(
        symbol,
        tp2
      ),

    tp3:
      precision(
        symbol,
        tp3
      ),

    risk:

      precision(
        symbol,
        risk
      ),

    rr: {
      tp1: 1,
      tp2: 2,
      tp3: 3
    },

    reason,

    createdAt:
      Date.now(),

    expiresAt:
      Date.now() +
      CONFIG.SIGNAL_COOLDOWN
  };
}


// ============================================================
// ANALYZE SYMBOL
// ============================================================

function analyzeSymbol(
  symbol
) {

  const c15 =
    state.candles[
      symbol
    ]["15"];

  const c5 =
    state.candles[
      symbol
    ]["5"];

  const c1 =
    state.candles[
      symbol
    ]["1"];

  if (
    c15.length < 60 ||
    c5.length < 30 ||
    c1.length < 30
  ) {

    return null;
  }

  const last15 =
    c15[c15.length - 1];

  const last5 =
    c5[c5.length - 1];

  const last1 =
    c1[c1.length - 1];

  const trend =
    getTrend(c15);

  const sweep =
    getLiquiditySweep(c15);

  const atr =
    ATR(
      c15,
      CONFIG.ATR_PERIOD
    );

  if (!atr)
    return null;


  // ========================================================
  // LONG
  // ========================================================

  if (
    trend === "BULLISH" &&
    sweep.bullish
  ) {

    const bos =
      getStructureBreak(
        c15,
        "LONG"
      );

    const breakout =
      Math.max(
        ...c15
          .slice(
            -CONFIG.STRUCTURE_LOOKBACK - 1,
            -1
          )
          .map(
            c => c.high
          )
      );

    const retest =
      validRetest(
        last15.close,
        breakout,
        atr
      );

    const m5 =
      getMomentum(last5);

    const m1 =
      getMomentum(last1);

    const volume =
      volumeConfirm(c5);

    const score =
      calculateScore({

        trend: true,

        sweep: true,

        bos,

        retest,

        momentum5:
          m5.bullish,

        momentum1:
          m1.bullish,

        volume
      });

    if (
      score >=
        CONFIG.ENTRY_SCORE &&
      bos &&
      retest &&
      m5.bullish &&
      m1.bullish
    ) {

      return createTradePlan({

        symbol,

        direction:
          "LONG",

        entry:
          last1.close,

        atr,

        score,

        reason:
          "15M bullish trend + sell-side liquidity sweep + BOS + retest + M5/M1 momentum"
      });
    }
  }


  // ========================================================
  // SHORT
  // ========================================================

  if (
    trend === "BEARISH" &&
    sweep.bearish
  ) {

    const bos =
      getStructureBreak(
        c15,
        "SHORT"
      );

    const breakout =
      Math.min(
        ...c15
          .slice(
            -CONFIG.STRUCTURE_LOOKBACK - 1,
            -1
          )
          .map(
            c => c.low
          )
      );

    const retest =
      validRetest(
        last15.close,
        breakout,
        atr
      );

    const m5 =
      getMomentum(last5);

    const m1 =
      getMomentum(last1);

    const volume =
      volumeConfirm(c5);

    const score =
      calculateScore({

        trend: true,

        sweep: true,

        bos,

        retest,

        momentum5:
          m5.bearish,

        momentum1:
          m1.bearish,

        volume
      });

    if (
      score >=
        CONFIG.ENTRY_SCORE &&
      bos &&
      retest &&
      m5.bearish &&
      m1.bearish
    ) {

      return createTradePlan({

        symbol,

        direction:
          "SHORT",

        entry:
          last1.close,

        atr,

        score,

        reason:
          "15M bearish trend + buy-side liquidity sweep + BOS + retest + M5/M1 momentum"
      });
    }
  }

  return null;
}


// ============================================================
// DUPLICATE CHECK
// ============================================================

function isDuplicate(
  signal
) {

  return state.signals.some(
    old =>

      old.symbol ===
        signal.symbol &&

      old.direction ===
        signal.direction &&

      Date.now() -
        old.createdAt <
        CONFIG.SIGNAL_COOLDOWN
  );
}


// ============================================================
// SAVE SIGNAL
// ============================================================

function saveSignal(
  signal
) {

  if (
    isDuplicate(signal)
  ) {

    return false;
  }

  state.signals.unshift(
    signal
  );

  state.signals =
    state.signals.slice(
      0,
      CONFIG.MAX_SIGNALS
    );

  state.cooldowns[
    signal.symbol
  ] = Date.now();

  return true;
}


// ============================================================
// BROADCAST
// ============================================================

function broadcast(
  data
) {

  const payload =
    JSON.stringify(data);

  for (
    const client
    of state.wsClients
  ) {

    if (
      client.readyState ===
      WebSocket.OPEN
    ) {

      client.send(
        payload
      );
    }
  }
}


// ============================================================
// SCAN
// ============================================================

function scan() {

  state.lastScan =
    Date.now();

  for (
    const symbol
    of SYMBOLS
  ) {

    try {

      const signal =
        analyzeSymbol(
          symbol
        );

      if (!signal)
        continue;

      if (
        saveSignal(
          signal
        )
      ) {

        console.log(
          "\n===================================="
        );

        console.log(
          "🔥 SONNY FOREX ENTRY"
        );

        console.log(
          "===================================="
        );

        console.log(
          JSON.stringify(
            signal,
            null,
            2
          )
        );

        broadcast({

          type:
            "FOREX_SIGNAL",

          signal
        });
      }

    } catch (err) {

      console.error(
        `${symbol} scan error:`,
        err.message
      );
    }
  }
}


// ============================================================
// BYBIT WEBSOCKET
// ============================================================

let bybitWS = null;

let reconnectTimer = null;


function connectBybitWS() {

  if (
    bybitWS &&
    (
      bybitWS.readyState ===
        WebSocket.OPEN ||
      bybitWS.readyState ===
        WebSocket.CONNECTING
    )
  ) {

    return;
  }

  console.log(
    "Connecting Bybit WebSocket..."
  );

  bybitWS =
    new WebSocket(
      BYBIT_WS_URL
    );


  bybitWS.on(
    "open",
    () => {

      state.wsConnected =
        true;

      console.log(
        "✅ BYBIT WS CONNECTED"
      );

      const args = [];

      for (
        const symbol
        of SYMBOLS
      ) {

        for (
          const tf
          of TIMEFRAMES
        ) {

          args.push(
            `kline.${tf}.${symbol}`
          );
        }

        args.push(
          `tickers.${symbol}`
        );

        args.push(
          `publicTrade.${symbol}`
        );
      }

      bybitWS.send(
        JSON.stringify({

          op:
            "subscribe",

          args
        })
      );
    }
  );


  bybitWS.on(
    "message",
    raw => {

      try {

        const msg =
          JSON.parse(
            raw.toString()
          );

        if (
          !msg.topic
        ) {

          return;
        }


        // ==================================================
        // KLINE
        // ==================================================

        if (
          msg.topic.startsWith(
            "kline."
          )
        ) {

          const parts =
            msg.topic.split(".");

          const tf =
            parts[1];

          const symbol =
            parts[2];

          if (
            !state.candles[symbol] ||
            !state.candles[symbol][tf]
          ) {

            return;
          }

          const rows =
            msg.data || [];

          for (
            const row
            of rows
          ) {

            const candle = {

              time:
                Number(
                  row.start
                ),

              open:
                Number(
                  row.open
                ),

              high:
                Number(
                  row.high
                ),

              low:
                Number(
                  row.low
                ),

              close:
                Number(
                  row.close
                ),

              volume:
                Number(
                  row.volume
                ),

              turnover:
                Number(
                  row.turnover
                ),

              closed:
                Boolean(
                  row.confirm
                )
            };

            const arr =
              state.candles[
                symbol
              ][tf];

            const index =
              arr.findIndex(
                c =>
                  c.time ===
                  candle.time
              );

            if (
              index >= 0
            ) {

              arr[index] =
                candle;

            } else {

              arr.push(
                candle
              );
            }

            while (
              arr.length >
              CONFIG.HISTORY_LIMIT
            ) {

              arr.shift();
            }
          }

          return;
        }


        // ==================================================
        // TICKER
        // ==================================================

        if (
          msg.topic.startsWith(
            "tickers."
          )
        ) {

          const symbol =
            msg.topic.split(
              "."
            )[1];

          const d =
            msg.data;

          if (!d)
            return;

          state.ticker[
            symbol
          ] = {

            price:
              Number(
                d.lastPrice || 0
              ),

            bid:
              Number(
                d.bid1Price || 0
              ),

            ask:
              Number(
                d.ask1Price || 0
              ),

            mark:
              Number(
                d.markPrice || 0
              ),

            index:
              Number(
                d.indexPrice || 0
              ),

            funding:
              Number(
                d.fundingRate || 0
              ),

            timestamp:
              Date.now()
          };

          broadcast({

            type:
              "TICKER",

            symbol,

            ticker:
              state.ticker[
                symbol
              ]
          });

          return;
        }


        // ==================================================
        // PUBLIC TRADE
        // ==================================================

        if (
          msg.topic.startsWith(
            "publicTrade."
          )
        ) {

          const symbol =
            msg.topic.split(
              "."
            )[1];

          if (
            !state.trades[symbol]
          ) {

            return;
          }

          for (
            const trade
            of msg.data || []
          ) {

            state.trades[
              symbol
            ].push({

              time:
                Number(
                  trade.T ||
                  Date.now()
                ),

              price:
                Number(
                  trade.p
                ),

              size:
                Number(
                  trade.v
                ),

              side:
                trade.S
            });
          }

          const cutoff =
            Date.now() -
            120000;

          state.trades[
            symbol
          ] =
            state.trades[
              symbol
            ].filter(
              x =>
                x.time >=
                cutoff
            );
        }

      } catch (err) {

        console.error(
          "WS message error:",
          err.message
        );
      }
    }
  );


  bybitWS.on(
    "close",
    () => {

      state.wsConnected =
        false;

      console.log(
        "⚠️ BYBIT WS CLOSED"
      );

      scheduleReconnect();
    }
  );


  bybitWS.on(
    "error",
    err => {

      state.wsConnected =
        false;

      console.error(
        "❌ BYBIT WS ERROR:",
        err.message
      );
    }
  );
}


// ============================================================
// RECONNECT
// ============================================================

function scheduleReconnect() {

  if (
    reconnectTimer
  ) {

    return;
  }

  reconnectTimer =
    setTimeout(
      () => {

        reconnectTimer =
          null;

        connectBybitWS();

      },
      5000
    );
}


// ============================================================
// REMOVE EXPIRED SIGNALS
// ============================================================

function cleanupSignals() {

  const now =
    Date.now();

  state.signals =
    state.signals.filter(
      signal =>
        now -
          signal.createdAt <
        CONFIG.SIGNAL_COOLDOWN
    );
}


// ============================================================
// API STATUS
// ============================================================

app.get(
  "/api/status",
  (req, res) => {

    res.json({

      ok: true,

      engine:
        "SONNY FOREX BYBIT V2",

      exchange:
        "BYBIT",

      market:
        "TRADFI PERPETUAL",

      symbols:
        SYMBOLS,

      wsConnected:
        state.wsConnected,

      restConnected:
        Boolean(
          state.lastRESTSuccess
        ),

      lastRESTSuccess:
        state.lastRESTSuccess,

      lastRESTError:
        state.lastRESTError,

      lastScan:
        state.lastScan,

      signals:
        state.signals,

      ticker:
        state.ticker,

      uptime:
        process.uptime()
    });
  }
);


// ============================================================
// API SIGNALS
// ============================================================

app.get(
  "/api/signals",
  (req, res) => {

    res.json(
      state.signals
    );
  }
);


// ============================================================
// API CANDLES
// ============================================================

app.get(
  "/api/candles/:symbol/:tf",
  (req, res) => {

    const {
      symbol,
      tf
    } = req.params;

    if (
      !state.candles[symbol] ||
      !state.candles[symbol][tf]
    ) {

      return res
        .status(404)
        .json({
          error:
            "Symbol/timeframe not found"
        });
    }

    res.json(
      state.candles[
        symbol
      ][tf]
    );
  }
);


// ============================================================
// BYBIT TEST
// ============================================================

app.get(
  "/api/bybit-test",
  async (req, res) => {

    try {

      const data =
        await bybitRequest(
          "/v5/market/time"
        );

      res.json({

        ok: true,

        endpoint:
          "Bybit V5",

        time:
          data.time

      });

    } catch (err) {

      res
        .status(502)
        .json({

          ok: false,

          error:
            err.message,

          hint:
            "Render region must be Frankfurt or Singapore if Bybit blocks the current IP."
        });
    }
  }
);


// ============================================================
// HEALTH
// ============================================================

app.get(
  "/api/health",
  (req, res) => {

    res.json({

      ok: true,

      engine:
        "SONNY FOREX BYBIT V2",

      ws:
        state.wsConnected,

      rest:
        Boolean(
          state.lastRESTSuccess
        ),

      uptime:
        process.uptime(),

      symbols:
        SYMBOLS.length,

      signals:
        state.signals.length
    });
  }
);


// ============================================================
// FRONTEND
// ============================================================

app.get(
  "/",
  (req, res) => {

    res.send(`
<!DOCTYPE html>

<html lang="tr">

<head>

<meta charset="UTF-8">

<meta
name="viewport"
content="width=device-width,initial-scale=1"
/>

<title>
SonnyTrader Forex
</title>

<style>

*{
box-sizing:border-box;
}

body{
margin:0;
background:#080b10;
color:#e8edf5;
font-family:Arial,sans-serif;
}

header{
padding:18px 24px;
border-bottom:1px solid #202630;
display:flex;
justify-content:space-between;
align-items:center;
}

.logo{
font-size:22px;
font-weight:bold;
}

.status{
font-size:13px;
}

.green{
color:#38d996;
}

.red{
color:#ff5d73;
}

main{
padding:20px;
}

.grid{
display:grid;
grid-template-columns:
repeat(auto-fit,minmax(250px,1fr));
gap:14px;
}

.card{
background:#10151d;
border:1px solid #202630;
border-radius:12px;
padding:16px;
}

.symbol{
font-size:18px;
font-weight:bold;
}

.price{
font-size:28px;
margin-top:10px;
}

.signal{
margin-top:12px;
padding:12px;
border-radius:10px;
background:#151c25;
}

.long{
border-left:4px solid #27d88b;
}

.short{
border-left:4px solid #ff5c72;
}

.score{
font-size:24px;
font-weight:bold;
}

.small{
font-size:12px;
color:#8d98a8;
margin-top:5px;
}

</style>

</head>

<body>

<header>

<div class="logo">
SONNYTRADER
</div>

<div
id="status"
class="status">
Connecting...
</div>

</header>

<main>

<div
id="markets"
class="grid">
</div>

<h2>
Signals
</h2>

<div
id="signals"
class="grid">
</div>

</main>

<script>

const ws =
new WebSocket(
location.protocol === "https:"
? "wss://" + location.host
: "ws://" + location.host
);

const markets = {};

const signals = {};

const status =
document.getElementById(
"status"
);

ws.onopen = () => {

status.textContent =
"BYBIT WS CONNECTED";

status.className =
"status green";

};

ws.onclose = () => {

status.textContent =
"BYBIT WS DISCONNECTED";

status.className =
"status red";

};

ws.onmessage = event => {

const data =
JSON.parse(
event.data
);

if (
data.type === "INIT"
) {

Object.assign(
signals,
Object.fromEntries(
(data.signals || [])
.map(
s => [s.id,s]
)
)
);

Object.assign(
markets,
data.ticker || {}
);

render();

}

if (
data.type === "TICKER"
) {

markets[
data.symbol
] =
data.ticker;

render();

}

if (
data.type === "FOREX_SIGNAL"
) {

signals[
data.signal.id
] =
data.signal;

render();

}

};

function renderMarkets(){

const container =
document.getElementById(
"markets"
);

container.innerHTML =
"";

for (
const [symbol,t]
of Object.entries(markets)
){

container.innerHTML += `

<div class="card">

<div class="symbol">
${symbol}
</div>

<div class="price">
${t.price || "-"}
</div>

<div class="small">
Mark:
${t.mark || "-"}
</div>

<div class="small">
Index:
${t.index || "-"}
</div>

</div>

`;

}

}

function renderSignals(){

const container =
document.getElementById(
"signals"
);

container.innerHTML =
"";

Object.values(signals)
.slice(0,20)
.forEach(
s => {

const cls =
s.direction === "LONG"
? "long"
: "short";

container.innerHTML += `

<div
class="card signal ${cls}">

<div class="symbol">
${s.symbol}
</div>

<div>
${s.direction}
</div>

<div class="score">
${s.score}/100
</div>

<div class="small">
ENTRY:
${s.entry}
</div>

<div class="small">
SL:
${s.stop}
</div>

<div class="small">
TP1:
${s.tp1}
</div>

<div class="small">
TP2:
${s.tp2}
</div>

<div class="small">
TP3:
${s.tp3}
</div>

<div class="small">
${s.reason}
</div>

</div>

`;

});

}

function render(){

renderMarkets();

renderSignals();

}

</script>

</body>

</html>
`);
  }
);


// ============================================================
// BROWSER WEBSOCKET
// ============================================================

const browserWSS =
new WebSocket.Server({
  server,
  path: "/"
});

browserWSS.on(
  "connection",
  ws => {

    state.wsClients.add(
      ws
    );

    ws.send(
      JSON.stringify({

        type:
          "INIT",

        signals:
          state.signals,

        ticker:
          state.ticker

      })
    );

    ws.on(
      "close",
      () => {

        state.wsClients.delete(
          ws
        );

      }
    );
  }
);


// ============================================================
// START
// ============================================================

async function start() {

  console.log(
    "\n======================================"
  );

  console.log(
    " SONNYTRADER FOREX — BYBIT V2"
  );

  console.log(
    "======================================"
  );

  console.log(
    "Symbols:",
    SYMBOLS.join(", ")
  );

  console.log(
    "Auto Trade: OFF"
  );

  console.log(
    "======================================\n"
  );


  // --------------------------------------
  // BYBIT TEST
  // --------------------------------------

  const connected =
    await testBybit();

  if (!connected) {

    console.error(
      "\n❌ BYBIT REST ERİŞİLEMİYOR."
    );

    console.error(
      "Render servisinin Frankfurt veya Singapore bölgesinde olduğundan emin ol."
    );

  } else {

    await loadInitialHistory();

  }


  // --------------------------------------
  // WS
  // --------------------------------------

  connectBybitWS();


  // --------------------------------------
  // SCANNER
  // --------------------------------------

  setInterval(
    () => {

      scan();

    },
    15000
  );


  // --------------------------------------
  // CLEANUP
  // --------------------------------------

  setInterval(
    () => {

      cleanupSignals();

    },
    30000
  );


  // --------------------------------------
  // SERVER
  // --------------------------------------

  server.listen(
    PORT,
    "0.0.0.0",
    () => {

      console.log(
        `\n🚀 SonnyTrader running on ${PORT}`
      );

      console.log(
        `🌐 http://0.0.0.0:${PORT}`
      );

      console.log(
        "📡 Bybit V5 REST + WebSocket"
      );

      console.log(
        "📊 1M / 5M / 15M"
      );

      console.log(
        "🎯 ENTRY score:",
        CONFIG.ENTRY_SCORE
      );

    }
  );
}


start()
.catch(
  err => {

    console.error(
      "FATAL:",
      err
    );

    process.exit(1);

  }
);
