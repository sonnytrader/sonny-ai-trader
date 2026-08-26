const http = require('http');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 10000);
const HOST = '0.0.0.0';

const BITGET = 'https://api.bitget.com';
const PRODUCT = 'USDT-FUTURES';

const SCAN_MS = 60_000;
const MAX_ANALYSIS = 160;
const MAX_SIGNALS = 12;

const MIN_USDT_VOLUME = 2_000_000;

const ENTRY_TOL = 0.009;
const CLUSTER_TOL = 0.0035;

const MAX_SIGNAL_AGE = 90 * 60 * 1000;

const CONCURRENCY = 5;

let state = {
  signals: [],
  universe: 0,
  analyzed: 0,
  lastScan: 0,
  market: 'YATAY',
  busy: false,
  error: null
};

const candleCache = new Map();
const signalFirstSeen = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function fmt(n) {
  if (!Number.isFinite(n)) return '-';

  const x = Math.abs(n);

  if (x >= 1000) {
    return n.toLocaleString('en-US', {
      maximumFractionDigits: 2
    });
  }

  if (x >= 1) {
    return n.toLocaleString('en-US', {
      maximumFractionDigits: 5
    });
  }

  if (x >= 0.01) {
    return n.toLocaleString('en-US', {
      maximumFractionDigits: 6
    });
  }

  return n.toLocaleString('en-US', {
    maximumFractionDigits: 8
  });
}

function clampPrice(n) {
  return Number.isFinite(n) ? n : 0;
}


/* =========================================================
   BITGET API
========================================================= */

async function bitget(path, params = {}, tries = 3) {
  const url = new URL(BITGET + path);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }

  let lastError = null;

  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'application/json'
        }
      });

      if (response.status === 429) {
        await sleep(400 * (attempt + 1));
        continue;
      }

      if (!response.ok) {
        throw new Error(
          `Bitget HTTP ${response.status}`
        );
      }

      const json = await response.json();

      if (json.code !== '00000') {
        throw new Error(
          `Bitget ${json.code}: ${json.msg || 'API error'}`
        );
      }

      return json.data;
    } catch (error) {
      lastError = error;
      await sleep(300 * (attempt + 1));
    }
  }

  throw lastError || new Error('Bitget request failed');
}


/* =========================================================
   UNIVERSE
========================================================= */

async function getUniverse() {
  const [contracts, tickers] = await Promise.all([
    bitget(
      '/api/v2/mix/market/contracts',
      {
        productType: PRODUCT
      }
    ),

    bitget(
      '/api/v2/mix/market/tickers',
      {
        productType: PRODUCT
      }
    )
  ]);

  const activeContracts = new Map();

  for (const contract of contracts || []) {
    if (contract.symbolType !== 'perpetual') {
      continue;
    }

    if (contract.symbolStatus !== 'normal') {
      continue;
    }

    const symbol = String(contract.symbol || '');

    if (!symbol.endsWith('USDT')) {
      continue;
    }

    activeContracts.set(symbol, contract);
  }

  return (tickers || [])
    .filter(ticker => activeContracts.has(ticker.symbol))
    .map(ticker => ({
      symbol: ticker.symbol,
      price: Number(ticker.lastPr),
      volume: Number(
        ticker.usdtVolume ||
        ticker.quoteVolume ||
        0
      ),
      change24h: Number(
        ticker.change24h || 0
      )
    }))
    .filter(item => {
      return (
        Number.isFinite(item.price) &&
        item.price > 0 &&
        item.volume >= MIN_USDT_VOLUME
      );
    })
    .sort((a, b) => b.volume - a.volume);
}


/* =========================================================
   CANDLE DATA
========================================================= */

function parseCandles(rows) {
  return (rows || [])
    .map(row => ({
      t: Number(row[0]),
      o: Number(row[1]),
      h: Number(row[2]),
      l: Number(row[3]),
      c: Number(row[4]),
      v: Number(row[5] || 0)
    }))
    .filter(candle => {
      return [
        candle.t,
        candle.o,
        candle.h,
        candle.l,
        candle.c
      ].every(Number.isFinite);
    })
    .sort((a, b) => a.t - b.t);
}


async function getCandles(
  symbol,
  timeframe,
  limit = 100
) {
  const cacheKey = `${symbol}:${timeframe}`;

  const data = await bitget(
    '/api/v2/mix/market/candles',
    {
      symbol,
      granularity: timeframe,
      limit,
      productType: PRODUCT
    }
  );

  const candles = parseCandles(data);

  candleCache.set(cacheKey, candles);

  return candles;
}


/* =========================================================
   CONCURRENCY
========================================================= */

async function pool(
  items,
  worker,
  concurrency = CONCURRENCY
) {
  const result = new Array(items.length);

  let cursor = 0;

  async function runner() {
    while (true) {
      const index = cursor++;

      if (index >= items.length) {
        return;
      }

      try {
        result[index] = await worker(
          items[index],
          index
        );
      } catch (error) {
        result[index] = null;
      }
    }
  }

  const runners = [];

  for (
    let i = 0;
    i < Math.min(concurrency, items.length);
    i++
  ) {
    runners.push(runner());
  }

  await Promise.all(runners);

  return result;
}


/* =========================================================
   PRICE STRUCTURE
========================================================= */

function pivots(
  candles,
  side,
  left = 3,
  right = 3
) {
  const result = [];

  for (
    let i = left;
    i < candles.length - right;
    i++
  ) {
    const current =
      side === 'high'
        ? candles[i].h
        : candles[i].l;

    let valid = true;

    for (
      let j = i - left;
      j <= i + right;
      j++
    ) {
      if (j === i) continue;

      if (
        side === 'high' &&
        candles[j].h >= current
      ) {
        valid = false;
        break;
      }

      if (
        side === 'low' &&
        candles[j].l <= current
      ) {
        valid = false;
        break;
      }
    }

    if (valid) {
      result.push({
        price: current,
        index: i,
        t: candles[i].t
      });
    }
  }

  return result;
}


