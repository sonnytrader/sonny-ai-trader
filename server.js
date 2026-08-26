// ============================================================
// SONNY AI SIGNAL TERMINAL V10
// 4H SUPPORT/RESISTANCE + 2H CONFIRMATION + 15M STRUCTURE
// BITGET DATA / BINANCE TRADINGVIEW / SIGNAL ONLY
// ============================================================

require('dotenv').config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 10000;

// ============================================================
// CONFIG
// ============================================================

const CONFIG = {
  MAX_COINS: Number(process.env.MAX_COINS || 260),
  MIN_VOLUME_USD: Number(process.env.MIN_VOLUME_USD || 500000),
  MAX_SIGNALS: Number(process.env.MAX_SIGNALS || 12),

  SCAN_INTERVAL_MS: 60 * 1000,
  PRICE_INTERVAL_MS: 5 * 1000,

  LEVEL_LOOKBACK: 80,
  LEVEL_TOLERANCE_PCT: 1.20,
  ZONE_WIDTH_PCT: 0.35,

  SIGNAL_MAX_AGE_MS: 45 * 60 * 1000
};

// ============================================================
// BITGET
// ============================================================

const exchange = new ccxt.bitget({
  apiKey: process.env.BITGET_API_KEY || '',
  secret: process.env.BITGET_SECRET || '',
  password: process.env.BITGET_PASSPHRASE || '',
  enableRateLimit: true,
  timeout: 20000,
  sandbox: false
});

// ============================================================
// STATE
// ============================================================

let universe = [];
let signals = new Map();
let selectedSignalId = null;

let lastScan = 0;
let scanRunning = false;
let priceRunning = false;

const stats = {
  scanned: 0,
  signals: 0,
  errors: 0,
  lastDuration: 0
};

// ============================================================
// HELPERS
// ============================================================

function now() {
  return Date.now();
}

function cleanSymbol(symbol) {
  return String(symbol || '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase();
}

function baseSymbol(symbol) {
  return cleanSymbol(symbol).replace(/USDT$/, '');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatPrice(price) {
  const n = Number(price);

  if (!Number.isFinite(n)) return 0;

  if (n >= 1000) return Number(n.toFixed(2));
  if (n >= 1) return Number(n.toFixed(4));
  if (n >= 0.01) return Number(n.toFixed(6));

  return Number(n.toFixed(8));
}

function distancePct(price, level) {
  if (!price || !level) return 999;

  return Math.abs(price - level) / price * 100;
}

function signalAge(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));

  if (seconds < 60) {
    return `${seconds} sn`;
  }

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    return `${minutes} dk`;
  }

  return `${Math.floor(minutes / 60)} sa ${minutes % 60} dk`;
}

function tradingViewLink(symbol) {
  const coin = baseSymbol(symbol);

  return (
    'https://www.tradingview.com/chart/?symbol=BINANCE%3A' +
    coin +
    'USDT.P'
  );
}

// ============================================================
// ATR
// ============================================================

