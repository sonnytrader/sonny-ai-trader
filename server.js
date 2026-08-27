'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = Number(process.env.PORT || 10000);

/*
==========================================================
SONNY AI TRADER V6.0
SCALP RADAR

500 MARKET
   ↓
150 CANDIDATE
   ↓
40 DEEP
   ↓
4H + 2H BIAS
   ↓
15M STRUCTURE / BREAKOUT
   ↓
RETEST veya GÜÇLÜ MOMENTUM
   ↓
5M SCALP TRIGGER
   ↓
SCORE
   ↓
SIGNAL
==========================================================
*/

const CFG = {

  RADAR_SIZE: 500,
  CANDIDATE_SIZE: 150,
  DEEP_SIZE: 40,

  SCAN_INTERVAL: 60_000,

  MIN_QUOTE_VOLUME: 750_000,

  /*
   * 24H hareket filtresi artık sert kapı değil.
   * Çok hareketli ama yeni coinleri kaçırmamak için
   * aday sıralamasında kullanılıyor.
   */
  MIN_MOVE: 0.50,

  MAX_SPREAD: 0.45,

  CONCURRENCY: 6,

  OHLCV_LIMIT: 100,

  BREAKOUT_LOOKBACK: 20,

  RETEST_BARS: 6,

  RETEST_TOLERANCE: 0.35,

  MIN_VOLUME_RATIO: 1.05,

  STRONG_VOLUME_RATIO: 1.50,

  MIN_SCORE: 68,

  STRONG_SCORE: 82,

  MOMENTUM_SCORE: 78,

  MIN_RR: 1.15,

  SIGNAL_TTL: 6 * 60 * 60_000,

  SIGNAL_COOLDOWN: 45 * 60_000,

  BREAKOUT_DEDUPE: 30 * 60_000,

  EMA_FAST: 21,
  EMA_SLOW: 50,

  RSI_LENGTH: 14,

  ATR_LENGTH: 14,

  /*
   * 5M artık sert kapı değil.
   * Güçlü scalp fırsatlarını öldürmemesi için
   * puanlayıcı olarak kullanılıyor.
   */
  REQUIRE_5M: false,

  ALLOW_MOMENTUM: true,

  /*
   * Pozisyonun breakout seviyesinden aşırı uzaklaşmış
   * olması durumunda sinyal üretme.
   */
  MAX_ENTRY_DISTANCE_ATR: 2.2
};

const exchange = new ccxt.bitget({
  enableRateLimit: true,
  timeout: 20_000,
  options: {
    defaultType: 'swap'
  }
});

const STATE = {

  markets: [],

  universe: [],

  candidates: [],

  deep: [],

  signals: [],

  pending: new Map(),

  breakoutMemory: new Map(),

  cooldowns: new Map(),

  charts: new Map(),

  market: {
    label: 'KARMA',
    breadth: 50,
    green: 0,
    red: 0,
    averageMove: 0
  },

  stats: {
    scanned: 0,
    candidates: 0,
    deep: 0,
    analyzed: 0,
    pending: 0,
    signals: 0,
    errors: 0,
    lastScan: null
  },

  busy: false
};

/* =========================================================
   HELPERS
========================================================= */