/* =========================================================
   LEVEL CLUSTERING
========================================================= */

function clusterLevels(
  points,
  tolerance = CLUSTER_TOL
) {
  const sorted = [...points].sort(
    (a, b) => a.price - b.price
  );

  const groups = [];

  for (const point of sorted) {
    let group =
      groups[groups.length - 1];

    if (
      !group ||
      Math.abs(point.price - group.price) /
        group.price >
        tolerance
    ) {
      group = {
        price: point.price,
        count: 1,
        last: point.t,
        touches: [point.t]
      };

      groups.push(group);
    } else {
      group.price =
        (
          group.price * group.count +
          point.price
        ) /
        (group.count + 1);

      group.count += 1;

      group.last = Math.max(
        group.last,
        point.t
      );

      group.touches.push(point.t);
    }
  }

  return groups;
}


function buildLevels(candles) {
  const highs = clusterLevels(
    pivots(candles, 'high')
      .map(point => ({
        price: point.price,
        t: point.t
      }))
  );

  const lows = clusterLevels(
    pivots(candles, 'low')
      .map(point => ({
        price: point.price,
        t: point.t
      }))
  );

  return [
    ...highs.map(level => ({
      ...level,
      type: 'resistance'
    })),

    ...lows.map(level => ({
      ...level,
      type: 'support'
    }))
  ];
}


/* =========================================================
   4H / 2H CONFLUENCE
========================================================= */

function find2HConfirmation(
  level,
  levels2H
) {
  let best = null;

  for (const candidate of levels2H) {
    const distance =
      Math.abs(
        candidate.price - level.price
      ) /
      level.price;

    if (distance > 0.006) {
      continue;
    }

    if (!best || distance < best.distance) {
      best = {
        ...candidate,
        distance
      };
    }
  }

  return best;
}


/* =========================================================
   15M MARKET STRUCTURE
========================================================= */

function get15MStructure(candles) {
  if (candles.length < 20) {
    return 'NEUTRAL';
  }

  const highs = pivots(
    candles,
    'high',
    2,
    2
  ).slice(-5);

  const lows = pivots(
    candles,
    'low',
    2,
    2
  ).slice(-5);

  if (
    highs.length < 2 ||
    lows.length < 2
  ) {
    return 'NEUTRAL';
  }

  const previousHigh =
    highs[highs.length - 2].price;

  const latestHigh =
    highs[highs.length - 1].price;

  const previousLow =
    lows[lows.length - 2].price;

  const latestLow =
    lows[lows.length - 1].price;

  if (
    latestHigh > previousHigh &&
    latestLow > previousLow
  ) {
    return 'LONG';
  }

  if (
    latestHigh < previousHigh &&
    latestLow < previousLow
  ) {
    return 'SHORT';
  }

  return 'NEUTRAL';
}


/* =========================================================
   15M REJECTION
========================================================= */

function getRejection(
  candles,
  level,
  type
) {
  const recent =
    candles.slice(-6);

  let score = 0;

  for (const candle of recent) {
    if (
      type === 'resistance' &&
      candle.h >= level * 0.998 &&
      candle.c < level
    ) {
      score++;
    }

    if (
      type === 'support' &&
      candle.l <= level * 1.002 &&
      candle.c > level
    ) {
      score++;
    }
  }

  return score;
}


/* =========================================================
   BREAKOUT
========================================================= */

function isBreakout(
  candles,
  level,
  type
) {
  if (candles.length < 2) {
    return false;
  }

  const previous =
    candles[candles.length - 2];

  const latest =
    candles[candles.length - 1];

  if (type === 'resistance') {
    return (
      previous.c <= level &&
      latest.c > level &&
      latest.c >= latest.o
    );
  }

  return (
    previous.c >= level &&
    latest.c < level &&
    latest.c <= latest.o
  );
}


/* =========================================================
   SETUP ENGINE
========================================================= */

