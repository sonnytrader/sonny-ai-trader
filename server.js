'use strict';

/*
============================================================
SONNY AI TRADER V7
BITGET USDT FUTURES SCALP ENGINE
============================================================

500 COIN RADAR
    ↓
150 CANDIDATE
    ↓
40 DEEP ANALYSIS
    ↓
4H + 2H MARKET STRUCTURE
    ↓
15M BREAKOUT / RETEST
    ↓
5M ENTRY CONFIRMATION
    ↓
SCALP SIGNAL

ÖNEMLİ:
- public/index.html GEREKMEZ.
- Arayüz bu dosyanın içindedir.
- dotenv GEREKMEZ.
- express + ws + ccxt yeterlidir.
- Otomatik emir KAPALI.
============================================================
*/

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = Number(process.env.PORT || 10000);

const PRODUCT_TYPE = 'USDT-FUTURES';
const API_BASE = 'https://api.bitget.com';

/*
============================================================
CONFIG
============================================================
*/

const CFG = {

  // Radar
  RADAR_LIMIT: 500,
  CANDIDATE_LIMIT: 150,
  DEEP_LIMIT: 40,

  // Hacim
  MIN_TURNOVER_24H: 750000,

  // 24h hareket
  MIN_MOVE_24H: 0.35,

  // Tarama
  SCAN_MS: 60000,

  // Mum
  CANDLE_LIMIT: 160,

  // 15M breakout
  BREAKOUT_LOOKBACK: 20,
  BREAKOUT_BUFFER: 0.0015,

  // Retest
  RETEST_WINDOW: 8,
  RETEST_TOLERANCE: 0.0035,

  // 5M
  ENTRY_LOOKBACK: 12,

  // ATR
  ATR_PERIOD: 14,

  // Risk
  MIN_RR: 1.15,
  MAX_STOP_PCT: 0.035,
  MIN_STOP_PCT: 0.0015,

  // Sinyal
  MIN_SIGNAL_SCORE: 62,

  // Cooldown
  SIGNAL_COOLDOWN_MS: 30 * 60 * 1000,

  // API concurrency
  CONCURRENCY: 8,

  // Chart
  DEFAULT_TIMEFRAME: '15m'
};

/*
============================================================
STATE
============================================================
*/

const STATE = {

  markets: [],
  tickers: new Map(),

  universe: [],
  candidates: [],
  deep: [],

  signals: [],
  pending: [],

  market: {
    regime: 'YATAY',
    breadth: 50,
    green: 0,
    red: 0,
    averageChange: 0
  },

  selectedSymbol: null,

  chartCache: new Map(),

  cooldowns: new Map(),

  lastScan: 0,

  scanning: false,

  lastError: null
};

/*
============================================================
UTILITIES
============================================================
*/

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function round(v, decimals = 6) {
  const p = Math.pow(10, decimals);
  return Math.round(v * p) / p;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function priceDecimals(price) {

  price = Math.abs(num(price));

  if (price >= 10000) return 2;
  if (price >= 1000) return 3;
  if (price >= 100) return 4;
  if (price >= 10) return 4;
  if (price >= 1) return 5;
  if (price >= 0.1) return 6;
  if (price >= 0.01) return 7;
  return 8;
}

function fmtPrice(price) {

  const p = num(price);

  if (!p) return '-';

  return p.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: priceDecimals(p)
  });
}

function fmtPct(v) {
  return `${num(v).toFixed(2)}%`;
}

function avg(arr) {

  const a = arr
    .map(Number)
    .filter(Number.isFinite);

  if (!a.length) return 0;

  return a.reduce((x, y) => x + y, 0) / a.length;
}

function median(arr) {

  const a = arr
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (!a.length) return 0;

  const m = Math.floor(a.length / 2);

  return a.length % 2
    ? a[m]
    : (a[m - 1] + a[m]) / 2;
}

/*
============================================================
HTTP
============================================================
*/

async function fetchJson(url, options = {}) {

  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    12000
  );

  try {

    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'SonnyAITrader/7.0',
        ...(options.headers || {})
      }
    });

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    const json = await response.json();

    if (
      json &&
      json.code &&
      json.code !== '00000'
    ) {
      throw new Error(
        json.msg || json.code
      );
    }

    return json;

  } finally {

    clearTimeout(timeout);
  }
}

/*
============================================================
BITGET MARKETS
============================================================
*/

async function loadMarkets() {

  const url =
    `${API_BASE}/api/v2/mix/market/contracts` +
    `?productType=${PRODUCT_TYPE.toLowerCase()}`;

  const json = await fetchJson(url);

  const data =
    Array.isArray(json.data)
      ? json.data
      : [];

  const markets = data
    .filter(m =>
      String(m.symbolType || '').toLowerCase() === 'perpetual'
    )
    .filter(m =>
      String(m.symbolStatus || '').toLowerCase() === 'normal'
    )
    .filter(m =>
      String(m.quoteCoin || '').toUpperCase() === 'USDT'
    )
    .map(m => ({
      symbol: String(m.symbol).toUpperCase(),
      baseCoin: m.baseCoin,
      quoteCoin: m.quoteCoin,
      tickSize: num(m.pricePlace ? 1 : 0),
      minTradeUSDT: num(m.minTradeUSDT)
    }))
    .filter(m =>
      m.symbol &&
      m.symbol.endsWith('USDT')
    );

  STATE.markets = markets;

  console.log(
    `MARKETS | Gerçek USDT perpetual=${markets.length}`
  );

  return markets;
}

/*
============================================================
TICKERS
============================================================
*/

async function loadTickers() {

  const url =
    `${API_BASE}/api/v2/mix/market/tickers` +
    `?productType=${PRODUCT_TYPE}`;

  const json = await fetchJson(url);

  const data =
    Array.isArray(json.data)
      ? json.data
      : [];

  STATE.tickers.clear();

  for (const t of data) {

    const symbol =
      String(t.symbol || '')
        .toUpperCase();

    if (!symbol.endsWith('USDT')) {
      continue;
    }

    const last =
      num(t.lastPr);

    if (last <= 0) {
      continue;
    }

    /*
      Bitget change24h örneğin:
      0.025 = %2.5

      Sistemde yüzde olarak kullanıyoruz.
    */

    const change =
      num(t.change24h) * 100;

    let turnover =
      num(t.usdtVolume);

    if (turnover <= 0) {
      turnover =
        num(t.quoteVolume);
    }

    if (
      turnover <= 0 &&
      num(t.baseVolume) > 0
    ) {
      turnover =
        num(t.baseVolume) * last;
    }

    STATE.tickers.set(symbol, {

      symbol,

      last,

      bid:
        num(t.bidPr),

      ask:
        num(t.askPr),

      high:
        num(t.high24h),

      low:
        num(t.low24h),

      change,

      turnover,

      baseVolume:
        num(t.baseVolume),

      quoteVolume:
        num(t.quoteVolume),

      usdtVolume:
        num(t.usdtVolume),

      fundingRate:
        num(t.fundingRate)
    });
  }

  return STATE.tickers;
}

/*
============================================================
MARKET REGIME
============================================================
*/

function calculateMarketRegime() {

  const values =
    [...STATE.tickers.values()]
      .filter(x =>
        x.last > 0
      );

  if (!values.length) {

    STATE.market = {
      regime: 'YATAY',
      breadth: 50,
      green: 0,
      red: 0,
      averageChange: 0
    };

    return;
  }

  let green = 0;
  let red = 0;

  const changes = [];

  for (const t of values) {

    if (t.change > 0) green++;
    if (t.change < 0) red++;

    changes.push(t.change);
  }

  const total =
    Math.max(1, green + red);

  const breadth =
    (green / total) * 100;

  const averageChange =
    avg(changes);

  let regime = 'YATAY';

  if (
    breadth >= 62 &&
    averageChange >= 0.45
  ) {
    regime = 'YÜKSELİŞ';

  } else if (
    breadth <= 38 &&
    averageChange <= -0.45
  ) {
    regime = 'DÜŞÜŞ';

  } else if (
    breadth >= 55 &&
    averageChange > 0.15
  ) {
    regime = 'HAFİF YÜKSELİŞ';

  } else if (
    breadth <= 45 &&
    averageChange < -0.15
  ) {
    regime = 'HAFİF DÜŞÜŞ';
  }

  STATE.market = {

    regime,

    breadth:
      round(breadth, 1),

    green,

    red,

    averageChange:
      round(averageChange, 2)
  };
}

/*
============================================================
RADAR
============================================================
*/

