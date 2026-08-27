const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');

const PORT = Number(process.env.PORT || 10000);

const CFG = {
  RADAR_LIMIT: 500,
  CANDIDATE_LIMIT: 150,
  DEEP_LIMIT: 40,

  SCAN_MS: 60_000,
  CONCURRENCY: 6,
  CANDLE_LIMIT: 180,

  LEVEL_LOOKBACK_4H: 30,
  LEVEL_LOOKBACK_2H: 36,

  LEVEL_TOLERANCE: 0.0018,
  BREAKOUT_BUFFER: 0.0008,

  MIN_BREAKOUT_VOLUME_RATIO: 1.15,
  MAX_BREAKOUT_VOLUME_RATIO: 12,

  RETEST_WINDOW_MIN: 90,
  RETEST_TOLERANCE: 0.0035,
  RETEST_CONFIRM_CLOSE: 0.0005,

  MIN_STOP_PCT: 0.0015,
  MAX_STOP_PCT: 0.012,

  MIN_RR: 1.20,

  TP1_R: 1.20,
  TP2_R: 2.00,
  TP3_R: 3.00,

  SIGNAL_TTL_MIN: 120,
  BREAKOUT_TTL_MIN: 100,

  DUPLICATE_LEVEL_PCT: 0.004,
  LEVEL_COOLDOWN_MIN: 180,

  MIN_24H_QUOTE_VOLUME: 750000,
  MIN_24H_MOVE: 0.008,
  MAX_SPREAD_PCT: 0.008,

  MIN_5M_ATR_PCT: 0.0007,
  MAX_5M_ATR_PCT: 0.035,

  SCORE_SIGNAL: 72,
  SCORE_STRONG: 85,

  EXCLUDE_BASES: new Set([
    'USDT',
    'USDC',
    'BUSD',
    'DAI',
    'TUSD',
    'FDUSD',
    'USD',
    'EUR'
  ]),

  EXCLUDE_WORDS: [
    'UP/',
    'DOWN/',
    'BULL/',
    'BEAR/',
    '3L/',
    '3S/',
    '5L/',
    '5S/'
  ]
};

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const exchange = new ccxt.bitget({
  enableRateLimit: true,
  options: {
    defaultType: 'swap'
  }
});

const STATE = {
  markets: new Map(),

  universe: [],
  candidates: [],
  deep: [],

  signals: new Map(),
  pending: new Map(),
  cooldowns: new Map(),

  candleCache: new Map(),
  metrics: new Map(),

  lastScan: 0,
  scanning: false,

  stats: {
    universe: 0,
    candidates: 0,
    deep: 0,
    analyzed: 0,
    pending: 0,
    signals: 0,

    breadthPct: 50,
    avgMove: 0,

    marketState: 'BEKLENİYOR',
    up: 0,
    down: 0,
    total: 0
  },

  logs: []
};