function chooseSetup(
  price,
  candles4H,
  candles2H,
  candles15M
) {
  const levels4H =
    buildLevels(candles4H);

  const levels2H =
    buildLevels(candles2H);

  const allCandidates = [
    ...levels4H.map(level => ({
      ...level,
      timeframe: '4H'
    })),

    ...levels2H.map(level => ({
      ...level,
      timeframe: '2H'
    }))
  ];

  allCandidates.sort(
    (a, b) =>
      Math.abs(a.price - price) -
      Math.abs(b.price - price)
  );

  const structure15M =
    get15MStructure(candles15M);

  let bestSetup = null;

  for (
    const candidate of
    allCandidates.slice(0, 30)
  ) {
    const distance =
      Math.abs(
        price - candidate.price
      ) /
      candidate.price;

    if (distance > ENTRY_TOL) {
      continue;
    }

    const confirmation =
      find2HConfirmation(
        candidate,
        levels2H
      );

    const rejection =
      getRejection(
        candles15M,
        candidate.price,
        candidate.type
      );

    const breakout =
      isBreakout(
        candles15M,
        candidate.price,
        candidate.type
      );

    let direction = null;
    let reason = '';

    /*
      DİRENÇ
      --------
      Ret -> SHORT
      Kırılım -> LONG
    */

    if (
      candidate.type ===
      'resistance'
    ) {
      if (
        structure15M === 'SHORT' ||
        rejection >= 1
      ) {
        direction = 'SHORT';

        reason =
          confirmation
            ? '4H + 2H direnç + 15M ret'
            : '4H direnç + 15M ret';
      } else if (breakout) {
        direction = 'LONG';

        reason =
          'Direnç kırılımı';
      }
    }

    /*
      DESTEK
      --------
      Ret -> LONG
      Kırılım -> SHORT
    */

    if (
      candidate.type ===
      'support'
    ) {
      if (
        structure15M === 'LONG' ||
        rejection >= 1
      ) {
        direction = 'LONG';

        reason =
          confirmation
            ? '4H + 2H destek + 15M ret'
            : '4H destek + 15M ret';
      } else if (breakout) {
        direction = 'SHORT';

        reason =
          'Destek kırılımı';
      }
    }

    if (!direction) {
      continue;
    }

    /*
      Gerçek piyasa yapısından STOP
    */

    const recent15 =
      candles15M.slice(-12);

    const recent2H =
      candles2H.slice(-8);

    const recentHighs = [
      ...recent15.map(
        candle => candle.h
      ),
      ...recent2H.map(
        candle => candle.h
      )
    ];

    const recentLows = [
      ...recent15.map(
        candle => candle.l
      ),
      ...recent2H.map(
        candle => candle.l
      )
    ];

    const swingHigh =
      Math.max(...recentHighs);

    const swingLow =
      Math.min(...recentLows);

    const recentRange =
      Math.max(
        ...recent15.map(
          candle => candle.h
        )
      ) -
      Math.min(
        ...recent15.map(
          candle => candle.l
        )
      );

    const buffer =
      Math.max(
        candidate.price * 0.0015,
        recentRange * 0.12
      );

    const entry = {
      low:
        direction === 'LONG'
          ? candidate.price * 0.9975
          : candidate.price * 0.9985,

      high:
        direction === 'LONG'
          ? candidate.price * 1.0015
          : candidate.price * 1.0025
    };

    const entryMid =
      (entry.low + entry.high) / 2;

    const stop =
      direction === 'LONG'
        ? swingLow - buffer
        : swingHigh + buffer;

    const risk =
      Math.abs(
        stop - entryMid
      );

    if (
      !Number.isFinite(risk) ||
      risk <= 0
    ) {
      continue;
    }

    /*
      Aşırı geniş stopları ele
    */

    if (
      risk / entryMid > 0.08
    ) {
      continue;
    }

    const tp1 =
      direction === 'LONG'
        ? entryMid + risk
        : entryMid - risk;

    const tp2 =
      direction === 'LONG'
        ? entryMid + risk * 2
        : entryMid - risk * 2;

    const tp3 =
      direction === 'LONG'
        ? entryMid + risk * 3
        : entryMid - risk * 3;

    /*
      Kalite
    */

    let quality = 55;

    if (confirmation) {
      quality += 20;
    }

    const touches =
      (candidate.count || 0) +
      (confirmation?.count || 0);

    quality += Math.min(
      12,
      touches * 2
    );

    if (
      structure15M ===
      direction
    ) {
      quality += 10;
    }

    if (rejection >= 2) {
      quality += 4;
    }

    if (breakout) {
      quality += 8;
    }

    quality = clamp(
      Math.round(quality),
      0,
      99
    );

    let grade = 'C';

    if (quality >= 88) {
      grade = 'A+';
    } else if (quality >= 78) {
      grade = 'A';
    } else if (quality >= 68) {
      grade = 'B';
    }

    /*
      Sinyalin sıralama puanı
    */

    const rankingScore =
      quality -
      distance * 1000 +
      (confirmation ? 8 : 0) +
      (
        structure15M === direction
          ? 6
          : 0
      );

    const setup = {
      symbol: null,

      direction,

      price,

      level:
        candidate.price,

      type:
        candidate.type,

      timeframe:
        candidate.timeframe,

      confidence:
        Boolean(confirmation),

      touches,

      structure:
        structure15M,

      rejection,

      breakout,

      reason,

      entry,

      stop,

      tp1,

      tp2,

      tp3,

      risk,

      quality,

      grade,

      distance:
        distance * 100,

      levelStrength:
        touches >= 5
          ? 'ÇOK GÜÇLÜ'
          : touches >= 3
            ? 'GÜÇLÜ'
            : 'NORMAL',

      score:
        rankingScore
    };

    if (
      !bestSetup ||
      setup.score >
      bestSetup.score
    ) {
      bestSetup = setup;
    }
  }

  return bestSetup;
}


/* =========================================================
   MARKET REGIME
========================================================= */

function getMarketRegime(
  universe
) {
  const changes =
    universe
      .map(x => x.change24h)
      .filter(Number.isFinite);

  const up =
    changes.filter(
      x => x > 0.5
    ).length;

  const down =
    changes.filter(
      x => x < -0.5
    ).length;

  if (
    up >
    down * 1.35
  ) {
    return 'YUKARI';
  }

  if (
    down >
    up * 1.35
  ) {
    return 'AŞAĞI';
  }

  return 'YATAY';
}


/* =========================================================
   SIGNAL AGE
========================================================= */

function signalKey(
  symbol,
  direction
) {
  return `${symbol}:${direction}`;
}


/* =========================================================
   COIN ANALYSIS
========================================================= */

async function analyzeCoin(
  asset
) {
  const [
    candles4H,
    candles2H,
    candles15M
  ] = await Promise.all([
    getCandles(
      asset.symbol,
      '4H',
      100
    ),

    getCandles(
      asset.symbol,
      '2H',
      100
    ),

    getCandles(
      asset.symbol,
      '15m',
      100
    )
  ]);

  if (
    candles4H.length < 30 ||
    candles2H.length < 30 ||
    candles15M.length < 30
  ) {
    return null;
  }

  const setup =
    chooseSetup(
      asset.price,
      candles4H,
      candles2H,
      candles15M
    );

  if (!setup) {
    return null;
  }

  setup.symbol =
    asset.symbol;

  const key =
    signalKey(
      asset.symbol,
      setup.direction
    );

  if (
    !signalFirstSeen.has(key)
  ) {
    signalFirstSeen.set(
      key,
      Date.now()
    );
  }

  setup.createdAt =
    signalFirstSeen.get(key);

  setup.livePrice =
    asset.price;

  setup.change24h =
    asset.change24h;

  setup.volume =
    asset.volume;

  setup.chartTf =
    '2H';

  return setup;
}


/* =========================================================
   MAIN SCANNER
========================================================= */