function buildRadar() {

  const marketSet =
    new Set(
      STATE.markets.map(
        m => m.symbol
      )
    );

  const universe =
    [...STATE.tickers.values()]
      .filter(t =>
        marketSet.has(t.symbol)
      )
      .filter(t =>
        t.last > 0
      )
      .filter(t =>
        t.turnover >=
        CFG.MIN_TURNOVER_24H
      )
      .filter(t =>
        Math.abs(t.change) >=
        CFG.MIN_MOVE_24H
      )
      .sort((a, b) => {

        /*
          Likidite + hareket + momentum
        */

        const scoreA =
          Math.log10(
            Math.max(1, a.turnover)
          ) * 2 +
          Math.abs(a.change) * 2 +
          Math.min(
            10,
            Math.abs(a.change)
          );

        const scoreB =
          Math.log10(
            Math.max(1, b.turnover)
          ) * 2 +
          Math.abs(b.change) * 2 +
          Math.min(
            10,
            Math.abs(b.change)
          );

        return scoreB - scoreA;
      });

  STATE.universe =
    universe.slice(
      0,
      CFG.RADAR_LIMIT
    );

  STATE.candidates =
    STATE.universe
      .slice(
        0,
        CFG.CANDIDATE_LIMIT
      );

  return STATE.candidates;
}

/*
============================================================
CANDLE API
============================================================
*/

