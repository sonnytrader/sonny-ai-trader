const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 10000;

const BYBIT_REST = "https://api.bybit.com";
const BYBIT_WS = "wss://stream.bybit.com/v5/public/linear";

const SYMBOLS = [
  "EURUSDUSDT",
  "GBPUSDUSDT",
  "USDJPYUSDT",
  "XAUUSDT"
];

const CONFIG = {
  category: "linear",

  scoreEntry: 82,
  scoreStrong: 88,

  emaFast: 21,
  emaSlow: 50,

  atrPeriod: 14,

  structureLookback: 12,
  liquidityLookback: 20,

  slAtr: {
    EURUSDUSDT: 1.20,
    GBPUSDUSDT: 1.20,
    USDJPYUSDT: 1.20,
    XAUUSDT: 1.35
  },

  tp1R: 1,
  tp2R: 2,
  tp3R: 3,

  maxSignalAge: 10 * 60 * 1000,

  scanInterval: 15000
};

const state = {
  candles: {},
  ticker: {},
  trades: {},
  signals: [],
  clients: new Set()
};

for (const symbol of SYMBOLS) {
  state.candles[symbol] = {
    "1": [],
    "5": [],
    "15": []
  };

  state.trades[symbol] = [];
}


// ============================================================
// BYBIT REST
// ============================================================