async function scan() {
  if (state.busy) {
    return;
  }

  state.busy = true;
  state.error = null;

  try {
    const universe =
      await getUniverse();

    state.universe =
      universe.length;

    const selected =
      universe.slice(
        0,
        MAX_ANALYSIS
      );

    console.log(
      `[${new Date().toISOString()}] RADAR başladı | Universe=${universe.length} | Analysis=${selected.length}`
    );

    const results =
      await pool(
        selected,
        analyzeCoin,
        CONCURRENCY
      );

    const signals =
      results
        .filter(Boolean)
        .sort(
          (a, b) =>
            b.score - a.score
        )
        .slice(
          0,
          MAX_SIGNALS
        );

    const activeKeys =
      new Set(
        signals.map(
          s =>
            signalKey(
              s.symbol,
              s.direction
            )
        )
      );

    /*
      Eski sinyalleri temizle
    */

    for (
      const [
        key,
        created
      ] of signalFirstSeen
    ) {
      if (
        Date.now() - created >
        MAX_SIGNAL_AGE
      ) {
        signalFirstSeen.delete(
          key
        );
        continue;
      }

      /*
        Artık hiçbir taramada
        görünmeyen eski setupları
        temizle.
      */

      if (
        !activeKeys.has(key)
      ) {
        signalFirstSeen.delete(
          key
        );
      }
    }

    state.signals =
      signals;

    state.analyzed =
      selected.length;

    state.lastScan =
      Date.now();

    state.market =
      getMarketRegime(
        universe
      );

    console.log(
      `[${new Date().toISOString()}] RADAR tamamlandı | Universe=${state.universe} | Analiz=${state.analyzed} | SIGNAL=${signals.length}`
    );

  } catch (error) {
    state.error =
      error.message;

    console.error(
      `[${new Date().toISOString()}] RADAR HATA | ${error.message}`
    );
  } finally {
    state.busy = false;
  }
}


/* =========================================================
   API OUTPUT
========================================================= */

function safeSignal(signal) {
  return {
    symbol:
      signal.symbol,

    direction:
      signal.direction,

    price:
      signal.livePrice,

    level:
      signal.level,

    type:
      signal.type,

    confidence:
      signal.confidence,

    touches:
      signal.touches,

    structure:
      signal.structure,

    reason:
      signal.reason,

    entry:
      signal.entry,

    stop:
      signal.stop,

    tp1:
      signal.tp1,

    tp2:
      signal.tp2,

    tp3:
      signal.tp3,

    rr:
      2,

    quality:
      signal.quality,

    grade:
      signal.grade,

    distance:
      signal.distance,

    levelStrength:
      signal.levelStrength,

    createdAt:
      signal.createdAt,

    ageMs:
      Date.now() -
      signal.createdAt,

    chartTf:
      signal.chartTf
  };
}


function sendJSON(
  response,
  data,
  status = 200
) {
  const body =
    JSON.stringify(data);

  response.writeHead(
    status,
    {
      'content-type':
        'application/json; charset=utf-8',

      'cache-control':
        'no-store'
    }
  );

  response.end(body);
}


/* =========================================================
   FINAL UI
========================================================= */