function candleUrl(
  symbol,
  granularity,
  limit = CFG.CANDLE_LIMIT
) {

  return (
    `${API_BASE}/api/v2/mix/market/candles` +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&granularity=${encodeURIComponent(granularity)}` +
    `&limit=${limit}` +
    `&productType=${PRODUCT_TYPE.toLowerCase()}`
  );
}

async function fetchCandles(
  symbol,
  timeframe,
  limit = CFG.CANDLE_LIMIT
) {

  const json =
    await fetchJson(
      candleUrl(
        symbol,
        timeframe,
        limit
      )
    );

  const rows =
    Array.isArray(json.data)
      ? json.data
      : [];

  return rows
    .map(r => ({

      time: num(r[0]),

      open: num(r[1]),

      high: num(r[2]),

      low: num(r[3]),

      close: num(r[4]),

      volume: num(r[5]),

      turnover: num(r[6])
    }))
    .filter(c =>
      c.time > 0 &&
      c.close > 0
    )
    .sort(
      (a, b) =>
        a.time - b.time
    );
}

/*
============================================================
INDICATORS
============================================================
*/

function ema(values, period) {

  if (!values.length) {
    return 0;
  }

  const k =
    2 / (period + 1);

  let e =
    values[0];

  for (
    let i = 1;
    i < values.length;
    i++
  ) {

    e =
      values[i] * k +
      e * (1 - k);
  }

  return e;
}

function rsi(values, period = 14) {

  if (
    values.length <
    period + 1
  ) {
    return 50;
  }

  let gain = 0;
  let loss = 0;

  for (
    let i = values.length - period;
    i < values.length;
    i++
  ) {

    const diff =
      values[i] -
      values[i - 1];

    if (diff > 0) {
      gain += diff;
    } else {
      loss -= diff;
    }
  }

  if (loss === 0) {
    return 100;
  }

  const rs =
    gain / loss;

  return (
    100 -
    100 / (1 + rs)
  );
}

function atr(
  candles,
  period = CFG.ATR_PERIOD
) {

  if (
    candles.length <
    period + 1
  ) {
    return 0;
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

    trs.push(
      Math.max(
        c.high - c.low,

        Math.abs(
          c.high - p.close
        ),

        Math.abs(
          c.low - p.close
        )
      )
    );
  }

  return avg(
    trs.slice(-period)
  );
}

function averageVolume(
  candles,
  period = 20
) {

  return avg(
    candles
      .slice(-period)
      .map(c => c.volume)
  );
}

/*
============================================================
STRUCTURE
============================================================
*/

function findSwingHigh(
  candles,
  lookback = 20
) {

  const c =
    candles.slice(
      -(lookback + 1),
      -1
    );

  if (!c.length) {
    return 0;
  }

  return Math.max(
    ...c.map(x => x.high)
  );
}

function findSwingLow(
  candles,
  lookback = 20
) {

  const c =
    candles.slice(
      -(lookback + 1),
      -1
    );

  if (!c.length) {
    return 0;
  }

  return Math.min(
    ...c.map(x => x.low)
  );
}

function trendBias(candles) {

  if (
    candles.length < 60
  ) {
    return 'NEUTRAL';
  }

  const closes =
    candles.map(
      c => c.close
    );

  const fast =
    ema(closes, 21);

  const slow =
    ema(closes, 50);

  const price =
    closes[closes.length - 1];

  const distance =
    (fast - slow) /
    slow;

  if (
    fast > slow &&
    price > fast &&
    distance > 0.001
  ) {
    return 'LONG';
  }

  if (
    fast < slow &&
    price < fast &&
    distance < -0.001
  ) {
    return 'SHORT';
  }

  return 'NEUTRAL';
}

/*
============================================================
5M MOMENTUM
============================================================
*/

function fiveMinuteConfirmation(
  candles,
  side
) {

  if (
    candles.length < 20
  ) {
    return {
      ok: false,
      score: 0,
      reason: '5M DATA YETERSİZ'
    };
  }

  const last =
    candles[
      candles.length - 1
    ];

  const prev =
    candles[
      candles.length - 2
    ];

  const closes =
    candles.map(
      c => c.close
    );

  const fast =
    ema(closes.slice(-30), 9);

  const slow =
    ema(closes.slice(-30), 20);

  const av =
    averageVolume(
      candles,
      20
    );

  const volumeRatio =
    av > 0
      ? last.volume / av
      : 1;

  let score = 0;

  if (side === 'LONG') {

    if (
      last.close >
      last.open
    ) {
      score += 20;
    }

    if (
      last.close >
      prev.close
    ) {
      score += 15;
    }

    if (
      fast > slow
    ) {
      score += 15;
    }

    if (
      volumeRatio >= 1.05
    ) {
      score += 15;
    }

    if (
      last.close >=
      last.low +
      (last.high - last.low) * 0.55
    ) {
      score += 10;
    }

  } else {

    if (
      last.close <
      last.open
    ) {
      score += 20;
    }

    if (
      last.close <
      prev.close
    ) {
      score += 15;
    }

    if (
      fast < slow
    ) {
      score += 15;
    }

    if (
      volumeRatio >= 1.05
    ) {
      score += 15;
    }

    if (
      last.close <=
      last.high -
      (last.high - last.low) * 0.55
    ) {
      score += 10;
    }
  }

  return {

    ok:
      score >= 35,

    score,

    volumeRatio:

      round(
        volumeRatio,
        2
      )
  };
}

/*
============================================================
15M BREAKOUT
============================================================
*/

function detectBreakout(
  candles
) {

  if (
    candles.length <
    CFG.BREAKOUT_LOOKBACK + 5
  ) {
    return [];
  }

  const result = [];

  const closed =
    candles.slice(
      0,
      -1
    );

  const last =
    closed[
      closed.length - 1
    ];

  const previous =
    closed[
      closed.length - 2
    ];

  const lookback =
    closed.slice(
      -CFG.BREAKOUT_LOOKBACK - 1,
      -1
    );

  if (!lookback.length) {
    return result;
  }

  const resistance =
    Math.max(
      ...lookback.map(
        c => c.high
      )
    );

  const support =
    Math.min(
      ...lookback.map(
        c => c.low
      )
    );

  const av =
    averageVolume(
      closed,
      20
    );

  const volumeRatio =
    av > 0
      ? last.volume / av
      : 1;

  /*
    LONG breakout
  */

  if (
    last.close >
    resistance *
    (1 + CFG.BREAKOUT_BUFFER)
  ) {

    result.push({

      side: 'LONG',

      level:
        resistance,

      breakoutPrice:
        last.close,

      volumeRatio,

      time:
        last.time,

      candle:
        last
    });
  }

  /*
    SHORT breakout
  */

  if (
    last.close <
    support *
    (1 - CFG.BREAKOUT_BUFFER)
  ) {

    result.push({

      side: 'SHORT',

      level:
        support,

      breakoutPrice:
        last.close,

      volumeRatio,

      time:
        last.time,

      candle:
        last
    });
  }

  /*
    Ayrıca son hareketin henüz tam breakout
    olmaması halinde "yakın breakout" üret.
    Bu, scalp radarının fırsat kaçırmasını önler.
  */

  const proximity =
    0.0018;

  if (
    last.close >
    resistance *
    (1 - proximity) &&
    last.close <=
    resistance *
    (1 + CFG.BREAKOUT_BUFFER)
  ) {

    result.push({

      side: 'LONG',

      level:
        resistance,

      breakoutPrice:
        last.close,

      volumeRatio,

      time:
        last.time,

      nearBreakout: true,

      candle:
        last
    });
  }

  if (
    last.close <
    support *
    (1 + proximity) &&
    last.close >=
    support *
    (1 - CFG.BREAKOUT_BUFFER)
  ) {

    result.push({

      side: 'SHORT',

      level:
        support,

      breakoutPrice:
        last.close,

      volumeRatio,

      time:
        last.time,

      nearBreakout: true,

      candle:
        last
    });
  }

  /*
    Duplicate direction temizle
  */

  const unique =
    new Map();

  for (const b of result) {

    const key =
      `${b.side}-${round(
        b.level,
        8
      )}`;

    if (!unique.has(key)) {
      unique.set(
        key,
        b
      );
    }
  }

  return [
    ...unique.values()
  ];
}

/*
============================================================
RETEST
============================================================
*/

function evaluateRetest(
  candles,
  breakout
) {

  if (!breakout) {
    return {
      valid: false,
      quality: 0
    };
  }

  const level =
    breakout.level;

  const side =
    breakout.side;

  const tolerance =
    Math.max(
      level *
      CFG.RETEST_TOLERANCE,
      0.00000001
    );

  const after =
    candles.filter(
      c =>
        c.time >
        breakout.time
    );

  const window =
    after.slice(
      0,
      CFG.RETEST_WINDOW
    );

  if (!window.length) {

    const last =
      candles[
        candles.length - 1
      ];

    const distance =
      Math.abs(
        last.close - level
      ) / level;

    return {

      valid:
        distance <=
        CFG.RETEST_TOLERANCE,

      waiting: true,

      quality:
        distance <=
        CFG.RETEST_TOLERANCE
          ? 35
          : 0
    };
  }

  let touched = false;
  let held = false;

  for (const c of window) {

    if (
      c.low <=
      level + tolerance &&
      c.high >=
      level - tolerance
    ) {
      touched = true;

      if (
        side === 'LONG' &&
        c.close >= level
      ) {
        held = true;
      }

      if (
        side === 'SHORT' &&
        c.close <= level
      ) {
        held = true;
      }
    }
  }

  const last =
    window[
      window.length - 1
    ];

  const distance =
    Math.abs(
      last.close - level
    ) / level;

  let quality = 0;

  if (touched) {
    quality += 30;
  }

  if (held) {
    quality += 30;
  }

  if (
    distance <=
    CFG.RETEST_TOLERANCE
  ) {
    quality += 20;
  }

  return {

    valid:
      touched &&
      held,

    waiting:
      !touched,

    quality,

    lastPrice:
      last.close
  };
}

/*
============================================================
SIGNAL BUILD
============================================================
*/

function buildSignal(
  symbol,
  ticker,
  candles4h,
  candles2h,
  candles15,
  candles5
) {

  if (
    !candles4h.length ||
    !candles2h.length ||
    !candles15.length ||
    !candles5.length
  ) {
    return null;
  }

  const current =
    ticker.last;

  const bias4h =
    trendBias(
      candles4h
    );

  const bias2h =
    trendBias(
      candles2h
    );

  const breakouts =
    detectBreakout(
      candles15
    );

  if (!breakouts.length) {
    return null;
  }

  let best = null;

  for (const breakout of breakouts) {

    const side =
      breakout.side;

    /*
      4H / 2H yön uyumu.
      Tam ters ise tamamen öldürmüyoruz.
      Çünkü scalp'ta kısa karşı-trend fırsatı olabilir.
    */

    let score = 0;

    if (
      bias4h === side
    ) {
      score += 20;
    } else if (
      bias4h === 'NEUTRAL'
    ) {
      score += 10;
    }

    if (
      bias2h === side
    ) {
      score += 15;
    } else if (
      bias2h === 'NEUTRAL'
    ) {
      score += 8;
    }

    /*
      Breakout hacmi
    */

    const vr =
      num(
        breakout.volumeRatio,
        1
      );

    if (vr >= 2) {
      score += 20;
    } else if (vr >= 1.5) {
      score += 15;
    } else if (vr >= 1.15) {
      score += 10;
    } else {
      score += 5;
    }

    /*
      Retest
    */

    const retest =
      evaluateRetest(
        candles15,
        breakout
      );

    score +=
      retest.quality;

    /*
      5M
    */

    const confirm =
      fiveMinuteConfirmation(
        candles5,
        side
      );

    score +=
      confirm.score *
      0.35;

    /*
      RSI
    */

    const rsiValue =
      rsi(
        candles5.map(
          c => c.close
        )
      );

    if (
      side === 'LONG'
    ) {

      if (
        rsiValue >= 48 &&
        rsiValue <= 72
      ) {
        score += 8;
      }

    } else {

      if (
        rsiValue >= 28 &&
        rsiValue <= 52
      ) {
        score += 8;
      }
    }

    /*
      Current price level distance
    */

    const level =
      breakout.level;

    const levelDistance =
      Math.abs(
        current - level
      ) / level;

    if (
      levelDistance <=
      CFG.RETEST_TOLERANCE
    ) {
      score += 10;
    }

    /*
      Near breakout bonus
    */

    if (
      breakout.nearBreakout
    ) {
      score += 5;
    }

    score =
      clamp(
        Math.round(score),
        0,
        100
      );

    /*
      Entry zone
    */

    const zoneWidth =
      Math.max(
        level *
        0.0018,
        atr(
          candles5
        ) * 0.35
      );

    let entryLow;
    let entryHigh;

    if (
      side === 'LONG'
    ) {

      entryLow =
        level -
        zoneWidth * 0.35;

      entryHigh =
        level +
        zoneWidth;

    } else {

      entryLow =
        level -
        zoneWidth;

      entryHigh =
        level +
        zoneWidth * 0.35;
    }

    /*
      Entry:
      mevcut fiyat bölgenin içindeyse
      mevcut fiyat,
      değilse kırılım seviyesi.
    */

    let entry =
      current;

    if (
      side === 'LONG'
    ) {

      entry =
        clamp(
          current,
          entryLow,
          entryHigh
        );

    } else {

      entry =
        clamp(
          current,
          entryLow,
          entryHigh
        );
    }

    /*
      ATR stop
    */

    const atr5 =
      atr(
        candles5
      );

    const atrStop =
      atr5 > 0
        ? atr5 * 1.15
        : entry *
          0.004;

    /*
      Swing stop
    */

    const swingLow =
      findSwingLow(
        candles5,
        12
      );

    const swingHigh =
      findSwingHigh(
        candles5,
        12
      );

    let stop;

    if (
      side === 'LONG'
    ) {

      stop =
        Math.min(
          swingLow,
          entry - atrStop
        );

      /*
        Stop'un aşırı uzaklaşmasını engelle
      */

      const maxStop =
        entry *
        (1 - CFG.MIN_STOP_PCT);

      const hardStop =
        entry *
        (1 - CFG.MAX_STOP_PCT);

      stop =
        Math.max(
          stop,
          hardStop
        );

      stop =
        Math.min(
          stop,
          maxStop
        );

    } else {

      stop =
        Math.max(
          swingHigh,
          entry + atrStop
        );

      const maxStop =
        entry *
        (1 + CFG.MIN_STOP_PCT);

      const hardStop =
        entry *
        (1 + CFG.MAX_STOP_PCT);

      stop =
        Math.min(
          stop,
          hardStop
        );

      stop =
        Math.max(
          stop,
          maxStop
        );
    }

    const risk =
      Math.abs(
        entry - stop
      );

    if (
      risk <= 0
    ) {
      continue;
    }

    /*
      TP yapısı:
      TP1 hızlı scalp
      TP2 devam
      TP3 geniş momentum
    */

    let tp1;
    let tp2;
    let tp3;

    if (
      side === 'LONG'
    ) {

      tp1 =
        entry +
        risk * 1.15;

      tp2 =
        entry +
        risk * 1.8;

      tp3 =
        entry +
        risk * 2.5;

    } else {

      tp1 =
        entry -
        risk * 1.15;

      tp2 =
        entry -
        risk * 1.8;

      tp3 =
        entry -
        risk * 2.5;
    }

    /*
      TP'leri gerçek 15M karşı seviyesine göre
      mantıklı şekilde kırp.
    */

    const oppositeHigh =
      findSwingHigh(
        candles15,
        35
      );

    const oppositeLow =
      findSwingLow(
        candles15,
        35
      );

    if (
      side === 'LONG'
    ) {

      if (
        oppositeHigh >
        entry
      ) {

        tp1 =
          Math.min(
            tp1,
            oppositeHigh
          );

        tp2 =
          Math.min(
            tp2,
            oppositeHigh *
            1.002
          );

        tp3 =
          Math.min(
            tp3,
            oppositeHigh *
            1.004
          );
      }

    } else {

      if (
        oppositeLow > 0 &&
        oppositeLow <
        entry
      ) {

        tp1 =
          Math.max(
            tp1,
            oppositeLow
          );

        tp2 =
          Math.max(
            tp2,
            oppositeLow *
            0.998
          );

        tp3 =
          Math.max(
            tp3,
            oppositeLow *
            0.996
          );
      }
    }

    /*
      TP sıralamasını garanti et.
    */

    if (
      side === 'LONG'
    ) {

      tp1 =
        Math.max(
          tp1,
          entry +
          risk * 1.05
        );

      tp2 =
        Math.max(
          tp2,
          tp1 +
          risk * 0.25
        );

      tp3 =
        Math.max(
          tp3,
          tp2 +
          risk * 0.25
        );

    } else {

      tp1 =
        Math.min(
          tp1,
          entry -
          risk * 1.05
        );

      tp2 =
        Math.min(
          tp2,
          tp1 -
          risk * 0.25
        );

      tp3 =
        Math.min(
          tp3,
          tp2 -
          risk * 0.25
        );
    }

    const rr =
      risk > 0
        ? Math.abs(
            tp1 - entry
          ) / risk
        : 0;

    /*
      R:R düşükse sinyali öldürme.
      Ancak score düşür.
    */

    if (
      rr < CFG.MIN_RR
    ) {
      score -= 12;
    }

    /*
      Ters yön ciddi cezalandırılır
      ama tamamen yasaklanmaz.
    */

    if (
      bias4h !== 'NEUTRAL' &&
      bias4h !== side
    ) {
      score -= 12;
    }

    if (
      bias2h !== 'NEUTRAL' &&
      bias2h !== side
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
      Minimum koşul:
      - Breakout veya seviyeye çok yakın yapı
      - 5M en az kısmi teyit
      - score >= 62
    */

    const acceptable =
      score >=
      CFG.MIN_SIGNAL_SCORE &&
      confirm.score >= 30;

    if (!acceptable) {
      continue;
    }

    const signal = {

      id:
        `${symbol}-${side}-${Math.round(Date.now() / 10000)}`,

      symbol,

      type:
        side,

      status:
        retest.valid
          ? 'GİRİŞ'
          : 'GİRİŞ BEKLENİYOR',

      score,

      timeframe:
        '4H + 2H + 15M + 5M',

      levelTimeframe:
        '15M',

      entry,

      entryLow,

      entryHigh,

      stop,

      tp1,

      tp2,

      tp3,

      rr,

      rsi:
        round(
          rsiValue,
          1
        ),

      volumeRatio:
        round(
          vr,
          2
        ),

      confirmScore:
        Math.round(
          confirm.score
        ),

      trend4h:
        bias4h,

      trend2h:
        bias2h,

      breakoutLevel:
        level,

      breakoutPrice:
        breakout.breakoutPrice,

      retest:
        retest.valid,

      waitingRetest:
        !retest.valid,

      price:
        current,

      createdAt:
        Date.now(),

      reason:
        `${side === 'LONG'
          ? 'Yukarı'
          : 'Aşağı'} 15M yapı + ` +
        `4H ${bias4h} + ` +
        `2H ${bias2h} + ` +
        `5M teyit`
    };

    if (
      !best ||
      signal.score >
      best.score
    ) {
      best = signal;
    }
  }

  return best;
}

/*
============================================================
COIN ANALYSIS
============================================================
*/

async function analyzeCoin(
  ticker
) {

  const symbol =
    ticker.symbol;

  try {

    const [
      candles4h,
      candles2h,
      candles15,
      candles5
    ] =
      await Promise.all([

        fetchCandles(
          symbol,
          '4H',
          100
        ),

        fetchCandles(
          symbol,
          '2H',
          100
        ),

        fetchCandles(
          symbol,
          '15m',
          120
        ),

        fetchCandles(
          symbol,
          '5m',
          100
        )
      ]);

    if (
      candles4h.length < 60 ||
      candles2h.length < 60 ||
      candles15.length < 40 ||
      candles5.length < 30
    ) {
      return {
        symbol,
        signal: null,
        pending: null
      };
    }

    const signal =
      buildSignal(
        symbol,
        ticker,
        candles4h,
        candles2h,
        candles15,
        candles5
      );

    /*
      Pending:
      breakout var fakat henüz giriş teyidi yok.
    */

    let pending = null;

    const breakouts =
      detectBreakout(
        candles15
      );

    if (
      breakouts.length
    ) {

      const b =
        breakouts
          .sort(
            (a, z) =>
              z.volumeRatio -
              a.volumeRatio
          )[0];

      const retest =
        evaluateRetest(
          candles15,
          b
        );

      const confirm =
        fiveMinuteConfirmation(
          candles5,
          b.side
        );

      if (
        !signal &&
        (
          retest.waiting ||
          !retest.valid
        )
      ) {

        pending = {

          symbol,

          type:
            b.side,

          status:
            'RETEST BEKLENİYOR',

          level:
            b.level,

          breakoutPrice:
            b.breakoutPrice,

          volumeRatio:
            round(
              b.volumeRatio,
              2
            ),

          confirmScore:
            Math.round(
              confirm.score
            ),

          createdAt:
            Date.now()
        };
      }
    }

    return {
      symbol,
      signal,
      pending
    };

  } catch (err) {

    console.error(
      `ANALYZE ERROR | ${symbol} | ${err.message}`
    );

    return {
      symbol,
      signal: null,
      pending: null
    };
  }
}

/*
============================================================
CONCURRENCY
============================================================
*/

async function mapLimit(
  items,
  limit,
  fn
) {

  const results =
    new Array(
      items.length
    );

  let cursor = 0;

  async function worker() {

    while (true) {

      const index =
        cursor++;

      if (
        index >=
        items.length
      ) {
        return;
      }

      try {

        results[index] =
          await fn(
            items[index],
            index
          );

      } catch (err) {

        results[index] =
          null;
      }
    }
  }

  const workers =
    Array.from(
      {
        length:
          Math.min(
            limit,
            items.length
          )
      },
      worker
    );

  await Promise.all(
    workers
  );

  return results;
}

/*
============================================================
COOLDOWN
============================================================
*/

function cooldownKey(
  signal
) {

  return (
    `${signal.symbol}:` +
    `${signal.type}:` +
    `${round(
      signal.breakoutLevel,
      8
    )}`
  );
}

function isCoolingDown(
  signal
) {

  const key =
    cooldownKey(
      signal
    );

  const until =
    STATE.cooldowns.get(
      key
    );

  if (!until) {
    return false;
  }

  if (
    Date.now() >
    until
  ) {

    STATE.cooldowns.delete(
      key
    );

    return false;
  }

  return true;
}

function registerCooldown(
  signal
) {

  STATE.cooldowns.set(
    cooldownKey(signal),
    Date.now() +
    CFG.SIGNAL_COOLDOWN_MS
  );
}

/*
============================================================
SCAN
============================================================
*/

async function scanRadar() {

  if (STATE.scanning) {
    return;
  }

  STATE.scanning = true;

  try {

    console.log('');
    console.log(
      '=============================================='
    );
    console.log(
      'SONNY AI TRADER V7 RADAR'
    );
    console.log(
      '=============================================='
    );

    await loadTickers();

    calculateMarketRegime();

    buildRadar();

    /*
      Deep analiz:
      Önce en güçlü 40 aday.
    */

    STATE.deep =
      STATE.candidates
        .slice(
          0,
          CFG.DEEP_LIMIT
        );

    const results =
      await mapLimit(
        STATE.deep,
        CFG.CONCURRENCY,
        ticker =>
          analyzeCoin(
            ticker
          )
      );

    const signals = [];
    const pending = [];

    for (const result of results) {

      if (!result) {
        continue;
      }

      if (
        result.pending
      ) {
        pending.push(
          result.pending
        );
      }

      if (
        result.signal
      ) {

        if (
          !isCoolingDown(
            result.signal
          )
        ) {

          signals.push(
            result.signal
          );
        }
      }
    }

    /*
      Aynı coin + aynı yön:
      sadece en yüksek skor.
    */

    const unique =
      new Map();

    for (const signal of signals) {

      const key =
        `${signal.symbol}-${signal.type}`;

      const old =
        unique.get(key);

      if (
        !old ||
        signal.score >
        old.score
      ) {

        unique.set(
          key,
          signal
        );
      }
    }

    STATE.signals =
      [...unique.values()]
        .sort(
          (a, b) =>
            b.score -
            a.score
        )
        .slice(
          0,
          20
        );

    /*
      Pending duplicate temizliği
    */

    const pendingMap =
      new Map();

    for (const p of pending) {

      const key =
        `${p.symbol}-${p.type}`;

      if (
        !pendingMap.has(key)
      ) {
        pendingMap.set(
          key,
          p
        );
      }
    }

    STATE.pending =
      [...pendingMap.values()]
        .sort(
          (a, b) =>
            b.volumeRatio -
            a.volumeRatio
        )
        .slice(
          0,
          20
        );

    /*
      En iyi sinyali seç
    */

    if (
      STATE.signals.length
    ) {

      STATE.selectedSymbol =
        STATE.signals[0].symbol;

    } else if (
      STATE.selectedSymbol === null &&
      STATE.candidates.length
    ) {

      STATE.selectedSymbol =
        STATE.candidates[0].symbol;
    }

    /*
      Cooldown register
    */

    for (
      const signal of
      STATE.signals
    ) {

      registerCooldown(
        signal
      );
    }

    STATE.lastScan =
      Date.now();

    STATE.lastError =
      null;

    console.log(
      `RADAR tamamlandı | ` +
      `Universe=${STATE.universe.length} | ` +
      `Candidates=${STATE.candidates.length} | ` +
      `Deep=${STATE.deep.length} | ` +
      `Analiz=${results.filter(Boolean).length} | ` +
      `Pending=${STATE.pending.length} | ` +
      `SIGNAL=${STATE.signals.length}`
    );

    for (
      const signal of
      STATE.signals
    ) {

      console.log(
        `SIGNAL | ` +
        `${signal.symbol} | ` +
        `${signal.type} | ` +
        `ENTRY ${fmtPrice(signal.entry)} | ` +
        `STOP ${fmtPrice(signal.stop)} | ` +
        `TP1 ${fmtPrice(signal.tp1)} | ` +
        `TP2 ${fmtPrice(signal.tp2)} | ` +
        `TP3 ${fmtPrice(signal.tp3)} | ` +
        `SCORE ${signal.score} | ` +
        `RR 1:${signal.rr.toFixed(2)}`
      );
    }

    broadcastState();

  } catch (err) {

    STATE.lastError =
      err.message;

    console.error(
      'RADAR ERROR:',
      err
    );

    broadcastState();

  } finally {

    STATE.scanning = false;
  }
}

/*
============================================================
CHART DATA
============================================================
*/

function timeframeToGranularity(
  timeframe
) {

  const map = {

    '5m': '5m',

    '15m': '15m',

    '1h': '1H',

    '2h': '2H',

    '4h': '4H'
  };

  return (
    map[timeframe] ||
    '15m'
  );
}

async function getChartData(
  symbol,
  timeframe
) {

  const tf =
    timeframeToGranularity(
      timeframe
    );

  const key =
    `${symbol}:${tf}`;

  const cached =
    STATE.chartCache.get(key);

  /*
    15 saniye cache.
    UI sürekli refresh yaptığında
    Bitget'e gereksiz yük bindirme.
  */

  if (
    cached &&
    Date.now() -
    cached.time <
    15000
  ) {

    return cached.data;
  }

  const candles =
    await fetchCandles(
      symbol,
      tf,
      120
    );

  let signal =
    STATE.signals.find(
      s =>
        s.symbol ===
        symbol
    );

  /*
    Chart için pending sinyali de kullan.
  */

  if (!signal) {

    const p =
      STATE.pending.find(
        x =>
          x.symbol ===
          symbol
      );

    if (p) {

      signal = {

        symbol,

        type:
          p.type,

        entry:
          p.level,

        entryLow:
          p.level *
          0.998,

        entryHigh:
          p.level *
          1.002,

        breakoutLevel:
          p.level,

        stop:
          p.type === 'LONG'
            ? p.level * 0.996
            : p.level * 1.004,

        tp1:
          p.type === 'LONG'
            ? p.level * 1.006
            : p.level * 0.994,

        tp2:
          p.type === 'LONG'
            ? p.level * 1.012
            : p.level * 0.988,

        tp3:
          p.type === 'LONG'
            ? p.level * 1.018
            : p.level * 0.982,

        score:
          Math.round(
            50 +
            p.volumeRatio * 8
          )
      };
    }
  }

  const data = {

    symbol,

    timeframe:

      timeframe,

    candles,

    signal:
      signal || null
  };

  STATE.chartCache.set(
    key,
    {
      time: Date.now(),
      data
    }
  );

  return data;
}

/*
============================================================
STATUS
============================================================
*/

function serializeSignal(
  s
) {

  return {

    ...s,

    entry:
      round(
        s.entry,
        priceDecimals(
          s.entry
        )
      ),

    entryLow:
      round(
        s.entryLow,
        priceDecimals(
          s.entryLow
        )
      ),

    entryHigh:
      round(
        s.entryHigh,
        priceDecimals(
          s.entryHigh
        )
      ),

    stop:
      round(
        s.stop,
        priceDecimals(
          s.stop
        )
      ),

    tp1:
      round(
        s.tp1,
        priceDecimals(
          s.tp1
        )
      ),

    tp2:
      round(
        s.tp2,
        priceDecimals(
          s.tp2
        )
      ),

    tp3:
      round(
        s.tp3,
        priceDecimals(
          s.tp3
        )
      )
  };
}

function getStatus() {

  return {

    ok: true,

    time:
      Date.now(),

    stats: {

      scanned:
        STATE.universe.length,

      candidates:
        STATE.candidates.length,

      deep:
        STATE.deep.length,

      analyzed:
        STATE.deep.length,

      pending:
        STATE.pending.length,

      activeSignalsCount:
        STATE.signals.length
    },

    market:
      STATE.market,

    signals:
      STATE.signals.map(
        serializeSignal
      ),

    pending:
      STATE.pending,

    selectedSymbol:
      STATE.selectedSymbol,

    error:
      STATE.lastError
  };
}

/*
============================================================
WEBSOCKET
============================================================
*/

function broadcastState() {

  const payload =
    JSON.stringify(
      getStatus()
    );

  for (
    const client of
    wss.clients
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

wss.on(
  'connection',
  ws => {

    ws.send(
      JSON.stringify(
        getStatus()
      )
    );
  }
);

/*
============================================================
API
============================================================
*/

app.get(
  '/api/status',
  (req, res) => {

    res.json(
      getStatus()
    );
  }
);

app.get(
  '/api/chart',
  async (req, res) => {

    try {

      let symbol =
        String(
          req.query.symbol ||
          STATE.selectedSymbol ||
          'BTCUSDT'
        )
          .toUpperCase();

      let timeframe =
        String(
          req.query.timeframe ||
          '15m'
        ).toLowerCase();

      if (
        !/^[A-Z0-9]+USDT$/.test(
          symbol
        )
      ) {

        return res.status(400)
          .json({
            error:
              'Geçersiz USDT sembolü'
          });
      }

      const data =
        await getChartData(
          symbol,
          timeframe
        );

      res.json(
        data
      );

    } catch (err) {

      res.status(500)
        .json({

          error:
            err.message
        });
    }
  }
);

app.get(
  '/api/select',
  async (req, res) => {

    const symbol =
      String(
        req.query.symbol ||
        ''
      )
        .toUpperCase();

    if (!symbol) {

      return res.status(400)
        .json({
          error:
            'symbol gerekli'
        });
    }

    STATE.selectedSymbol =
      symbol;

    broadcastState();

    res.json({
      ok: true,
      symbol
    });
  }
);

app.post(
  '/api/scan',
  async (req, res) => {

    if (
      STATE.scanning
    ) {

      return res.json({
        ok: false,
        message:
          'Radar zaten tarıyor'
      });
    }

    scanRadar();

    res.json({
      ok: true,
      message:
        'Radar başlatıldı'
    });
  }
);

/*
============================================================
EMBEDDED FRONTEND
============================================================
*/

const HTML = String.raw`<!DOCTYPE html>
<html lang="tr">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1,maximum-scale=1"
/>

<title>Sonny AI Trader V7</title>

<style>

*{
  box-sizing:border-box;
}

html,
body{
  margin:0;
  width:100%;
  height:100%;
  overflow:hidden;
  background:#070b12;
  color:#e8eef7;
  font-family:
    Inter,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    Arial,
    sans-serif;
}

button{
  font-family:inherit;
}

.app{
  width:100%;
  height:100vh;
  display:grid;
  grid-template-columns:235px minmax(0,1fr) 280px;
  background:#070b12;
}

.sidebar{
  min-width:0;
  border-right:1px solid #182233;
  background:#0a0f17;
  display:flex;
  flex-direction:column;
}

.logo{
  padding:18px 15px;
  border-bottom:1px solid #182233;
}

.logo-title{
  font-size:16px;
  font-weight:900;
  color:#fff;
}

.logo-sub{
  font-size:9px;
  color:#6f8199;
  margin-top:6px;
  line-height:1.5;
}

.radar-button{
  margin:10px;
  border:0;
  border-radius:7px;
  padding:11px;
  background:#162744;
  color:#fff;
  font-weight:800;
  cursor:pointer;
}

.radar-button:hover{
  background:#1c355c;
}

.coin-list{
  overflow:auto;
  padding:0 10px 10px;
}

.coin{
  width:100%;
  text-align:left;
  background:#0f1723;
  border:1px solid #1c2a3d;
  border-left:3px solid #64748b;
  border-radius:8px;
  padding:10px;
  margin-bottom:8px;
  color:#fff;
  cursor:pointer;
}

.coin.long{
  border-left-color:#00d69a;
}

.coin.short{
  border-left-color:#ff4265;
}

.coin:hover{
  background:#142033;
}

.coin-symbol{
  font-weight:900;
  font-size:13px;
}

.coin-line{
  display:flex;
  justify-content:space-between;
  align-items:center;
  margin-top:5px;
}

.coin-price{
  font-size:14px;
  font-weight:800;
}

.coin-score{
  font-size:10px;
  font-weight:900;
  padding:3px 5px;
  border-radius:4px;
  background:#172338;
}

.coin-detail{
  font-size:9px;
  color:#73859c;
  margin-top:5px;
}

.main{
  min-width:0;
  display:flex;
  flex-direction:column;
}

.topbar{
  height:62px;
  flex:none;
  border-bottom:1px solid #182233;
  display:flex;
  align-items:center;
  justify-content:space-between;
  padding:0 14px;
}

.title{
  font-size:18px;
  font-weight:900;
}

.subtitle{
  font-size:9px;
  color:#6e819a;
  margin-top:4px;
}

.stats{
  display:flex;
  gap:14px;
  font-size:10px;
  color:#8fa0b7;
}

.stats b{
  color:#fff;
}

.chart-controls{
  height:48px;
  flex:none;
  display:flex;
  align-items:center;
  gap:6px;
  padding:0 12px;
  border-bottom:1px solid #182233;
}

.tf{
  background:#101a2a;
  border:1px solid #23344d;
  color:#8ea1b8;
  border-radius:5px;
  padding:7px 11px;
  font-size:10px;
  font-weight:800;
  cursor:pointer;
}

.tf.active{
  background:#173767;
  color:#fff;
  border-color:#2b6dcc;
}

.chart-wrap{
  position:relative;
  flex:1;
  min-height:0;
  background:#070b12;
}

#chart{
  width:100%;
  height:100%;
  display:block;
}

.chart-loading{
  position:absolute;
  left:50%;
  top:50%;
  transform:translate(-50%,-50%);
  color:#63758d;
  font-size:11px;
  pointer-events:none;
}

.right{
  min-width:0;
  border-left:1px solid #182233;
  background:#0a0f17;
  overflow:auto;
  padding:10px;
}

.panel{
  border:1px solid #1b293c;
  background:#0e1621;
  border-radius:9px;
  padding:11px;
  margin-bottom:10px;
}

.panel-title{
  color:#6e819a;
  font-size:9px;
  font-weight:900;
  letter-spacing:.4px;
  margin-bottom:8px;
}

.regime{
  font-size:18px;
  font-weight:900;
}

.regime.up{
  color:#00d69a;
}

.regime.down{
  color:#ff4265;
}

.regime.flat{
  color:#f4c95d;
}

.market-row{
  display:flex;
  justify-content:space-between;
  font-size:9px;
  color:#72859c;
  margin-top:6px;
}

.market-row b{
  color:#dce5ef;
}

.signal-title{
  font-size:14px;
  font-weight:900;
}

.signal-side{
  font-size:11px;
  font-weight:900;
  margin-top:3px;
}

.signal-side.long{
  color:#00d69a;
}

.signal-side.short{
  color:#ff4265;
}

.level-grid{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:6px;
  margin-top:10px;
}

.level{
  background:#0a111b;
  border:1px solid #172334;
  border-radius:6px;
  padding:7px;
}

.level-label{
  color:#62748c;
  font-size:8px;
}

.level-value{
  margin-top:3px;
  font-size:11px;
  font-weight:900;
}

.entry .level-value{
  color:#00d8ff;
}

.stop .level-value{
  color:#ff4265;
}

.tp .level-value{
  color:#00d69a;
}

.signal-info{
  margin-top:9px;
  color:#70839a;
  font-size:9px;
  line-height:1.55;
}

.pending{
  border-left:2px solid #f2c14e;
  background:#0a111b;
  border-radius:5px;
  padding:8px;
  margin-top:6px;
}

.pending-symbol{
  font-size:10px;
  font-weight:900;
}

.pending-text{
  font-size:8px;
  color:#71839a;
  margin-top:3px;
}

.empty{
  color:#5e7188;
  font-size:10px;
  line-height:1.5;
}

.legend{
  position:absolute;
  left:10px;
  top:10px;
  display:flex;
  gap:10px;
  font-size:9px;
  color:#8394aa;
  pointer-events:none;
}

.legend span{
  display:flex;
  align-items:center;
  gap:4px;
}

.dot{
  width:7px;
  height:7px;
  border-radius:50%;
}

.dot.entry{
  background:#00d8ff;
}

.dot.stop{
  background:#ff4265;
}

.dot.tp{
  background:#00d69a;
}

@media(max-width:1050px){

  .app{
    grid-template-columns:205px minmax(0,1fr);
  }

  .right{
    display:none;
  }

}

@media(max-width:700px){

  html,
  body{
    overflow:auto;
  }

  .app{
    height:auto;
    min-height:100vh;
    display:flex;
    flex-direction:column;
  }

  .sidebar{
    width:100%;
    height:auto;
    border-right:0;
    border-bottom:1px solid #182233;
  }

  .logo{
    padding:10px 12px;
    display:flex;
    justify-content:space-between;
    align-items:center;
  }

  .logo-sub{
    margin:0;
  }

  .coin-list{
    display:flex;
    gap:7px;
    overflow-x:auto;
    overflow-y:hidden;
    padding:8px 10px;
  }

  .coin{
    flex:none;
    width:155px;
    margin:0;
  }

  .radar-button{
    margin:7px 10px 0;
  }

  .main{
    height:65vh;
    min-height:450px;
  }

  .topbar{
    height:54px;
  }

  .title{
    font-size:14px;
  }

  .stats{
    gap:6px;
    font-size:8px;
  }

  .chart-controls{
    height:42px;
    overflow-x:auto;
  }

  .tf{
    padding:6px 9px;
  }

  .right{
    display:block;
    border-left:0;
    border-top:1px solid #182233;
    overflow:visible;
  }

}

</style>

</head>

<body>

<div class="app">

  <aside class="sidebar">

    <div class="logo">

      <div>

        <div class="logo-title">
          ⚡ SONNY AI TRADER
        </div>

        <div class="logo-sub">
          V7 • BITGET USDT FUTURES • SCALP ENGINE
        </div>

      </div>

    </div>

    <button
      class="radar-button"
      onclick="scanRadar()"
    >
      RADARI YENİLE
    </button>

    <div
      class="coin-list"
      id="coinList"
    ></div>

  </aside>

  <main class="main">

    <div class="topbar">

      <div>

        <div
          class="title"
          id="chartTitle"
        >
          BTCUSDT • 15M
        </div>

        <div class="subtitle">
          500 RADAR → 150 ADAY → 40 DERİN → 15M BREAKOUT → RETEST → 5M SCALP
        </div>

      </div>

      <div
        class="stats"
        id="stats"
      >
        RADAR 0 • ADAY 0 • DERİN 0 • SİNYAL 0
      </div>

    </div>

    <div class="chart-controls">

      <button class="tf" data-tf="5m">
        5M
      </button>

      <button class="tf active" data-tf="15m">
        15M
      </button>

      <button class="tf" data-tf="1h">
        1H
      </button>

      <button class="tf" data-tf="2h">
        2H
      </button>

      <button class="tf" data-tf="4h">
        4H
      </button>

    </div>

    <div class="chart-wrap">

      <canvas id="chart"></canvas>

      <div
        class="chart-loading"
        id="chartLoading"
      >
        Grafik yükleniyor...
      </div>

      <div class="legend">

        <span>
          <i class="dot entry"></i>
          GİRİŞ
        </span>

        <span>
          <i class="dot stop"></i>
          STOP
        </span>

        <span>
          <i class="dot tp"></i>
          TP
        </span>

      </div>

    </div>

  </main>

  <aside class="right">

    <div class="panel">

      <div class="panel-title">
        GENEL PİYASA
      </div>

      <div
        class="regime flat"
        id="regime"
      >
        YATAY
      </div>

      <div class="market-row">
        <span>BREADTH</span>
        <b id="breadth">50%</b>
      </div>

      <div class="market-row">
        <span>YEŞİL</span>
        <b id="green">0</b>
      </div>

      <div class="market-row">
        <span>KIRMIZI</span>
        <b id="red">0</b>
      </div>

      <div class="market-row">
        <span>ORTALAMA</span>
        <b id="average">0%</b>
      </div>

    </div>

    <div class="panel">

      <div class="panel-title">
        AKTİF SCALP SİNYALİ
      </div>

      <div id="activeSignal">

        <div class="empty">
          Henüz teyit edilmiş scalp sinyali yok.
        </div>

      </div>

    </div>

    <div class="panel">

      <div class="panel-title">
        BEKLEYEN BREAKOUT / RETEST
      </div>

      <div id="pendingList">

        <div class="empty">
          Bekleyen yapı yok.
        </div>

      </div>

    </div>

  </aside>

</div>

<script>

let state = {
  signals: [],
  pending: [],
  selectedSymbol: null
};

let selectedSymbol = null;
let timeframe = '15m';
let chartData = null;

const canvas =
  document.getElementById('chart');

const ctx =
  canvas.getContext('2d');

function escapeHtml(value){

  return String(value ?? '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#039;');

}

function formatPrice(v){

  const n =
    Number(v);

  if(!Number.isFinite(n))
    return '-';

  if(n >= 10000)
    return n.toLocaleString(
      'en-US',
      {maximumFractionDigits:2}
    );

  if(n >= 1000)
    return n.toFixed(3);

  if(n >= 100)
    return n.toFixed(4);

  if(n >= 10)
    return n.toFixed(4);

  if(n >= 1)
    return n.toFixed(5);

  if(n >= .1)
    return n.toFixed(6);

  if(n >= .01)
    return n.toFixed(7);

  return n.toFixed(8);
}

function resizeCanvas(){

  const rect =
    canvas.getBoundingClientRect();

  const dpr =
    window.devicePixelRatio || 1;

  canvas.width =
    Math.floor(
      rect.width * dpr
    );

  canvas.height =
    Math.floor(
      rect.height * dpr
    );

  ctx.setTransform(
    dpr,
    0,
    0,
    dpr,
    0,
    0
  );

  if(chartData)
    drawChart();

}

window.addEventListener(
  'resize',
  resizeCanvas
);

function drawChart(){

  if(!chartData)
    return;

  const rect =
    canvas.getBoundingClientRect();

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

  const candles =
    chartData.candles || [];

  if(!candles.length)
    return;

  const visible =
    candles.slice(-100);

  let min =
    Math.min(
      ...visible.map(c => c.low)
    );

  let max =
    Math.max(
      ...visible.map(c => c.high)
    );

  const signal =
    chartData.signal;

  if(signal){

    const levels = [
      signal.entry,
      signal.stop,
      signal.tp1,
      signal.tp2,
      signal.tp3
    ].filter(
      Number.isFinite
    );

    if(levels.length){

      min =
        Math.min(
          min,
          ...levels
        );

      max =
        Math.max(
          max,
          ...levels
        );
    }
  }

  const range =
    Math.max(
      max - min,
      max * 0.001
    );

  const left = 15;
  const right = 70;
  const top = 25;
  const bottom = 25;

  const chartW =
    width -
    left -
    right;

  const chartH =
    height -
    top -
    bottom;

  function x(i){

    if(visible.length <= 1)
      return left;

    return (
      left +
      (
        i /
        (visible.length - 1)
      ) *
      chartW
    );
  }

  function y(price){

    return (
      top +
      (
        max - price
      ) /
      range *
      chartH
    );
  }

  /*
    Grid
  */

  ctx.font =
    '10px Arial';

  ctx.lineWidth =
    1;

  for(let i=0;i<6;i++){

    const gy =
      top +
      (
        i / 5
      ) *
      chartH;

    ctx.strokeStyle =
      '#111b2a';

    ctx.beginPath();

    ctx.moveTo(
      left,
      gy
    );

    ctx.lineTo(
      width-right,
      gy
    );

    ctx.stroke();

    const price =
      max -
      (
        i / 5
      ) *
      range;

    ctx.fillStyle =
      '#50627a';

    ctx.fillText(
      formatPrice(price),
      width - right + 7,
      gy + 3
    );
  }

  /*
    Candles
  */

  const step =
    chartW /
    Math.max(
      1,
      visible.length
    );

  const bodyW =
    Math.max(
      2,
      Math.min(
        9,
        step * .62
      )
    );

  visible.forEach(
    (c,i)=>{

      const xx =
        x(i);

      const openY =
        y(c.open);

      const closeY =
        y(c.close);

      const highY =
        y(c.high);

      const lowY =
        y(c.low);

      const up =
        c.close >= c.open;

      ctx.strokeStyle =
        up
          ? '#00d69a'
          : '#ff4265';

      ctx.fillStyle =
        up
          ? '#00d69a'
          : '#ff4265';

      /*
        Wick
      */

      ctx.beginPath();

      ctx.moveTo(
        xx,
        highY
      );

      ctx.lineTo(
        xx,
        lowY
      );

      ctx.stroke();

      /*
        Body
      */

      const bodyTop =
        Math.min(
          openY,
          closeY
        );

      const bodyHeight =
        Math.max(
          1,
          Math.abs(
            closeY-openY
          )
        );

      ctx.fillRect(
        xx - bodyW/2,
        bodyTop,
        bodyW,
        bodyHeight
      );

    }
  );

  /*
    Level lines
  */

  if(signal){

    drawLevel(
      signal.entry,
      '#00d8ff',
      'GİRİŞ',
      false
    );

    drawLevel(
      signal.stop,
      '#ff4265',
      'STOP',
      false
    );

    drawLevel(
      signal.tp1,
      '#00d69a',
      'TP1',
      true
    );

    drawLevel(
      signal.tp2,
      '#00d69a',
      'TP2',
      true
    );

    drawLevel(
      signal.tp3,
      '#00d69a',
      'TP3',
      true
    );

  }

  /*
    Breakout level
  */

  if(
    signal &&
    Number.isFinite(
      signal.breakoutLevel
    )
  ){

    drawLevel(
      signal.breakoutLevel,
      '#e0a92e',
      'BREAKOUT',
      true
    );
  }

  function drawLevel(
    price,
    color,
    label,
    dash
  ){

    if(!Number.isFinite(
      Number(price)
    ))
      return;

    const yy =
      y(Number(price));

    ctx.save();

    ctx.strokeStyle =
      color;

    ctx.lineWidth =
      1;

    if(dash)
      ctx.setLineDash([
        6,
        5
      ]);

    ctx.beginPath();

    ctx.moveTo(
      left,
      yy
    );

    ctx.lineTo(
      width-right,
      yy
    );

    ctx.stroke();

    ctx.setLineDash([]);

    ctx.fillStyle =
      color;

    ctx.font =
      'bold 10px Arial';

    ctx.fillText(
      `${label} ${formatPrice(price)}`,
      left + 5,
      yy - 4
    );

    ctx.restore();
  }

  /*
    Current price
  */

  const last =
    visible[
      visible.length - 1
    ];

  if(last){

    const yy =
      y(last.close);

    ctx.strokeStyle =
      '#778ba4';

    ctx.setLineDash([
      3,
      4
    ]);

    ctx.beginPath();

    ctx.moveTo(
      left,
      yy
    );

    ctx.lineTo(
      width-right,
      yy
    );

    ctx.stroke();

    ctx.setLineDash([]);

    ctx.fillStyle =
      '#dce5ef';

    ctx.font =
      'bold 10px Arial';

    ctx.fillText(
      formatPrice(last.close),
      width-right+7,
      yy-4
    );
  }

}

async function loadChart(){

  if(!selectedSymbol)
    return;

  const loading =
    document.getElementById(
      'chartLoading'
    );

  loading.style.display =
    'block';

  try{

    const response =
      await fetch(
        '/api/chart?symbol=' +
        encodeURIComponent(
          selectedSymbol
        ) +
        '&timeframe=' +
        encodeURIComponent(
          timeframe
        )
      );

    chartData =
      await response.json();

    document.getElementById(
      'chartTitle'
    ).innerText =
      `${selectedSymbol} • ${timeframe.toUpperCase()}`;

    loading.style.display =
      'none';

    resizeCanvas();

  }catch(err){

    loading.innerText =
      'Grafik alınamadı';

  }

}

function selectSymbol(
  symbol
){

  selectedSymbol =
    symbol;

  fetch(
    '/api/select?symbol=' +
    encodeURIComponent(
      symbol
    )
  ).catch(()=>{});

  loadChart();
}

function renderCoins(){

  const list =
    document.getElementById(
      'coinList'
    );

  const signals =
    state.signals || [];

  const pending =
    state.pending || [];

  const items = [];

  signals.forEach(
    s=>{
      items.push({
        symbol:s.symbol,
        type:s.type,
        score:s.score,
        price:s.price,
        status:'SİNYAL'
      });
    }
  );

  pending.forEach(
    p=>{

      if(
        items.some(
          x =>
            x.symbol ===
            p.symbol
        )
      )
        return;

      items.push({
        symbol:p.symbol,
        type:p.type,
        score:Math.round(
          45 +
          p.volumeRatio*10
        ),
        price:p.level,
        status:'RETEST'
      });

    }
  );

  if(
    !selectedSymbol &&
    items.length
  ){
    selectedSymbol =
      items[0].symbol;
  }

  if(!items.length){

    list.innerHTML =
      '<div class="empty" style="padding:15px">Henüz sinyal yok.</div>';

    return;
  }

  list.innerHTML =
    items.slice(0,20)
    .map(
      item=>`

      <button
        class="coin ${item.type === 'LONG' ? 'long':'short'}"
        onclick="selectSymbol('${escapeHtml(item.symbol)}')"
      >

        <div class="coin-line">

          <div class="coin-symbol">
            ${escapeHtml(item.symbol)}
          </div>

          <div class="coin-score">
            ${escapeHtml(item.status)}
            • ${item.score}
          </div>

        </div>

        <div class="coin-price">
          ${formatPrice(item.price)}
        </div>

        <div class="coin-detail">
          ${item.type} •
          ${escapeHtml(item.status)}
        </div>

      </button>

      `
    )
    .join('');

}

function renderSignal(){

  const box =
    document.getElementById(
      'activeSignal'
    );

  if(!state.signals.length){

    box.innerHTML =
      '<div class="empty">Henüz teyit edilmiş scalp sinyali yok.</div>';

    return;
  }

  const signal =
    state.signals[0];

  box.innerHTML = `

    <div class="signal-title">
      ${escapeHtml(signal.symbol)}
    </div>

    <div class="signal-side ${signal.type === 'LONG' ? 'long':'short'}">
      ${signal.type}
      • SKOR ${signal.score}/100
    </div>

    <div class="level-grid">

      <div class="level entry">

        <div class="level-label">
          GİRİŞ
        </div>

        <div class="level-value">
          ${formatPrice(signal.entry)}
        </div>

      </div>

      <div class="level stop">

        <div class="level-label">
          STOP
        </div>

        <div class="level-value">
          ${formatPrice(signal.stop)}
        </div>

      </div>

      <div class="level tp">

        <div class="level-label">
          TP1
        </div>

        <div class="level-value">
          ${formatPrice(signal.tp1)}
        </div>

      </div>

      <div class="level tp">

        <div class="level-label">
          TP2
        </div>

        <div class="level-value">
          ${formatPrice(signal.tp2)}
        </div>

      </div>

      <div class="level tp">

        <div class="level-label">
          TP3
        </div>

        <div class="level-value">
          ${formatPrice(signal.tp3)}
        </div>

      </div>

      <div class="level">

        <div class="level-label">
          R:R
        </div>

        <div class="level-value">
          1:${Number(signal.rr).toFixed(2)}
        </div>

      </div>

    </div>

    <div class="signal-info">

      Giriş bölgesi:
      ${formatPrice(signal.entryLow)}
      -
      ${formatPrice(signal.entryHigh)}

      <br>

      4H:
      ${escapeHtml(signal.trend4h)}

      • 2H:
      ${escapeHtml(signal.trend2h)}

      <br>

      15M breakout:
      ${formatPrice(signal.breakoutLevel)}

      <br>

      5M teyit:
      ${signal.confirmScore}/70

      • RSI:
      ${signal.rsi}

      <br>

      Hacim:
      ${signal.volumeRatio}x

    </div>

  `;

  /*
    Aktif sinyalin grafiğini aç
  */

  if(
    selectedSymbol !==
    signal.symbol
  ){

    selectedSymbol =
      signal.symbol;

    loadChart();
  }

}

function renderPending(){

  const box =
    document.getElementById(
      'pendingList'
    );

  if(!state.pending.length){

    box.innerHTML =
      '<div class="empty">Bekleyen breakout/retest yok.</div>';

    return;
  }

  box.innerHTML =
    state.pending
      .slice(0,12)
      .map(
        p=>`

        <div
          class="pending"
          onclick="selectSymbol('${escapeHtml(p.symbol)}')"
          style="cursor:pointer"
        >

          <div class="pending-symbol">

            ${escapeHtml(p.symbol)}
            ${escapeHtml(p.type)}

          </div>

          <div class="pending-text">

            Seviye:
            ${formatPrice(p.level)}

            • Hacim:
            ${p.volumeRatio}x

            • ${escapeHtml(p.status)}

          </div>

        </div>

        `
      )
      .join('');

}

function updateState(data){

  state =
    data || state;

  const stats =
    document.getElementById(
      'stats'
    );

  stats.innerText =
    `RADAR ${data.stats.scanned} • ` +
    `ADAY ${data.stats.candidates} • ` +
    `DERİN ${data.stats.deep} • ` +
    `SİNYAL ${data.stats.activeSignalsCount}`;

  const market =
    data.market || {};

  const regime =
    document.getElementById(
      'regime'
    );

  regime.innerText =
    market.regime ||
    'YATAY';

  regime.className =
    'regime ' +
    (
      String(
        market.regime || ''
      ).includes('YÜKSEL')
        ? 'up'
        :
      String(
        market.regime || ''
      ).includes('DÜŞ')
        ? 'down'
        : 'flat'
    );

  document.getElementById(
    'breadth'
  ).innerText =
    `${market.breadth || 50}%`;

  document.getElementById(
    'green'
  ).innerText =
    market.green || 0;

  document.getElementById(
    'red'
  ).innerText =
    market.red || 0;

  document.getElementById(
    'average'
  ).innerText =
    `${Number(
      market.averageChange || 0
    ).toFixed(2)}%`;

  renderCoins();

  renderSignal();

  renderPending();

  /*
    İlk seçim
  */

  if(
    !selectedSymbol &&
    data.selectedSymbol
  ){

    selectedSymbol =
      data.selectedSymbol;

    loadChart();
  }

}

async function scanRadar(){

  try{

    await fetch(
      '/api/scan',
      {
        method:'POST'
      }
    );

  }catch(e){}

}

document
  .querySelectorAll('.tf')
  .forEach(
    button=>{

      button.addEventListener(
        'click',
        ()=>{

          document
            .querySelectorAll(
              '.tf'
            )
            .forEach(
              x =>
                x.classList.remove(
                  'active'
                )
            );

          button.classList.add(
            'active'
          );

          timeframe =
            button.dataset.tf;

          loadChart();

        }
      );

    }
  );

/*
============================================================
WEBSOCKET
============================================================
*/

let ws;

function connectWS(){

  const protocol =
    location.protocol ===
    'https:'
      ? 'wss:'
      : 'ws:';

  ws =
    new WebSocket(
      `${protocol}//${location.host}`
    );

  ws.onmessage =
    event=>{

      try{

        const data =
          JSON.parse(
            event.data
          );

        updateState(
          data
        );

      }catch(e){}

    };

  ws.onclose =
    ()=>{
      setTimeout(
        connectWS,
        2000
      );
    };

}

connectWS();

/*
  İlk REST durumunu al.
*/

fetch('/api/status')
  .then(
    r=>r.json()
  )
  .then(
    data=>{
      updateState(data);

      if(
        !selectedSymbol
      ){

        selectedSymbol =
          data.selectedSymbol ||
          (
            data.signals &&
            data.signals[0] &&
            data.signals[0].symbol
          ) ||
          'BTCUSDT';
      }

      loadChart();
    }
  )
  .catch(
    ()=>{
      selectedSymbol =
        'BTCUSDT';

      loadChart();
    }
  );

/*
  Grafik 10 saniyede bir güncellensin.
*/

setInterval(
  ()=>{
    if(selectedSymbol)
      loadChart();
  },
  10000
);

</script>

</body>

</html>`;

/*
============================================================
ROOT
============================================================
*/

app.get(
  '/',
  (req, res) => {

    res
      .type('html')
      .send(HTML);
  }
);

/*
============================================================
HEALTH
============================================================
*/

app.get(
  '/health',
  (req, res) => {

    res.json({

      ok: true,

      service:
        'SONNY AI TRADER V7',

      time:
        Date.now(),

      radar:
        STATE.universe.length,

      candidates:
        STATE.candidates.length,

      deep:
        STATE.deep.length,

      signals:
        STATE.signals.length
    });
  }
);

/*
============================================================
START
============================================================
*/

server.listen(
  PORT,
  '0.0.0.0',
  async () => {

    console.log('');
    console.log(
      '=============================================='
    );

    console.log(
      '🚀 SONNY AI TRADER V7'
    );

    console.log(
      '📡 Bitget USDT Futures'
    );

    console.log(
      `🛰️ Radar: ${CFG.RADAR_LIMIT} Coin`
    );

    console.log(
      `🎯 Candidate: ${CFG.CANDIDATE_LIMIT}`
    );

    console.log(
      `🔬 Deep: ${CFG.DEEP_LIMIT}`
    );

    console.log(
      '📊 4H + 2H → 15M Breakout → Retest → 5M'
    );

    console.log(
      `💰 Minimum Volume: $${CFG.MIN_TURNOVER_24H}`
    );

    console.log(
      `🎯 Minimum R:R: 1:${CFG.MIN_RR}`
    );

    console.log(
      '⏱️ Scan: 60 sec'
    );

    console.log(
      '🤖 Auto Trade: KAPALI'
    );

    console.log(
      `🌐 Port: ${PORT}`
    );

    console.log(
      '=============================================='
    );

    try {

      await loadMarkets();

    } catch (err) {

      console.error(
        'MARKET LOAD ERROR:',
        err.message
      );
    }

    /*
      İlk radar
    */

    scanRadar();

    /*
      60 saniyede bir radar
    */

    setInterval(
      scanRadar,
      CFG.SCAN_MS
    );

  }
);

/*
============================================================
PROCESS SAFETY
============================================================
*/

process.on(
  'unhandledRejection',
  err => {

    console.error(
      'UNHANDLED REJECTION:',
      err
    );
  }
);

process.on(
  'uncaughtException',
  err => {

    console.error(
      'UNCAUGHT EXCEPTION:',
      err
    );
  }
);