function now() {
  return Date.now();
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function pct(a, b) {
  return b ? ((a / b) - 1) * 100 : 0;
}

function roundPrice(v) {
  if (!Number.isFinite(v)) return null;

  if (v >= 1000) return Number(v.toFixed(2));
  if (v >= 1) return Number(v.toFixed(4));
  if (v >= 0.01) return Number(v.toFixed(6));

  return Number(v.toFixed(8));
}

function log(msg) {
  const line =
    new Date().toISOString().slice(11, 19) +
    ' ' +
    msg;

  STATE.logs.push(line);

  if (STATE.logs.length > 100) {
    STATE.logs.shift();
  }

  console.log(msg);
}

function symbolForUI(symbol) {
  const m = STATE.markets.get(symbol);

  if (m) {
    return m.base + 'USDT';
  }

  return String(symbol)
    .replace('/USDT:USDT', '')
    .replace('/USDT', '')
    .replace(/[^A-Z0-9]/gi, '')
    .toUpperCase() + 'USDT';
}

function validMarket(m) {
  if (!m) return false;
  if (!m.active) return false;
  if (m.type !== 'swap') return false;

  if (m.quote !== 'USDT') return false;
  if (m.settle !== 'USDT') return false;

  if (!m.base) return false;

  if (CFG.EXCLUDE_BASES.has(m.base)) {
    return false;
  }

  if (
    CFG.EXCLUDE_WORDS.some(word =>
      String(m.symbol).includes(word)
    )
  ) {
    return false;
  }

  if (!m.contract) return false;

  return true;
}

async function mapLimit(items, concurrency, fn) {
  const output = new Array(items.length);

  let index = 0;

  async function worker() {
    while (true) {
      const i = index++;

      if (i >= items.length) {
        return;
      }

      try {
        output[i] = await fn(items[i], i);
      } catch (e) {
        output[i] = null;
      }
    }
  }

  const workers = [];

  for (
    let i = 0;
    i < Math.min(concurrency, items.length);
    i++
  ) {
    workers.push(worker());
  }

  await Promise.all(workers);

  return output;
}

async function loadMarkets() {
  await exchange.loadMarkets(true);

  STATE.markets.clear();

  for (const m of Object.values(exchange.markets)) {
    if (validMarket(m)) {
      STATE.markets.set(m.symbol, m);
    }
  }

  log(
    'MARKETS | Gerçek USDT perpetual=' +
    STATE.markets.size
  );
}

function tickerQuoteVolume(t) {
  return num(
    t.quoteVolume,
    num(t.baseVolume) * num(t.last)
  );
}

/*
  Önce Bitget'teki gerçek USDT perpetual evreni alınır.

  Burada 500 zorla uydurulmaz.
  Bitget o anda 500'den az geçerli USDT perpetual
  döndürüyorsa gerçek sayı kullanılır.

  Önemli:
  150 filtrelemesi bundan SONRA yapılır.
*/
function buildUniverse(tickers) {
  const rows = [];

  for (const [symbol, market] of STATE.markets) {
    const ticker = tickers[symbol];

    if (!ticker) continue;

    const last = num(ticker.last);
    const quoteVolume = tickerQuoteVolume(ticker);

    const change = num(ticker.percentage) / 100;

    const bid = num(ticker.bid);
    const ask = num(ticker.ask);

    let spread = 0;

    if (bid > 0 && ask > 0) {
      spread =
        (ask - bid) /
        ((ask + bid) / 2);
    }

    if (!(last > 0)) continue;
    if (!(quoteVolume > 0)) continue;

    if (spread > CFG.MAX_SPREAD_PCT) {
      continue;
    }

    rows.push({
      symbol,
      base: market.base,
      last,
      quoteVolume,
      move: change,
      spread,
      ticker
    });
  }

  rows.sort((a, b) => {
    const scoreA =
      Math.log10(a.quoteVolume + 1) * 0.65 +
      Math.abs(a.move) * 100 * 0.35;

    const scoreB =
      Math.log10(b.quoteVolume + 1) * 0.65 +
      Math.abs(b.move) * 100 * 0.35;

    return scoreB - scoreA;
  });

  return rows.slice(0, CFG.RADAR_LIMIT);
}

function buildCandidates(universe) {
  return universe
    .filter(item => {
      return (
        item.quoteVolume >= CFG.MIN_24H_QUOTE_VOLUME &&
        Math.abs(item.move) >= CFG.MIN_24H_MOVE
      );
    })
    .sort((a, b) => {
      const scoreA =
        Math.log10(a.quoteVolume + 1) +
        Math.abs(a.move) * 80 -
        a.spread * 100;

      const scoreB =
        Math.log10(b.quoteVolume + 1) +
        Math.abs(b.move) * 80 -
        b.spread * 100;

      return scoreB - scoreA;
    })
    .slice(0, CFG.CANDIDATE_LIMIT);
}

async function fetchOHLCV(
  symbol,
  timeframe,
  limit = CFG.CANDLE_LIMIT
) {
  const key = symbol + '|' + timeframe;

  const cached = STATE.candleCache.get(key);

  if (
    cached &&
    now() - cached.time < 45_000
  ) {
    return cached.data;
  }

  let data;

  try {
    data = await exchange.fetchOHLCV(
      symbol,
      timeframe,
      undefined,
      limit
    );
  } catch (e) {
    /*
      Bitget bazı durumlarda 2H'i desteklemeyebilir.
      1H verisinden 2H oluşturuyoruz.
    */
    if (timeframe === '2h') {
      const oneHour =
        await exchange.fetchOHLCV(
          symbol,
          '1h',
          undefined,
          Math.min(
            limit * 2 + 10,
            400
          )
        );

      data = aggregate(
        oneHour,
        2 * 60 * 60 * 1000
      );
    } else {
      throw e;
    }
  }

  if (
    !Array.isArray(data) ||
    data.length < 30
  ) {
    throw new Error(
      'insufficient candles'
    );
  }

  STATE.candleCache.set(key, {
    time: now(),
    data
  });

  return data;
}

function aggregate(candles, bucketMs) {
  const output = [];

  let bucket = null;
  let row = null;

  for (const c of candles) {
    const currentBucket =
      Math.floor(c[0] / bucketMs) *
      bucketMs;

    if (currentBucket !== bucket) {
      if (row) {
        output.push(row);
      }

      bucket = currentBucket;

      row = [
        currentBucket,
        c[1],
        c[2],
        c[3],
        c[4],
        c[5]
      ];
    } else {
      row[2] = Math.max(
        row[2],
        c[2]
      );

      row[3] = Math.min(
        row[3],
        c[3]
      );

      row[4] = c[4];
      row[5] += c[5];
    }
  }

  if (row) {
    output.push(row);
  }

  return output;
}

function closedCandles(candles) {
  if (
    !candles ||
    candles.length < 4
  ) {
    return [];
  }

  /*
    Son mum halen açık olabilir.
    Sadece kapanmış mumları kullanıyoruz.
  */
  return candles.slice(0, -1);
}

function ema(values, period) {
  if (!values.length) {
    return 0;
  }

  const k = 2 / (period + 1);

  let result = values[0];

  for (let i = 1; i < values.length; i++) {
    result =
      values[i] * k +
      result * (1 - k);
  }

  return result;
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

  for (let i = 1; i <= period; i++) {
    const difference =
      values[i] -
      values[i - 1];

    if (difference >= 0) {
      gain += difference;
    } else {
      loss -= difference;
    }
  }

  gain /= period;
  loss /= period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {
    const difference =
      values[i] -
      values[i - 1];

    const currentGain =
      Math.max(0, difference);

    const currentLoss =
      Math.max(0, -difference);

    gain =
      (gain * (period - 1) +
        currentGain) /
      period;

    loss =
      (loss * (period - 1) +
        currentLoss) /
      period;
  }

  if (loss === 0) {
    return 100;
  }

  return (
    100 -
    100 /
      (1 + gain / loss)
  );
}

function atr(candles, period = 14) {
  if (
    candles.length <
    period + 2
  ) {
    return 0;
  }

  const trueRanges = [];

  for (let i = 1; i < candles.length; i++) {
    const high = candles[i][2];
    const low = candles[i][3];
    const previousClose =
      candles[i - 1][4];

    trueRanges.push(
      Math.max(
        high - low,
        Math.abs(
          high - previousClose
        ),
        Math.abs(
          low - previousClose
        )
      )
    );
  }

  const last =
    trueRanges.slice(-period);

  return (
    last.reduce(
      (sum, value) =>
        sum + value,
      0
    ) / last.length
  );
}

function volumeRatio(
  candles,
  lookback = 20
) {
  const closed =
    closedCandles(candles);

  if (
    closed.length <
    lookback + 2
  ) {
    return 1;
  }

  const last =
    closed[closed.length - 1][5];

  const previous =
    closed
      .slice(
        -lookback - 1,
        -1
      )
      .reduce(
        (sum, candle) =>
          sum + candle[5],
        0
      ) / lookback;

  return previous > 0
    ? last / previous
    : 1;
}

function trendFrom(candles) {
  const closed =
    closedCandles(candles);

  const closes =
    closed.map(c => c[4]);

  const e21 =
    ema(closes, 21);

  const e50 =
    ema(closes, 50);

  const last =
    closes[closes.length - 1];

  const gap =
    e50 !== 0
      ? (e21 - e50) / e50
      : 0;

  if (
    gap > 0.004 &&
    last >= e21
  ) {
    return 'LONG';
  }

  if (
    gap < -0.004 &&
    last <= e21
  ) {
    return 'SHORT';
  }

  return 'NEUTRAL';
}

function levels(candles, lookback) {
  const closed =
    closedCandles(candles);

  const selected =
    closed.slice(-lookback);

  if (!selected.length) {
    return {
      resistance: 0,
      support: 0
    };
  }

  return {
    resistance: Math.max(
      ...selected.map(
        x => x[2]
      )
    ),

    support: Math.min(
      ...selected.map(
        x => x[3]
      )
    )
  };
}

function chooseLevel(
  candles4h,
  candles2h,
  direction
) {
  const l4 = levels(
    candles4h,
    CFG.LEVEL_LOOKBACK_4H
  );

  const l2 = levels(
    candles2h,
    CFG.LEVEL_LOOKBACK_2H
  );

  if (direction === 'LONG') {
    const candidates = [
      {
        value: l2.resistance,
        timeframe: '2H'
      },
      {
        value: l4.resistance,
        timeframe: '4H'
      }
    ]
      .filter(x => x.value > 0)
      .sort(
        (a, b) =>
          a.value - b.value
      );

    return candidates[0] || null;
  }

  const candidates = [
    {
      value: l2.support,
      timeframe: '2H'
    },
    {
      value: l4.support,
      timeframe: '4H'
    }
  ]
    .filter(x => x.value > 0)
    .sort(
      (a, b) =>
        b.value - a.value
    );

  return candidates[0] || null;
}

function breakoutDetected(
  candles15m,
  level,
  direction
) {
  const closed =
    closedCandles(
      candles15m
    );

  if (
    closed.length < 25 ||
    !level ||
    !Number.isFinite(
      level.value
    )
  ) {
    return null;
  }

  const previous =
    closed[closed.length - 2];

  const current =
    closed[closed.length - 1];

  /*
    Çok önemli:
    Breakout hacmi breakout mumundan
    alınır. Retest mumundan değil.
  */
  const volume =
    volumeRatio(candles15m);

  if (
    volume <
      CFG.MIN_BREAKOUT_VOLUME_RATIO
  ) {
    return null;
  }

  if (
    volume >
      CFG.MAX_BREAKOUT_VOLUME_RATIO
  ) {
    /*
      126x gibi anomalileri
      direkt sinyal olarak kabul etmiyoruz.
    */
    return null;
  }

  const range =
    Math.max(
      current[2] -
        current[3],
      current[4] * 0.000001
    );

  const body =
    Math.abs(
      current[4] -
        current[1]
    );

  const bodyRatio =
    body / range;

  /*
    Çok zayıf gövdeli mumları
    breakout kabul etmiyoruz.
  */
  if (bodyRatio < 0.25) {
    return null;
  }

  if (direction === 'LONG') {
    if (
      previous[4] <=
        level.value *
          (1 +
            CFG.LEVEL_TOLERANCE) &&
      current[4] >
        level.value *
          (1 +
            CFG.BREAKOUT_BUFFER)
    ) {
      return {
        candleTs: current[0],
        price: current[4],
        level: level.value,
        timeframe: level.timeframe,
        volumeRatio: volume,
        bodyRatio
      };
    }
  }

  if (direction === 'SHORT') {
    if (
      previous[4] >=
        level.value *
          (1 -
            CFG.LEVEL_TOLERANCE) &&
      current[4] <
        level.value *
          (1 -
            CFG.BREAKOUT_BUFFER)
    ) {
      return {
        candleTs: current[0],
        price: current[4],
        level: level.value,
        timeframe: level.timeframe,
        volumeRatio: volume,
        bodyRatio
      };
    }
  }

  return null;
}

function near(
  a,
  b,
  tolerance =
    CFG.DUPLICATE_LEVEL_PCT
) {
  return (
    Math.abs(a - b) /
      Math.max(
        Math.abs(b),
        1e-12
      ) <= tolerance
  );
}

function keyFor(
  symbol,
  direction,
  level
) {
  return (
    symbol +
    '|' +
    direction +
    '|' +
    level.toFixed(8)
  );
}

function levelCooldownKey(
  symbol,
  level
) {
  return (
    symbol +
    '|' +
    level.toFixed(8)
  );
}

function addPending(
  symbol,
  direction,
  breakout
) {
  const opposite =
    direction === 'LONG'
      ? 'SHORT'
      : 'LONG';

  /*
    Aynı coin için karşı yön
    pending setup varsa onu kaldır.
  */
  for (
    const [key, pending] of
    STATE.pending
  ) {
    if (
      pending.symbol !==
      symbol
    ) {
      continue;
    }

    if (
      pending.direction ===
        opposite &&
      near(
        pending.level,
        breakout.level
      )
    ) {
      STATE.pending.delete(
        key
      );
    }
  }

  /*
    Aynı coin + aynı yön +
    aynı bölge tekrar eklenmez.
  */
  for (
    const pending of
    STATE.pending.values()
  ) {
    if (
      pending.symbol ===
        symbol &&
      pending.direction ===
        direction &&
      near(
        pending.level,
        breakout.level
      )
    ) {
      return false;
    }
  }

  const cooldownKey =
    levelCooldownKey(
      symbol,
      breakout.level
    );

  const cooldown =
    STATE.cooldowns.get(
      cooldownKey
    );

  if (
    cooldown &&
    cooldown > now()
  ) {
    return false;
  }

  const key = keyFor(
    symbol,
    direction,
    breakout.level
  );

  STATE.pending.set(key, {
    key,
    symbol,
    direction,

    level:
      breakout.level,

    timeframeLevel:
      breakout.timeframe,

    breakoutPrice:
      breakout.price,

    breakoutTs:
      breakout.candleTs,

    volumeRatio:
      breakout.volumeRatio,

    bodyRatio:
      breakout.bodyRatio,

    createdAt: now(),

    expiresAt:
      now() +
      CFG.BREAKOUT_TTL_MIN *
        60_000,

    status:
      'RETEST BEKLENİYOR'
  });

  log(
    'BREAKOUT | ' +
      symbolForUI(symbol) +
      ' | ' +
      direction +
      ' | ' +
      roundPrice(
        breakout.level
      ) +
      ' | VOL ' +
      breakout.volumeRatio.toFixed(
        2
      ) +
      'x'
  );

  return true;
}

function retestCheck(
  pending,
  candles15m
) {
  const closed =
    closedCandles(
      candles15m
    ).filter(
      candle =>
        candle[0] >
        pending.breakoutTs
    );

  if (!closed.length) {
    return null;
  }

  /*
    Retest yalnızca breakout'tan
    SONRA oluşan mumlarda aranır.
  */
  const maxAge =
    CFG.RETEST_WINDOW_MIN *
    60_000;

  const valid =
    closed.filter(
      candle =>
        candle[0] -
          pending.breakoutTs <=
        maxAge
    );

  for (const candle of valid) {
    const touched =
      candle[3] <=
        pending.level *
          (1 +
            CFG.RETEST_TOLERANCE) &&
      candle[2] >=
        pending.level *
          (1 -
            CFG.RETEST_TOLERANCE);

    if (!touched) {
      continue;
    }

    if (
      pending.direction ===
        'LONG' &&
      candle[4] >=
        pending.level *
          (1 +
            CFG.RETEST_CONFIRM_CLOSE)
    ) {
      return candle;
    }

    if (
      pending.direction ===
        'SHORT' &&
      candle[4] <=
        pending.level *
          (1 -
            CFG.RETEST_CONFIRM_CLOSE)
    ) {
      return candle;
    }
  }

  return null;
}

function fiveMinuteConfirm(
  candles5m,
  direction
) {
  const closed =
    closedCandles(
      candles5m
    );

  if (closed.length < 25) {
    return {
      ok: false,
      score: 0,
      rsi: 50,
      atrPct: 0
    };
  }

  const closes =
    closed.map(
      x => x[4]
    );

  const e9 =
    ema(closes, 9);

  const e21 =
    ema(closes, 21);

  const currentRsi =
    rsi(closes, 14);

  const currentAtr =
    atr(candles5m, 14);

  const last =
    closed[closed.length - 1];

  const atrPct =
    last[4] > 0
      ? currentAtr / last[4]
      : 0;

  /*
    Aşırı ölü veya aşırı patlamış
    5M piyasa filtrelenir.
  */
  if (
    atrPct <
      CFG.MIN_5M_ATR_PCT ||
    atrPct >
      CFG.MAX_5M_ATR_PCT
  ) {
    return {
      ok: false,
      score: 0,
      rsi: currentRsi,
      atrPct
    };
  }

  let score = 0;

  const range =
    Math.max(
      last[2] -
        last[3],
      last[4] * 0.000001
    );

  if (direction === 'LONG') {
    if (e9 > e21) {
      score += 25;
    }

    if (last[4] > e9) {
      score += 20;
    }

    if (
      currentRsi >= 50 &&
      currentRsi <= 72
    ) {
      score += 20;
    }

    if (
      last[4] >
      last[1]
    ) {
      score += 15;
    }

    if (
      (last[4] - last[3]) /
        range >
      0.55
    ) {
      score += 20;
    }
  }

  if (direction === 'SHORT') {
    if (e9 < e21) {
      score += 25;
    }

    if (last[4] < e9) {
      score += 20;
    }

    if (
      currentRsi >= 28 &&
      currentRsi <= 50
    ) {
      score += 20;
    }

    if (
      last[4] <
      last[1]
    ) {
      score += 15;
    }

    if (
      (last[2] - last[4]) /
        range >
      0.55
    ) {
      score += 20;
    }
  }

  return {
    ok: score >= 45,
    score,
    rsi: currentRsi,
    atrPct
  };
}

function makeSignal(
  pending,
  candles15m,
  candles5m,
  trend4h,
  trend2h
) {
  const confirmation =
    fiveMinuteConfirm(
      candles5m,
      pending.direction
    );

  if (!confirmation.ok) {
    return null;
  }

  const closed =
    closedCandles(
      candles5m
    );

  const last =
    closed[closed.length - 1];

  const currentAtr =
    atr(candles5m, 14);

  let stop;

  if (
    pending.direction ===
    'LONG'
  ) {
    const swingLow =
      Math.min(
        ...closed
          .slice(-6)
          .map(
            candle =>
              candle[3]
          )
      );

    stop = Math.min(
      swingLow,
      pending.level -
        currentAtr * 0.35
    );
  } else {
    const swingHigh =
      Math.max(
        ...closed
          .slice(-6)
          .map(
            candle =>
              candle[2]
          )
      );

    stop = Math.max(
      swingHigh,
      pending.level +
        currentAtr * 0.35
    );
  }

  const entry =
    last[4];

  const risk =
    pending.direction ===
    'LONG'
      ? entry - stop
      : stop - entry;

  const riskPct =
    risk / entry;

  if (!(risk > 0)) {
    return null;
  }

  if (
    riskPct <
      CFG.MIN_STOP_PCT ||
    riskPct >
      CFG.MAX_STOP_PCT
  ) {
    return null;
  }

  const tp1 =
    pending.direction ===
    'LONG'
      ? entry +
        risk * CFG.TP1_R
      : entry -
        risk * CFG.TP1_R;

  const tp2 =
    pending.direction ===
    'LONG'
      ? entry +
        risk * CFG.TP2_R
      : entry -
        risk * CFG.TP2_R;

  const tp3 =
    pending.direction ===
    'LONG'
      ? entry +
        risk * CFG.TP3_R
      : entry -
        risk * CFG.TP3_R;

  const rr1 =
    Math.abs(
      tp1 - entry
    ) / risk;

  if (
    rr1 <
    CFG.MIN_RR
  ) {
    return null;
  }

  let score =
    confirmation.score;

  /*
    4H ana trend uyumu.
  */
  if (
    (
      pending.direction ===
        'LONG' &&
      trend4h === 'LONG'
    ) ||
    (
      pending.direction ===
        'SHORT' &&
      trend4h === 'SHORT'
    )
  ) {
    score += 20;
  }

  /*
    2H ters yönde değilse
    ekstra puan.
  */
  if (
    (
      pending.direction ===
        'LONG' &&
      trend2h !== 'SHORT'
    ) ||
    (
      pending.direction ===
        'SHORT' &&
      trend2h !== 'LONG'
    )
  ) {
    score += 10;
  }

  /*
    Breakout hacmi güçlü ise
    ekstra puan.
  */
  if (
    pending.volumeRatio >= 1.5
  ) {
    score += 5;
  }

  score = clamp(
    Math.round(score),
    0,
    100
  );

  return {
    id:
      pending.key +
      '|' +
      Date.now(),

    symbol:
      pending.symbol,

    symbolUi:
      symbolForUI(
        pending.symbol
      ),

    type:
      pending.direction,

    status:
      'GİRİŞ HAZIR',

    score,

    entry,

    entryZone: [
      entry * 0.9985,
      entry * 1.0015
    ],

    stopLoss: stop,

    tp1,
    tp2,
    tp3,

    rr: rr1,

    rsi:
      confirmation.rsi,

    atrPct:
      confirmation.atrPct *
      100,

    timeframeLevel:
      pending.timeframeLevel,

    level:
      pending.level,

    breakoutPrice:
      pending.breakoutPrice,

    volumeRatio:
      pending.volumeRatio,

    createdAt:
      now(),

    expiresAt:
      now() +
      CFG.SIGNAL_TTL_MIN *
        60_000,

    note:
      '4H/2H seviye + 15M kırılım + retest + 5M scalp teyidi'
  };
}

async function analyzeCandidate(
  item
) {
  const symbol =
    item.symbol;

  try {
    const candles15 =
      await fetchOHLCV(
        symbol,
        '15m'
      );

    const candles5 =
      await fetchOHLCV(
        symbol,
        '5m'
      );

    const candles4 =
      await fetchOHLCV(
        symbol,
        '4h'
      );

    const candles2 =
      await fetchOHLCV(
        symbol,
        '2h'
      );

    const trend4 =
      trendFrom(
        candles4
      );

    const trend2 =
      trendFrom(
        candles2
      );

    const longLevel =
      chooseLevel(
        candles4,
        candles2,
        'LONG'
      );

    const shortLevel =
      chooseLevel(
        candles4,
        candles2,
        'SHORT'
      );

    /*
      Yalnızca yeni kapanmış 15M mumda
      yeni breakout aranır.
    */
    const closed15 =
      closedCandles(
        candles15
      );

    const latestTs =
      closed15.length
        ? closed15[
            closed15.length - 1
          ][0]
        : 0;

    const metricKey =
      symbol +
      '|15m|processed';

    const previousTs =
      STATE.metrics.get(
        metricKey
      );

    const isNew15m =
      previousTs !==
      latestTs;

    if (isNew15m) {
      STATE.metrics.set(
        metricKey,
        latestTs
      );

      /*
        4H SHORT ise LONG breakout
        doğrudan reddedilmiyor.
        Böylece altcoinlerde dönüş/fırsat
        tamamen kaçırılmıyor.

        Fakat 4H ters yön setup
        skor avantajını kaybediyor.
      */

      if (longLevel) {
        const breakout =
          breakoutDetected(
            candles15,
            longLevel,
            'LONG'
          );

        if (breakout) {
          addPending(
            symbol,
            'LONG',
            breakout
          );
        }
      }

      if (shortLevel) {
        const breakout =
          breakoutDetected(
            candles15,
            shortLevel,
            'SHORT'
          );

        if (breakout) {
          addPending(
            symbol,
            'SHORT',
            breakout
          );
        }
      }
    }

    /*
      Tüm pending setup'ları
      kendi breakout zamanından itibaren
      retest için kontrol et.
    */
    for (
      const [key, pending] of
      [...STATE.pending]
    ) {
      if (
        pending.symbol !==
        symbol
      ) {
        continue;
      }

      if (
        pending.expiresAt <
        now()
      ) {
        STATE.pending.delete(
          key
        );

        continue;
      }

      const retest =
        retestCheck(
          pending,
          candles15
        );

      if (!retest) {
        continue;
      }

      const signal =
        makeSignal(
          pending,
          candles15,
          candles5,
          trend4,
          trend2
        );

      if (
        signal &&
        signal.score >=
          CFG.SCORE_SIGNAL
      ) {
        /*
          Aynı coin için zaten
          aynı yönde aktif sinyal varsa
          yeni sinyal açma.
        */
        const duplicate =
          [...STATE.signals.values()]
            .some(
              existing =>
                existing.symbol ===
                  symbol &&
                existing.type ===
                  signal.type &&
                existing.expiresAt >
                  now()
            );

        if (duplicate) {
          STATE.pending.delete(
            key
          );

          continue;
        }

        STATE.signals.set(
          signal.id,
          signal
        );

        STATE.cooldowns.set(
          levelCooldownKey(
            symbol,
            pending.level
          ),
          now() +
            CFG.LEVEL_COOLDOWN_MIN *
              60_000
        );

        STATE.pending.delete(
          key
        );

        log(
          'SIGNAL | ' +
            signal.symbolUi +
            ' | ' +
            signal.type +
            ' | SCORE ' +
            signal.score +
            ' | 1:' +
            signal.rr.toFixed(2)
        );
      }
    }

    return {
      symbol,
      ok: true,
      trend4,
      trend2
    };
  } catch (e) {
    return {
      symbol,
      ok: false,
      error: e.message
    };
  }
}

function cleanup() {
  const current =
    now();

  for (
    const [key, pending] of
    STATE.pending
  ) {
    if (
      pending.expiresAt <
      current
    ) {
      STATE.pending.delete(
        key
      );
    }
  }

  for (
    const [key, signal] of
    STATE.signals
  ) {
    if (
      signal.expiresAt <
      current
    ) {
      STATE.signals.delete(
        key
      );
    }
  }

  for (
    const [key, expiration] of
    STATE.cooldowns
  ) {
    if (
      expiration <
      current
    ) {
      STATE.cooldowns.delete(
        key
      );
    }
  }

  if (
    STATE.candleCache.size >
    2500
  ) {
    for (
      const [key, value] of
      STATE.candleCache
    ) {
      if (
        current -
          value.time >
        300_000
      ) {
        STATE.candleCache.delete(
          key
        );
      }
    }
  }
}

function marketSummary(
  universe
) {
  const active =
    universe.filter(
      item =>
        item.quoteVolume >=
        CFG.MIN_24H_QUOTE_VOLUME
    );

  const up =
    active.filter(
      item => item.move > 0
    ).length;

  const down =
    active.filter(
      item => item.move < 0
    ).length;

  const breadth =
    active.length
      ? (up / active.length) *
        100
      : 50;

  const average =
    active.length
      ? active.reduce(
          (sum, item) =>
            sum + item.move,
          0
        ) /
        active.length *
        100
      : 0;

  let marketState =
    'YATAY / KARIŞIK';

  /*
    Sadece breadth veya sadece
    ortalama hareket kullanmıyoruz.
  */
  if (
    breadth >= 65 &&
    average >= 0.6
  ) {
    marketState =
      'YÜKSELİŞ';
  } else if (
    breadth <= 35 &&
    average <= -0.6
  ) {
    marketState =
      'DÜŞÜŞ';
  }

  return {
    breadthPct:
      Math.round(breadth),

    avgMove:
      average,

    marketState,

    up,
    down,

    total:
      active.length
  };
}

async function scan() {
  if (STATE.scanning) {
    return;
  }

  STATE.scanning = true;

  try {
    cleanup();

    if (
      !STATE.markets.size ||
      now() -
        STATE.lastScan >
        15 * 60_000
    ) {
      await loadMarkets();
    }

    /*
      Tüm ticker'lar tek istekte.
    */
    const tickers =
      await exchange.fetchTickers();

    /*
      GERÇEK ilk radar.
    */
    STATE.universe =
      buildUniverse(
        tickers
      );

    STATE.stats.universe =
      STATE.universe.length;

    /*
      Gerçek piyasa breadth.
    */
    const market =
      marketSummary(
        STATE.universe
      );

    STATE.stats = {
      ...STATE.stats,
      ...market
    };

    /*
      500 -> 150
    */
    STATE.candidates =
      buildCandidates(
        STATE.universe
      );

    STATE.stats.candidates =
      STATE.candidates.length;

    /*
      150 adaydan 15M hızlı metrik alınır.
      Sonra en aktif 40 deep analize gider.
    */
    const quick =
      await mapLimit(
        STATE.candidates,
        CFG.CONCURRENCY,
        async item => {
          try {
            const candles =
              await fetchOHLCV(
                item.symbol,
                '15m'
              );

            const closed =
              closedCandles(
                candles
              );

            const last =
              closed[
                closed.length - 1
              ];

            if (!last) {
              return null;
            }

            const currentAtr =
              atr(
                candles,
                14
              );

            const volume =
              volumeRatio(
                candles
              );

            const atrPct =
              last[4] > 0
                ? currentAtr /
                  last[4]
                : 0;

            const reference =
              closed[
                Math.max(
                  0,
                  closed.length - 5
                )
              ];

            const momentum =
              reference
                ? Math.abs(
                    pct(
                      last[4],
                      reference[4]
                    )
                  )
                : 0;

            return {
              ...item,

              atrPct,

              momentum,

              volumeRatio:
                volume
            };
          } catch (e) {
            return null;
          }
        }
      );

    /*
      150 -> 40
    */
    STATE.deep =
      quick
        .filter(Boolean)
        .sort((a, b) => {
          const scoreA =
            (b.volumeRatio || 1) *
              2 +
            (b.momentum || 0) *
              3 +
            Math.abs(b.move) *
              50;

          const scoreB =
            (a.volumeRatio || 1) *
              2 +
            (a.momentum || 0) *
              3 +
            Math.abs(a.move) *
              50;

          return (
            scoreA - scoreB
          );
        })
        .slice(
          0,
          CFG.DEEP_LIMIT
        );

    STATE.stats.deep =
      STATE.deep.length;

    /*
      40 deep analysis.
    */
    const results =
      await mapLimit(
        STATE.deep,
        CFG.CONCURRENCY,
        analyzeCandidate
      );

    STATE.stats.analyzed =
      results.filter(
        item =>
          item &&
          item.ok
      ).length;

    STATE.stats.pending =
      STATE.pending.size;

    STATE.stats.signals =
      STATE.signals.size;

    STATE.lastScan =
      now();

    log(
      'RADAR tamamlandı | Universe=' +
        STATE.stats.universe +
        ' | Candidates=' +
        STATE.stats.candidates +
        ' | Deep=' +
        STATE.stats.deep +
        ' | Analiz=' +
        STATE.stats.analyzed +
        ' | Pending=' +
        STATE.stats.pending +
        ' | SIGNAL=' +
        STATE.stats.signals
    );

    broadcast();
  } catch (e) {
    log(
      'SCAN ERROR | ' +
        e.message
    );

    broadcast();
  } finally {
    STATE.scanning = false;
  }
}

function signalArray() {
  return [
    ...STATE.signals.values()
  ]
    .sort(
      (a, b) =>
        b.score - a.score
    )
    .map(signal => ({
      ...signal,

      entry:
        roundPrice(
          signal.entry
        ),

      entryZone:
        signal.entryZone.map(
          roundPrice
        ),

      stopLoss:
        roundPrice(
          signal.stopLoss
        ),

      tp1:
        roundPrice(
          signal.tp1
        ),

      tp2:
        roundPrice(
          signal.tp2
        ),

      tp3:
        roundPrice(
          signal.tp3
        ),

      level:
        roundPrice(
          signal.level
        ),

      breakoutPrice:
        roundPrice(
          signal.breakoutPrice
        )
    }));
}

function pendingArray() {
  return [
    ...STATE.pending.values()
  ]
    .sort(
      (a, b) =>
        b.createdAt -
        a.createdAt
    )
    .slice(0, 40)
    .map(pending => ({
      ...pending,

      symbolUi:
        symbolForUI(
          pending.symbol
        ),

      level:
        roundPrice(
          pending.level
        ),

      breakoutPrice:
        roundPrice(
          pending.breakoutPrice
        )
    }));
}

async function chartPayload(
  symbol,
  timeframe = '15m'
) {
  const realSymbol =
    [
      ...STATE.markets.keys()
    ].find(
      item =>
        symbolForUI(item) ===
          symbol ||
        item === symbol ||
        item
          .replace(
            '/',
            ''
          )
          .replace(
            ':USDT',
            ''
          ) ===
          symbol
    );

  if (!realSymbol) {
    throw new Error(
      'symbol not found'
    );
  }

  const candles =
    await fetchOHLCV(
      realSymbol,
      timeframe,
      180
    );

  const chartCandles =
    candles.map(
      candle => ({
        time: candle[0],
        open: candle[1],
        high: candle[2],
        low: candle[3],
        close: candle[4],
        volume: candle[5]
      })
    );

  const signal =
    [
      ...STATE.signals.values()
    ].find(
      item =>
        item.symbol ===
        realSymbol
    );

  const pending =
    [
      ...STATE.pending.values()
    ].find(
      item =>
        item.symbol ===
        realSymbol
    );

  return {
    symbol:
      symbolForUI(
        realSymbol
      ),

    timeframe,

    candles:
      chartCandles,

    signal:
      signal || null,

    pending:
      pending || null
  };
}

function payload() {
  return {
    type: 'state',

    now:
      now(),

    stats: {
      ...STATE.stats,

      activeSignalsCount:
        STATE.signals.size
    },

    market: {
      state:
        STATE.stats
          .marketState,

      breadthPct:
        STATE.stats
          .breadthPct,

      avgMove:
        STATE.stats
          .avgMove,

      up:
        STATE.stats.up,

      down:
        STATE.stats.down,

      total:
        STATE.stats.total
    },

    signals:
      signalArray(),

    pending:
      pendingArray(),

    radar:
      STATE.universe
        .slice(0, 500)
        .map(item => ({
          symbol:
            symbolForUI(
              item.symbol
            ),

          price:
            roundPrice(
              item.last
            ),

          volume:
            item.quoteVolume,

          move:
            item.move * 100
        })),

    logs:
      STATE.logs.slice(-30)
  };
}

function broadcast() {
  const message =
    JSON.stringify(
      payload()
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
        message
      );
    }
  }
}