const HTML = `<!doctype html>
<html lang="tr">

<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>Sonny AI Trader FINAL</title>

<style>

:root {
  --bg: #070a0f;
  --panel: #0c1118;
  --panel2: #101721;
  --line: #202b39;
  --text: #edf2f7;
  --muted: #8290a0;

  --green: #18d49c;
  --red: #ff5573;
  --yellow: #f3c34f;
  --blue: #4da3ff;
}

* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--bg);
  color: var(--text);
  font-family:
    Inter,
    Segoe UI,
    Arial,
    sans-serif;
}

.app {
  width: 100%;
  height: 100vh;

  display: grid;

  grid-template-columns:
    300px 1fr;

  grid-template-rows:
    68px 1fr;
}


/* HEADER */

.top {
  grid-column: 1 / 3;

  height: 68px;

  display: flex;

  align-items: center;

  justify-content: space-between;

  padding:
    0 22px;

  background: #090d13;

  border-bottom:
    1px solid var(--line);
}

.brand {
  font-size: 19px;
  font-weight: 900;
}

.brand span {
  color: #59aaff;
}

.sub {
  margin-top: 4px;

  color: var(--muted);

  font-size: 10px;
}

.stats {
  display: flex;
  gap: 22px;
}

.stat {
  text-align: right;
}

.stat b {
  display: block;

  font-size: 15px;
}

.stat span {
  color: var(--muted);

  font-size: 9px;

  text-transform:
    uppercase;
}


/* LEFT */

.left {
  min-width: 0;

  overflow-y: auto;

  padding:
    12px 10px;

  background: #090d13;

  border-right:
    1px solid var(--line);
}

.left h3 {
  margin:
    4px 6px 12px;

  font-size: 12px;
}


/* SIGNAL CARD */

.card {
  padding: 12px;

  margin-bottom: 8px;

  border:
    1px solid var(--line);

  border-radius: 11px;

  background:
    linear-gradient(
      180deg,
      #111822,
      #0b1017
    );

  cursor: pointer;

  transition:
    border .15s,
    transform .15s;
}

.card:hover {
  transform:
    translateY(-1px);

  border-color:
    #355a7a;
}

.card.active {
  border-color:
    #4a91c8;
}

.row {
  display: flex;

  align-items: center;

  justify-content:
    space-between;
}

.symbol {
  font-weight: 900;

  font-size: 13px;
}

.badge {
  padding:
    5px 7px;

  border-radius: 6px;

  font-size: 9px;

  font-weight: 900;
}

.badge.long {
  color: var(--green);

  background:
    rgba(
      24,
      212,
      156,
      .10
    );
}

.badge.short {
  color: var(--red);

  background:
    rgba(
      255,
      85,
      115,
      .10
    );
}

.price {
  margin:
    9px 0 3px;

  font-size: 18px;

  font-weight: 900;
}

.small {
  color: var(--muted);

  font-size: 9px;
}

.ready {
  margin-top: 8px;

  color: var(--green);

  font-size: 10px;

  font-weight: 900;
}

.wait {
  margin-top: 8px;

  color: var(--yellow);

  font-size: 10px;

  font-weight: 900;
}


/* MAIN */

.main {
  position: relative;

  min-width: 0;

  overflow: hidden;
}


/* TOOLBAR */

.toolbar {
  height: 58px;

  display: flex;

  align-items: center;

  justify-content:
    space-between;

  padding:
    0 17px;

  border-bottom:
    1px solid var(--line);

  background:
    #090d13;
}

.title {
  font-size: 18px;

  font-weight: 900;
}

.title span {
  display: inline-block;

  margin-left: 8px;

  padding:
    4px 7px;

  border:
    1px solid var(--line);

  border-radius: 5px;

  color: var(--muted);

  font-size: 9px;
}

.actions button {
  padding:
    8px 10px;

  margin-left: 6px;

  color: #dce5ee;

  background:
    #101721;

  border:
    1px solid #293646;

  border-radius: 7px;

  cursor: pointer;
}

.actions button:hover {
  border-color:
    #4d7394;
}


/* CHART */

.chartWrap {
  position: absolute;

  left: 0;
  right: 0;
  top: 58px;
  bottom: 0;
}

.chart {
  width: 100%;
  height: 100%;

  display: block;
}


/* SIMPLE LEGEND */

.legend {
  position: absolute;

  left: 16px;
  top: 16px;

  padding:
    9px 11px;

  border:
    1px solid var(--line);

  border-radius: 9px;

  background:
    rgba(
      8,
      12,
      17,
      .88
    );

  color: #dbe3eb;

  font-size: 9px;

  line-height: 1.9;
}

.dot {
  display: inline-block;

  width: 7px;
  height: 7px;

  margin-right: 5px;

  border-radius: 50%;
}

.dot.yellow {
  background:
    var(--yellow);
}

.dot.green {
  background:
    var(--green);
}

.dot.red {
  background:
    var(--red);
}

.dot.blue {
  background:
    var(--blue);
}


/* SIMPLE PLAN */

.plan {
  position: absolute;

  right: 16px;
  top: 16px;

  width: 245px;

  padding:
    15px;

  border:
    1px solid #263546;

  border-radius: 13px;

  background:
    rgba(
      8,
      12,
      18,
      .94
    );

  backdrop-filter:
    blur(12px);
}

.plan .direction {
  margin:
    4px 0 10px;

  font-size: 27px;

  font-weight: 900;
}

.status {
  display: inline-block;

  padding:
    6px 8px;

  border-radius: 6px;

  color: var(--green);

  background:
    rgba(
      24,
      212,
      156,
      .10
    );

  font-size: 9px;

  font-weight: 900;
}

.plan h4 {
  margin:
    14px 0 5px;

  color: var(--muted);

  font-size: 9px;

  text-transform:
    uppercase;
}

.big {
  font-size: 18px;

  font-weight: 900;
}

.levels {
  display: grid;

  gap: 5px;

  margin-top: 10px;
}

.level {
  display: flex;

  align-items: center;

  justify-content:
    space-between;

  padding:
    8px;

  border-radius: 6px;

  background:
    #101721;

  font-size: 11px;
}

.level.stop {
  color: var(--red);
}

.level.tp {
  color: var(--blue);
}

.level.entry {
  color: var(--green);
}

.rule {
  margin-top: 12px;

  color: var(--muted);

  font-size: 9px;

  line-height: 1.5;
}


/* FOOTER */

.footer {
  position: absolute;

  left: 15px;
  bottom: 8px;

  color:
    #697686;

  font-size: 9px;
}


/* EMPTY */

.empty {
  padding: 30px 12px;

  text-align: center;

  color: var(--muted);

  font-size: 11px;
}


/* MOBILE */

@media (
  max-width: 900px
) {

  .app {
    grid-template-columns:
      245px 1fr;
  }

  .stats {
    gap: 8px;
  }

  .plan {
    width: 210px;
  }
}

</style>

</head>

<body>

<div class="app">


<header class="top">

  <div>

    <div class="brand">
      🚀 Sonny AI Trader
      <span>FINAL</span>
    </div>

    <div class="sub">
      4H Destek/Direnç ·
      2H Onay ·
      15M Yapı ·
      Canlı İşlem Planı
    </div>

  </div>


  <div class="stats">

    <div class="stat">
      <b id="universe">-</b>
      <span>Evren</span>
    </div>

    <div class="stat">
      <b id="analyzed">-</b>
      <span>Analiz</span>
    </div>

    <div class="stat">
      <b id="count">-</b>
      <span>Sinyal</span>
    </div>

    <div class="stat">
      <b id="market">-</b>
      <span>Piyasa</span>
    </div>

    <div class="stat">
      <b id="scan">-</b>
      <span>Son Tarama</span>
    </div>

  </div>

</header>


<aside class="left">

  <h3>
    🚨 İŞLEM FIRSATLARI
    <span id="sideCount"></span>
  </h3>

  <div id="list"></div>

</aside>


<main class="main">


  <div class="toolbar">

    <div
      class="title"
      id="mainTitle"
    >
      Bir sinyal seç

      <span>
        Grafikte işlem planını gör
      </span>
    </div>


    <div class="actions">

      <button id="tv">
        Binance TradingView
      </button>

      <button id="refresh">
        Yenile
      </button>

    </div>

  </div>


  <div class="chartWrap">

    <canvas
      id="chart"
      class="chart"
    ></canvas>


    <div
      id="legend"
      class="legend"
      style="display:none"
    >

      <div>
        <i class="dot yellow"></i>
        Kritik bölge
      </div>

      <div>
        <i class="dot green"></i>
        Giriş
      </div>

      <div>
        <i class="dot red"></i>
        Stop
      </div>

      <div>
        <i class="dot blue"></i>
        Kâr hedefleri
      </div>

    </div>


    <div
      id="plan"
      class="plan"
      style="display:none"
    ></div>


    <div class="footer">
      Bitget canlı veri ·
      Her 60 saniyede tarama ·
      Sinyal yaşı canlı güncellenir
    </div>

  </div>

</main>

</div>


<script>

let signals = [];

let selected = null;


function $(id) {
  return document.getElementById(id);
}


function fmt(n) {

  n = Number(n) || 0;

  const x = Math.abs(n);

  if (x >= 1000) {
    return n.toLocaleString(
      'en-US',
      {
        maximumFractionDigits: 2
      }
    );
  }

  if (x >= 1) {
    return n.toLocaleString(
      'en-US',
      {
        maximumFractionDigits: 5
      }
    );
  }

  if (x >= 0.01) {
    return n.toLocaleString(
      'en-US',
      {
        maximumFractionDigits: 6
      }
    );
  }

  return n.toLocaleString(
    'en-US',
    {
      maximumFractionDigits: 8
    }
  );
}


function age(ms) {

  let seconds =
    Math.max(
      0,
      Math.floor(
        ms / 1000
      )
    );

  if (seconds < 60) {
    return seconds + ' sn';
  }

  const minutes =
    Math.floor(
      seconds / 60
    );

  if (minutes < 60) {
    return minutes + ' dk';
  }

  const hours =
    Math.floor(
      minutes / 60
    );

  const rest =
    minutes % 60;

  return (
    hours +
    ' sa ' +
    rest +
    ' dk'
  );
}


function esc(value) {

  return String(
    value || ''
  )
    .replace(
      /[&<>\"']/g,
      function(char) {

        const map = {
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '\"': '&quot;',
          \"'\": '&#39;'
        };

        return map[char];
      }
    );
}


function isReady(signal) {

  const mid =
    (
      signal.entry.low +
      signal.entry.high
    ) / 2;

  return (
    Math.abs(
      signal.price - mid
    ) / mid
  ) < 0.004;
}


/* =========================================================
   LEFT SIGNAL LIST
========================================================= */

function renderList() {

  const list =
    $('list');

  list.innerHTML = '';

  $('sideCount').textContent =
    signals.length
      ? '(' + signals.length + ')'
      : '';


  if (!signals.length) {

    list.innerHTML =
      '<div class="empty">' +
      'Şu anda işlem fırsatı yok.<br><br>' +
      'Radar piyasayı tarıyor.' +
      '</div>';

    return;
  }


  signals.forEach(
    function(signal) {

      const card =
        document.createElement(
          'div'
        );

      card.className =
        'card' +
        (
          selected &&
          selected.symbol ===
            signal.symbol
            ? ' active'
            : ''
        );


      const ready =
        isReady(signal);


      card.innerHTML =

        '<div class="row">' +

          '<span class="symbol">' +
            esc(signal.symbol) +
          '</span>' +

          '<span class="badge ' +
            (
              signal.direction ===
              'LONG'
                ? 'long'
                : 'short'
            ) +
          '">' +

            signal.direction +

          '</span>' +

        '</div>' +


        '<div class="price">' +
          fmt(signal.price) +
        '</div>' +


        '<div class="small">' +

          'Seviye ' +
          fmt(signal.level) +

          ' · ' +

          signal.distance.toFixed(2) +

          '% uzaklık' +

        '</div>' +


        '<div class="' +
          (
            ready
              ? 'ready'
              : 'wait'
          ) +
        '">' +

          (
            ready
              ? '● GİRİŞ HAZIR'
              : '● BEKLE'
          ) +

          ' · ' +

          age(signal.ageMs) +

        '</div>';


      card.onclick =
        function() {

          selectSignal(
            signal.symbol
          );

        };


      list.appendChild(
        card
      );

    }
  );
}


/* =========================================================
   RIGHT PLAN CARD
========================================================= */

function renderPlan(signal) {

  const ready =
    isReady(signal);


  const color =
    signal.direction ===
      'LONG'
      ? 'var(--green)'
      : 'var(--red)';


  return `

    <div class="row">

      <b>
        ${esc(signal.symbol)}
      </b>

      <span
        class="badge ${
          signal.direction ===
          'LONG'
            ? 'long'
            : 'short'
        }"
      >
        ${signal.direction}
      </span>

    </div>


    <div
      class="direction"
      style="color:${color}"
    >
      ${signal.direction}
    </div>


    <span class="status">

      ${
        ready
          ? '● İŞLEME UYGUN'
          : '● BEKLE'
      }

    </span>


    <h4>
      Giriş bölgesi
    </h4>


    <div class="big">

      ${fmt(signal.entry.low)}
      –
      ${fmt(signal.entry.high)}

    </div>


    <div class="levels">


      <div class="level stop">

        <span>
          ⛔ Zarar kes
        </span>

        <b>
          ${fmt(signal.stop)}
        </b>

      </div>


      <div class="level tp">

        <span>
          🎯 Kâr al 1
        </span>

        <b>
          ${fmt(signal.tp1)}
        </b>

      </div>


      <div class="level tp">

        <span>
          🎯 Kâr al 2
        </span>

        <b>
          ${fmt(signal.tp2)}
        </b>

      </div>


      <div class="level tp">

        <span>
          🎯 Kâr al 3
        </span>

        <b>
          ${fmt(signal.tp3)}
        </b>

      </div>


    </div>


    <div class="rule">

      <b>
        ${signal.grade}
      </b>

      kalite ·

      ${esc(signal.reason)}

      <br>

      15M:
      ${esc(signal.structure)}

      ·

      ${signal.touches}
      temas

      ·

      sinyal:
      ${age(signal.ageMs)}

    </div>

  `;
}


/* =========================================================
   SELECT SIGNAL
========================================================= */

async function selectSignal(
  symbol
) {

  selected =
    signals.find(
      signal =>
        signal.symbol ===
        symbol
    ) || null;


  renderList();


  if (!selected) {
    return;
  }


  $('mainTitle').innerHTML =

    esc(selected.symbol) +

    ' <span>' +

    selected.direction +

    ' · ' +

    selected.grade +

    '</span>';


  $('plan').style.display =
    'block';


  $('plan').innerHTML =
    renderPlan(
      selected
    );


  $('legend').style.display =
    'block';


  $('tv').onclick =
    function() {

      window.open(

        'https://www.tradingview.com/chart/?symbol=BINANCE%3A' +

        encodeURIComponent(
          selected.symbol
        ),

        '_blank'

      );

    };


  drawChart(
    selected
  );
}


/* =========================================================
   CANVAS CHART
========================================================= */

async function drawChart(
  signal
) {

  const canvas =
    $('chart');

  const context =
    canvas.getContext(
      '2d'
    );


  const width =
    canvas.clientWidth;

  const height =
    canvas.clientHeight;

  const dpr =
    window.devicePixelRatio ||
    1;


  canvas.width =
    width * dpr;

  canvas.height =
    height * dpr;


  context.setTransform(
    dpr,
    0,
    0,
    dpr,
    0,
    0
  );


  context.clearRect(
    0,
    0,
    width,
    height
  );


  try {

    const response =
      await fetch(
        '/api/chart?symbol=' +
        encodeURIComponent(
          signal.symbol
        )
      );


    const data =
      await response.json();


    const candles =
      data.candles || [];


    if (!candles.length) {
      throw new Error(
        'No candles'
      );
    }


    const padding = {
      left: 20,
      right: 265,
      top: 25,
      bottom: 38
    };


    const chartWidth =
      width -
      padding.left -
      padding.right;


    const chartHeight =
      height -
      padding.top -
      padding.bottom;


    const visible =
      candles.slice(-70);


    let min =
      Math.min.apply(
        null,
        visible.map(
          candle =>
            candle.l
        )
      );


    let max =
      Math.max.apply(
        null,
        visible.map(
          candle =>
            candle.h
        )
      );


    [
      signal.stop,
      signal.entry.low,
      signal.entry.high,
      signal.tp1,
      signal.tp2,
      signal.tp3,
      signal.level
    ].forEach(
      function(value) {

        min =
          Math.min(
            min,
            value
          );

        max =
          Math.max(
            max,
            value
          );

      }
    );


    const range =
      max - min || 1;


    min -=
      range * 0.05;

    max +=
      range * 0.05;


    function x(index) {

      if (
        visible.length <= 1
      ) {
        return padding.left;
      }

      return (
        padding.left +
        index *
          (
            chartWidth /
            (
              visible.length - 1
            )
          )
      );
    }


    function y(value) {

      return (
        padding.top +

        (
          (
            max - value
          ) /
          (
            max - min
          )
        ) *

        chartHeight
      );

    }


    /*
      Background
    */

    context.fillStyle =
      '#070a0f';

    context.fillRect(
      0,
      0,
      width,
      height
    );


    /*
      Grid
    */

    context.strokeStyle =
      '#18212c';

    context.lineWidth = 1;


    for (
      let i = 0;
      i < 6;
      i++
    ) {

      const yy =
        padding.top +
        (
          i *
          chartHeight /
          5
        );


      context.beginPath();

      context.moveTo(
        padding.left,
        yy
      );

      context.lineTo(
        padding.left +
        chartWidth,
        yy
      );

      context.stroke();

    }


    for (
      let i = 0;
      i < 8;
      i++
    ) {

      const xx =
        padding.left +
        (
          i *
          chartWidth /
          7
        );


      context.beginPath();

      context.moveTo(
        xx,
        padding.top
      );

      context.lineTo(
        xx,
        padding.top +
        chartHeight
      );

      context.stroke();

    }


    /*
      Candles
    */

    const candleWidth =
      Math.max(
        3,
        chartWidth /
          visible.length *
          0.58
      );


    visible.forEach(
      function(candle, index) {

        const xx =
          x(index);

        const openY =
          y(candle.o);

        const closeY =
          y(candle.c);

        const highY =
          y(candle.h);

        const lowY =
          y(candle.l);


        const bullish =
          candle.c >=
          candle.o;


        const color =
          bullish
            ? '#18d49c'
            : '#ff5573';


        context.strokeStyle =
          color;

        context.fillStyle =
          color;

        context.lineWidth = 1;


        /*
          Wick
        */

        context.beginPath();

        context.moveTo(
          xx,
          highY
        );

        context.lineTo(
          xx,
          lowY
        );

        context.stroke();


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
            2,
            Math.abs(
              closeY -
              openY
            )
          );


        context.fillRect(
          xx -
            candleWidth / 2,
          bodyTop,
          candleWidth,
          bodyHeight
        );

      }
    );


    /*
      Entry zone
    */

    const entryTop =
      y(signal.entry.high);

    const entryBottom =
      y(signal.entry.low);


    context.fillStyle =
      'rgba(24,212,156,.08)';


    context.fillRect(
      padding.left,
      entryTop,
      chartWidth,
      entryBottom -
        entryTop
    );


    /*
      Line helper
    */

    function line(
      value,
      color,
      label
    ) {

      context.strokeStyle =
        color;

      context.lineWidth =
        1.5;

      context.setLineDash(
        [5, 4]
      );


      context.beginPath();

      context.moveTo(
        padding.left,
        y(value)
      );

      context.lineTo(
        padding.left +
        chartWidth,
        y(value)
      );

      context.stroke();


      context.setLineDash([]);


      context.fillStyle =
        color;

      context.font =
        'bold 11px Segoe UI';


      context.fillText(

        label +
        '  ' +
        fmt(value),

        padding.left +
        chartWidth +
        8,

        y(value) + 4

      );

    }


    /*
      Important levels
    */

    line(
      signal.level,
      '#f3c34f',
      'KRİTİK BÖLGE'
    );


    const entryMid =
      (
        signal.entry.low +
        signal.entry.high
      ) / 2;


    line(
      entryMid,
      '#18d49c',
      'GİRİŞ'
    );


    line(
      signal.stop,
      '#ff5573',
      'STOP'
    );


    line(
      signal.tp1,
      '#4da3ff',
      'KÂR 1'
    );


    line(
      signal.tp2,
      '#4da3ff',
      'KÂR 2'
    );


    line(
      signal.tp3,
      '#4da3ff',
      'KÂR 3'
    );


    /*
      Big instruction
    */

    context.fillStyle =
      signal.direction ===
      'LONG'
        ? '#18d49c'
        : '#ff5573';


    context.font =
      '900 16px Segoe UI';


    context.fillText(

      signal.direction ===
        'LONG'
        ? 'BURADAN AL / LONG'
        : 'BURADAN SAT / SHORT',

      padding.left,
      18

    );


    context.fillStyle =
      '#8290a0';


    context.font =
      '10px Segoe UI';


    context.fillText(

      '2H grafik · 4H / 2H bölgesi · 15M fiyat yapısı',

      padding.left,
      34

    );


  } catch (error) {

    context.fillStyle =
      '#8290a0';

    context.font =
      '14px Segoe UI';

    context.fillText(
      'Grafik verisi bekleniyor...',
      30,
      55
    );

  }

}


/* =========================================================
   LOAD STATE
========================================================= */

async function loadState() {

  try {

    const response =
      await fetch(
        '/api/state'
      );


    const data =
      await response.json();


    signals =
      data.signals || [];


    $('universe')
      .textContent =
      data.universe;


    $('analyzed')
      .textContent =
      data.analyzed;


    $('count')
      .textContent =
      signals.length;


    $('market')
      .textContent =
      data.market;


    $('scan')
      .textContent =
      data.lastScan
        ? new Date(
            data.lastScan
          ).toLocaleTimeString(
            'tr-TR'
          )
        : '-';


    renderList();


    /*
      İlk açılış
    */

    if (
      !selected &&
      signals.length
    ) {

      selectSignal(
        signals[0].symbol
      );

      return;
    }


    /*
      Seçili coin hâlâ varsa
      canlı verisini güncelle
    */

    if (selected) {

      const fresh =
        signals.find(
          signal =>
            signal.symbol ===
            selected.symbol
        );


      if (fresh) {

        selected =
          fresh;


        $('plan').innerHTML =
          renderPlan(
            selected
          );


        drawChart(
          selected
        );

      } else {

        selected = null;

        $('plan').style.display =
          'none';

        $('legend').style.display =
          'none';

        $('mainTitle').innerHTML =
          'Bir sinyal seç';

      }

    }

  } catch (error) {

    console.error(
      error
    );

  }

}


/* =========================================================
   BUTTONS
========================================================= */

$('refresh').onclick =
  function() {
    loadState();
  };


/* =========================================================
   LIVE
========================================================= */

loadState();


setInterval(
  loadState,
  10_000
);


setInterval(
  function() {

    if (!selected) {
      return;
    }

    selected.ageMs +=
      1000;


    $('plan').innerHTML =
      renderPlan(
        selected
      );


    renderList();

  },
  1000
);


window.addEventListener(
  'resize',
  function() {

    if (selected) {
      drawChart(
        selected
      );
    }

  }
);

</script>

</body>

</html>`;