function calculateATR(candles, period = 14) {
  if (!candles || candles.length < period + 2) {
    return 0;
  }

  const trs = [];

  for (let i = 1; i < candles.length; i++) {
    const high = Number(candles[i][2]);
    const low = Number(candles[i][3]);
    const previousClose = Number(candles[i - 1][4]);

    const tr = Math.max(
      high - low,
      Math.abs(high - previousClose),
      Math.abs(low - previousClose)
    );

    trs.push(tr);
  }

  const recent = trs.slice(-period);

  if (!recent.length) return 0;

  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

// ============================================================
// SWING HIGH
// ============================================================

function isSwingHigh(candles, index, radius = 2) {
  if (
    index < radius ||
    index >= candles.length - radius
  ) {
    return false;
  }

  const high = Number(candles[index][2]);

  for (let i = 1; i <= radius; i++) {
    if (
      high <= Number(candles[index - i][2]) ||
      high < Number(candles[index + i][2])
    ) {
      return false;
    }
  }

  return true;
}

// ============================================================
// SWING LOW
// ============================================================

function isSwingLow(candles, index, radius = 2) {
  if (
    index < radius ||
    index >= candles.length - radius
  ) {
    return false;
  }

  const low = Number(candles[index][3]);

  for (let i = 1; i <= radius; i++) {
    if (
      low >= Number(candles[index - i][3]) ||
      low > Number(candles[index + i][3])
    ) {
      return false;
    }
  }

  return true;
}

// ============================================================
// 15M STRUCTURE
// ============================================================

function analyze15MStructure(candles) {
  if (!candles || candles.length < 30) {
    return {
      direction: 'NEUTRAL',
      text: 'Yeterli 15M yapı yok',
      score: 0
    };
  }

  const highs = [];
  const lows = [];

  for (
    let i = 2;
    i < candles.length - 2;
    i++
  ) {
    if (isSwingHigh(candles, i, 2)) {
      highs.push({
        price: Number(candles[i][2]),
        index: i
      });
    }

    if (isSwingLow(candles, i, 2)) {
      lows.push({
        price: Number(candles[i][3]),
        index: i
      });
    }
  }

  const lastHighs = highs.slice(-3);
  const lastLows = lows.slice(-3);

  if (
    lastHighs.length < 2 ||
    lastLows.length < 2
  ) {
    return {
      direction: 'NEUTRAL',
      text: 'Nötr yapı',
      score: 0
    };
  }

  const h1 =
    lastHighs[lastHighs.length - 2].price;

  const h2 =
    lastHighs[lastHighs.length - 1].price;

  const l1 =
    lastLows[lastLows.length - 2].price;

  const l2 =
    lastLows[lastLows.length - 1].price;

  if (h2 > h1 && l2 > l1) {
    return {
      direction: 'LONG',
      text: 'HH + HL',
      score: 1
    };
  }

  if (h2 < h1 && l2 < l1) {
    return {
      direction: 'SHORT',
      text: 'LH + LL',
      score: 1
    };
  }

  return {
    direction: 'NEUTRAL',
    text: 'Kararsız yapı',
    score: 0
  };
}

// ============================================================
// BUILD LEVELS
// ============================================================

function buildLevels(candles, timeframe) {
  const raw = [];

  const start = Math.max(
    2,
    candles.length - CONFIG.LEVEL_LOOKBACK
  );

  for (
    let i = start;
    i < candles.length - 2;
    i++
  ) {
    if (isSwingHigh(candles, i, 2)) {
      raw.push({
        price: Number(candles[i][2]),
        type: 'RESISTANCE',
        timeframe,
        index: i
      });
    }

    if (isSwingLow(candles, i, 2)) {
      raw.push({
        price: Number(candles[i][3]),
        type: 'SUPPORT',
        timeframe,
        index: i
      });
    }
  }

  raw.sort((a, b) => a.price - b.price);

  const zones = [];

  for (const point of raw) {
    const existing = zones.find(zone => {
      return (
        Math.abs(point.price - zone.price) /
          point.price *
          100 <=
        CONFIG.ZONE_WIDTH_PCT
      );
    });

    if (existing) {
      existing.prices.push(point.price);
      existing.types.add(point.type);
      existing.lastIndex = Math.max(
        existing.lastIndex,
        point.index
      );

      existing.price =
        existing.prices.reduce(
          (a, b) => a + b,
          0
        ) / existing.prices.length;
    } else {
      zones.push({
        price: point.price,
        prices: [point.price],
        types: new Set([point.type]),
        lastIndex: point.index
      });
    }
  }

  return zones.map(zone => ({
    price: zone.price,

    type:
      zone.types.has('SUPPORT') &&
      zone.types.has('RESISTANCE')
        ? 'BOTH'
        : [...zone.types][0],

    timeframe,

    touches: zone.prices.length,

    lastIndex: zone.lastIndex
  }));
}

// ============================================================
// MERGE 4H + 2H
// ============================================================

function mergeMultiTimeframeLevels(
  levels4H,
  levels2H,
  currentPrice
) {
  const merged = [];

  for (const level4H of levels4H) {
    if (level4H.type === 'BOTH') continue;

    const matching2H = levels2H.find(level2H => {
      if (level2H.type !== level4H.type) {
        return false;
      }

      return (
        Math.abs(
          level2H.price -
          level4H.price
        ) /
          level4H.price *
          100 <=
        CONFIG.ZONE_WIDTH_PCT
      );
    });

    const finalPrice = matching2H
      ? (level4H.price + matching2H.price) / 2
      : level4H.price;

    merged.push({
      price: finalPrice,

      type: level4H.type,

      h4: true,
      h2: Boolean(matching2H),

      touches:
        level4H.touches +
        (matching2H ? matching2H.touches : 0),

      strength:
        level4H.touches +
        (matching2H
          ? matching2H.touches + 3
          : 0),

      distance: distancePct(
        currentPrice,
        finalPrice
      )
    });
  }

  for (const level2H of levels2H) {
    if (level2H.type === 'BOTH') continue;

    const exists = merged.some(level => {
      return (
        level.type === level2H.type &&
        Math.abs(
          level.price -
          level2H.price
        ) /
          level2H.price *
          100 <=
        CONFIG.ZONE_WIDTH_PCT
      );
    });

    if (exists) continue;

    merged.push({
      price: level2H.price,

      type: level2H.type,

      h4: false,
      h2: true,

      touches: level2H.touches,
      strength: level2H.touches,

      distance: distancePct(
        currentPrice,
        level2H.price
      )
    });
  }

  return merged
    .filter(
      level =>
        level.distance <=
        CONFIG.LEVEL_TOLERANCE_PCT
    )
    .sort(
      (a, b) =>
        a.distance -
        b.distance
    );
}

// ============================================================
// OHLCV
// ============================================================

async function fetchOHLCV(
  symbol,
  timeframe,
  limit
) {
  try {
    return await exchange.fetchOHLCV(
      symbol,
      timeframe,
      undefined,
      limit
    );
  } catch (error) {
    stats.errors++;
    return [];
  }
}

// ============================================================
// DISCOVERY
// ============================================================

async function fetchUniverse() {
  await exchange.loadMarkets(true);

  const markets =
    Object.values(exchange.markets)
      .filter(m => {
        return (
          m &&
          m.active !== false &&
          m.quote === 'USDT' &&
          (m.swap || m.contract) &&
          !String(m.symbol).includes(':')
        );
      });

  let tickers = {};

  const symbols =
    markets
      .slice(0, 500)
      .map(m => m.symbol);

  try {
    tickers =
      await exchange.fetchTickers(
        symbols
      );
  } catch (error) {
    console.log(
      'Ticker toplu istek hatası:',
      error.message
    );
  }

  const ranked =
    markets
      .map(m => {
        const ticker =
          tickers[m.symbol];

        const volume = Number(
          ticker?.quoteVolume ||
          ticker?.info?.quoteVol ||
          0
        );

        const last = Number(
          ticker?.last ||
          ticker?.close ||
          0
        );

        return {
          symbol: m.symbol,
          volume,
          last
        };
      })
      .filter(item => {
        return (
          item.last > 0 &&
          item.volume >=
            CONFIG.MIN_VOLUME_USD
        );
      })
      .sort(
        (a, b) =>
          b.volume -
          a.volume
      );

  universe =
    ranked.slice(
      0,
      CONFIG.MAX_COINS
    );

  console.log(
    `Discovery tamamlandı. ${universe.length} uygun coin bulundu.`
  );
}

// ============================================================
// CREATE SIGNAL
// ============================================================

function createSignal(
  symbol,
  price,
  levels,
  candles15,
  candles4H,
  candles2H
) {
  if (!levels.length) return null;

  const candidate = levels[0];

  let direction;

  if (
    candidate.type ===
    'SUPPORT'
  ) {
    direction = 'LONG';
  } else if (
    candidate.type ===
    'RESISTANCE'
  ) {
    direction = 'SHORT';
  } else {
    return null;
  }

  const structure =
    analyze15MStructure(
      candles15
    );

  /*
   * 15M yapı ters yöndeyse sinyali
   * reddet.
   *
   * NEUTRAL ise sinyal devam eder.
   */
  if (
    structure.direction !==
      'NEUTRAL' &&
    structure.direction !==
      direction
  ) {
    return null;
  }

  const level =
    Number(candidate.price);

  const atr =
    calculateATR(
      candles15,
      14
    );

  /*
   * Giriş bölgesi:
   * ATR'nin bir kısmı ile
   * seviyenin yüzdesinden
   * daha geniş olan kullanılır.
   */
  const zoneHalf =
    Math.max(
      level *
        CONFIG.ZONE_WIDTH_PCT /
        100,

      atr
        ? atr * 0.35
        : level * 0.0015
    );

  const entryLow =
    level - zoneHalf;

  const entryHigh =
    level + zoneHalf;

  /*
   * Stop:
   * LONG -> desteğin altında
   * SHORT -> direncin üstünde
   */
  const stopDistance =
    Math.max(
      atr
        ? atr * 1.25
        : level * 0.01,

      level * 0.006
    );

  const stop =
    direction === 'LONG'
      ? entryLow - stopDistance
      : entryHigh + stopDistance;

  const referenceEntry =
    direction === 'LONG'
      ? entryHigh
      : entryLow;

  const risk =
    Math.abs(
      referenceEntry -
      stop
    );

  /*
   * TP seviyeleri
   */
  const tp1 =
    direction === 'LONG'
      ? entryHigh + risk * 1.4
      : entryLow - risk * 1.4;

  const tp2 =
    direction === 'LONG'
      ? entryHigh + risk * 2.2
      : entryLow - risk * 2.2;

  const tp3 =
    direction === 'LONG'
      ? entryHigh + risk * 3.0
      : entryLow - risk * 3.0;

  /*
   * Kalite skoru
   */
  let score = 55;

  if (candidate.h4) {
    score += 15;
  }

  if (candidate.h2) {
    score += 15;
  }

  if (candidate.touches >= 3) {
    score += 5;
  }

  if (candidate.touches >= 5) {
    score += 5;
  }

  if (
    structure.direction ===
    direction
  ) {
    score += 12;
  }

  score -= Math.min(
    12,
    candidate.distance * 4
  );

  score = Math.max(
    55,
    Math.min(
      99,
      Math.round(score)
    )
  );

  let status = 'WAITING';

  if (
    price >= entryLow &&
    price <= entryHigh
  ) {
    status = 'ENTRY';
  }

  const id =
    cleanSymbol(symbol) +
    '-' +
    direction +
    '-' +
    Math.round(
      level * 100000000
    );

  return {
    id,

    symbol,

    direction,

    confidence: score,

    price,

    lastPrice: price,

    level,

    levelType:
      candidate.type,

    distancePct:
      Number(
        candidate.distance.toFixed(3)
      ),

    entryLow:
      formatPrice(entryLow),

    entryHigh:
      formatPrice(entryHigh),

    stop:
      formatPrice(stop),

    tp1:
      formatPrice(tp1),

    tp2:
      formatPrice(tp2),

    tp3:
      formatPrice(tp3),

    status,

    createdAt: now(),
    updatedAt: now(),

    structure:
      structure.direction,

    structureText:
      structure.text,

    touches:
      candidate.touches,

    strong:
      Boolean(
        candidate.h4 &&
        candidate.h2
      ),

    reason:
      `${candidate.h4 ? '4H' : ''}` +
      `${candidate.h4 && candidate.h2 ? ' + ' : ''}` +
      `${candidate.h2 ? '2H' : ''}` +
      ` bölge + ${candidate.touches} temas` +
      `${
        structure.direction ===
        direction
          ? ' + 15M yapı onayı'
          : ''
      }`,

    tvLink:
      tradingViewLink(
        symbol
      ),

    chart: {
      candles15,
      level,
      entryLow,
      entryHigh,
      stop,
      tp1,
      tp2,
      tp3
    }
  };
}

// ============================================================
// SIGNAL PAYLOAD
// ============================================================

function getSignalPayload() {
  return [...signals.values()]
    .sort((a, b) => {
      const aEntry =
        a.status === 'ENTRY'
          ? 1
          : 0;

      const bEntry =
        b.status === 'ENTRY'
          ? 1
          : 0;

      return (
        bEntry - aEntry ||
        b.confidence -
          a.confidence
      );
    })
    .slice(
      0,
      CONFIG.MAX_SIGNALS
    )
    .map(signal => ({
      ...signal,

      ageMs:
        now() -
        signal.createdAt,

      ageText:
        signalAge(
          now() -
          signal.createdAt
        )
    }));
}

// ============================================================
// BROADCAST
// ============================================================

function broadcast(type = 'state') {
  const payload = {
    type,

    signals:
      getSignalPayload(),

    selected:
      selectedSignalId
        ? signals.get(
            selectedSignalId
          ) || null
        : null,

    stats: {
      ...stats,

      universe:
        universe.length,

      active:
        signals.size
    },

    lastScan,

    market:
      'BITGET',

    tradingView:
      'BINANCE',

    serverTime:
      now()
  };

  const text =
    JSON.stringify(payload);

  for (
    const client of wss.clients
  ) {
    if (
      client.readyState ===
      WebSocket.OPEN
    ) {
      try {
        client.send(text);
      } catch {}
    }
  }
}

// ============================================================
// LIVE SIGNAL LIFECYCLE
// ============================================================

function updateSignalLifecycle(
  signal,
  price
) {
  signal.lastPrice =
    price;

  signal.updatedAt =
    now();

  const inside =
    price >=
      signal.entryLow &&
    price <=
      signal.entryHigh;

  if (inside) {
    signal.status =
      'ENTRY';
  } else if (
    signal.direction ===
      'LONG' &&
    price >
      signal.entryHigh
  ) {
    signal.status =
      'MISSED';
  } else if (
    signal.direction ===
      'SHORT' &&
    price <
      signal.entryLow
  ) {
    signal.status =
      'MISSED';
  } else {
    signal.status =
      'WAITING';
  }

  if (
    signal.status ===
    'MISSED'
  ) {
    return false;
  }

  if (
    now() -
      signal.createdAt >
    CONFIG.SIGNAL_MAX_AGE_MS
  ) {
    return false;
  }

  return true;
}

// ============================================================
// LIVE PRICE
// ============================================================

async function updateLivePrices() {
  if (
    priceRunning ||
    signals.size === 0
  ) {
    return;
  }

  priceRunning = true;

  try {
    const active =
      [...signals.values()];

    /*
     * Tek tek ticker yerine mümkün olduğunda
     * toplu ticker kullan.
     */
    let tickers = {};

    try {
      tickers =
        await exchange.fetchTickers(
          active.map(
            signal =>
              signal.symbol
          )
        );
    } catch {
      tickers = {};
    }

    for (
      const signal of active
    ) {
      try {
        const ticker =
          tickers[
            signal.symbol
          ];

        let price =
          Number(
            ticker?.last ||
            ticker?.close ||
            0
          );

        /*
         * Toplu ticker bulunamazsa
         * tekil istek fallback.
         */
        if (!price) {
          const single =
            await exchange.fetchTicker(
              signal.symbol
            );

          price =
            Number(
              single?.last ||
              single?.close ||
              0
            );
        }

        if (!price) {
          continue;
        }

        const alive =
          updateSignalLifecycle(
            signal,
            price
          );

        if (!alive) {
          signals.delete(
            signal.id
          );

          if (
            selectedSignalId ===
            signal.id
          ) {
            selectedSignalId =
              null;
          }
        }
      } catch {
        stats.errors++;
      }
    }

    stats.signals =
      signals.size;

    broadcast(
      'price_update'
    );
  } finally {
    priceRunning =
      false;
  }
}

// ============================================================
// ANALYZE COIN
// ============================================================

async function analyzeCoin(
  item
) {
  const symbol =
    item.symbol;

  const [
    candles4H,
    candles2H,
    candles15
  ] =
    await Promise.all([
      fetchOHLCV(
        symbol,
        '4h',
        100
      ),

      fetchOHLCV(
        symbol,
        '2h',
        100
      ),

      fetchOHLCV(
        symbol,
        '15m',
        120
      )
    ]);

  if (
    candles4H.length < 30 ||
    candles2H.length < 30 ||
    candles15.length < 30
  ) {
    return null;
  }

  const price =
    Number(
      candles15[
        candles15.length - 1
      ][4]
    );

  if (!price) {
    return null;
  }

  const levels4H =
    buildLevels(
      candles4H,
      '4H'
    );

  const levels2H =
    buildLevels(
      candles2H,
      '2H'
    );

  const merged =
    mergeMultiTimeframeLevels(
      levels4H,
      levels2H,
      price
    );

  return createSignal(
    symbol,
    price,
    merged,
    candles15,
    candles4H,
    candles2H
  );
}

// ============================================================
// SIGNAL COMPARISON
// ============================================================

function shouldReplace(
  oldSignal,
  newSignal
) {
  if (!oldSignal) {
    return true;
  }

  if (
    newSignal.confidence >
    oldSignal.confidence
  ) {
    return true;
  }

  if (
    newSignal.distancePct <
    oldSignal.distancePct
  ) {
    return true;
  }

  return false;
}

// ============================================================
// MAIN SCAN
// ============================================================

async function runScan() {
  if (scanRunning) {
    return;
  }

  scanRunning = true;

  const started =
    now();

  try {
    /*
     * Discovery başlangıçta yapılır.
     */
    if (
      universe.length === 0
    ) {
      await fetchUniverse();
    }

    /*
     * Her 10 dakikada evreni yenile.
     */
    if (
      lastScan &&
      now() -
        lastScan >
        10 * 60 * 1000
    ) {
      await fetchUniverse();
    }

    const candidates = [];

    /*
     * Coinleri sırayla analiz ediyoruz.
     * Bitget 429 riskini azaltmak için
     * küçük gecikme bırakıyoruz.
     */
    for (
      const item of universe
    ) {
      try {
        const signal =
          await analyzeCoin(
            item
          );

        if (signal) {
          candidates.push(
            signal
          );
        }
      } catch (error) {
        stats.errors++;
      }

      await sleep(30);
    }

    /*
     * Aynı coin için en iyi adayı seç.
     */
    const bestByCoin =
      new Map();

    for (
      const signal of
      candidates
    ) {
      const key =
        cleanSymbol(
          signal.symbol
        );

      const old =
        bestByCoin.get(
          key
        );

      if (
        shouldReplace(
          old,
          signal
        )
      ) {
        bestByCoin.set(
          key,
          signal
        );
      }
    }

    /*
     * Yeni sinyalleri ekle.
     */
    for (
      const signal of
      bestByCoin.values()
    ) {
      const sameCoin =
        [...signals.values()]
          .find(
            existing =>
              cleanSymbol(
                existing.symbol
              ) ===
              cleanSymbol(
                signal.symbol
              )
          );

      /*
       * Halihazırda ENTRY durumundaki
       * sinyali tarama sonucu değiştirme.
       */
      if (
        sameCoin &&
        sameCoin.status ===
          'ENTRY'
      ) {
        sameCoin.lastPrice =
          signal.price;

        sameCoin.updatedAt =
          now();

        continue;
      }

      if (
        shouldReplace(
          sameCoin,
          signal
        )
      ) {
        /*
         * Aynı sinyal tekrar bulunduysa
         * yaşını koru.
         */
        if (
          sameCoin &&
          sameCoin.id ===
            signal.id
        ) {
          signal.createdAt =
            sameCoin.createdAt;
        }

        if (sameCoin) {
          signals.delete(
            sameCoin.id
          );
        }

        signals.set(
          signal.id,
          signal
        );
      }
    }

    /*
     * Sinyalleri kaliteye göre sırala.
     */
    const sorted =
      [...signals.values()]
        .sort((a, b) => {
          const aEntry =
            a.status ===
              'ENTRY'
              ? 1
              : 0;

          const bEntry =
            b.status ===
              'ENTRY'
              ? 1
              : 0;

          return (
            bEntry -
              aEntry ||
            b.confidence -
              a.confidence ||
            a.distancePct -
              b.distancePct
          );
        })
        .slice(
          0,
          CONFIG.MAX_SIGNALS
        );

    signals =
      new Map(
        sorted.map(
          signal => [
            signal.id,
            signal
          ]
        )
      );

    stats.scanned =
      universe.length;

    stats.signals =
      signals.size;

    stats.lastDuration =
      now() -
      started;

    lastScan =
      now();

    console.log(
      `RADAR tamamlandı | ` +
      `Universe=${universe.length} | ` +
      `Analiz=${universe.length} | ` +
      `SIGNAL=${signals.size}`
    );

    broadcast(
      'scan_complete'
    );
  } catch (error) {
    stats.errors++;

    console.error(
      'RADAR ERROR:',
      error.message
    );

    broadcast(
      'error'
    );
  } finally {
    scanRunning =
      false;
  }
}

// ============================================================
// API - STATE
// ============================================================

app.get(
  '/api/state',
  (req, res) => {
    res.json({
      signals:
        getSignalPayload(),

      selected:
        selectedSignalId
          ? signals.get(
              selectedSignalId
            ) || null
          : null,

      stats: {
        ...stats,

        universe:
          universe.length,

        active:
          signals.size
      },

      lastScan,

      serverTime:
        now()
    });
  }
);

// ============================================================
// API - SIGNAL
// ============================================================

app.get(
  '/api/signal/:id',
  (req, res) => {
    res.json(
      signals.get(
        req.params.id
      ) || null
    );
  }
);

// ============================================================
// API - SELECT
// ============================================================

app.post(
  '/api/select',
  (req, res) => {
    selectedSignalId =
      req.body?.id ||
      null;

    broadcast(
      'selection'
    );

    res.json({
      ok: true
    });
  }
);

// ============================================================
// API - MANUAL SCAN
// ============================================================

app.post(
  '/api/scan',
  async (req, res) => {
    runScan().catch(
      () => {}
    );

    res.json({
      ok: true,
      message:
        'Tarama başlatıldı'
    });
  }
);

// ============================================================
// HEALTH
// ============================================================

app.get(
  '/health',
  (req, res) => {
    res.json({
      ok: true,
      uptime:
        process.uptime(),
      signals:
        signals.size,
      lastScan
    });
  }
);

// ============================================================
// FRONTEND
// ============================================================

const INDEX_HTML = [
  '<!doctype html>',
  '<html lang="tr">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<title>Sonny AI Trader V10</title>',

  '<style>',

  ':root{',
  '--bg:#080b10;',
  '--panel:#10151d;',
  '--panel2:#141b25;',
  '--line:#26303d;',
  '--text:#edf2f7;',
  '--muted:#8d99a8;',
  '--green:#18d889;',
  '--red:#ff4d67;',
  '--yellow:#ffc857;',
  '--blue:#58a6ff;',
  '}',

  '*{box-sizing:border-box;}',

  'body{',
  'margin:0;',
  'background:var(--bg);',
  'color:var(--text);',
  'font-family:Inter,Segoe UI,Arial,sans-serif;',
  'height:100vh;',
  'overflow:hidden;',
  '}',

  '.app{',
  'height:100vh;',
  'display:grid;',
  'grid-template-columns:330px 1fr 310px;',
  'grid-template-rows:72px 1fr;',
  '}',

  '.top{',
  'grid-column:1 / 4;',
  'border-bottom:1px solid var(--line);',
  'display:flex;',
  'align-items:center;',
  'gap:12px;',
  'padding:12px 18px;',
  'background:#0b0f15;',
  'overflow:auto;',
  '}',

  '.brand{',
  'font-weight:900;',
  'font-size:19px;',
  'white-space:nowrap;',
  '}',

  '.brand b{color:var(--green);}',

  '.pill{',
  'border:1px solid var(--line);',
  'background:var(--panel);',
  'padding:9px 12px;',
  'border-radius:10px;',
  'color:var(--muted);',
  'white-space:nowrap;',
  '}',

  '.pill strong{',
  'color:var(--text);',
  'margin-left:4px;',
  '}',

  '.live{color:var(--green)!important;}',

  '.side{',
  'min-width:0;',
  'background:var(--panel);',
  'border-right:1px solid var(--line);',
  'overflow:auto;',
  '}',

  '.right{',
  'min-width:0;',
  'background:var(--panel);',
  'border-left:1px solid var(--line);',
  'overflow:auto;',
  '}',

  '.title{',
  'padding:17px 16px;',
  'border-bottom:1px solid var(--line);',
  'font-weight:800;',
  '}',

  '.signal{',
  'margin:10px;',
  'border:1px solid var(--line);',
  'background:var(--panel2);',
  'border-radius:13px;',
  'padding:13px;',
  'cursor:pointer;',
  'transition:.15s;',
  '}',

  '.signal:hover,.signal.sel{',
  'border-color:#59687a;',
  'transform:translateY(-1px);',
  '}',

  '.signal.long{border-left:4px solid var(--green);}',
  '.signal.short{border-left:4px solid var(--red);}',

  '.row{',
  'display:flex;',
  'justify-content:space-between;',
  'gap:8px;',
  '}',

  '.coin{',
  'font-weight:900;',
  'font-size:16px;',
  '}',

  '.longtxt{color:var(--green);}',
  '.shorttxt{color:var(--red);}',

  '.badge{',
  'font-size:11px;',
  'padding:4px 7px;',
  'border-radius:6px;',
  'background:#1b2430;',
  'color:var(--muted);',
  '}',

  '.entrybadge{',
  'background:#123b2b;',
  'color:var(--green);',
  '}',

  '.waitbadge{',
  'background:#302b16;',
  'color:var(--yellow);',
  '}',

  '.meta{',
  'color:var(--muted);',
  'font-size:12px;',
  'margin-top:8px;',
  '}',

  '.center{',
  'min-width:0;',
  'display:flex;',
  'flex-direction:column;',
  'background:#090d13;',
  '}',

  '.charthead{',
  'padding:14px 18px;',
  'border-bottom:1px solid var(--line);',
  'display:flex;',
  'justify-content:space-between;',
  '}',

  '.chartwrap{',
  'position:relative;',
  'flex:1;',
  'min-height:0;',
  '}',

  '.chart{',
  'position:absolute;',
  'inset:0;',
  '}',

  '.empty{',
  'height:100%;',
  'display:grid;',
  'place-items:center;',
  'color:var(--muted);',
  'font-size:16px;',
  '}',

  '.details{',
  'padding:18px;',
  '}',

  '.bigdir{',
  'font-size:30px;',
  'font-weight:950;',
  'margin:7px 0 18px;',
  '}',

  '.score{',
  'font-size:13px;',
  'color:var(--muted);',
  '}',

  '.score strong{',
  'font-size:25px;',
  'color:var(--text);',
  '}',

  '.price{',
  'font-size:26px;',
  'font-weight:900;',
  'margin:5px 0 20px;',
  '}',

  '.kv{',
  'display:grid;',
  'grid-template-columns:1fr 1fr;',
  'gap:8px;',
  'margin-top:10px;',
  '}',

  '.box{',
  'background:var(--panel2);',
  'border:1px solid var(--line);',
  'border-radius:10px;',
  'padding:11px;',
  '}',

  '.box label{',
  'display:block;',
  'color:var(--muted);',
  'font-size:11px;',
  'margin-bottom:5px;',
  '}',

  '.box b{font-size:14px;}',

  '.why{',
  'margin-top:16px;',
  'background:var(--panel2);',
  'border:1px solid var(--line);',
  'border-radius:10px;',
  'padding:12px;',
  'line-height:1.6;',
  'color:#cbd4df;',
  '}',

  '.tv{',
  'display:block;',
  'text-align:center;',
  'margin-top:16px;',
  'padding:12px;',
  'border-radius:9px;',
  'background:#263041;',
  'color:white;',
  'text-decoration:none;',
  'font-weight:800;',
  '}',

  '.foot{',
  'padding:10px 16px;',
  'color:var(--muted);',
  'font-size:11px;',
  'border-top:1px solid var(--line);',
  '}',

  'canvas{',
  'width:100%;',
  'height:100%;',
  '}',

  '@media(max-width:1000px){',
  '.app{grid-template-columns:280px 1fr;}',
  '.right{display:none;}',
  '}',

  '@media(max-width:700px){',
  '.app{',
  'grid-template-columns:1fr;',
  'grid-template-rows:auto auto 1fr;',
  '}',
  '.top{grid-column:1;}',
  '.side{display:none;}',
  '}',

  '</style>',
  '</head>',

  '<body>',

  '<div class="app">',

  '<header class="top">',

  '<div class="brand">',
  '⚡ SONNY <b>AI TRADER V10</b>',
  '</div>',

  '<div class="pill live">',
  '● CANLI <strong id="age">-</strong>',
  '</div>',

  '<div class="pill">',
  'EVREN <strong id="universe">0</strong>',
  '</div>',

  '<div class="pill">',
  'AKTİF <strong id="active">0</strong>',
  '</div>',

  '<div class="pill">',
  'SON TARAMA <strong id="scan">-</strong>',
  '</div>',

  '<div class="pill">',
  'VERİ <strong>BITGET</strong> · TV <strong>BINANCE</strong>',
  '</div>',

  '</header>',

  '<aside class="side">',

  '<div class="title">',
  'AKTİF SİNYALLER <span id="sigcount">0</span>',
  '</div>',

  '<div id="signals"></div>',

  '<div class="foot">',
  'Sinyal giriş bölgesini geçerse otomatik olarak kaldırılır.',
  '</div>',

  '</aside>',

  '<main class="center">',

  '<div class="charthead">',
  '<b id="charttitle">Sinyal seç</b>',
  '<span id="chartstatus">-</span>',
  '</div>',

  '<div class="chartwrap">',
  '<canvas id="chart"></canvas>',
  '<div class="empty" id="empty">Soldan bir sinyal seç.</div>',
  '</div>',

  '</main>',

  '<aside class="right">',

  '<div class="title">SONNY KARARI</div>',

  '<div id="details" class="details">',
  '<div class="empty" style="height:300px">Sinyal seç.</div>',
  '</div>',

  '</aside>',

  '</div>',

  '<script>',

  'let state = { signals: [], selected: null, stats: {}, lastScan: 0 };',
  'let ws = null;',

  'function $(id) {',
  '  return document.getElementById(id);',
  '}',

  'function fmt(n) {',
  '  n = Number(n);',
  '  if (!Number.isFinite(n)) return "-";',
  '  if (n >= 1000) return n.toLocaleString("en-US",{maximumFractionDigits:2});',
  '  if (n >= 1) return n.toLocaleString("en-US",{maximumFractionDigits:4});',
  '  return n.toLocaleString("en-US",{maximumFractionDigits:8});',
  '}',

  'function ageText(ms) {',
  '  let seconds = Math.max(0, Math.floor(ms / 1000));',
  '  if (seconds < 60) return seconds + " sn";',
  '  let minutes = Math.floor(seconds / 60);',
  '  if (minutes < 60) return minutes + " dk";',
  '  return Math.floor(minutes / 60) + " sa " + (minutes % 60) + " dk";',
  '}',

  'function escapeHtml(value) {',
  '  return String(value ?? "")',
  '    .replace(/&/g,"&amp;")',
  '    .replace(/</g,"&lt;")',
  '    .replace(/>/g,"&gt;")',
  '    .replace(/"/g,"&quot;")',
  '    .replace(/\\x27/g,"&#039;");',
  '}',

  'function render() {',

  '  const sigs = state.signals || [];',

  '  $("universe").textContent = state.stats?.universe || 0;',
  '  $("active").textContent = sigs.length;',
  '  $("sigcount").textContent = sigs.length;',

  '  $("scan").textContent = state.lastScan',
  '    ? new Date(state.lastScan).toLocaleTimeString("tr-TR")',
  '    : "-";',

  '  $("signals").innerHTML = sigs.length',
  '    ? sigs.map(function(signal) {',

  '        const isLong = signal.direction === "LONG";',
  '        const isEntry = signal.status === "ENTRY";',

  '        return',
  '          "<div class=\\"signal " +',
  '          (isLong ? "long" : "short") +',
  '          (state.selected?.id === signal.id ? " sel" : "") +',
  '          "\\" data-id=\\"" +',
  '          escapeHtml(signal.id) +',
  '          "\\">" +',

  '          "<div class=\\"row\\">" +',
  '          "<span class=\\"coin\\">" +',
  '          escapeHtml(signal.symbol) +',
  '          "</span>" +',
  '          "<b class=\\"" +',
  '          (isLong ? "longtxt" : "shorttxt") +',
  '          "\\">" +',
  '          escapeHtml(signal.direction) +',
  '          "</b></div>" +',

  '          "<div class=\\"row\\" style=\\"margin-top:8px\\">" +',
  '          "<span class=\\"badge " +',
  '          (isEntry ? "entrybadge" : "waitbadge") +',
  '          "\\">" +',
  '          (isEntry ? "GİRİŞ BÖLGESİNDE" : "BEKLENİYOR") +',
  '          "</span>" +',
  '          "<span class=\\"badge\\">" +',
  '          escapeHtml(signal.confidence) +',
  '          "/100</span>" +',
  '          "</div>" +',

  '          "<div class=\\"meta\\">" +',
  '          "Canlı " + escapeHtml(fmt(signal.lastPrice)) +',
  '          " · " + escapeHtml(ageText(Date.now() - signal.createdAt)) +',
  '          " önce</div>" +',

  '          "</div>";',

  '      }).join("")',
  '    : "<div class=\\"foot\\">Şu an aktif sinyal yok.</div>";',

  '  document.querySelectorAll(".signal").forEach(function(el) {',
  '    el.onclick = function() {',
  '      selectSignal(el.getAttribute("data-id"));',
  '    };',
  '  });',

  '  renderDetails();',
  '  renderChart();',
  '}',

  'async function selectSignal(id) {',

  '  state.selected = state.signals.find(function(s) {',
  '    return s.id === id;',
  '  }) || null;',

  '  render();',

  '  try {',
  '    await fetch("/api/select",{',
  '      method:"POST",',
  '      headers:{"Content-Type":"application/json"},',
  '      body:JSON.stringify({id:id})',
  '    });',
  '  } catch {}',

  '}',

  'function renderDetails() {',

  '  const s = state.selected;',

  '  if (!s) {',
  '    $("details").innerHTML =',
  '      \'<div class="empty" style="height:300px">Sinyal seç.</div>\';',
  '    $("charttitle").textContent = "Sinyal seç";',
  '    $("chartstatus").textContent = "-";',
  '    return;',
  '  }',

  '  const isLong = s.direction === "LONG";',
  '  const cls = isLong ? "longtxt" : "shorttxt";',

  '  $("charttitle").textContent = s.symbol + " · " + s.direction;',
  '  $("chartstatus").textContent =',
  '    s.status === "ENTRY"',
  '      ? "● GİRİŞ BÖLGESİNDE"',
  '      : "○ BEKLENİYOR";',

  '  $("details").innerHTML =',

  '    \'<div class="score">KALİTE <strong>\' +',
  '    escapeHtml(s.confidence) +',
  '    \'/100</strong></div>\' +',

  '    \'<div class="bigdir \' + cls + \'">\' +',
  '    escapeHtml(s.direction) +',
  '    "</div>" +',

  '    \'<div class="score">CANLI FİYAT</div>\' +',
  '    \'<div class="price">\' +',
  '    escapeHtml(fmt(s.lastPrice)) +',
  '    "</div>" +',

  '    \'<div class="kv">\' +',

  '    \'<div class="box"><label>GİRİŞ</label><b>\' +',
  '    escapeHtml(fmt(s.entryLow)) +',
  '    " - " +',
  '    escapeHtml(fmt(s.entryHigh)) +',
  '    "</b></div>" +',

  '    \'<div class="box"><label>SEVİYE</label><b>\' +',
  '    escapeHtml(fmt(s.level)) +',
  '    "</b></div>" +',

  '    \'<div class="box"><label>STOP</label><b>\' +',
  '    escapeHtml(fmt(s.stop)) +',
  '    "</b></div>" +',

  '    \'<div class="box"><label>TP1</label><b>\' +',
  '    escapeHtml(fmt(s.tp1)) +',
  '    "</b></div>" +',

  '    \'<div class="box"><label>TP2</label><b>\' +',
  '    escapeHtml(fmt(s.tp2)) +',
  '    "</b></div>" +',

  '    \'<div class="box"><label>TP3</label><b>\' +',
  '    escapeHtml(fmt(s.tp3)) +',
  '    "</b></div>" +',

  '    "</div>" +',

  '    \'<div class="why"><b>NEDEN?</b><br>\' +',
  '    escapeHtml(s.reason) +',
  '    \'<br><span style="color:#8d99a8">15M yapı: \' +',
  '    escapeHtml(s.structureText) +',
  '    " · " +',
  '    escapeHtml(s.touches) +',
  '    " temas</span>" +',
  '    \'<br><span style="color:#8d99a8">Sinyal yaşı: \' +',
  '    escapeHtml(ageText(Date.now() - s.createdAt)) +',
  '    "</span></div>" +',

  '    \'<a class="tv" href="\' +',
  '    escapeHtml(s.tvLink) +',
  '    \'" target="_blank">📊 BINANCE TRADINGVIEW AÇ</a>";',
  '}',

  'function renderChart() {',

  '  const s = state.selected;',
  '  const canvas = $("chart");',
  '  const ctx = canvas.getContext("2d");',
  '  const rect = canvas.getBoundingClientRect();',
  '  const dpr = window.devicePixelRatio || 1;',

  '  canvas.width = Math.max(1, rect.width * dpr);',
  '  canvas.height = Math.max(1, rect.height * dpr);',

  '  ctx.setTransform(dpr,0,0,dpr,0,0);',
  '  ctx.clearRect(0,0,rect.width,rect.height);',

  '  if (!s || !s.chart || !s.chart.candles15 || !s.chart.candles15.length) {',
  '    $("empty").style.display = "grid";',
  '    return;',
  '  }',

  '  $("empty").style.display = "none";',

  '  const data = s.chart.candles15;',
  '  const W = rect.width;',
  '  const H = rect.height;',

  '  const pad = {l:70,r:25,t:25,b:35};',

  '  let low = Math.min.apply(null,data.map(function(k){return Number(k[3]);}));',
  '  let high = Math.max.apply(null,data.map(function(k){return Number(k[2]);}));',

  '  low = Math.min(low,Number(s.stop),Number(s.tp3),Number(s.entryLow));',
  '  high = Math.max(high,Number(s.stop),Number(s.tp3),Number(s.entryHigh));',

  '  const range = Math.max(0.00000001,high-low);',

  '  function y(price) {',
  '    return pad.t + ((high-price)/range)*(H-pad.t-pad.b);',
  '  }',

  '  function x(index) {',
  '    return pad.l + (index/Math.max(1,data.length-1))*(W-pad.l-pad.r);',
  '  }',

  '  ctx.strokeStyle = "#1f2935";',
  '  ctx.lineWidth = 1;',

  '  for (let i=0;i<7;i++) {',
  '    const yy = pad.t + i*(H-pad.t-pad.b)/6;',
  '    ctx.beginPath();',
  '    ctx.moveTo(pad.l,yy);',
  '    ctx.lineTo(W-pad.r,yy);',
  '    ctx.stroke();',
  '    ctx.fillStyle = "#718096";',
  '    ctx.font = "11px Arial";',
  '    ctx.fillText(fmt(high-range*i/6),8,yy+4);',
  '  }',

  '  const candleWidth = Math.max(2,Math.min(8,(W-pad.l-pad.r)/data.length*0.65));',

  '  data.forEach(function(k,i) {',

  '    const xx = x(i);',
  '    const open = y(Number(k[1]));',
  '    const close = y(Number(k[4]));',
  '    const highY = y(Number(k[2]));',
  '    const lowY = y(Number(k[3]));',
  '    const bullish = Number(k[4]) >= Number(k[1]);',

  '    ctx.strokeStyle = bullish ? "#18d889" : "#ff4d67";',
  '    ctx.fillStyle = ctx.strokeStyle;',
  '    ctx.lineWidth = 1;',

  '    ctx.beginPath();',
  '    ctx.moveTo(xx,highY);',
  '    ctx.lineTo(xx,lowY);',
  '    ctx.stroke();',

  '    const bodyTop = Math.min(open,close);',
  '    const bodyHeight = Math.max(1,Math.abs(close-open));',

  '    ctx.fillRect(',
  '      xx-candleWidth/2,',
  '      bodyTop,',
  '      candleWidth,',
  '      bodyHeight',
  '    );',
  '  });',

  '  function line(value,color,label,dashed) {',

  '    const yy = y(Number(value));',

  '    if (yy < 0 || yy > H) return;',

  '    ctx.strokeStyle = color;',
  '    ctx.lineWidth = 1;',
  '    ctx.setLineDash(dashed ? [6,5] : []);',

  '    ctx.beginPath();',
  '    ctx.moveTo(pad.l,yy);',
  '    ctx.lineTo(W-pad.r,yy);',
  '    ctx.stroke();',

  '    ctx.setLineDash([]);',

  '    if (label) {',
  '      ctx.fillStyle = color;',
  '      ctx.font = "bold 11px Arial";',
  '      ctx.fillText(label + " " + fmt(value),W-pad.r-150,yy-5);',
  '    }',
  '  }',

  '  line(s.level,"#ffc857","4H/2H",false);',
  '  line(s.entryLow,"#58a6ff","GİRİŞ",false);',
  '  line(s.entryHigh,"#58a6ff","",false);',
  '  line(s.stop,"#ff4d67","STOP",false);',
  '  line(s.tp1,"#18d889","TP1",false);',
  '  line(s.tp2,"#18d889","TP2",false);',
  '  line(s.tp3,"#18d889","TP3",false);',

  '  line(',
  '    s.lastPrice,',
  '    s.direction === "LONG" ? "#18d889" : "#ff4d67",',
  '    "CANLI",',
  '    true',
  '  );',
  '}',

  'function connect() {',

  '  const protocol = location.protocol === "https:" ? "wss://" : "ws://";',

  '  ws = new WebSocket(protocol + location.host);',

  '  ws.onopen = function() {',
  '    console.log("Sonny WebSocket connected");',
  '  };',

  '  ws.onmessage = function(event) {',

  '    try {',
  '      const payload = JSON.parse(event.data);',

  '      if (Array.isArray(payload.signals)) {',
  '        state.signals = payload.signals;',
  '      }',

  '      if (Object.prototype.hasOwnProperty.call(payload,"selected")) {',
  '        if (payload.selected) {',
  '          state.selected = payload.selected;',
  '        } else if (!state.selected || !state.signals.some(function(s){return s.id===state.selected.id;})) {',
  '          state.selected = null;',
  '        }',
  '      }',

  '      if (payload.stats) {',
  '        state.stats = payload.stats;',
  '      }',

  '      if (payload.lastScan) {',
  '        state.lastScan = payload.lastScan;',
  '      }',

  '      if (state.selected) {',
  '        const current = state.signals.find(function(s){',
  '          return s.id === state.selected.id;',
  '        });',
  '        if (current) state.selected = current;',
  '      }',

  '      render();',
  '    } catch (error) {',
  '      console.error("WS parse error",error);',
  '    }',
  '  };',

  '  ws.onclose = function() {',
  '    setTimeout(connect,2000);',
  '  };',

  '}',

  'setInterval(function() {',
  '  if (state.selected) {',
  '    const current = state.signals.find(function(s){',
  '      return s.id === state.selected.id;',
  '    });',
  '    if (current) state.selected = current;',
  '  }',
  '  render();',
  '},1000);',

  'window.addEventListener("resize",renderChart);',

  'connect();',
  'render();',

  '</script>',
  '</body>',
  '</html>'
].join('\n');

// ============================================================
// FRONTEND ROUTE
// ============================================================

app.get(
  '/',
  (req, res) => {
    res.type('html').send(
      INDEX_HTML
    );
  }
);

// ============================================================
// WEBSOCKET
// ============================================================

wss.on(
  'connection',
  ws => {
    console.log(
      'WS client connected'
    );

    ws.send(
      JSON.stringify({
        type: 'state',

        signals:
          getSignalPayload(),

        selected:
          selectedSignalId
            ? signals.get(
                selectedSignalId
              ) || null
            : null,

        stats: {
          ...stats,

          universe:
            universe.length,

          active:
            signals.size
        },

        lastScan,

        serverTime:
          now()
      })
    );
  }
);

// ============================================================
// START
// ============================================================

async function start() {
  console.log(
    '=============================================='
  );

  console.log(
    'Sonny AI Signal Scanner V10 started'
  );

  console.log(
    'Data source: BITGET'
  );

  console.log(
    'TradingView: BINANCE'
  );

  console.log(
    'Strategy: 4H SUPPORT/RESISTANCE + 2H CONFIRMATION + 15M STRUCTURE'
  );

  console.log(
    'Refresh: Every 60 seconds'
  );

  console.log(
    'Live prices: Every 5 seconds'
  );

  console.log(
    'Auto trade: OFF'
  );

  console.log(
    '=============================================='
  );

  await fetchUniverse();

  await runScan();

  setInterval(
    runScan,
    CONFIG.SCAN_INTERVAL_MS
  );

  setInterval(
    updateLivePrices,
    CONFIG.PRICE_INTERVAL_MS
  );
}

// ============================================================
// SERVER
// ============================================================

server.listen(
  PORT,
  () => {
    console.log(
      `Server listening on port ${PORT}`
    );

    start().catch(
      error => {
        console.error(
          'START ERROR:',
          error
        );
      }
    );
  }
);