/*
=========================================================
SERVER İÇİ ANA SAYFA
=========================================================
*/

const HTML = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport"
      content="width=device-width,initial-scale=1,viewport-fit=cover">

<title>SONNY AI TRADER V5.3</title>

<style>
* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  width: 100%;
  height: 100%;
}

body {
  background: #070b11;
  color: #e7edf5;
  font-family:
    Arial,
    Helvetica,
    sans-serif;
  overflow: hidden;
}

.app {
  width: 100%;
  height: 100vh;

  display: grid;

  grid-template-columns:
    255px
    minmax(0, 1fr)
    300px;
}

.left,
.right {
  background: #0b111a;
  border-color: #1b2635;
}

.left {
  border-right: 1px solid #1b2635;
  padding: 14px;
  overflow-y: auto;
}

.right {
  border-left: 1px solid #1b2635;
  padding: 12px;
  overflow-y: auto;
}

.main {
  min-width: 0;
  min-height: 0;

  display: flex;
  flex-direction: column;
}

.head {
  height: 72px;

  border-bottom:
    1px solid #1b2635;

  padding:
    14px 18px;

  display: flex;

  align-items: center;

  justify-content:
    space-between;
}

.brand {
  font-size: 18px;
  font-weight: 800;
}

.sub {
  font-size: 10px;
  color: #7f8da3;
  margin-top: 5px;
}