/* =========================================================
   HTTP SERVER
========================================================= */

function handleRequest(
  request,
  response
) {

  const url =
    new URL(
      request.url,
      'http://localhost'
    );


  /*
    STATE
  */

  if (
    request.method === 'GET' &&
    url.pathname ===
      '/api/state'
  ) {

    return sendJSON(
      response,
      {
        ...state,

        signals:
          state.signals.map(
            safeSignal
          )
      }
    );

  }


  /*
    CHART
  */

  if (
    request.method === 'GET' &&
    url.pathname ===
      '/api/chart'
  ) {

    const symbol =
      url.searchParams.get(
        'symbol'
      );


    const candles =
      candleCache.get(
        `${symbol}:2H`
      ) || [];


    const signal =
      state.signals.find(
        item =>
          item.symbol ===
          symbol
      );


    if (!signal) {

      return sendJSON(
        response,
        {
          candles
        },
        404
      );

    }


    return sendJSON(
      response,
      {
        candles:
          candles.slice(-100),

        level:
          signal.level,

        entry:
          signal.entry,

        stop:
          signal.stop,

        tp1:
          signal.tp1,

        tp2:
          signal.tp2,

        tp3:
          signal.tp3
      }
    );

  }


  /*
    HEALTH
  */

  if (
    request.method === 'GET' &&
    url.pathname ===
      '/health'
  ) {

    return sendJSON(
      response,
      {
        ok: true,

        busy:
          state.busy,

        lastScan:
          state.lastScan,

        signals:
          state.signals.length
      }
    );

  }


  /*
    HOME
  */

  if (
    request.method === 'GET' &&
    url.pathname === '/'
  ) {

    response.writeHead(
      200,
      {
        'content-type':
          'text/html; charset=utf-8',

        'cache-control':
          'no-store'
      }
    );

    return response.end(
      HTML
    );

  }


  response.writeHead(
    404,
    {
      'content-type':
        'text/plain; charset=utf-8'
    }
  );

  response.end(
    'Not found'
  );
}


/* =========================================================
   START
========================================================= */

const server =
  http.createServer(
    handleRequest
  );


server.listen(
  PORT,
  HOST,
  function() {

    console.log(
      '=========================================='
    );

    console.log(
      'Sonny AI Trader FINAL started'
    );

    console.log(
      'Data source: BITGET'
    );

    console.log(
      'Strategy:'
    );

    console.log(
      '4H SUPPORT/RESISTANCE'
    );

    console.log(
      '+ 2H CONFIRMATION'
    );

    console.log(
      '+ 15M STRUCTURE'
    );

    console.log(
      '+ PRICE ACTION'
    );

    console.log(
      '+ REAL MARKET STRUCTURE STOP'
    );

    console.log(
      '+ LIVE ENTRY / TP / STOP'
    );

    console.log(
      'Refresh: Every 60 seconds'
    );

    console.log(
      'Server listening on port ' +
      PORT
    );

    console.log(
      '=========================================='
    );


    scan();


    setInterval(
      scan,
      SCAN_MS
    );

  }
);