async function bybit(path, params = {}) {

  const query = new URLSearchParams(params).toString();

  const url =
    `${BYBIT_REST}${path}?${query}`;

  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Bybit HTTP ${response.status}`
    );
  }

  const json =
    await response.json();

  if (json.retCode !== 0) {
    throw new Error(
      `Bybit ${json.retCode}: ${json.retMsg}`
    );
  }

  return json;
}


// ============================================================
// LOAD CANDLES
// ============================================================

async function loadCandles(symbol, interval, limit = 200) {

  const data =
    await bybit(
      "/v5/market/kline",
      {
        category: "linear",
        symbol,
        interval,
        limit
      }
    );

  const list =
    data.result.list
      .slice()
      .reverse();

  return list.map(c => ({
    time: Number(c[0]),
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[5]),
    turnover: Number(c[6])
  }));
}


// ============================================================
// TECHNICALS
// ============================================================

function ema(candles, period) {

  if (candles.length < period)
    return null;

  const k = 2 / (period + 1);

  let value =
    candles
      .slice(0, period)
      .reduce(
        (a, b) => a + b.close,
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


function atr(candles, period = 14) {

  if (candles.length < period + 1)
    return null;

  const trs = [];

  for (let i = 1; i < candles.length; i++) {

    const c = candles[i];
    const p = candles[i - 1];

    trs.push(
      Math.max(
        c.high - c.low,
        Math.abs(c.high - p.close),
        Math.abs(c.low - p.close)
      )
    );
  }

  const values =
    trs.slice(-period);

  return (
    values.reduce(
      (a, b) => a + b,
      0
    ) / values.length
  );
}


function highest(candles, count) {

  return Math.max(
    ...candles
      .slice(-count)
      .map(c => c.high)
  );
}


function lowest(candles, count) {

  return Math.min(
    ...candles
      .slice(-count)
      .map(c => c.low)
  );
}


// ============================================================
// TREND
// ============================================================

function getTrend(candles) {

  const last =
    candles[candles.length - 1];

  const e21 =
    ema(candles, CONFIG.emaFast);

  const e50 =
    ema(candles, CONFIG.emaSlow);

  if (!e21 || !e50)
    return "NEUTRAL";

  if (
    last.close > e21 &&
    e21 > e50
  ) {
    return "BULLISH";
  }

  if (
    last.close < e21 &&
    e21 < e50
  ) {
    return "BEARISH";
  }

  return "NEUTRAL";
}


// ============================================================
// LIQUIDITY SWEEP
// ============================================================

function liquiditySweep(candles) {

  if (
    candles.length <
    CONFIG.liquidityLookback + 2
  ) {
    return {
      bullish: false,
      bearish: false
    };
  }

  const current =
    candles[candles.length - 1];

  const previous =
    candles.slice(
      -CONFIG.liquidityLookback - 1,
      -1
    );

  const high =
    Math.max(
      ...previous.map(c => c.high)
    );

  const low =
    Math.min(
      ...previous.map(c => c.low)
    );

  return {

    // Sell-side liquidity taken
    bullish:
      current.low < low &&
      current.close > low,

    // Buy-side liquidity taken
    bearish:
      current.high > high &&
      current.close < high
  };
}


// ============================================================
// BREAK OF STRUCTURE
// ============================================================

function structureBreak(
  candles,
  direction
) {

  if (
    candles.length <
    CONFIG.structureLookback + 2
  ) {
    return false;
  }

  const current =
    candles[candles.length - 1];

  const previous =
    candles.slice(
      -CONFIG.structureLookback - 1,
      -1
    );

  const high =
    Math.max(
      ...previous.map(c => c.high)
    );

  const low =
    Math.min(
      ...previous.map(c => c.low)
    );

  if (direction === "LONG")
    return current.close > high;

  if (direction === "SHORT")
    return current.close < low;

  return false;
}


// ============================================================
// MOMENTUM
// ============================================================

function momentum(candle) {

  const range =
    candle.high - candle.low;

  if (range <= 0)
    return {
      bullish: false,
      bearish: false,
      strength: 0
    };

  const body =
    Math.abs(
      candle.close - candle.open
    );

  const ratio =
    body / range;

  return {

    bullish:
      candle.close > candle.open &&
      ratio >= 0.55,

    bearish:
      candle.close < candle.open &&
      ratio >= 0.55,

    strength: ratio
  };
}


// ============================================================
// VOLUME CONFIRMATION
// ============================================================

function volumeConfirmation(candles) {

  if (candles.length < 10)
    return false;

  const current =
    candles[candles.length - 1];

  const previous =
    candles.slice(-9, -1);

  const avg =
    previous.reduce(
      (a, b) => a + b.volume,
      0
    ) / previous.length;

  return current.volume >= avg * 1.15;
}


// ============================================================
// SCORE
// ============================================================

function calculateScore(data) {

  let score = 0;

  if (data.trendMatch)
    score += 20;

  if (data.liquiditySweep)
    score += 20;

  if (data.structureBreak)
    score += 20;

  if (data.retest)
    score += 15;

  if (data.momentum5)
    score += 10;

  if (data.momentum1)
    score += 10;

  if (data.volume)
    score += 5;

  return Math.min(
    100,
    score
  );
}


// ============================================================
// RETEST
// ============================================================

function validRetest(
  price,
  level,
  atrValue
) {

  if (!level || !atrValue)
    return false;

  return (
    Math.abs(price - level) <=
    atrValue * 0.40
  );
}


// ============================================================
// TRADE PLAN
// ============================================================

function makePlan(
  symbol,
  direction,
  entry,
  atrValue,
  score,
  reason
) {

  const multiplier =
    CONFIG.slAtr[symbol] || 1.2;

  const risk =
    atrValue * multiplier;

  let stop;
  let tp1;
  let tp2;
  let tp3;

  if (direction === "LONG") {

    stop =
      entry - risk;

    tp1 =
      entry + risk;

    tp2 =
      entry + risk * 2;

    tp3 =
      entry + risk * 3;

  } else {

    stop =
      entry + risk;

    tp1 =
      entry - risk;

    tp2 =
      entry - risk * 2;

    tp3 =
      entry - risk * 3;
  }

  return {

    id:
      `SONNY-FX-${Date.now()}`,

    symbol,

    market:
      "BYBIT_TRADFI",

    direction,

    stage:
      "ENTRY",

    score,

    entry,
    stop,
    tp1,
    tp2,
    tp3,

    rr: {
      tp1: 1,
      tp2: 2,
      tp3: 3
    },

    reason,

    createdAt:
      Date.now()
  };
}


// ============================================================
// MAIN SIGNAL ENGINE
// ============================================================

function analyze(symbol) {

  const c15 =
    state.candles[symbol]["15"];

  const c5 =
    state.candles[symbol]["5"];

  const c1 =
    state.candles[symbol]["1"];

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
    liquiditySweep(c15);

  const atrValue =
    atr(c15, CONFIG.atrPeriod);

  if (!atrValue)
    return null;


  // ========================================================
  // LONG
  // ========================================================

  if (
    trend === "BULLISH" &&
    sweep.bullish
  ) {

    const bos =
      structureBreak(
        c15,
        "LONG"
      );

    const level =
      highest(
        c15.slice(0, -1),
        CONFIG.structureLookback
      );

    const retest =
      validRetest(
        last15.close,
        level,
        atrValue
      );

    const m5 =
      momentum(last5);

    const m1 =
      momentum(last1);

    const volume =
      volumeConfirmation(c5);

    const score =
      calculateScore({

        trendMatch: true,

        liquiditySweep: true,

        structureBreak: bos,

        retest,

        momentum5:
          m5.bullish,

        momentum1:
          m1.bullish,

        volume
      });

    if (
      score >= CONFIG.scoreEntry &&
      bos &&
      retest &&
      m5.bullish &&
      m1.bullish
    ) {

      return makePlan(

        symbol,

        "LONG",

        last1.close,

        atrValue,

        score,

        "15M bullish trend + sell-side liquidity sweep + BOS + retest + M5/M1 momentum"
      );
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
      structureBreak(
        c15,
        "SHORT"
      );

    const level =
      lowest(
        c15.slice(0, -1),
        CONFIG.structureLookback
      );

    const retest =
      validRetest(
        last15.close,
        level,
        atrValue
      );

    const m5 =
      momentum(last5);

    const m1 =
      momentum(last1);

    const volume =
      volumeConfirmation(c5);

    const score =
      calculateScore({

        trendMatch: true,

        liquiditySweep: true,

        structureBreak: bos,

        retest,

        momentum5:
          m5.bearish,

        momentum1:
          m1.bearish,

        volume
      });

    if (
      score >= CONFIG.scoreEntry &&
      bos &&
      retest &&
      m5.bearish &&
      m1.bearish
    ) {

      return makePlan(

        symbol,

        "SHORT",

        last1.close,

        atrValue,

        score,

        "15M bearish trend + buy-side liquidity sweep + BOS + retest + M5/M1 momentum"
      );
    }
  }

  return null;
}


// ============================================================
// LOAD ALL MARKETS
// ============================================================

async function refreshCandles() {

  for (const symbol of SYMBOLS) {

    try {

      const [
        c1,
        c5,
        c15
      ] = await Promise.all([

        loadCandles(
          symbol,
          "1",
          200
        ),

        loadCandles(
          symbol,
          "5",
          200
        ),

        loadCandles(
          symbol,
          "15",
          200
        )

      ]);

      state.candles[symbol]["1"] =
        c1;

      state.candles[symbol]["5"] =
        c5;

      state.candles[symbol]["15"] =
        c15;

    } catch (err) {

      console.error(
        `[${symbol}] candle error:`,
        err.message
      );
    }
  }
}


// ============================================================
// SIGNAL SCANNER
// ============================================================

function scanSignals() {

  for (const symbol of SYMBOLS) {

    const signal =
      analyze(symbol);

    if (!signal)
      continue;

    const duplicate =
      state.signals.some(
        x =>
          x.symbol === symbol &&
          x.direction === signal.direction &&
          Date.now() - x.createdAt < 10 * 60 * 1000
      );

    if (duplicate)
      continue;

    state.signals.unshift(signal);

    state.signals =
      state.signals.slice(0, 100);

    console.log(
      "\n🔥🔥 SONNY FOREX ENTRY 🔥🔥"
    );

    console.log(
      JSON.stringify(
        signal,
        null,
        2
      )
    );

    broadcast({
      type: "FOREX_SIGNAL",
      signal
    });
  }
}


// ============================================================
// BYBIT WEBSOCKET
// ============================================================

let bybitWS;

function connectBybitWS() {

  bybitWS =
    new WebSocket(
      BYBIT_WS
    );

  bybitWS.on(
    "open",
    () => {

      console.log(
        "Bybit Forex WS connected"
      );

      const args = [];

      for (const symbol of SYMBOLS) {

        args.push(
          `publicTrade.${symbol}`
        );

        args.push(
          `tickers.${symbol}`
        );
      }

      bybitWS.send(
        JSON.stringify({
          op: "subscribe",
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
          JSON.parse(raw.toString());

        if (!msg.topic)
          return;

        const symbol =
          msg.topic.split(".")[1];

        if (!SYMBOLS.includes(symbol))
          return;


        // ----------------------------------------------
        // TICKER
        // ----------------------------------------------

        if (
          msg.topic.startsWith(
            "tickers."
          )
        ) {

          const d =
            msg.data;

          if (!d)
            return;

          state.ticker[symbol] = {

            price:
              Number(
                d.lastPrice
              ),

            bid:
              Number(
                d.bid1Price || 0
              ),

            ask:
              Number(
                d.ask1Price || 0
              ),

            change24h:
              Number(
                d.price24hPcnt || 0
              ),

            time:
              Date.now()
          };

          return;
        }


        // ----------------------------------------------
        // TRADES
        // ----------------------------------------------

        if (
          msg.topic.startsWith(
            "publicTrade."
          )
        ) {

          if (!Array.isArray(msg.data))
            return;

          for (
            const trade of msg.data
          ) {

            state.trades[symbol]
              .push({

                time:
                  Number(trade.T),

                price:
                  Number(trade.p),

                size:
                  Number(trade.v),

                side:
                  trade.S
              });
          }

          const cutoff =
            Date.now() -
            60 * 1000;

          state.trades[symbol] =
            state.trades[symbol]
              .filter(
                x =>
                  x.time >= cutoff
              );
        }

      } catch (err) {

        console.error(
          "WS parse error:",
          err.message
        );
      }
    }
  );


  bybitWS.on(
    "close",
    () => {

      console.log(
        "Bybit WS closed - reconnecting..."
      );

      setTimeout(
        connectBybitWS,
        3000
      );
    }
  );


  bybitWS.on(
    "error",
    err => {

      console.error(
        "Bybit WS error:",
        err.message
      );
    }
  );
}


// ============================================================
// BROADCAST
// ============================================================

function broadcast(data) {

  const payload =
    JSON.stringify(data);

  for (
    const client of state.clients
  ) {

    if (
      client.readyState ===
      WebSocket.OPEN
    ) {

      client.send(payload);
    }
  }
}


wss.on(
  "connection",
  ws => {

    state.clients.add(ws);

    ws.send(
      JSON.stringify({
        type: "INIT",
        signals: state.signals,
        ticker: state.ticker
      })
    );

    ws.on(
      "close",
      () => {
        state.clients.delete(ws);
      }
    );
  }
);


// ============================================================
// API
// ============================================================

app.get(
  "/api/status",
  (req, res) => {

    res.json({

      ok: true,

      engine:
        "SONNY FOREX BYBIT V1",

      exchange:
        "BYBIT",

      symbols:
        SYMBOLS,

      signals:
        state.signals,

      ticker:
        state.ticker,

      time:
        new Date().toISOString()
    });
  }
);


app.get(
  "/api/signals",
  (req, res) => {

    res.json(
      state.signals
    );
  }
);


app.get(
  "/api/candles/:symbol/:tf",
  (req, res) => {

    const symbol =
      req.params.symbol;

    const tf =
      req.params.tf;

    if (
      !state.candles[symbol] ||
      !state.candles[symbol][tf]
    ) {

      return res
        .status(404)
        .json({
          error: "Not found"
        });
    }

    res.json(
      state.candles[symbol][tf]
    );
  }
);


app.get(
  "/api/health",
  (req, res) => {

    res.json({
      ok: true,
      uptime: process.uptime(),
      wsClients:
        state.clients.size,
      symbols:
        SYMBOLS.length
    });
  }
);


// ============================================================
// START
// ============================================================

async function start() {

  console.log(
    "======================================"
  );

  console.log(
    " SONNY FOREX — BYBIT ENGINE V1"
  );

  console.log(
    "======================================"
  );

  console.log(
    "Markets:",
    SYMBOLS.join(", ")
  );

  await refreshCandles();

  console.log(
    "Initial candles loaded."
  );

  connectBybitWS();

  setInterval(
    async () => {

      try {

        await refreshCandles();

        scanSignals();

      } catch (err) {

        console.error(
          "Scanner error:",
          err.message
        );
      }

    },
    CONFIG.scanInterval
  );

  server.listen(
    PORT,
    "0.0.0.0",
    () => {

      console.log(
        `Server running on port ${PORT}`
      );

      console.log(
        "AUTO TRADE: OFF"
      );
    }
  );
}

start().catch(
  console.error
);