function n(v, fallback = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function round(v, digits = 6) {
  return Number(n(v).toFixed(digits));
}

function decimals(price) {

  price = Math.abs(n(price));

  if (price >= 1000) return 2;
  if (price >= 100) return 3;
  if (price >= 10) return 4;
  if (price >= 1) return 4;
  if (price >= 0.1) return 5;
  if (price >= 0.01) return 6;

  return 8;
}

function price(v) {
  return n(v).toFixed(decimals(v));
}

function body(c) {
  return Math.abs(n(c[4]) - n(c[1]));
}

function range(c) {
  return Math.max(n(c[2]) - n(c[3]), 1e-12);
}

function bullish(c) {
  return n(c[4]) > n(c[1]);
}

function bearish(c) {
  return n(c[4]) < n(c[1]);
}

/* =========================================================
   INDICATORS
========================================================= */

function EMA(values, period) {

  if (!values.length) return [];

  const k = 2 / (period + 1);

  const result = [];

  let e = values[0];

  result.push(e);

  for (let i = 1; i < values.length; i++) {

    e = values[i] * k + e * (1 - k);

    result.push(e);
  }

  return result;
}

function RSI(values, period = 14) {

  if (values.length < period + 1) {
    return 50;
  }

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {

    const diff = values[i] - values[i - 1];

    if (diff >= 0) {
      gain += diff;
    } else {
      loss -= diff;
    }
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

  for (let i = period + 1; i < values.length; i++) {

    const diff = values[i] - values[i - 1];

    const g = Math.max(diff, 0);
    const l = Math.max(-diff, 0);

    avgGain =
      ((avgGain * (period - 1)) + g) / period;

    avgLoss =
      ((avgLoss * (period - 1)) + l) / period;
  }

  if (avgLoss === 0) return 100;

  return 100 -
    (100 / (1 + avgGain / avgLoss));
}

function ATR(candles, period = 14) {

  if (candles.length < period + 1) {
    return 0;
  }

  const trs = [];

  for (let i = 1; i < candles.length; i++) {

    const high = n(candles[i][2]);
    const low = n(candles[i][3]);
    const prevClose = n(candles[i - 1][4]);

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );

    trs.push(tr);
  }

  return avg(trs.slice(-period));
}

function volumeRatio(candles) {

  const closed = candles.slice(0, -1);

  if (closed.length < 22) {
    return 1;
  }

  const last = closed[closed.length - 1];

  const history =
    closed.slice(-21, -1)
      .map(c => n(c[5]));

  const base = avg(history);

  if (!base) return 1;

  return n(last[5]) / base;
}

/* =========================================================
   STRUCTURE
========================================================= */

function structure(candles) {

  const closed = candles.slice(0, -1);

  if (closed.length < 30) {

    return {
      close: 0,
      high: 0,
      low: 0,
      ema21: 0,
      ema50: 0,
      rsi: 50,
      atr: 0,
      volume: 1
    };
  }

  const closes =
    closed.map(c => n(c[4]));

  const e21 =
    EMA(closes, CFG.EMA_FAST);

  const e50 =
    EMA(closes, CFG.EMA_SLOW);

  const window =
    closed.slice(-CFG.BREAKOUT_LOOKBACK);

  return {

    close: closes[closes.length - 1],

    high:
      Math.max(...window.map(c => n(c[2]))),

    low:
      Math.min(...window.map(c => n(c[3]))),

    ema21:
      e21[e21.length - 1],

    ema50:
      e50[e50.length - 1],

    rsi:
      RSI(closes, CFG.RSI_LENGTH),

    atr:
      ATR(candles, CFG.ATR_LENGTH),

    volume:
      volumeRatio(candles)
  };
}

function trendBias(candles) {

  const s = structure(candles);

  if (!s.close || !s.ema50) {

    return {
      direction: 'NEUTRAL',
      strength: 0,
      ...s
    };
  }

  const distance =
    Math.abs(s.ema21 - s.ema50)
    / s.close * 100;

  const strength =
    clamp(distance / 0.35, 0, 1);

  if (s.ema21 > s.ema50 * 1.001) {

    return {
      direction: 'LONG',
      strength,
      ...s
    };
  }

  if (s.ema21 < s.ema50 * 0.999) {

    return {
      direction: 'SHORT',
      strength,
      ...s
    };
  }

  return {
    direction: 'NEUTRAL',
    strength: 0,
    ...s
  };
}

/* =========================================================
   MARKET FILTER
========================================================= */

function validMarket(m) {

  if (!m) return false;

  if (m.active === false) return false;

  if (m.type !== 'swap') return false;

  if (m.quote !== 'USDT') return false;

  if (m.settle && m.settle !== 'USDT') return false;

  const base =
    String(m.base || '').toUpperCase();

  const id =
    String(m.id || '').toUpperCase();

  /*
   * USDT/USDC gibi saçma baz varlıklar
   */
  if (base === 'USDT' || base === 'USDC') {
    return false;
  }

  /*
   * Leveraged token / test / sentetik ürünleri çıkar.
   */
  const banned = [
    '3L',
    '3S',
    '5L',
    '5S',
    '2L',
    '2S',
    'BULL',
    'BEAR',
    'UP',
    'DOWN',
    'TEST'
  ];

  if (banned.some(x => base.endsWith(x))) {
    return false;
  }

  if (base.startsWith('1000')) {
    return false;
  }

  if (id.includes('INDEX')) {
    return false;
  }

  if (!/^[A-Z0-9]+$/.test(base)) {
    return false;
  }

  return true;
}

async function loadMarkets() {

  await exchange.loadMarkets(true);

  STATE.markets =
    Object.values(exchange.markets)
      .filter(validMarket);

  console.log(
    `MARKETS | Gerçek USDT perpetual=${STATE.markets.length}`
  );
}

/* =========================================================
   CONCURRENCY
========================================================= */

async function mapLimit(items, limit, fn) {

  const result =
    new Array(items.length);

  let pointer = 0;

  async function worker() {

    while (true) {

      const index = pointer++;

      if (index >= items.length) {
        return;
      }

      try {

        result[index] =
          await fn(items[index], index);

      } catch (e) {

        result[index] = null;
      }
    }
  }

  const workers =
    Array.from(
      {
        length:
          Math.min(limit, items.length)
      },
      worker
    );

  await Promise.all(workers);

  return result;
}

/* =========================================================
   RADAR
========================================================= */

async function buildRadar() {

  let tickers;

  try {

    tickers =
      await exchange.fetchTickers();

  } catch (e) {

    console.error(
      'TICKER HATA:',
      e.message
    );

    return [];
  }

  const rows = [];

  for (const market of STATE.markets) {

    const ticker =
      tickers[market.symbol] ||
      tickers[market.id];

    if (!ticker) continue;

    const last =
      n(ticker.last);

    const quoteVolume =
      n(ticker.quoteVolume);

    const change =
      n(ticker.percentage);

    const bid =
      n(ticker.bid);

    const ask =
      n(ticker.ask);

    if (!last) continue;

    if (
      quoteVolume <
      CFG.MIN_QUOTE_VOLUME
    ) {
      continue;
    }

    let spread = 0;

    if (bid && ask) {

      spread =
        ((ask - bid) /
        ((ask + bid) / 2)) *
        100;
    }

    if (
      spread >
      CFG.MAX_SPREAD
    ) {
      continue;
    }

    rows.push({

      symbol: market.symbol,

      base: market.base,

      last,

      change,

      quoteVolume,

      spread,

      ticker
    });
  }

  /*
   * Likidite + hareket + volatilite.
   */
  rows.sort((a, b) => {

    const scoreA =
      Math.abs(a.change) * 0.75 +
      Math.log10(
        Math.max(a.quoteVolume, 1)
      ) * 0.25;

    const scoreB =
      Math.abs(b.change) * 0.75 +
      Math.log10(
        Math.max(b.quoteVolume, 1)
      ) * 0.25;

    return scoreB - scoreA;
  });

  STATE.universe =
    rows.slice(0, CFG.RADAR_SIZE);

  /*
   * 500 market içinden piyasa yönü.
   */
  const green =
    rows.filter(x => x.change > 0).length;

  const red =
    rows.filter(x => x.change < 0).length;

  const total =
    green + red;

  const breadth =
    total
      ? green / total * 100
      : 50;

  const averageMove =
    avg(rows.map(x => x.change));

  STATE.market.green = green;
  STATE.market.red = red;
  STATE.market.breadth =
    round(breadth, 1);

  STATE.market.averageMove =
    round(averageMove, 2);

  if (
    breadth >= 60 &&
    averageMove > 0.35
  ) {

    STATE.market.label =
      'YÜKSELİŞ';

  } else if (
    breadth <= 40 &&
    averageMove < -0.35
  ) {

    STATE.market.label =
      'DÜŞÜŞ';

  } else if (
    breadth >= 54 &&
    averageMove >= 0
  ) {

    STATE.market.label =
      'POZİTİF';

  } else if (
    breadth <= 46 &&
    averageMove <= 0
  ) {

    STATE.market.label =
      'NEGATİF';

  } else {

    STATE.market.label =
      'KARMA';
  }

  /*
   * 150 ADAY.
   *
   * Burada 1.5% gibi aşırı sert filtre yok.
   * Altcoin fırsatlarını kaçırmıyoruz.
   */
  let candidates =
    rows
      .filter(x =>
        Math.abs(x.change) >= CFG.MIN_MOVE ||
        x.quoteVolume >= CFG.MIN_QUOTE_VOLUME * 4
      )
      .slice(
        0,
        CFG.CANDIDATE_SIZE
      );

  /*
   * 150 dolmadıysa likit marketlerle tamamla.
   */
  if (
    candidates.length <
    CFG.CANDIDATE_SIZE
  ) {

    const used =
      new Set(
        candidates.map(x => x.symbol)
      );

    for (const item of rows) {

      if (used.has(item.symbol)) {
        continue;
      }

      candidates.push(item);

      if (
        candidates.length >=
        CFG.CANDIDATE_SIZE
      ) {
        break;
      }
    }
  }

  STATE.candidates =
    candidates.slice(
      0,
      CFG.CANDIDATE_SIZE
    );

  STATE.stats.scanned =
    STATE.universe.length;

  STATE.stats.candidates =
    STATE.candidates.length;

  return STATE.candidates;
}

/* =========================================================
   OHLCV
========================================================= */

async function candles(
  symbol,
  timeframe
) {

  return exchange.fetchOHLCV(
    symbol,
    timeframe,
    undefined,
    CFG.OHLCV_LIMIT
  );
}

/* =========================================================
   15M BREAKOUT
========================================================= */

function findBreakout(c15) {

  const closed =
    c15.slice(0, -1);

  if (closed.length < 35) {
    return null;
  }

  /*
   * Sadece son birkaç mum değil,
   * breakout geçmişi taranıyor.
   */
  const start =
    Math.max(
      25,
      closed.length -
      CFG.RETEST_BARS -
      3
    );

  let latest = null;

  for (
    let i = start;
    i < closed.length;
    i++
  ) {

    const previous =
      closed.slice(
        Math.max(
          0,
          i - CFG.BREAKOUT_LOOKBACK
        ),
        i
      );

    if (
      previous.length <
      CFG.BREAKOUT_LOOKBACK
    ) {
      continue;
    }

    const candle =
      closed[i];

    const resistance =
      Math.max(
        ...previous.map(
          x => n(x[2])
        )
      );

    const support =
      Math.min(
        ...previous.map(
          x => n(x[3])
        )
      );

    const close =
      n(candle[4]);

    const volBase =
      avg(
        previous
          .slice(-20)
          .map(x => n(x[5]))
      );

    const vr =
      volBase
        ? n(candle[5]) / volBase
        : 1;

    const bodyPct =
      body(candle) /
      range(candle);

    /*
     * LONG breakout
     */
    if (
      close > resistance &&
      bullish(candle) &&
      bodyPct >= 0.40 &&
      vr >= CFG.MIN_VOLUME_RATIO
    ) {

      latest = {

        side: 'LONG',

        level: resistance,

        time: n(candle[0]),

        close,

        volumeRatio: vr
      };
    }

    /*
     * SHORT breakout
     */
    if (
      close < support &&
      bearish(candle) &&
      bodyPct >= 0.40 &&
      vr >= CFG.MIN_VOLUME_RATIO
    ) {

      latest = {

        side: 'SHORT',

        level: support,

        time: n(candle[0]),

        close,

        volumeRatio: vr
      };
    }
  }

  return latest;
}

/* =========================================================
   RETEST
========================================================= */

function checkRetest(
  c15,
  breakout
) {

  if (!breakout) {

    return {
      state: 'NONE'
    };
  }

  const after =
    c15
      .slice(0, -1)
      .filter(
        c =>
          n(c[0]) >
          breakout.time
      );

  if (!after.length) {

    return {
      state: 'WAIT'
    };
  }

  const recent =
    after.slice(
      -CFG.RETEST_BARS
    );

  const tolerance =
    Math.max(
      Math.abs(
        breakout.level
      ) *
      CFG.RETEST_TOLERANCE /
      100,
      1e-12
    );

  let touched = false;
  let held = false;

  for (const c of recent) {

    const high = n(c[2]);
    const low = n(c[3]);
    const close = n(c[4]);

    if (
      low <=
      breakout.level +
      tolerance &&

      high >=
      breakout.level -
      tolerance
    ) {

      touched = true;
    }

    if (
      breakout.side === 'LONG' &&
      touched &&
      close >= breakout.level
    ) {

      held = true;
    }

    if (
      breakout.side === 'SHORT' &&
      touched &&
      close <= breakout.level
    ) {

      held = true;
    }
  }

  if (
    touched &&
    held
  ) {

    return {
      state: 'RETEST_OK',
      candle:
        recent[recent.length - 1]
    };
  }

  if (
    after.length >=
    CFG.RETEST_BARS
  ) {

    return {
      state: 'EXPIRED'
    };
  }

  return {
    state: 'WAIT'
  };
}

/* =========================================================
   5M SCALP TRIGGER
========================================================= */

function scalpTrigger(
  c5,
  side,
  level
) {

  const closed =
    c5.slice(0, -1);

  if (closed.length < 30) {

    return {
      score: 0,
      ok: false,
      rsi: 50,
      volume: 1
    };
  }

  const closes =
    closed.map(
      c => n(c[4])
    );

  const e9 =
    EMA(closes, 9);

  const e21 =
    EMA(closes, 21);

  const r =
    RSI(
      closes,
      CFG.RSI_LENGTH
    );

  const last =
    closed[closed.length - 1];

  const previous =
    closed[closed.length - 2];

  const volumeBase =
    avg(
      closed
        .slice(-21, -1)
        .map(x => n(x[5]))
    );

  const vr =
    volumeBase
      ? n(last[5]) /
        volumeBase
      : 1;

  let score = 0;

  if (side === 'LONG') {

    if (
      e9[e9.length - 1] >
      e21[e21.length - 1]
    ) {
      score += 25;
    }

    if (
      bullish(last)
    ) {
      score += 20;
    }

    if (
      n(last[4]) >
      n(previous[2])
    ) {
      score += 20;
    }

    if (
      r >= 48 &&
      r <= 74
    ) {
      score += 15;
    }

    if (
      vr >= 1.15
    ) {
      score += 20;
    }

    if (
      n(last[4]) >=
      level * 0.997
    ) {
      score += 10;
    }

  } else {

    if (
      e9[e9.length - 1] <
      e21[e21.length - 1]
    ) {
      score += 25;
    }

    if (
      bearish(last)
    ) {
      score += 20;
    }

    if (
      n(last[4]) <
      n(previous[3])
    ) {
      score += 20;
    }

    if (
      r <= 52 &&
      r >= 26
    ) {
      score += 15;
    }

    if (
      vr >= 1.15
    ) {
      score += 20;
    }

    if (
      n(last[4]) <=
      level * 1.003
    ) {
      score += 10;
    }
  }

  score =
    clamp(
      score,
      0,
      100
    );

  return {

    score,

    ok:
      score >= 45,

    rsi:
      round(r, 1),

    volume:
      round(vr, 2),

    last
  };
}

/* =========================================================
   SIGNAL BUILDER
========================================================= */

function buildSignal({

  symbol,

  side,

  level,

  c4,

  c2,

  c15,

  c5,

  breakout,

  retestOk,

  meta

}) {

  const closed5 =
    c5.slice(0, -1);

  const closed15 =
    c15.slice(0, -1);

  if (
    closed5.length < 30 ||
    closed15.length < 30
  ) {
    return null;
  }

  const current =
    n(
      closed5[
        closed5.length - 1
      ][4]
    );

  const s15 =
    structure(c15);

  const b4 =
    trendBias(c4);

  const b2 =
    trendBias(c2);

  const trigger =
    scalpTrigger(
      c5,
      side,
      level
    );

  /*
   * Fiyat breakout seviyesinden
   * çok uzaklaşmışsa kovalamıyoruz.
   */
  const atr15 =
    Math.max(
      s15.atr,
      current * 0.001
    );

  const distanceFromLevel =
    Math.abs(
      current - level
    );

  if (
    distanceFromLevel >
    atr15 *
    CFG.MAX_ENTRY_DISTANCE_ATR
  ) {

    return null;
  }

  let score = 0;

  const reasons = [];

  /*
   * 15M ana yapı
   */
  score += 20;

  reasons.push(
    '15M yapı'
  );

  /*
   * Breakout hacmi
   */
  if (
    meta.volumeRatio >=
    CFG.STRONG_VOLUME_RATIO
  ) {

    score += 15;

    reasons.push(
      'güçlü hacim'
    );

  } else if (
    meta.volumeRatio >=
    CFG.MIN_VOLUME_RATIO
  ) {

    score += 8;

    reasons.push(
      'hacim teyidi'
    );
  }

  /*
   * RETEST
   */
  if (retestOk) {

    score += 18;

    reasons.push(
      'retest tuttu'
    );

  } else if (
    CFG.ALLOW_MOMENTUM &&
    meta.volumeRatio >=
    1.45
  ) {

    score += 10;

    reasons.push(
      'momentum'
    );
  }

  /*
   * 4H yönü
   *
   * ARTIK KAPI DEĞİL.
   */
  if (
    b4.direction === side
  ) {

    score += 12;

    reasons.push(
      '4H uyumlu'
    );

  } else if (
    b4.direction === 'NEUTRAL'
  ) {

    score += 5;

  } else {

    score -= 5;

    reasons.push(
      '4H ters'
    );
  }

  /*
   * 2H yönü
   */
  if (
    b2.direction === side
  ) {

    score += 10;

    reasons.push(
      '2H uyumlu'
    );

  } else if (
    b2.direction === 'NEUTRAL'
  ) {

    score += 4;

  } else {

    score -= 4;

    reasons.push(
      '2H ters'
    );
  }

  /*
   * 15M EMA
   */
  if (
    side === 'LONG' &&
    s15.ema21 >
    s15.ema50
  ) {

    score += 6;

    reasons.push(
      '15M trend'
    );
  }

  if (
    side === 'SHORT' &&
    s15.ema21 <
    s15.ema50
  ) {

    score += 6;

    reasons.push(
      '15M trend'
    );
  }

  /*
   * 5M tetik puanı.
   *
   * Zorunlu değil.
   */
  score +=
    Math.round(
      trigger.score * 0.18
    );

  if (
    trigger.ok
  ) {

    reasons.push(
      '5M tetik'
    );
  }

  /*
   * RSI aşırı bölge cezası.
   */
  if (
    side === 'LONG' &&
    trigger.rsi > 80
  ) {

    score -= 8;
  }

  if (
    side === 'SHORT' &&
    trigger.rsi < 20
  ) {

    score -= 8;
  }

  score =
    clamp(
      Math.round(score),
      0,
      100
    );

  /*
   * Giriş
   */
  const entry =
    current;

  /*
   * 5M swing
   */
  const swing =
    closed5.slice(
      -8
    );

  const swingLow =
    Math.min(
      ...swing.map(
        c => n(c[3])
      )
    );

  const swingHigh =
    Math.max(
      ...swing.map(
        c => n(c[2])
      )
    );

  const atr5 =
    Math.max(
      ATR(c5, CFG.ATR_LENGTH),
      entry * 0.001
    );

  const buffer =
    Math.max(
      atr5 * 0.18,
      entry * 0.0007
    );

  let stop;
  let tp1;
  let tp2;
  let tp3;

  if (
    side === 'LONG'
  ) {

    stop =
      Math.min(
        swingLow - buffer,
        level -
        Math.max(
          atr15 * 0.20,
          level * 0.001
        )
      );

    if (
      stop >= entry
    ) {

      stop =
        entry -
        Math.max(
          atr5 * 0.75,
          entry * 0.003
        );
    }

    const risk =
      entry - stop;

    /*
     * Scalp hedefleri.
     */
    tp1 =
      entry +
      risk * 1.15;

    tp2 =
      entry +
      risk * 1.70;

    tp3 =
      entry +
      risk * 2.25;

    /*
     * Yakın yapı hedefi varsa
     * TP1'i mantıksız biçimde
     * uzağa taşımıyoruz.
     */
    const structureHigh =
      Math.max(
        ...closed15
          .slice(-30)
          .map(c => n(c[2]))
      );

    if (
      structureHigh >
      entry
    ) {

      tp1 =
        Math.min(
          tp1,
          structureHigh
        );
    }

    if (
      tp2 <= tp1
    ) {

      tp2 =
        tp1 +
        risk * 0.45;
    }

    if (
      tp3 <= tp2
    ) {

      tp3 =
        tp2 +
        risk * 0.55;
    }

  } else {

    stop =
      Math.max(
        swingHigh + buffer,
        level +
        Math.max(
          atr15 * 0.20,
          level * 0.001
        )
      );

    if (
      stop <= entry
    ) {

      stop =
        entry +
        Math.max(
          atr5 * 0.75,
          entry * 0.003
        );
    }

    const risk =
      stop - entry;

    tp1 =
      entry -
      risk * 1.15;

    tp2 =
      entry -
      risk * 1.70;

    tp3 =
      entry -
      risk * 2.25;

    const structureLow =
      Math.min(
        ...closed15
          .slice(-30)
          .map(c => n(c[3]))
      );

    if (
      structureLow <
      entry
    ) {

      tp1 =
        Math.max(
          tp1,
          structureLow
        );
    }

    if (
      tp2 >= tp1
    ) {

      tp2 =
        tp1 -
        risk * 0.45;
    }

    if (
      tp3 >= tp2
    ) {

      tp3 =
        tp2 -
        risk * 0.55;
    }
  }

  const risk =
    Math.abs(
      entry - stop
    );

  const reward =
    Math.abs(
      tp1 - entry
    );

  const rr =
    risk
      ? reward / risk
      : 0;

  /*
   * Gerçek R:R.
   */
  if (
    rr <
    CFG.MIN_RR
  ) {

    return null;
  }

  /*
   * Retest yoksa:
   *
   * güçlü momentum +
   * güçlü skor +
   * 5M makul teyit
   *
   * gerekiyor.
   */
  const momentumAllowed =
    CFG.ALLOW_MOMENTUM &&
    meta.volumeRatio >= 1.35 &&
    trigger.ok &&
    score >= CFG.MOMENTUM_SCORE;

  if (
    !retestOk &&
    !momentumAllowed
  ) {

    return null;
  }

  if (
    CFG.REQUIRE_5M &&
    !trigger.ok
  ) {

    return null;
  }

  if (
    score <
    CFG.MIN_SCORE
  ) {

    return null;
  }

  return {

    id:
      `${symbol}:${side}:${Date.now()}`,

    symbol,

    type:
      side,

    status:
      score >= CFG.STRONG_SCORE
        ? 'GÜÇLÜ SCALP'
        : 'SCALP',

    score,

    entry,

    level,

    entryZone:
      `${price(Math.min(entry, level))} - ${price(Math.max(entry, level))}`,

    stopLoss:
      stop,

    tp1,
    tp2,
    tp3,

    rr,

    rsi:
      trigger.rsi,

    volumeRatio:
      meta.volumeRatio,

    trigger:
      trigger.ok
        ? '5M ONAY'
        : 'MOMENTUM',

    retest:
      retestOk,

    timeframeLevel:
      '4H/2H → 15M',

    reasons,

    createdAt:
      Date.now(),

    updatedAt:
      Date.now()
  };
}

/* =========================================================
   DEDUPE
========================================================= */

function canCreateSignal(signal) {

  const key =
    `${signal.symbol}:${signal.type}`;

  const now =
    Date.now();

  const cooldown =
    STATE.cooldowns.get(key) || 0;

  if (
    now - cooldown <
    CFG.SIGNAL_COOLDOWN
  ) {

    return false;
  }

  const existing =
    STATE.signals.find(
      x =>
        x.symbol ===
        signal.symbol &&
        x.type ===
        signal.type
    );

  if (existing) {
    return false;
  }

  STATE.cooldowns.set(
    key,
    now
  );

  return true;
}

/* =========================================================
   CHART CACHE
========================================================= */

function cacheChart(
  symbol,
  candles5,
  signal
) {

  STATE.charts.set(
    symbol,
    {
      candles:
        candles5.slice(-120),

      signal:
        signal || null,

      timeframe:
        '5m',

      updatedAt:
        Date.now()
    }
  );
}

/* =========================================================
   DEEP ANALYSIS
========================================================= */

async function analyze(item) {

  const symbol =
    item.symbol;

  try {

    const results =
      await Promise.all([
        candles(symbol, '4h'),
        candles(symbol, '2h'),
        candles(symbol, '15m'),
        candles(symbol, '5m')
      ]);

    const c4 =
      results[0];

    const c2 =
      results[1];

    const c15 =
      results[2];

    const c5 =
      results[3];

    if (
      !c4 ||
      !c2 ||
      !c15 ||
      !c5
    ) {

      return null;
    }

    if (
      c15.length < 35 ||
      c5.length < 35
    ) {

      return null;
    }

    const breakout =
      findBreakout(c15);

    if (
      breakout
    ) {

      const memoryKey =
        `${symbol}:${breakout.side}:${round(breakout.level, 8)}`;

      const lastSeen =
        STATE.breakoutMemory.get(
          memoryKey
        ) || 0;

      if (
        Date.now() -
        lastSeen >
        CFG.BREAKOUT_DEDUPE
      ) {

        STATE.breakoutMemory.set(
          memoryKey,
          Date.now()
        );

        console.log(
          `BREAKOUT | ${symbol} | ${breakout.side} | ${price(breakout.level)} | VOL ${round(breakout.volumeRatio, 2)}x`
        );
      }

      const retest =
        checkRetest(
          c15,
          breakout
        );

      const pendingKey =
        `${symbol}:${breakout.side}`;

      if (
        retest.state ===
        'WAIT'
      ) {

        STATE.pending.set(
          pendingKey,
          {

            symbol,

            side:
              breakout.side,

            level:
              breakout.level,

            volumeRatio:
              round(
                breakout.volumeRatio,
                2
              ),

            breakoutTime:
              breakout.time,

            state:
              'RETEST BEKLENİYOR',

            updatedAt:
              Date.now()
          }
        );

      } else if (
        retest.state ===
        'EXPIRED'
      ) {

        STATE.pending.delete(
          pendingKey
        );
      }

      const signal =
        buildSignal({

          symbol,

          side:
            breakout.side,

          level:
            breakout.level,

          c4,

          c2,

          c15,

          c5,

          breakout,

          retestOk:
            retest.state ===
            'RETEST_OK',

          meta: {
            volumeRatio:
              breakout.volumeRatio
          }
        });

      if (
        signal &&
        canCreateSignal(signal)
      {

        STATE.signals.unshift(
          signal
        );

        STATE.signals =
          STATE.signals.slice(
            0,
            30
          );

        STATE.pending.delete(
          pendingKey
        );

        cacheChart(
          symbol,
          c5,
          signal
        );

        console.log(
          `SIGNAL | ${symbol} | ${signal.type} | SCORE ${signal.score} | RR 1:${round(signal.rr, 2)}`
        );

        return signal;
      }

    } else {

      /*
       * BREAKOUT OLMASA BİLE
       *
       * güçlü momentum fırsatı aranıyor.
       *
       * Böylece altcoin fırsatları
       * tamamen kaçırılmıyor.
       */

      const s15 =
        structure(c15);

      const b2 =
        trendBias(c2);

      const last =
        c15[
          c15.length - 2
        ];

      const previous =
        c15.slice(
          -22,
          -2
        );

      if (
        previous.length >= 15
      ) {

        const high =
          Math.max(
            ...previous.map(
              c => n(c[2])
            )
          );

        const low =
          Math.min(
            ...previous.map(
              c => n(c[3])
            )
          );

        let side = null;

        if (
          n(last[4]) >
          high
        ) {

          side = 'LONG';
        }

        if (
          n(last[4]) <
          low
        ) {

          side = 'SHORT';
        }

        /*
         * 2H tamamen ters ise
         * momentum fırsatını kapatmıyoruz.
         *
         * Sadece skor cezası alacak.
         */
        if (side) {

          const level =
            side === 'LONG'
              ? high
              : low;

          const vr =
            volumeRatio(c15);

          const signal =
            buildSignal({

              symbol,

              side,

              level,

              c4,

              c2,

              c15,

              c5,

              breakout: null,

              retestOk: false,

              meta: {
                volumeRatio: vr
              }
            });

          if (
            signal &&
            signal.score >=
            CFG.MOMENTUM_SCORE &&
            canCreateSignal(signal)
          ) {

            STATE.signals.unshift(
              signal
            );

            STATE.signals =
              STATE.signals.slice(
                0,
                30
              );

            cacheChart(
              symbol,
              c5,
              signal
            );

            console.log(
              `MOMENTUM SIGNAL | ${symbol} | ${side} | SCORE ${signal.score}`
            );

            return signal;
          }
        }
      }
    }

    /*
     * Sinyal yoksa bile chart verisini sakla.
     */
    cacheChart(
      symbol,
      c5,
      null
    );

    return null;

  } catch (e) {

    STATE.stats.errors++;

    return null;
  }
}

/* =========================================================
   CLEANUP
========================================================= */

function cleanup() {

  const now =
    Date.now();

  STATE.signals =
    STATE.signals.filter(
      s =>
        now - s.createdAt <
        CFG.SIGNAL_TTL
    );

  for (
    const [key, value]
    of STATE.pending
  ) {

    if (
      now - value.updatedAt >
      2 * 60 * 60_000
    ) {

      STATE.pending.delete(
        key
      );
    }
  }

  for (
    const [key, value]
    of STATE.cooldowns
  ) {

    if (
      now - value >
      CFG.SIGNAL_COOLDOWN * 2
    ) {

      STATE.cooldowns.delete(
        key
      );
    }
  }
}

/* =========================================================
   SCAN
========================================================= */

async function scan() {

  if (
    STATE.busy
  ) {
    return;
  }

  STATE.busy = true;

  try {

    const candidates =
      await buildRadar();

    STATE.deep =
      candidates.slice(
        0,
        CFG.DEEP_SIZE
      );

    STATE.stats.deep =
      STATE.deep.length;

    STATE.stats.analyzed =
      0;

    await mapLimit(
      STATE.deep,
      CFG.CONCURRENCY,
      async item => {

        await analyze(item);

        STATE.stats.analyzed++;
      }
    );

    cleanup();

    STATE.stats.pending =
      STATE.pending.size;

    STATE.stats.signals =
      STATE.signals.length;

    STATE.stats.lastScan =
      new Date().toISOString();

    broadcast();

    console.log(
      `RADAR tamamlandı | Universe=${STATE.stats.scanned} | Candidates=${STATE.stats.candidates} | Deep=${STATE.stats.deep} | Analiz=${STATE.stats.analyzed} | Pending=${STATE.stats.pending} | SIGNAL=${STATE.stats.signals}`
    );

  } catch (e) {

    console.error(
      'SCAN HATA:',
      e.message
    );

  } finally {

    STATE.busy = false;
  }
}

/* =========================================================
   PUBLIC API DATA
========================================================= */

function publicState() {

  const pending =
    Array.from(
      STATE.pending.values()
    )
      .sort(
        (a, b) =>
          b.updatedAt -
          a.updatedAt
      )
      .slice(0, 20);

  const signals =
    STATE.signals.map(
      s => ({

        ...s,

        entry:
          price(s.entry),

        level:
          price(s.level),

        stopLoss:
          price(s.stopLoss),

        tp1:
          price(s.tp1),

        tp2:
          price(s.tp2),

        tp3:
          price(s.tp3),

        rr:
          `1:${round(s.rr, 2)}`,

        age:
          Math.round(
            (Date.now() -
              s.createdAt) /
            1000
          )
      })
    );

  const radar =
    STATE.candidates.map(
      x => ({

        symbol:
          x.symbol,

        last:
          price(x.last),

        change:
          round(
            x.change,
            2
          ),

        quoteVolume:
          Math.round(
            x.quoteVolume
          ),

        spread:
          round(
            x.spread,
            3
          )
      })
    );

  return {

    version:
      'SONNY AI TRADER V6.0',

    market:
      STATE.market,

    stats:
      STATE.stats,

    signals,

    pending,

    radar,

    deep:
      STATE.deep.map(
        x => ({

          symbol:
            x.symbol,

          change:
            round(
              x.change,
              2
            ),

          volume:
            Math.round(
              x.quoteVolume
            )
        })
      ),

    config: {

      radar:
        CFG.RADAR_SIZE,

      candidates:
        CFG.CANDIDATE_SIZE,

      deep:
        CFG.DEEP_SIZE,

      minimumVolume:
        CFG.MIN_QUOTE_VOLUME,

      minimumRR:
        CFG.MIN_RR,

      scanSeconds:
        CFG.SCAN_INTERVAL /
        1000
    }
  };
}

/* =========================================================
   WEBSOCKET
========================================================= */

function broadcast() {

  const message =
    JSON.stringify(
      publicState()
    );

  for (
    const client
    of wss.clients
  ) {

    if (
      client.readyState ===
      WebSocket.OPEN
    ) {

      client.send(
        message
      );
    }
  }
}

wss.on(
  'connection',
  ws => {

    ws.send(
      JSON.stringify(
        publicState()
      )
    );
  }
);

/* =========================================================
   API
========================================================= */

app.get(
  '/api/status',
  (req, res) => {

    res.json(
      publicState()
    );
  }
);

app.get(
  '/api/chart',
  async (req, res) => {

    const symbol =
      String(
        req.query.symbol || ''
      ).toUpperCase();

    const timeframe =
      String(
        req.query.timeframe ||
        '5m'
      );

    if (!symbol) {

      return res
        .status(400)
        .json({
          error:
            'symbol gerekli'
        });
    }

    const allowed = [
      '1m',
      '5m',
      '15m',
      '1h',
      '2h',
      '4h'
    ];

    if (
      !allowed.includes(
        timeframe
      )
    ) {

      return res
        .status(400)
        .json({
          error:
            'geçersiz timeframe'
        });
    }

    try {

      const data =
        await exchange.fetchOHLCV(
          symbol,
          timeframe,
          undefined,
          150
        );

      const signal =
        STATE.signals.find(
          x =>
            x.symbol ===
            symbol
        ) || null;

      res.json({

        symbol,

        timeframe,

        candles:
          data,

        signal
      });

    } catch (e) {

      const cached =
        STATE.charts.get(
          symbol
        );

      if (cached) {

        return res.json(
          cached
        );
      }

      res
        .status(500)
        .json({
          error:
            e.message
        });
    }
  }
);

app.post(
  '/api/scan',
  async (req, res) => {

    if (!STATE.busy) {

      scan().catch(
        () => {}
      );
    }

    res.json({
      ok: true
    });
  }
);

/* =========================================================
   HTML
   SERVER İÇİNDE
========================================================= */

const HTML = `
<!DOCTYPE html>

<html lang="tr">

<head>

<meta charset="UTF-8">

<meta
name="viewport"
content="width=device-width,initial-scale=1,maximum-scale=1"
>

<title>SONNY AI TRADER V6</title>

<style>

*{
box-sizing:border-box;
}

html,
body{
margin:0;
padding:0;
width:100%;
height:100%;
background:#080c12;
color:#e8edf5;
font-family:Arial,Helvetica,sans-serif;
}

button{
font:inherit;
}

.app{
min-height:100vh;
display:grid;
grid-template-columns:245px minmax(0,1fr) 285px;
}

.left,
.right{
background:#0d131d;
}

.left{
border-right:1px solid #1d2938;
padding:12px;
overflow-y:auto;
}

.right{
border-left:1px solid #1d2938;
padding:12px;
overflow-y:auto;
}

.main{
min-width:0;
display:flex;
flex-direction:column;
}

.brand{
font-size:17px;
font-weight:900;
line-height:1.15;
}

.sub{
font-size:9px;
color:#718198;
margin-top:5px;
margin-bottom:15px;
}

.title{
font-size:18px;
font-weight:900;
}

.description{
font-size:9px;
color:#718198;
margin-top:5px;
}

.top{
height:68px;
padding:12px 16px;
display:flex;
align-items:center;
justify-content:space-between;
gap:10px;
border-bottom:1px solid #1d2938;
}

.counts{
font-size:10px;
color:#8b9ab0;
white-space:nowrap;
}

.radarTitle{
font-size:10px;
color:#8997aa;
display:flex;
justify-content:space-between;
margin-bottom:8px;
}

.radar{
display:block;
}

.coin{
background:#101824;
border:1px solid #1c2a3c;
border-left:4px solid #26364a;
border-radius:8px;
padding:9px;
margin-bottom:7px;
cursor:pointer;
}

.coin:hover{
border-color:#315779;
}

.coin.up{
border-left-color:#00d9a5;
}

.coin.down{
border-left-color:#ff4d6d;
}

.coinHeader{
display:flex;
justify-content:space-between;
align-items:center;
}

.symbol{
font-size:12px;
font-weight:900;
}

.move{
font-size:9px;
padding:3px 5px;
border-radius:4px;
background:#172438;
}

.up .move{
color:#00e0ad;
}

.down .move{
color:#ff657e;
}

.coinPrice{
font-size:12px;
font-weight:700;
margin-top:5px;
}

.volume{
font-size:8px;
color:#65758a;
margin-top:3px;
}

.scan{
width:100%;
border:0;
background:#173454;
color:#fff;
border-radius:6px;
padding:9px;
cursor:pointer;
margin-top:4px;
}

.toolbar{
height:48px;
display:flex;
align-items:center;
gap:6px;
padding:7px 14px;
border-bottom:1px solid #1d2938;
overflow-x:auto;
}

.tf{
background:#111a27;
border:1px solid #24364d;
color:#8090a6;
border-radius:5px;
padding:6px 10px;
font-size:9px;
cursor:pointer;
}

.tf.active{
background:#173454;
color:#fff;
border-color:#2f6ea6;
}

.chart{
position:relative;
flex:1;
min-height:450px;
}

.chart canvas{
position:absolute;
inset:0;
width:100%;
height:100%;
}

.market{
background:#101824;
border:1px solid #1d2a3b;
border-radius:8px;
padding:11px;
margin-bottom:12px;
}

.marketTitle{
font-size:9px;
color:#7c8ca1;
margin-bottom:6px;
}

.marketLabel{
font-size:18px;
font-weight:900;
color:#00d9a5;
}

.row{
display:flex;
justify-content:space-between;
font-size:9px;
color:#75849a;
margin-top:6px;
}

.row b{
color:#e7ecf4;
}

.section{
font-size:9px;
color:#7c8ca1;
margin:11px 0 7px;
text-transform:uppercase;
}

.signal{
background:#101824;
border:1px solid #1c2b3c;
border-radius:8px;
padding:9px;
margin-bottom:8px;
cursor:pointer;
}

.signal.long{
border-left:4px solid #00d9a5;
}

.signal.short{
border-left:4px solid #ff4d6d;
}

.signalHeader{
display:flex;
justify-content:space-between;
align-items:center;
font-size:12px;
font-weight:900;
}

.badge{
font-size:8px;
padding:3px 5px;
border-radius:4px;
}

.long .badge{
background:#073a2f;
color:#00e0ad;
}

.short .badge{
background:#3c121e;
color:#ff6a81;
}

.grid{
display:grid;
grid-template-columns:1fr 1fr;
gap:5px;
margin-top:8px;
}

.box{
background:#0a111a;
padding:6px;
border-radius:5px;
}

.box small{
display:block;
font-size:7px;
color:#627187;
}

.box b{
display:block;
font-size:9px;
margin-top:2px;
}

.green{
color:#00d9a5;
}

.red{
color:#ff657e;
}

.pending{
background:#101824;
border-left:3px solid #e9b949;
border-radius:5px;
padding:8px;
margin-bottom:6px;
font-size:8px;
color:#abb8ca;
}

.empty{
text-align:center;
font-size:9px;
color:#617188;
padding:15px 5px;
}

.note{
font-size:8px;
line-height:1.5;
color:#607087;
margin-top:12px;
}

/* TABLET */

@media(max-width:1000px){

.app{
grid-template-columns:205px minmax(0,1fr);
}

.right{
display:none;
}

}

/* MOBILE */

@media(max-width:650px){

html,
body{
overflow-x:hidden;
}

.app{
display:block;
}

.left{
height:225px;
border-right:0;
border-bottom:1px solid #1d2938;
padding:9px;
overflow:hidden;
}

.radarTitle{
margin-top:4px;
}

.radar{
display:flex;
overflow-x:auto;
gap:6px;
padding-bottom:4px;
}

.coin{
flex:0 0 155px;
margin:0;
}

.scan{
margin-top:6px;
}

.top{
height:68px;
padding:9px;
}

.title{
font-size:14px;
}

.description{
font-size:7px;
}

.counts{
font-size:7px;
}

.toolbar{
height:44px;
padding:6px 9px;
}

.tf{
padding:5px 8px;
}

.chart{
height:calc(100vh - 337px);
min-height:360px;
}

}

</style>

</head>

<body>

<div class="app">

<aside class="left">

<div class="brand">
⚡ SONNY AI<br>
TRADER
</div>

<div class="sub">
V6.0 • 500 RADAR • SCALP ENGINE
</div>

<div class="radarTitle">
<span>RADAR</span>
<b id="radarCount">0</b>
</div>

<div
id="radar"
class="radar"
></div>

<button
class="scan"
onclick="manualScan()"
>
RADARI YENİLE
</button>

</aside>

<main class="main">

<div class="top">

<div>

<div class="title">
SONNY AI TİCARETÇİSİ
</div>

<div class="description">
500 COIN → 150 ADAY → 40 DERİN → 15M YAPI → RETEST / MOMENTUM → 5M SCALP
</div>

</div>

<div
id="counts"
class="counts"
>
Bağlanıyor...
</div>

</div>

<div class="toolbar">

<button
class="tf"
data-tf="1m"
>
1M
</button>

<button
class="tf active"
data-tf="5m"
>
5M
</button>

<button
class="tf"
data-tf="15m"
>
15M
</button>

<button
class="tf"
data-tf="1h"
>
1H
</button>

<button
class="tf"
data-tf="2h"
>
2H
</button>

<button
class="tf"
data-tf="4h"
>
4H
</button>

</div>

<div
class="chart"
>

<canvas
id="chart"
></canvas>

</div>

</main>

<aside class="right">

<div class="market">

<div class="marketTitle">
GENEL PİYASA
</div>

<div
id="marketLabel"
class="marketLabel"
>
KARMA
</div>

<div class="row">
<span>YEŞİL / KIRMIZI</span>
<b id="breadth">-</b>
</div>

<div class="row">
<span>ORTALAMA</span>
<b id="average">-</b>
</div>

</div>

<div class="section">
AKTİF SCALP SİNYALLERİ
</div>

<div
id="signals"
></div>

<div class="section">
BEKLEYEN KIRILIM / RETEST
</div>

<div
id="pending"
></div>

<div class="note">

4H ve 2H yönü sinyali tek başına
engellemez.

5M teyidi skora katkı sağlar.

Güçlü momentum oluştuğunda retest
beklemeden scalp fırsatı değerlendirilebilir.

</div>

</aside>

</div>

<script>

let state = null;

let currentSymbol = null;

let currentTimeframe = '5m';

const canvas =
document.getElementById('chart');

const ctx =
canvas.getContext('2d');

function esc(value){

return String(
value ?? ''
)
.replace(
/[&<>"']/g,
function(m){

return {
'&':'&amp;',
'<':'&lt;',
'>':'&gt;',
'"':'&quot;',
"'":'&#39;'
}[m];

}
);

}

function numberFormat(value){

return Number(value)
.toLocaleString(
'tr-TR',
{
maximumFractionDigits:8
}
);

}

/* =========================================================
   CHART
========================================================= */

function drawChart(
candles,
signal
){

const rect =
canvas.getBoundingClientRect();

const dpr =
window.devicePixelRatio || 1;

canvas.width =
rect.width * dpr;

canvas.height =
rect.height * dpr;

ctx.setTransform(
dpr,
0,
0,
dpr,
0,
0
);

const width =
rect.width;

const height =
rect.height;

ctx.clearRect(
0,
0,
width,
height
);

if (
!candles ||
candles.length < 2
){

ctx.fillStyle =
'#66768c';

ctx.font =
'11px Arial';

ctx.fillText(
'Grafik verisi bekleniyor...',
20,
30
);

return;
}

const data =
candles.slice(-100);

let high =
Math.max(
...data.map(c => Number(c[2]))
);

let low =
Math.min(
...data.map(c => Number(c[3]))
);

if (signal){

high =
Math.max(
high,
Number(signal.tp3 || high)
);

low =
Math.min(
low,
Number(signal.stopLoss || low)
);

}

const padding = {

left:12,

right:55,

top:20,

bottom:25

};

const chartWidth =
width -
padding.left -
padding.right;

const chartHeight =
height -
padding.top -
padding.bottom;

function X(i){

return (
padding.left +
(
i /
(data.length - 1)
) *
chartWidth
);

}

function Y(value){

return (
padding.top +
(
(high - value) /
(Math.max(high-low,1e-12))
) *
chartHeight
);

}

/* GRID */

ctx.strokeStyle =
'#162130';

ctx.lineWidth = 1;

for (
let i=0;
i<6;
i++
){

const y =
padding.top +
i *
chartHeight /
5;

ctx.beginPath();

ctx.moveTo(
padding.left,
y
);

ctx.lineTo(
width-padding.right,
y
);

ctx.stroke();

const value =
high -
(
(high-low) *
i / 5
);

ctx.fillStyle =
'#607086';

ctx.font =
'9px Arial';

ctx.fillText(
numberFormat(value),
width-padding.right+5,
y+3
);

}

/* CANDLES */

const candleWidth =
Math.max(
2,
chartWidth /
data.length *
0.62
);

data.forEach(
(c,i)=>{

const open =
Number(c[1]);

const h =
Number(c[2]);

const l =
Number(c[3]);

const close =
Number(c[4]);

const up =
close >= open;

const color =
up
? '#00d9a5'
: '#ff4d6d';

const x =
X(i);

ctx.strokeStyle =
color;

ctx.fillStyle =
color;

ctx.beginPath();

ctx.moveTo(
x,
Y(h)
);

ctx.lineTo(
x,
Y(l)
);

ctx.stroke();

const top =
Y(
Math.max(open,close)
);

const bodyHeight =
Math.max(
1,
Math.abs(
Y(open)-Y(close)
)
);

ctx.fillRect(
x-candleWidth/2,
top,
candleWidth,
bodyHeight
);

}
);

/* SIGNAL LINES */

if (signal){

const lines = [

[
'GİRİŞ',
signal.entry,
'#29d7a8'
],

[
'STOP',
signal.stopLoss,
'#ff4d6d'
],

[
'TP1',
signal.tp1,
'#4fa7ff'
],

[
'TP2',
signal.tp2,
'#4fa7ff'
],

[
'TP3',
signal.tp3,
'#4fa7ff'
]

];

lines.forEach(
line=>{

const label =
line[0];

const value =
Number(line[1]);

const color =
line[2];

if (!value) return;

const y =
Y(value);

ctx.strokeStyle =
color;

ctx.setLineDash(
[5,5]
);

ctx.beginPath();

ctx.moveTo(
padding.left,
y
);

ctx.lineTo(
width-padding.right,
y
);

ctx.stroke();

ctx.setLineDash([]);

ctx.fillStyle =
color;

ctx.font =
'9px Arial';

ctx.fillText(
label +
' ' +
numberFormat(value),
padding.left+4,
y-3
);

}
);

}

}

/* =========================================================
   CHART LOAD
========================================================= */

async function loadChart(){

if (!currentSymbol) {
return;
}

try{

const response =
await fetch(
'/api/chart?symbol=' +
encodeURIComponent(
currentSymbol
) +
'&timeframe=' +
currentTimeframe
);

const data =
await response.json();

drawChart(
data.candles,
data.signal
);

}catch(e){

console.log(
'Chart error',
e
);

}

}

/* =========================================================
   SELECT
========================================================= */

function selectSymbol(
symbol
){

currentSymbol =
symbol;

loadChart();

}

/* =========================================================
   RENDER
========================================================= */

function render(){

if (!state) return;

const stats =
state.stats || {};

const market =
state.market || {};

document.getElementById(
'counts'
).innerText =
'Radar ' +
stats.scanned +
' • Aday ' +
stats.candidates +
' • Derin ' +
stats.deep +
' • Analiz ' +
stats.analyzed +
' • Sinyal ' +
stats.signals;

document.getElementById(
'radarCount'
).innerText =
stats.scanned;

document.getElementById(
'marketLabel'
).innerText =
market.label || 'KARMA';

document.getElementById(
'breadth'
).innerText =
(
market.breadth ??
50
) +
'%';

document.getElementById(
'average'
).innerText =
(
market.averageMove ??
0
) +
'%';

/* RADAR */

const radar =
document.getElementById(
'radar'
);

radar.innerHTML =
(
state.radar || []
)
.slice(
0,
150
)
.map(
item=>{

const direction =
item.change >= 0
? 'up'
: 'down';

return `

<div
class="coin ${direction}"
onclick="selectSymbol('${esc(item.symbol)}')"
>

<div
class="coinHeader"
>

<span
class="symbol"
>
${esc(item.symbol)}
</span>

<span
class="move"
>
${item.change >= 0 ? '+' : ''}
${item.change}%
</span>

</div>

<div
class="coinPrice"
>
${esc(item.last)}
</div>

<div
class="volume"
>
24H HACİM
${Math.round(
item.quoteVolume / 1000000
)}M
</div>

</div>

`;

}
)
.join('');

/* SIGNALS */

const signals =
document.getElementById(
'signals'
);

if (
(state.signals || []).length
){

signals.innerHTML =
state.signals
.map(
s=>`

<div
class="signal ${s.type === 'LONG' ? 'long' : 'short'}"
onclick="selectSymbol('${esc(s.symbol)}')"
>

<div
class="signalHeader"
>

<span>
${esc(s.symbol)}
${s.type === 'LONG'
? 'UZUN'
: 'KISA'}
</span>

<span
class="badge"
>
${esc(s.status)}
•
${s.score}
</span>

</div>

<div
class="grid"
>

<div class="box">

<small>
GİRİŞ
</small>

<b>
${esc(s.entry)}
</b>

</div>

<div class="box">

<small>
STOP
</small>

<b
class="red"
>
${esc(s.stopLoss)}
</b>

</div>

<div class="box">

<small>
TP1
</small>

<b
class="green"
>
${esc(s.tp1)}
</b>

</div>

<div class="box">

<small>
TP2
</small>

<b
class="green"
>
${esc(s.tp2)}
</b>

</div>

<div class="box">

<small>
TP3
</small>

<b
class="green"
>
${esc(s.tp3)}
</b>

</div>

<div class="box">

<small>
R:R / RSI
</small>

<b>
${esc(s.rr)}
/
${esc(s.rsi)}
</b>

</div>

</div>

</div>

`
)
.join('');

}else{

signals.innerHTML =
`
<div class="empty">
Şu anda teyit edilmiş
scalp sinyali yok.
</div>
`;

}

/* PENDING */

const pending =
document.getElementById(
'pending'
);

if (
(state.pending || []).length
){

pending.innerHTML =
state.pending
.map(
p=>`

<div
class="pending"
>

<b>
${esc(p.symbol)}
${esc(p.side)}
</b>

<br>

Seviye:
${esc(p.level)}

•

VOL:
${esc(p.volumeRatio)}x

<br>

${esc(p.state)}

</div>

`
)
.join('');

}else{

pending.innerHTML =
`
<div class="empty">
Bekleyen kırılım yok.
</div>
`;

}

/*
 * Grafik seçim mantığı:
 *
 * 1 aktif sinyal
 * 2 deep
 * 3 radar
 *
 * Rastgele ilk coin yok.
 */

if (!currentSymbol){

if (
state.signals &&
state.signals.length
){

currentSymbol =
state.signals[0].symbol;

}else if (
state.deep &&
state.deep.length
){

currentSymbol =
state.deep[0].symbol;

}else if (
state.radar &&
state.radar.length
){

currentSymbol =
state.radar[0].symbol;

}

loadChart();

}

}

/* =========================================================
   MANUAL SCAN
========================================================= */

async function manualScan(){

try{

await fetch(
'/api/scan',
{
method:'POST'
}
);

}catch(e){

console.log(e);

}

}

/* =========================================================
   TIMEFRAMES
========================================================= */

document
.querySelectorAll('.tf')
.forEach(
button=>{

button.addEventListener(
'click',
function(){

document
.querySelectorAll('.tf')
.forEach(
x =>
x.classList.remove(
'active'
)
);

this.classList.add(
'active'
);

currentTimeframe =
this.dataset.tf;

loadChart();

}
);

}
);

/* =========================================================
   RESIZE
========================================================= */

window.addEventListener(
'resize',
function(){

loadChart();

}
);

/* =========================================================
   WEBSOCKET
========================================================= */

const protocol =
location.protocol === 'https:'
? 'wss:'
: 'ws:';

const ws =
new WebSocket(
protocol +
'//' +
location.host
);

ws.onmessage =
function(event){

try{

state =
JSON.parse(
event.data
);

render();

}catch(e){

console.log(
'WS parse error',
e
);

}

};

ws.onclose =
function(){

setTimeout(
function(){

location.reload();

},
5000
);

};

</script>

</body>

</html>
`;

/* =========================================================
   ROOT
========================================================= */

app.get(
'/',
(req,res)=>{

res
.type('html')
.send(HTML);

}
);

/* =========================================================
   START
========================================================= */

async function boot(){

console.log('');
console.log(
'=============================================='
);

console.log(
'🚀 SONNY AI TRADER V6.0'
);

console.log(
'📡 Bitget USDT Futures'
);

console.log(
'🛰️ Radar: 500 Coin'
);

console.log(
'🎯 Candidate: 150'
);

console.log(
'🔬 Deep: 40'
);

console.log(
'📊 4H + 2H → 15M → RETEST/MOMENTUM → 5M'
);

console.log(
'💰 Minimum Volume: $' +
CFG.MIN_QUOTE_VOLUME
);

console.log(
'🎯 Minimum R:R: 1:' +
CFG.MIN_RR
);

console.log(
'⏱️ Scan: ' +
CFG.SCAN_INTERVAL / 1000 +
' sec'
);

console.log(
'🤖 Auto Trade: KAPALI'
);

console.log(
'🌐 Port: ' +
PORT
);

console.log(
'=============================================='
);

try{

await loadMarkets();

await scan();

}catch(e){

console.error(
'BOOT ERROR:',
e
);

}

setInterval(
scan,
CFG.SCAN_INTERVAL
);

server.listen(
PORT,
'0.0.0.0',
function(){

console.log(
'SERVER READY | PORT ' +
PORT
);

}
}

boot();