.stats {
  font-size: 11px;
  color: #8b9ab0;
  text-align: right;
}

.toolbar {
  height: 48px;

  display: flex;

  align-items: center;

  gap: 7px;

  padding:
    7px 12px;

  border-bottom:
    1px solid #1b2635;

  overflow-x: auto;
}

.btn {
  background:
    #101a28;

  border:
    1px solid #26344a;

  color:
    #a9b7c9;

  border-radius:
    6px;

  padding:
    6px 9px;

  font-size:
    11px;

  cursor:
    pointer;
}

.btn.active {
  background:
    #18304c;

  color:
    #ffffff;

  border-color:
    #2b74bd;
}

.chartwrap {
  position:
    relative;

  flex: 1;

  min-height: 0;
}

.chart {
  width: 100%;
  height: 100%;
  display: block;
}

.cards {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.card {
  background:
    #0f1723;

  border:
    1px solid #1c2a3c;

  border-left:
    4px solid #64748b;

  border-radius:
    8px;

  padding:
    11px;

  cursor:
    pointer;
}

.card.long {
  border-left-color:
    #12d99b;
}

.card.short {
  border-left-color:
    #ff4768;
}

.row {
  display: flex;

  justify-content:
    space-between;

  gap:
    8px;

  font-size:
    11px;

  margin:
    5px 0;
}

.muted {
  color:
    #718096;
}

.green {
  color:
    #19d99c;
}

.red {
  color:
    #ff526d;
}

.yellow {
  color:
    #f6c453;
}

.titleline {
  font-size:
    13px;

  font-weight:
    800;

  margin-bottom:
    8px;
}

.badge {
  float:
    right;

  font-size:
    10px;

  padding:
    4px 6px;

  border-radius:
    5px;

  background:
    #142235;
}

.box {
  background:
    #0f1723;

  border:
    1px solid #1c2a3c;

  border-radius:
    8px;

  padding:
    11px;

  margin-bottom:
    10px;
}

.box h3 {
  font-size:
    10px;

  color:
    #8391a5;

  margin:
    0 0 9px;
}

.market {
  font-size:
    18px;

  font-weight:
    900;

  margin-bottom:
    8px;
}

.tiny {
  font-size:
    9px;

  color:
    #708096;
}

.pending {
  border-left:
    3px solid #e5b94f;

  padding:
    7px;

  margin:
    5px 0;

  background:
    #0b121c;

  font-size:
    9px;
}

.empty {
  padding:
    25px 8px;

  text-align:
    center;

  color:
    #68778d;

  font-size:
    12px;
}

.price {
  font-size:
    17px;

  font-weight:
    800;

  margin:
    6px 0;
}

.notice {
  position:
    absolute;

  left:
    12px;

  top:
    12px;

  background:
    rgba(11,17,26,.92);

  border:
    1px solid #1b2635;

  padding:
    7px 9px;

  border-radius:
    6px;

  font-size:
    10px;

  color:
    #8b9ab0;

  z-index:
    2;
}

@media(max-width:1000px) {

  .app {
    grid-template-columns:
      210px
      minmax(0,1fr);
  }

  .right {
    display:
      none;
  }
}

@media(max-width:650px) {

  body {
    overflow:
      auto;
  }

  .app {
    height:
      auto;

    min-height:
      100vh;

    display:
      block;
  }

  .left {
    height:
      38vh;

    max-height:
      380px;

    border-right:
      0;

    border-bottom:
      1px solid #1b2635;
  }

  .main {
    height:
      62vh;

    min-height:
      430px;
  }

  .head {
    height:
      62px;

    padding:
      9px 12px;
  }

  .brand {
    font-size:
      15px;
  }

  .stats {
    font-size:
      9px;
  }

  .toolbar {
    height:
      48px;
  }

  .chartwrap {
    height:
      calc(62vh - 110px);

    min-height:
      320px;
  }

  .right {
    display:
      block;

    border-left:
      0;

    border-top:
      1px solid #1b2635;
  }

  .left .cards {
    display:
      grid;

    grid-template-columns:
      1fr 1fr;

    gap:
      7px;
  }

  .card {
    padding:
      9px;
  }

  .row {
    font-size:
      10px;
  }
}
</style>
</head>

<body>

<div class="app">

<aside class="left">

  <div class="brand">
    ⚡ SONNY AI TRADER
  </div>

  <div class="sub">
    V5.3 • 500 RADAR • SCALP ENGINE
  </div>

  <div style="height:12px"></div>

  <div class="row">
    <span class="muted">
      RADAR
    </span>

    <b id="radarCount">
      0
    </b>
  </div>

  <div class="row">
    <span class="muted">
      ADAY
    </span>

    <b id="candCount">
      0
    </b>
  </div>

  <div class="row">
    <span class="muted">
      DERİN
    </span>

    <b id="deepCount">
      0
    </b>
  </div>

  <div style="height:8px"></div>

  <div id="radar"
       class="cards">
  </div>

</aside>

<main class="main">

<header class="head">

  <div>

    <div class="brand">
      SONNY AI TİCARETÇİSİ
    </div>

    <div class="sub">
      4H / 2H YÖN • 15M KIRILIM • RETEST • 5M SCALP TEYİDİ
    </div>

  </div>

  <div class="stats"
       id="topStats">
    Bağlanıyor...
  </div>

</header>

<div class="toolbar">

  <button
    class="btn"
    data-tf="5m">
    5M
  </button>

  <button
    class="btn active"
    data-tf="15m">
    15M
  </button>

  <button
    class="btn"
    data-tf="1h">
    1H
  </button>

  <button
    class="btn"
    data-tf="2h">
    2H
  </button>

  <button
    class="btn"
    data-tf="4h">
    4H
  </button>

  <span style="flex:1"></span>

  <span
    class="tiny"
    id="selected">
    Coin seçmek için soldaki radardan tıkla
  </span>

</div>

<div class="chartwrap">

  <div
    class="notice"
    id="chartNotice">
    Grafik yükleniyor...
  </div>

  <canvas
    id="chart"
    class="chart">
  </canvas>

</div>

</main>

<aside class="right">

<div class="box">

  <h3>
    GENEL PİYASA
  </h3>

  <div
    class="market"
    id="marketState">
    BEKLENİYOR
  </div>

  <div class="row">
    <span class="muted">
      YEŞİL / KIRMIZI
    </span>

    <b id="breadth">
      -
    </b>
  </div>

  <div class="row">
    <span class="muted">
      ORTALAMA
    </span>

    <b id="avg">
      -
    </b>
  </div>

</div>

<div class="box">

  <h3>
    AKTİF SCALP SİNYALLERİ
  </h3>

  <div
    id="signals"
    class="cards">
  </div>

</div>

<div class="box">

  <h3>
    BEKLEYEN KIRILIM / RETEST
  </h3>

  <div id="pending">
  </div>

</div>

</aside>

</div>

<script>

var ws = null;

var state = null;

var selected = null;

var timeframe = '15m';

var chartCanvas =
  document.getElementById(
    'chart'
  );

var chartContext =
  chartCanvas.getContext(
    '2d'
  );

function connect() {

  var protocol =
    location.protocol ===
    'https:'
      ? 'wss:'
      : 'ws:';

  ws =
    new WebSocket(
      protocol +
      '//' +
      location.host
    );

  ws.onmessage =
    function(event) {

      try {

        state =
          JSON.parse(
            event.data
          );

        render();

      } catch (e) {
        console.error(e);
      }
    };

  ws.onclose =
    function() {

      setTimeout(
        connect,
        2000
      );

    };
}

function esc(value) {

  return String(
    value == null
      ? ''
      : value
  ).replace(
    /[&<>\"']/g,
    function(c) {

      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '\"': '&quot;',
        \"'\": '&#39;'
      }[c];

    }
  );
}

function money(value) {

  var n =
    Number(value);

  if (!isFinite(n)) {
    return '-';
  }

  if (n >= 1000) {
    return n.toFixed(2);
  }

  if (n >= 1) {
    return n.toFixed(4);
  }

  if (n >= 0.01) {
    return n.toFixed(6);
  }

  return n.toFixed(8);
}

function render() {

  if (!state) {
    return;
  }

  var stats =
    state.stats;

  document.getElementById(
    'radarCount'
  ).textContent =
    stats.universe;

  document.getElementById(
    'candCount'
  ).textContent =
    stats.candidates;

  document.getElementById(
    'deepCount'
  ).textContent =
    stats.deep;

  document.getElementById(
    'topStats'
  ).textContent =
    'Radar ' +
    stats.universe +
    ' • Aday ' +
    stats.candidates +
    ' • Derin ' +
    stats.deep +
    ' • Sinyal ' +
    stats.activeSignalsCount;

  document.getElementById(
    'marketState'
  ).textContent =
    state.market.state;

  document.getElementById(
    'breadth'
  ).textContent =
    state.market.breadthPct +
    '%';

  document.getElementById(
    'avg'
  ).textContent =
    Number(
      state.market.avgMove || 0
    ).toFixed(2) +
    '%';

  var radar =
    document.getElementById(
      'radar'
    );

  radar.innerHTML =
    state.radar
      .slice(0, 80)
      .map(
        function(item) {

          var cls =
            item.move >= 0
              ? 'long'
              : 'short';

          return (
            '<div class="card ' +
            cls +
            '" data-symbol="' +
            esc(item.symbol) +
            '">' +

            '<div class="titleline">' +
            esc(item.symbol) +

            '<span class="badge">' +
            (
              item.move >= 0
                ? '+'
                : ''
            ) +

            Number(
              item.move
            ).toFixed(2) +

            '%</span>' +

            '</div>' +

            '<div class="price">' +
            money(item.price) +
            '</div>' +

            '<div class="row">' +

            '<span class="muted">' +
            '24H HACİM' +
            '</span>' +

            '<span>' +
            Math.round(
              item.volume /
              1000000
            ) +
            'M' +
            '</span>' +

            '</div>' +

            '</div>'
          );

        }
      )
      .join('');

  Array.from(
    radar.children
  ).forEach(
    function(element) {

      element.onclick =
        function() {

          selected =
            element.getAttribute(
              'data-symbol'
            );

          loadChart();
        };

    }
  );

  var signals =
    document.getElementById(
      'signals'
    );

  if (
    state.signals.length
  ) {

    signals.innerHTML =
      state.signals
        .map(
          function(signal) {

            return (
              '<div class="card ' +
              signal.type.toLowerCase() +
              '" data-symbol="' +
              esc(
                signal.symbolUi
              ) +
              '">' +

              '<div class="titleline">' +

              esc(
                signal.symbolUi
              ) +

              '<span class="badge">' +
              signal.type +
              ' • ' +
              signal.score +
              '</span>' +

              '</div>' +

              '<div class="price">' +
              money(
                signal.entry
              ) +
              '</div>' +

              '<div class="row">' +

              '<span class="muted">' +
              'Giriş' +
              '</span>' +

              '<span class="green">' +
              money(
                signal.entry
              ) +
              '</span>' +

              '</div>' +

              '<div class="row">' +

              '<span class="muted">' +
              'SL' +
              '</span>' +

              '<span class="red">' +
              money(
                signal.stopLoss
              ) +
              '</span>' +

              '</div>' +

              '<div class="row">' +

              '<span class="muted">' +
              'TP1 / TP2 / TP3' +
              '</span>' +

              '<span class="green">' +
              money(
                signal.tp1
              ) +
              ' / ' +
              money(
                signal.tp2
              ) +
              ' / ' +
              money(
                signal.tp3
              ) +

              '</span>' +

              '</div>' +

              '<div class="row">' +

              '<span class="muted">' +
              'R:R • RSI' +
              '</span>' +

              '<span>' +
              '1:' +
              Number(
                signal.rr
              ).toFixed(2) +
              ' • ' +
              Number(
                signal.rsi
              ).toFixed(1) +

              '</span>' +

              '</div>' +

              '</div>'
            );

          }
        )
        .join('');

  } else {

    signals.innerHTML =
      '<div class="empty">' +
      'Şu anda teyit edilmiş scalp sinyali yok.' +
      '</div>';
  }

  Array.from(
    signals.children
  ).forEach(
    function(element) {

      element.onclick =
        function() {

          selected =
            element.getAttribute(
              'data-symbol'
            );

          loadChart();

        };

    }
  );

  var pending =
    document.getElementById(
      'pending'
    );

  if (
    state.pending.length
  ) {

    pending.innerHTML =
      state.pending
        .slice(0, 15)
        .map(
          function(item) {

            return (
              '<div class="pending">' +

              '<b>' +
              esc(
                item.symbolUi
              ) +
              ' ' +
              esc(
                item.direction
              ) +
              '</b>' +

              '<br>' +

              'Seviye ' +
              money(
                item.level
              ) +
              ' • ' +
              esc(
                item.timeframeLevel
              ) +

              '<br>' +

              esc(
                item.status
              ) +

              ' • VOL ' +
              Number(
                item.volumeRatio
              ).toFixed(2) +
              'x' +

              '</div>'
            );

          }
        )
        .join('');

  } else {

    pending.innerHTML =
      '<div class="empty">' +
      'Bekleyen retest yok.' +
      '</div>';

  }

  /*
    İlk açılışta sinyal varsa onu göster.
    Yoksa radarın ilk gerçek coinini göster.
  */
  if (
    !selected &&
    state.signals.length
  ) {
    selected =
      state.signals[0]
        .symbolUi;
  }

  if (
    !selected &&
    state.radar.length
  ) {
    selected =
      state.radar[0]
        .symbol;
  }

  if (selected) {
    loadChart();
  }
}

function loadChart() {

  if (!selected) {
    return;
  }

  document.getElementById(
    'selected'
  ).textContent =
    selected +
    ' • ' +
    timeframe;

  fetch(
    '/api/chart?symbol=' +
    encodeURIComponent(
      selected
    ) +
    '&timeframe=' +
    encodeURIComponent(
      timeframe
    )
  )
    .then(
      function(response) {
        return response.json();
      }
    )
    .then(
      function(data) {

        if (data.error) {
          throw new Error(
            data.error
          );
        }

        drawChart(data);

        document.getElementById(
          'chartNotice'
        ).textContent =
          selected +
          ' • ' +
          timeframe;

      }
    )
    .catch(
      function() {

        document.getElementById(
          'chartNotice'
        ).textContent =
          'Grafik verisi bekleniyor';

      }
    );
}

function resizeCanvas() {

  var rect =
    chartCanvas.getBoundingClientRect();

  var ratio =
    window.devicePixelRatio ||
    1;

  chartCanvas.width =
    Math.max(
      1,
      Math.floor(
        rect.width *
        ratio
      )
    );

  chartCanvas.height =
    Math.max(
      1,
      Math.floor(
        rect.height *
        ratio
      )
    );

  chartContext.setTransform(
    ratio,
    0,
    0,
    ratio,
    0,
    0
  );
}

function drawChart(data) {

  resizeCanvas();

  var width =
    chartCanvas.clientWidth;

  var height =
    chartCanvas.clientHeight;

  chartContext.clearRect(
    0,
    0,
    width,
    height
  );

  var candles =
    data.candles || [];

  if (
    candles.length < 2
  ) {
    return;
  }

  var padding = {
    left: 45,
    right: 75,
    top: 18,
    bottom: 28
  };

  var chartWidth =
    width -
    padding.left -
    padding.right;

  var chartHeight =
    height -
    padding.top -
    padding.bottom;

  var minPrice =
    Math.min.apply(
      null,
      candles.map(
        x => x.low
      )
    );

  var maxPrice =
    Math.max.apply(
      null,
      candles.map(
        x => x.high
      )
    );

  var extra =
    (maxPrice -
      minPrice) *
    0.08;

  minPrice -= extra;
  maxPrice += extra;

  function X(index) {

    return (
      padding.left +
      (
        index /
        (candles.length - 1)
      ) *
      chartWidth
    );

  }

  function Y(price) {

    return (
      padding.top +
      (
        maxPrice -
        price
      ) /
      (
        maxPrice -
        minPrice
      ) *
      chartHeight
    );

  }

  /*
    Grid
  */

  chartContext.strokeStyle =
    '#162131';

  chartContext.lineWidth =
    1;

  for (
    var i = 0;
    i < 6;
    i++
  ) {

    var y =
      padding.top +
      (
        i / 5
      ) *
      chartHeight;

    chartContext.beginPath();

    chartContext.moveTo(
      padding.left,
      y
    );

    chartContext.lineTo(
      width -
      padding.right,
      y
    );

    chartContext.stroke();

    chartContext.fillStyle =
      '#607086';

    chartContext.font =
      '10px Arial';

    chartContext.fillText(
      money(
        maxPrice -
        (
          maxPrice -
          minPrice
        ) *
        (i / 5)
      ),
      4,
      y + 3
    );
  }

  var candleWidth =
    Math.max(
      2,
      (
        chartWidth /
        candles.length
      ) *
      0.72
    );

  /*
    Candles
  */

  candles.forEach(
    function(candle, index) {

      var x =
        X(index);

      var open =
        Y(candle.open);

      var close =
        Y(candle.close);

      var high =
        Y(candle.high);

      var low =
        Y(candle.low);

      var bullish =
        candle.close >=
        candle.open;

      chartContext.strokeStyle =
        bullish
          ? '#16d99b'
          : '#ff506b';

      chartContext.beginPath();

      chartContext.moveTo(
        x,
        high
      );

      chartContext.lineTo(
        x,
        low
      );

      chartContext.stroke();

      chartContext.fillStyle =
        chartContext.strokeStyle;

      chartContext.fillRect(
        x -
          candleWidth / 2,
        Math.min(
          open,
          close
        ),
        candleWidth,
        Math.max(
          1,
          Math.abs(
            close -
            open
          )
        )
      );

    }
  );

  /*
    Sinyal çizgileri
  */

  var signal =
    data.signal;

  if (signal) {

    var lines = [
      [
        'GİRİŞ',
        signal.entry,
        '#16d99b'
      ],

      [
        'STOP',
        signal.stopLoss,
        '#ff506b'
      ],

      [
        'TP1',
        signal.tp1,
        '#4b8dff'
      ],

      [
        'TP2',
        signal.tp2,
        '#4b8dff'
      ],

      [
        'TP3',
        signal.tp3,
        '#4b8dff'
      ]
    ];

    lines.forEach(
      function(line) {

        var y =
          Y(line[1]);

        if (
          y <
            padding.top ||
          y >
            height -
            padding.bottom
        ) {
          return;
        }

        chartContext.strokeStyle =
          line[2];

        chartContext.setLineDash(
          [6, 5]
        );

        chartContext.beginPath();

        chartContext.moveTo(
          padding.left,
          y
        );

        chartContext.lineTo(
          width -
          padding.right,
          y
        );

        chartContext.stroke();

        chartContext.setLineDash(
          []
        );

        chartContext.fillStyle =
          line[2];

        chartContext.font =
          '10px Arial';

        chartContext.fillText(
          line[0] +
          ' ' +
          money(line[1]),
          width -
          70,
          y - 3
        );

      }
    );
  }

  /*
    Pending retest seviyesi
  */

  if (data.pending) {

    var pendingY =
      Y(
        data.pending.level
      );

    if (
      pendingY >=
        padding.top &&
      pendingY <=
        height -
        padding.bottom
    ) {

      chartContext.strokeStyle =
        '#e6b94d';

      chartContext.setLineDash(
        [4, 4]
      );

      chartContext.beginPath();

      chartContext.moveTo(
        padding.left,
        pendingY
      );

      chartContext.lineTo(
        width -
        padding.right,
        pendingY
      );

      chartContext.stroke();

      chartContext.setLineDash(
        []
      );
    }
  }
}

/*
  Zaman dilimi
*/

document
  .querySelectorAll('.btn')
  .forEach(
    function(button) {

      button.onclick =
        function() {

          timeframe =
            button.getAttribute(
              'data-tf'
            );

          document
            .querySelectorAll(
              '.btn'
            )
            .forEach(
              function(item) {
                item.classList.remove(
                  'active'
                );
              }
            );

          button.classList.add(
            'active'
          );

          loadChart();
        };
    }
  );

window.addEventListener(
  'resize',
  function() {

    if (selected) {
      loadChart();
    }

  }
);

connect();

</script>

</body>
</html>`;

app.get(
  '/',
  (req, res) => {
    res
      .status(200)
      .type('html')
      .send(HTML);
  }
);

app.get(
  '/api/status',
  (req, res) => {
    res.json(
      payload()
    );
  }
);

app.get(
  '/api/signals',
  (req, res) => {
    res.json(
      signalArray()
    );
  }
);

app.get(
  '/api/chart',
  async (req, res) => {
    try {

      const result =
        await chartPayload(
          req.query.symbol,
          req.query.timeframe ||
            '15m'
        );

      res.json(result);

    } catch (e) {

      res
        .status(404)
        .json({
          error:
            e.message
        });
    }
  }
);

app.get(
  '/api/health',
  (req, res) => {
    res.json({
      ok: true,
      time: now(),
      stats:
        STATE.stats
    });
  }
);

wss.on(
  'connection',
  ws => {
    ws.send(
      JSON.stringify(
        payload()
      )
    );
  }
);

server.listen(
  PORT,
  () => {

    console.log(
      '\n=============================================='
    );

    console.log(
      '🚀 SONNY AI TRADER V5.3'
    );

    console.log(
      '📡 Bitget USDT Futures'
    );

    console.log(
      '🛰️ Radar: ' +
      CFG.RADAR_LIMIT +
      ' Coin'
    );

    console.log(
      '🎯 Candidate: ' +
      CFG.CANDIDATE_LIMIT
    );

    console.log(
      '🔬 Deep: ' +
      CFG.DEEP_LIMIT
    );

    console.log(
      '📊 4H + 2H → 15M Breakout → Retest → 5M'
    );

    console.log(
      '💰 Minimum Volume: $' +
      CFG.MIN_24H_QUOTE_VOLUME
    );

    console.log(
      '🎯 Minimum R:R: 1:' +
      CFG.MIN_RR
    );

    console.log(
      '⏱️ Scan: ' +
      CFG.SCAN_MS / 1000 +
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
      '==============================================\n'
    );

    scan();

    setInterval(
      scan,
      CFG.SCAN_MS
    );
  }
);
