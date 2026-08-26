'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');

/* =========================================================
   SONNY AI TRADER FINAL
   BITGET FUTURES
   4H + 2H DESTEK / DİRENÇ
   15M YAPI ONAYI
   YÜKSEK HACİM + HAREKET FİLTRESİ
   CANLI CANVAS GRAFİK
   ========================================================= */

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 10000;

/* =========================================================
   CONFIG
   ========================================================= */

const CFG = {

  /* Minimum 24H USDT hacmi */
  MIN_VOLUME_USD: 1_000_000,

  /* 24H hareket filtresi.
     Çok cansız coinleri ele */
  MIN_24H_MOVE_PCT: 0.75,

  /* Maksimum radar evreni */
  MAX_COINS: 200,

  /* Ekranda gösterilecek maksimum sinyal */
  MAX_SIGNALS: 15,

  /* Radar */
  SCAN_MS: 60_000,

  /* Market listesi yenileme */
  DISCOVERY_MS: 15 * 60_000,

  /* 4H / 2H seviyeye yakınlık */
  LEVEL_TOLERANCE: 0.012,

  /* Seviye kümelendirme */
  CLUSTER_TOLERANCE: 0.004,

  /* Minimum sinyal skoru */
  MIN_SCORE: 68,

  /* Grafik mum sayısı */
  MAX_CHART_CANDLES: 180,

  /* Aynı anda OHLCV istekleri */
  REQUEST_CONCURRENCY: 6,

  /* API yükünü azalt */
  REQUEST_DELAY: 100,

  /* 15M ATR / fiyat minimum hareket */
  MIN_ATR_PCT_15M: 0.08
};

/* =========================================================
   EXCHANGE
   ========================================================= */

const exchange = new ccxt.bitget({
  enableRateLimit: true,
  timeout: 20000,
  options: {
    defaultType: 'swap'
  }
});

/* =========================================================
   STATE
   ========================================================= */

let marketRows = [];
let signals = [];
let lastScan = 0;
let lastDiscovery = 0;
let scanRunning = false;
let lastError = null;

let stats = {
  universe: 0,
  analyzed: 0,
  candidates: 0,
  signals: 0,
  seconds: 0
};

let marketSentiment = {
  label: 'YATAY / KARIŞIK',
  direction: 'NEUTRAL',
  reason: 'Piyasa verisi bekleniyor.',
  btc24h: 0,
  eth24h: 0,
  average24h: 0
};

/* =========================================================
   HELPERS
   ========================================================= */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function num(value, fallback = 0) {
  const x = Number(value);
  return Number.isFinite(x) ? x : fallback;
}

function clean(symbol) {
  return String(symbol || '')
    .replace('/USDT:USDT', '')
    .replace('/USDT', '')
    .replace(':USDT', '')
    .replace(/[^A-Z0-9]/gi, '')
    .toUpperCase()
    .replace(/USDT$/, '') + 'USDT';
}

function marketSymbol(symbol) {

  if (!symbol) return null;

  if (exchange.markets) {

    const wanted = clean(symbol);

    const found = Object.keys(exchange.markets)
      .find(key => clean(key) === wanted);

    if (found) return found;
  }

  return null;
}

function fmtPrice(value) {

  const x = Number(value);

  if (!Number.isFinite(x)) return null;

  if (x >= 1000) return Number(x.toFixed(2));
  if (x >= 100) return Number(x.toFixed(3));
  if (x >= 1) return Number(x.toFixed(5));
  if (x >= 0.01) return Number(x.toFixed(6));

  return Number(x.toFixed(10));
}

function pct(value) {
  return Number(num(value).toFixed(3));
}

/* =========================================================
   ATR
   ========================================================= */

function atr(candles, period = 14) {

  if (!candles || candles.length < period + 1) {
    return null;
  }

  const trs = [];

  for (let i = 1; i < candles.length; i++) {

    const high = num(candles[i][2]);
    const low = num(candles[i][3]);
    const prevClose = num(candles[i - 1][4]);

    trs.push(
      Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      )
    );
  }

  const recent = trs.slice(-period);

  if (!recent.length) return null;

  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

/* =========================================================
   PIVOTS
   ========================================================= */

function pivots(candles, lookback = 3) {

  const result = [];

  if (!candles || candles.length < lookback * 2 + 5) {
    return result;
  }

  for (
    let i = lookback;
    i < candles.length - lookback;
    i++
  ) {

    const high = num(candles[i][2]);
    const low = num(candles[i][3]);

    let isHigh = true;
    let isLow = true;

    for (let j = 1; j <= lookback; j++) {

      if (
        high <= num(candles[i - j][2]) ||
        high <= num(candles[i + j][2])
      ) {
        isHigh = false;
      }

      if (
        low >= num(candles[i - j][3]) ||
        low >= num(candles[i + j][3])
      ) {
        isLow = false;
      }
    }

    if (isHigh) {

      result.push({
        price: high,
        type: 'resistance',
        time: candles[i][0]
      });

    }

    if (isLow) {

      result.push({
        price: low,
        type: 'support',
        time: candles[i][0]
      });

    }
  }

  return result;
}

/* =========================================================
   LEVEL CLUSTER
   ========================================================= */

function clusterLevels(levels) {

  const sorted = [...levels]
    .filter(x => num(x.price) > 0)
    .sort((a, b) => a.price - b.price);

  const groups = [];

  for (const level of sorted) {

    const existing = groups.find(group =>
      group.type === level.type &&
      Math.abs(level.price - group.price) /
        group.price <= CFG.CLUSTER_TOLERANCE
    );

    if (existing) {

      existing.items.push(level);

      existing.price =
        existing.items.reduce(
          (sum, item) => sum + item.price,
          0
        ) / existing.items.length;

    } else {

      groups.push({
        type: level.type,
        price: level.price,
        items: [level]
      });
    }
  }

  return groups.map(group => ({
    type: group.type,
    price: group.price,
    touches: group.items.length
  }));
}

/* =========================================================
   15M STRUCTURE
   ========================================================= */

function structure15m(candles) {

  if (!candles || candles.length < 10) {
    return 'NEUTRAL';
  }

  const c = candles.slice(-10);

  const highs = c.map(x => num(x[2]));
  const lows = c.map(x => num(x[3]));
  const closes = c.map(x => num(x[4]));

  const recentHigh = highs.slice(-3).reduce(
    (a, b) => Math.max(a, b),
    0
  );

  const previousHigh = highs.slice(-7, -3).reduce(
    (a, b) => Math.max(a, b),
    0
  );

  const recentLow = lows.slice(-3).reduce(
    (a, b) => Math.min(a, b),
    Infinity
  );

  const previousLow = lows.slice(-7, -3).reduce(
    (a, b) => Math.min(a, b),
    Infinity
  );

  const lastClose = closes[closes.length - 1];
  const midClose = closes[3];

  if (
    recentHigh > previousHigh &&
    recentLow > previousLow &&
    lastClose > midClose
  ) {
    return 'LONG';
  }

  if (
    recentHigh < previousHigh &&
    recentLow < previousLow &&
    lastClose < midClose
  ) {
    return 'SHORT';
  }

  return 'NEUTRAL';
}

/* =========================================================
   VOLUME RATIO
   ========================================================= */

function volumeRatio(candles) {

  if (!candles || candles.length < 21) {
    return 0;
  }

  const recent =
    num(candles[candles.length - 1][5]);

  const previous = candles
    .slice(-21, -1)
    .map(c => num(c[5]));

  const average =
    previous.reduce((a, b) => a + b, 0) /
    previous.length;

  if (!average) return 0;

  return recent / average;
}

/* =========================================================
   OHLCV
   ========================================================= */

async function fetchOHLCV(symbol, timeframe, limit) {

  return exchange.fetchOHLCV(
    symbol,
    timeframe,
    undefined,
    limit
  );
}

/* =========================================================
   DISCOVERY
   ========================================================= */

async function discover() {

  await exchange.loadMarkets(true);

  const markets = Object.values(exchange.markets)
    .filter(market => {

      if (!market) return false;
      if (market.active === false) return false;
      if (market.quote !== 'USDT') return false;
      if (market.settle !== 'USDT') return false;

      return (
        market.swap === true ||
        market.future === true
      );
    });

  console.log(
    `Bitget USDT Futures marketleri: ${markets.length}`
  );

  const result = [];

  for (let i = 0; i < markets.length; i += 40) {

    const batch = markets
      .slice(i, i + 40)
      .map(market => market.symbol);

    try {

      const tickers =
        await exchange.fetchTickers(batch);

      for (const ticker of Object.values(tickers || {})) {

        if (!ticker || !ticker.symbol) continue;

        const volume = num(ticker.quoteVolume);
        const last = num(ticker.last);
        const move = Math.abs(num(ticker.percentage));

        /*
         * 1M$ altındaki hacimsizleri at.
         * %0.75'ten az hareket eden cansızları at.
         */
        if (
          volume < CFG.MIN_VOLUME_USD ||
          last <= 0 ||
          move < CFG.MIN_24H_MOVE_PCT
        ) {
          continue;
        }

        result.push({
          symbol: ticker.symbol,
          last,
          quoteVolume: volume,
          percentage: num(ticker.percentage),
          baseVolume: num(ticker.baseVolume)
        });
      }

    } catch (error) {

      console.log(
        'Ticker batch hatası:',
        error.message
      );
    }

    await sleep(CFG.REQUEST_DELAY);
  }

  /*
   * Önce hacme göre sırala.
   * Böylece küçük ve önemsiz coinler
   * üst sıralara çıkamaz.
   */
  result.sort(
    (a, b) => b.quoteVolume - a.quoteVolume
  );

  return result.slice(0, CFG.MAX_COINS);
}

/* =========================================================
   MARKET SENTIMENT
   ========================================================= */

function calculateMarketSentiment(rows) {

  const btc = rows.find(
    row => clean(row.symbol) === 'BTCUSDT'
  );

  const eth = rows.find(
    row => clean(row.symbol) === 'ETHUSDT'
  );

  const average = rows.length
    ? rows.reduce(
        (sum, row) => sum + num(row.percentage),
        0
      ) / rows.length
    : 0;

  const majors = [btc, eth].filter(Boolean);

  const majorAverage = majors.length
    ? majors.reduce(
        (sum, row) => sum + num(row.percentage),
        0
      ) / majors.length
    : average;

  /*
   * BTC + ETH + evren birlikte değerlendirilir.
   */

  if (
    majorAverage >= 1.2 &&
    average >= 0.5
  ) {

    return {
      label: 'YÜKSELİŞ',
      direction: 'LONG',
      reason:
        'BTC / ETH güçlü ve hacimli piyasa genelinde pozitif hareket var.',
      btc24h: pct(btc?.percentage),
      eth24h: pct(eth?.percentage),
      average24h: pct(average)
    };
  }

  if (
    majorAverage <= -1.2 &&
    average <= -0.5
  ) {

    return {
      label: 'DÜŞÜŞ',
      direction: 'SHORT',
      reason:
        'BTC / ETH zayıf ve hacimli piyasa genelinde negatif hareket var.',
      btc24h: pct(btc?.percentage),
      eth24h: pct(eth?.percentage),
      average24h: pct(average)
    };
  }

  if (
    majorAverage > 0.3 &&
    average > 0
  ) {

    return {
      label: 'HAFİF POZİTİF',
      direction: 'LONG',
      reason:
        'Piyasa pozitif fakat henüz güçlü trend teyidi yok.',
      btc24h: pct(btc?.percentage),
      eth24h: pct(eth?.percentage),
      average24h: pct(average)
    };
  }

  if (
    majorAverage < -0.3 &&
    average < 0
  ) {

    return {
      label: 'HAFİF NEGATİF',
      direction: 'SHORT',
      reason:
        'Piyasa negatif fakat henüz güçlü trend teyidi yok.',
      btc24h: pct(btc?.percentage),
      eth24h: pct(eth?.percentage),
      average24h: pct(average)
    };
  }

  return {
    label: 'YATAY / KARIŞIK',
    direction: 'NEUTRAL',
    reason:
      'Genel piyasa yönü net değil.',
    btc24h: pct(btc?.percentage),
    eth24h: pct(eth?.percentage),
    average24h: pct(average)
  };
}

/* =========================================================
   ANALYZE
   ========================================================= */

async function analyzeSymbol(row) {

  const symbol = row.symbol;

  try {

    /*
     * İlk aşamada sadece 4H + 2H çekiyoruz.
     * 15M gereksiz coinlere çekilmiyor.
     */

    const [h4, h2] = await Promise.all([

      fetchOHLCV(
        symbol,
        '4h',
        90
      ),

      fetchOHLCV(
        symbol,
        '2h',
        90
      )

    ]);

    if (
      h4.length < 40 ||
      h2.length < 40
    ) {
      return null;
    }

    const price =
      num(row.last) ||
      num(h2[h2.length - 1][4]);

    if (!price) return null;

    const levels4 =
      clusterLevels(
        pivots(h4, 3)
      ).map(level => ({
        ...level,
        tf: '4H'
      }));

    const levels2 =
      clusterLevels(
        pivots(h2, 3)
      ).map(level => ({
        ...level,
        tf: '2H'
      }));

    const allLevels = [
      ...levels4,
      ...levels2
    ];

    if (!allLevels.length) {
      return null;
    }

    const nearby = allLevels

      .map(level => ({
        ...level,

        distance:
          Math.abs(
            price - level.price
          ) / price
      }))

      .filter(
        level =>
          level.distance <=
          CFG.LEVEL_TOLERANCE
      )

      .sort(
        (a, b) =>
          a.distance -
          b.distance
      );

    /*
     * Fiyata yakın destek / direnç yoksa
     * bu coin sinyal adayı değildir.
     */

    if (!nearby.length) {
      return null;
    }

    const chosen = nearby[0];

    /*
     * 4H + 2H aynı bölge kontrolü.
     */

    const sameZone = allLevels.filter(
      level =>
        level.type === chosen.type &&
        Math.abs(
          level.price - chosen.price
        ) / chosen.price <=
        CFG.CLUSTER_TOLERANCE
    );

    const has4 =
      sameZone.some(
        level => level.tf === '4H'
      );

    const has2 =
      sameZone.some(
        level => level.tf === '2H'
      );

    const confluence =
      has4 && has2;

    /*
     * Ancak buraya kadar gelen coinlerde
     * 15M verisini çek.
     */

    const m15 =
      await fetchOHLCV(
        symbol,
        '15m',
        100
      );

    if (m15.length < 30) {
      return null;
    }

    const structure =
      structure15m(m15);

    const vol =
      volumeRatio(m15);

    const currentATR =
      atr(m15, 14);

    if (!currentATR) {
      return null;
    }

    const atrPct =
      (currentATR / price) * 100;

    /*
     * Tamamen cansız coinleri ikinci kez temizle.
     */

    if (
      atrPct <
      CFG.MIN_ATR_PCT_15M
    ) {
      return null;
    }

    let side =
      chosen.type === 'support'
        ? 'LONG'
        : 'SHORT';

    /*
     * SCORE
     */

    let score = 40;

    if (confluence) {
      score += 20;
    } else if (has4 || has2) {
      score += 10;
    }

    if (chosen.touches >= 4) {
      score += 12;
    } else if (chosen.touches >= 2) {
      score += 7;
    }

    if (structure === side) {
      score += 18;
    } else if (structure === 'NEUTRAL') {
      score += 5;
    } else {
      score -= 10;
    }

    if (vol >= 1.5) {
      score += 10;
    } else if (vol >= 1.2) {
      score += 8;
    } else if (vol >= 0.8) {
      score += 4;
    }

    /*
     * 24H hareket bonusu.
     */

    const move =
      Math.abs(
        num(row.percentage)
      );

    if (move >= 5) {
      score += 5;
    } else if (move >= 2) {
      score += 3;
    }

    /*
     * Yakın seviyeye bonus.
     */

    score -= Math.min(
      10,
      (
        chosen.distance /
        CFG.LEVEL_TOLERANCE
      ) * 10
    );

    score = Math.round(
      Math.max(
        0,
        Math.min(
          100,
          score
        )
      )
    );

    if (
      score <
      CFG.MIN_SCORE
    ) {
      return null;
    }

    /*
     * İŞLEM PLANLARI
     */

    const buffer =
      Math.max(
        currentATR * 0.35,
        price * 0.0025
      );

    let entryLow;
    let entryHigh;
    let stop;
    let tp1;
    let tp2;
    let tp3;

    if (side === 'LONG') {

      entryLow =
        Math.min(
          price,
          chosen.price * 1.002
        );

      entryHigh =
        Math.max(
          price,
          chosen.price * 1.002
        );

      stop =
        chosen.price -
        Math.max(
          buffer,
          chosen.price * 0.0035
        );

      const risk =
        Math.max(
          price - stop,
          price * 0.002
        );

      tp1 = price + risk * 1.4;
      tp2 = price + risk * 2.2;
      tp3 = price + risk * 3.0;

    } else {

      entryLow =
        Math.min(
          price,
          chosen.price * 0.998
        );

      entryHigh =
        Math.max(
          price,
          chosen.price * 0.998
        );

      stop =
        chosen.price +
        Math.max(
          buffer,
          chosen.price * 0.0035
        );

      const risk =
        Math.max(
          stop - price,
          price * 0.002
        );

      tp1 = price - risk * 1.4;
      tp2 = price - risk * 2.2;
      tp3 = price - risk * 3.0;
    }

    const now = Date.now();

    return {

      id:
        clean(symbol) +
        '-' +
        now,

      coin:
        clean(symbol),

      symbol:
        clean(symbol),

      ccxt_symbol:
        symbol,

      taraf:
        side,

      direction:
        side,

      confidence:
        score,

      livePrice:
        fmtPrice(price),

      giris:
        fmtPrice(
          (
            entryLow +
            entryHigh
          ) / 2
        ),

      entryLow:
        fmtPrice(entryLow),

      entryHigh:
        fmtPrice(entryHigh),

      sl:
        fmtPrice(stop),

      stop:
        fmtPrice(stop),

      tp1:
        fmtPrice(tp1),

      tp2:
        fmtPrice(tp2),

      tp3:
        fmtPrice(tp3),

      level:
        fmtPrice(chosen.price),

      levelType:
        chosen.type,

      distance:
        Number(
          (
            chosen.distance *
            100
          ).toFixed(3)
        ),

      touches:
        chosen.touches,

      confluence,

      timeframeLevel:
        confluence
          ? '4H + 2H'
          : chosen.tf,

      structure15m:
        structure,

      volume24h:
        num(row.quoteVolume),

      volumeRatio:
        Number(
          vol.toFixed(2)
        ),

      move24h:
        num(row.percentage),

      atr15mPct:
        Number(
          atrPct.toFixed(3)
        ),

      signalAt:
        now,

      timestamp:
        now,

      ageSeconds:
        0,

      reason:
        (
          confluence
            ? '4H + 2H aynı bölge'
            : chosen.tf +
              ' seviye'
        ) +

        (
          chosen.touches > 1
            ? ' + ' +
              chosen.touches +
              ' temas'
            : ''
        ) +

        (
          structure === side
            ? ' + 15M yön onayı'
            : ''
        ) +

        ' + Hacim/Hareket filtresi'
    };

  } catch (error) {

    console.log(
      `Analiz hatası ${symbol}:`,
      error.message
    );

    return null;
  }
}

/* =========================================================
   AGE
   ========================================================= */

function ageSignal(signal) {

  return Math.max(
    0,
    Math.floor(
      (
        Date.now() -
        num(
          signal.signalAt ||
          signal.timestamp
        )
      ) / 1000
    )
  );
}

function publicSignals() {

  return signals.map(
    signal => ({
      ...signal,
      ageSeconds:
        ageSignal(signal)
    })
  );
}

/* =========================================================
   BROADCAST
   ========================================================= */

function broadcast() {

  const payload =
    JSON.stringify({

      type: 'snapshot',

      data: {

        signals:
          publicSignals(),

        stats,

        market:
          marketSentiment,

        lastScan,

        lastError,

        config: {

          minVolumeUSD:
            CFG.MIN_VOLUME_USD,

          min24hMovePct:
            CFG.MIN_24H_MOVE_PCT,

          maxCoins:
            CFG.MAX_COINS,

          maxSignals:
            CFG.MAX_SIGNALS,

          scanSeconds:
            CFG.SCAN_MS / 1000
        }
      }
    });

  for (const client of wss.clients) {

    if (
      client.readyState ===
      WebSocket.OPEN
    ) {

      try {
        client.send(payload);
      } catch (_) {}
    }
  }
}

/* =========================================================
   RADAR
   ========================================================= */

async function runScan() {

  if (scanRunning) {
    return;
  }

  scanRunning = true;

  const started = Date.now();

  try {

    console.log('');
    console.log(
      '🔎 Bitget piyasası taranıyor...'
    );

    /*
     * Market keşfi her taramada değil.
     */

    if (
      !marketRows.length ||
      Date.now() - lastDiscovery >=
      CFG.DISCOVERY_MS
    ) {

      marketRows =
        await discover();

      lastDiscovery =
        Date.now();

      console.log(
        `📊 Radar evreni: ${marketRows.length} coin`
      );

    }

    /*
     * Market sentiment.
     */

    marketSentiment =
      calculateMarketSentiment(
        marketRows
      );

    const found = [];

    /*
     * Paralel analiz.
     */

    for (
      let i = 0;
      i < marketRows.length;
      i += CFG.REQUEST_CONCURRENCY
    ) {

      const batch =
        marketRows.slice(
          i,
          i +
          CFG.REQUEST_CONCURRENCY
        );

      const results =
        await Promise.all(
          batch.map(
            analyzeSymbol
          )
        );

      for (const signal of results) {

        if (signal) {
          found.push(signal);
        }
      }
    }

    /*
     * En güçlüleri üste al.
     */

    found.sort(
      (a, b) => {

        if (
          b.confidence !==
          a.confidence
        ) {
          return (
            b.confidence -
            a.confidence
          );
        }

        return (
          a.distance -
          b.distance
        );
      }
    );

    /*
     * Aynı coin tekrarlarını temizle.
     */

    const unique = [];
    const seen = new Set();

    for (const signal of found) {

      if (
        seen.has(signal.coin)
      ) {
        continue;
      }

      seen.add(signal.coin);
      unique.push(signal);
    }

    signals =
      unique.slice(
        0,
        CFG.MAX_SIGNALS
      );

    stats = {

      universe:
        marketRows.length,

      analyzed:
        marketRows.length,

      candidates:
        found.length,

      signals:
        signals.length,

      seconds:
        Number(
          (
            (
              Date.now() -
              started
            ) / 1000
          ).toFixed(1)
        )
    };

    lastScan =
      Date.now();

    lastError =
      null;

    broadcast();

    console.log(
      `✅ RADAR TAMAMLANDI | Universe=${stats.universe} | Analiz=${stats.analyzed} | Aday=${stats.candidates} | SIGNAL=${stats.signals}`
    );

  } catch (error) {

    lastError =
      error.message;

    console.error(
      '❌ RADAR ERROR:',
      error.message
    );

    broadcast();

  } finally {

    scanRunning =
      false;
  }
}

/* =========================================================
   STATUS API
   ========================================================= */

app.get(
  '/api/status',
  (req, res) => {

    res.json({

      success: true,

      signals:
        publicSignals(),

      stats,

      market:
        marketSentiment,

      lastScan,

      lastError,

      config: {

        minVolumeUSD:
          CFG.MIN_VOLUME_USD,

        min24hMovePct:
          CFG.MIN_24H_MOVE_PCT,

        maxCoins:
          CFG.MAX_COINS,

        maxSignals:
          CFG.MAX_SIGNALS,

        scanSeconds:
          CFG.SCAN_MS / 1000
      }
    });
  }
);

/* =========================================================
   CHART API
   ========================================================= */

app.get(
  '/api/chart',
  async (req, res) => {

    try {

      const symbol =
        marketSymbol(
          req.query.symbol
        );

      const allowed = [
        '5m',
        '15m',
        '1h',
        '2h',
        '4h'
      ];

      const timeframe =
        allowed.includes(
          req.query.timeframe
        )
          ? req.query.timeframe
          : '15m';

      if (!symbol) {

        return res
          .status(404)
          .json({
            success: false,
            error: 'Coin bulunamadı.'
          });
      }

      const candles =
        await exchange.fetchOHLCV(
          symbol,
          timeframe,
          undefined,
          CFG.MAX_CHART_CANDLES
        );

      const ticker =
        await exchange.fetchTicker(
          symbol
        );

      res.json({

        success: true,

        symbol:
          clean(symbol),

        timeframe,

        price:
          num(
            ticker.last ||
            candles.at(-1)?.[4]
          ),

        candles:
          candles.map(
            candle => ({

              time:
                candle[0],

              open:
                candle[1],

              high:
                candle[2],

              low:
                candle[3],

              close:
                candle[4],

              volume:
                candle[5]
            })
          )
      });

    } catch (error) {

      res
        .status(500)
        .json({
          success: false,
          error: error.message
        });
    }
  }
);

/* =========================================================
   HEALTH
   ========================================================= */

app.get(
  '/health',
  (req, res) => {

    res.json({

      ok: true,

      uptime:
        process.uptime(),

      lastScan,

      lastError,

      stats,

      market:
        marketSentiment
    });
  }
);

/* =========================================================
   WEBSOCKET
   ========================================================= */

wss.on(
  'connection',
  ws => {

    ws.send(
      JSON.stringify({

        type: 'snapshot',

        data: {

          signals:
            publicSignals(),

          stats,

          market:
            marketSentiment,

          lastScan,

          lastError,

          config: {

            minVolumeUSD:
              CFG.MIN_VOLUME_USD,

            min24hMovePct:
              CFG.MIN_24H_MOVE_PCT,

            maxCoins:
              CFG.MAX_COINS,

            maxSignals:
              CFG.MAX_SIGNALS
          }
        }
      })
    );
  }
);

/* =========================================================
   FRONTEND
   ========================================================= */

const HTML = String.raw`<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport"
content="width=device-width,initial-scale=1">
<title>Sonny AI Trader FINAL</title>

<style>

*{
 box-sizing:border-box;
}

html,body{
 margin:0;
 width:100%;
 height:100%;
 overflow:hidden;
 background:#070a0f;
 color:#eef3f8;
 font-family:Arial,Helvetica,sans-serif;
}

.app{
 width:100%;
 height:100vh;
 display:grid;
 grid-template-columns:285px minmax(0,1fr);
}

.side{
 background:#0b0f16;
 border-right:1px solid #202936;
 overflow:auto;
 padding:14px;
}

.brand{
 font-size:18px;
 font-weight:900;
}

.brand small{
 display:block;
 color:#718096;
 font-size:10px;
 margin-top:5px;
}

.cards{
 margin-top:18px;
 display:grid;
 gap:9px;
}

.card{
 background:#0f151e;
 border:1px solid #202b39;
 border-radius:14px;
 padding:12px;
 cursor:pointer;
}

.card:hover{
 border-color:#4776ff;
}

.card.active{
 border-color:#4776ff;
 box-shadow:0 0 0 1px #244a9c;
}

.top{
 display:flex;
 justify-content:space-between;
}

.coin{
 font-weight:900;
}

.badge{
 font-size:10px;
 font-weight:900;
 padding:4px 7px;
 border-radius:6px;
}

.long{
 color:#2be19b;
 background:#103425;
}

.short{
 color:#ff5d6d;
 background:#35131b;
}

.price{
 font-size:18px;
 font-weight:900;
 margin-top:8px;
}

.meta{
 font-size:10px;
 color:#778397;
 margin-top:6px;
}

.ready{
 font-size:10px;
 color:#2be19b;
 margin-top:7px;
}

.main{
 min-width:0;
 display:flex;
 flex-direction:column;
}

.head{
 height:72px;
 border-bottom:1px solid #202936;
 padding:0 18px;
 display:flex;
 align-items:center;
 justify-content:space-between;
}

.title{
 font-weight:900;
 font-size:18px;
}

.sub{
 font-size:10px;
 color:#788598;
 margin-top:5px;
}

.stats{
 display:flex;
 gap:18px;
 color:#778397;
 font-size:10px;
}

.stats b{
 color:#eef3f8;
}

.work{
 flex:1;
 min-height:0;
 display:grid;
 grid-template-columns:minmax(0,1fr) 285px;
}

.chartwrap{
 position:relative;
 min-width:0;
 min-height:0;
 background:#070a0f;
}

.toolbar{
 position:absolute;
 z-index:4;
 top:12px;
 left:16px;
 right:16px;
 display:flex;
 justify-content:space-between;
 pointer-events:none;
}

.chartname{
 font-weight:900;
 font-size:12px;
}

.tf{
 pointer-events:auto;
 display:flex;
 gap:4px;
}

.tf button{
 background:#101722;
 color:#8995a6;
 border:1px solid #273241;
 border-radius:5px;
 padding:5px 8px;
 font-size:10px;
 cursor:pointer;
}

.tf button.active{
 color:#fff;
 background:#17233b;
 border-color:#4776ff;
}

canvas{
 width:100%;
 height:100%;
 display:block;
}

.right{
 background:#0b0f16;
 border-left:1px solid #202936;
 padding:12px;
 overflow:auto;
}

.box{
 background:#0f151e;
 border:1px solid #202b39;
 border-radius:13px;
 padding:13px;
 margin-bottom:12px;
}

.label{
 font-size:10px;
 color:#7e899a;
 font-weight:900;
}

.market{
 font-size:20px;
 font-weight:900;
 margin-top:7px;
}

.market.up{
 color:#2be19b;
}

.market.down{
 color:#ff5d6d;
}

.market.flat{
 color:#e4c34c;
}

.reason{
 font-size:10px;
 color:#7e899a;
 line-height:1.45;
 margin-top:6px;
}

.row{
 display:flex;
 justify-content:space-between;
 border-bottom:1px solid #1b2430;
 padding:8px 0;
 font-size:10px;
}

.row:last-child{
 border:0;
}

.green{
 color:#2be19b;
}

.red{
 color:#ff5d6d;
}

.blue{
 color:#409cff;
}

.dcoin{
 font-size:16px;
 font-weight:900;
}

.dir{
 font-size:22px;
 font-weight:900;
 margin-top:7px;
}

.dir.long{
 color:#2be19b;
}

.dir.short{
 color:#ff5d6d;
}

.age{
 background:#111924;
 border-radius:8px;
 padding:9px;
 margin-top:10px;
 color:#8995a6;
 font-size:10px;
 line-height:1.5;
}

.empty{
 padding:30px 8px;
 text-align:center;
 color:#687487;
 font-size:11px;
}

@media(max-width:900px){

 .app{
   grid-template-columns:220px minmax(0,1fr);
 }

 .work{
   grid-template-columns:1fr;
 }

 .right{
   display:none;
 }
}

</style>
</head>

<body>

<div class="app">

<aside class="side">

 <div class="brand">
   🚀 Sonny AI Trader

   <small>
     4H/2H DESTEK-DİRENÇ ·
     15M ONAY ·
     YÜKSEK HACİM
   </small>
 </div>

 <div id="cards" class="cards">
   <div class="empty">
     Radar başlatılıyor...
   </div>
 </div>

</aside>

<main class="main">

<header class="head">

 <div>

   <div class="title">
     SİNYAL GRAFİĞİ
   </div>

   <div id="sub" class="sub">
     Son tarama bekleniyor...
   </div>

 </div>

 <div class="stats">

   <span>
     EVREN
     <b id="universe">-</b>
   </span>

   <span>
     ADAY
     <b id="candidates">0</b>
   </span>

   <span>
     SİNYAL
     <b id="count">0</b>
   </span>

   <span>
     SON
     <b id="clock">--:--:--</b>
   </span>

 </div>

</header>

<section class="work">

<div class="chartwrap">

 <div class="toolbar">

   <div
     id="chartname"
     class="chartname"
   >
     Sinyal seçin
   </div>

   <div class="tf">

     <button data-tf="5m">
       5M
     </button>

     <button
       data-tf="15m"
       class="active"
     >
       15M
     </button>

     <button data-tf="1h">
       1H
     </button>

     <button data-tf="4h">
       4H
     </button>

   </div>

 </div>

 <canvas id="chart"></canvas>

</div>

<aside class="right">

 <div class="box">

   <div class="label">
     GENEL PİYASA DURUMU
   </div>

   <div
     id="market"
     class="market flat"
   >
     YÜKLENİYOR...
   </div>

   <div
     id="reason"
     class="reason"
   >
     Piyasa verisi bekleniyor.
   </div>

   <div class="row">
     <span>BTC 24H</span>
     <b id="btc">-</b>
   </div>

   <div class="row">
     <span>ETH 24H</span>
     <b id="eth">-</b>
   </div>

   <div class="row">
     <span>EVREN ORT.</span>
     <b id="avg">-</b>
   </div>

   <div class="row">
     <span>MIN HACİM</span>
     <b id="volume">-</b>
   </div>

   <div class="row">
     <span>MIN HAREKET</span>
     <b id="move">-</b>
   </div>

 </div>

 <div class="box">

   <div
     id="dcoin"
     class="dcoin"
   >
     SİNYAL SEÇİN
   </div>

   <div
     id="ddir"
     class="dir"
   >
     —
   </div>

   <div class="row">
     <span>ŞU AN</span>
     <b id="p">—</b>
   </div>

   <div class="row">
     <span>GİRİŞ</span>
     <b id="e" class="green">—</b>
   </div>

   <div class="row">
     <span>STOP</span>
     <b id="sl" class="red">—</b>
   </div>

   <div class="row">
     <span>KÂR 1</span>
     <b id="tp1" class="blue">—</b>
   </div>

   <div class="row">
     <span>KÂR 2</span>
     <b id="tp2" class="blue">—</b>
   </div>

   <div class="row">
     <span>KÂR 3</span>
     <b id="tp3" class="blue">—</b>
   </div>

   <div class="row">
     <span>24H HACİM</span>
     <b id="dv">—</b>
   </div>

   <div class="row">
     <span>24H HAREKET</span>
     <b id="dm">—</b>
   </div>

   <div
     id="age"
     class="age"
   >
     Sinyal seçilmedi.
   </div>

 </div>

</aside>

</section>

</main>

</div>

<script>

/* =========================================================
   FRONTEND STATE
   ========================================================= */

const S = {
  signals: [],
  selected: null,
  tf: '15m',
  candles: [],
  chartRequest: 0
};

/* =========================================================
   HELPERS
   ========================================================= */

function $(id){
  return document.getElementById(id);
}

function sym(s){

  return String(s || '')
    .replace('/USDT:USDT','')
    .replace('/USDT','')
    .replace(':USDT','')
    .replace('USDT','')
    .toUpperCase() +
    'USDT';
}

function number(v){

  const x = Number(v);

  return Number.isFinite(x)
    ? x
    : null;
}

function formatPrice(v){

  const x = number(v);

  if(x === null) return '—';

  if(x >= 1000){
    return x.toLocaleString(
      'tr-TR',
      {
        maximumFractionDigits:2
      }
    );
  }

  if(x >= 100){
    return x.toFixed(3);
  }

  if(x >= 1){
    return x.toFixed(5);
  }

  if(x >= 0.01){
    return x.toFixed(6);
  }

  return x.toFixed(10);
}

function formatUsd(v){

  const x = number(v);

  if(x === null) return '—';

  if(x >= 1000000000){
    return (
      x / 1000000000
    ).toFixed(2) + 'B $';
  }

  if(x >= 1000000){
    return (
      x / 1000000
    ).toFixed(2) + 'M $';
  }

  if(x >= 1000){
    return (
      x / 1000
    ).toFixed(1) + 'K $';
  }

  return x.toFixed(0) + ' $';
}

function side(signal){

  return String(
    signal &&
    (
      signal.taraf ||
      signal.direction
    ) ||
    ''
  ).toUpperCase() === 'SHORT'
    ? 'SHORT'
    : 'LONG';
}

function ageText(seconds){

  const s =
    Math.max(
      0,
      Math.floor(
        Number(seconds) || 0
      )
    );

  if(s < 60){
    return s + ' sn';
  }

  const m =
    Math.floor(s / 60);

  const sec =
    s % 60;

  return (
    m +
    ' dk ' +
    sec +
    ' sn'
  );
}

/* =========================================================
   SIGNAL RENDER
   ========================================================= */

function render(){

  const box =
    $('cards');

  if(!S.signals.length){

    box.innerHTML =
      '<div class="empty">' +
      'Şu an uygun sinyal yok.' +
      '</div>';

    return;
  }

  box.innerHTML =
    S.signals.map(
      (signal,index) => {

        const direction =
          side(signal);

        return `
          <div
            class="card ${
              S.selected &&
              S.selected.id === signal.id
                ? 'active'
                : ''
            }"
            data-i="${index}"
          >

            <div class="top">

              <span class="coin">
                ${sym(
                  signal.coin ||
                  signal.symbol
                )}
              </span>

              <span class="badge ${
                direction === 'LONG'
                  ? 'long'
                  : 'short'
              }">
                ${direction}
              </span>

            </div>

            <div class="price">
              ${formatPrice(
                signal.livePrice
              )}
            </div>

            <div class="meta">
              Güven ${
                signal.confidence || 0
              }/100 · ${
                signal.timeframeLevel || ''
              }
            </div>

            <div class="ready">
              ● GİRİŞ HAZIR ·
              ${ageText(
                signal.ageSeconds
              )}
            </div>

          </div>
        `;
      }
    ).join('');

  box
    .querySelectorAll('.card')
    .forEach(card => {

      card.onclick = () => {

        S.selected =
          S.signals[
            Number(
              card.dataset.i
            )
          ];

        render();
        details();
        loadChart();
      };
    });
}

/* =========================================================
   DETAILS
   ========================================================= */

function details(){

  const signal =
    S.selected;

  if(!signal) return;

  const direction =
    side(signal);

  $('dcoin').textContent =
    sym(
      signal.coin ||
      signal.symbol
    );

  $('ddir').textContent =
    direction;

  $('ddir').className =
    'dir ' +
    direction.toLowerCase();

  $('p').textContent =
    formatPrice(
      signal.livePrice
    );

  $('e').textContent =
    formatPrice(
      signal.giris
    );

  $('sl').textContent =
    formatPrice(
      signal.sl
    );

  $('tp1').textContent =
    formatPrice(
      signal.tp1
    );

  $('tp2').textContent =
    formatPrice(
      signal.tp2
    );

  $('tp3').textContent =
    formatPrice(
      signal.tp3
    );

  $('dv').textContent =
    formatUsd(
      signal.volume24h
    );

  $('dm').textContent =
    number(
      signal.move24h
    ) !== null
      ? Number(
          signal.move24h
        ).toFixed(2) + '%'
      : '—';

  $('age').innerHTML =

    'Sinyal yaşı: <b>' +

    ageText(
      signal.ageSeconds
    ) +

    '</b><br>' +

    (
      signal.reason ||
      ''
    ) +

    '<br>' +

    '15M yapı: <b>' +

    (
      signal.structure15m ||
      'NEUTRAL'
    ) +

    '</b><br>' +

    '24H hacim: <b>' +

    formatUsd(
      signal.volume24h
    ) +

    '</b><br>' +

    '15M ATR: <b>' +

    (
      signal.atr15mPct ||
      0
    ) +

    '%</b>';

  $('chartname').textContent =
    sym(
      signal.coin ||
      signal.symbol
    ) +
    ' · ' +
    S.tf.toUpperCase();
}

/* =========================================================
   MARKET
   ========================================================= */

function renderMarket(data){

  const market =
    data || {};

  $('market').textContent =
    market.label ||
    'YATAY / KARIŞIK';

  $('market').className =
    'market ' +
    (
      market.direction === 'LONG'
        ? 'up'
        : market.direction === 'SHORT'
          ? 'down'
          : 'flat'
    );

  $('reason').textContent =
    market.reason || '';

  $('btc').textContent =
    number(market.btc24h) !== null
      ? market.btc24h.toFixed(2) + '%'
      : '—';

  $('eth').textContent =
    number(market.eth24h) !== null
      ? market.eth24h.toFixed(2) + '%'
      : '—';

  $('avg').textContent =
    number(market.average24h) !== null
      ? market.average24h.toFixed(2) + '%'
      : '—';
}

/* =========================================================
   STATUS
   ========================================================= */

function status(data){

  S.signals =
    data.signals || [];

  $('count').textContent =
    S.signals.length;

  $('universe').textContent =
    data.stats &&
    data.stats.universe || 0;

  $('candidates').textContent =
    data.stats &&
    data.stats.candidates || 0;

  $('sub').textContent =
    'Son tarama: ' +

    (
      data.lastScan
        ? new Date(
            data.lastScan
          ).toLocaleTimeString(
            'tr-TR'
          )
        : '-'
    );

  $('volume').textContent =
    formatUsd(
      data.config &&
      data.config.minVolumeUSD
    ) + '+';

  $('move').textContent =
    (
      data.config &&
      data.config.min24hMovePct ||
      0.75
    ) + '%+';

  renderMarket(
    data.market
  );

  if(
    !S.selected ||
    !S.signals.some(
      signal =>
        signal.id ===
        S.selected.id
    )
  ){

    S.selected =
      S.signals[0] ||
      null;
  }

  render();
  details();

  if(S.selected){
    loadChart();
  }
}

/* =========================================================
   STATUS API
   ========================================================= */

async function loadStatus(){

  try{

    const response =
      await fetch(
        '/api/status',
        {
          cache:'no-store'
        }
      );

    const data =
      await response.json();

    status(data);

  }catch(error){

    $('sub').textContent =
      'Sunucu bağlantısı bekleniyor...';
  }
}

/* =========================================================
   CHART LOAD
   ========================================================= */

async function loadChart(){

  if(!S.selected){
    emptyChart(
      'Grafik için sinyal seçin'
    );
    return;
  }

  const requestId =
    ++S.chartRequest;

  const symbol =
    S.selected.coin ||
    S.selected.symbol;

  const url =
    '/api/chart?symbol=' +
    encodeURIComponent(
      symbol
    ) +
    '&timeframe=' +
    encodeURIComponent(
      S.tf
    );

  try{

    const response =
      await fetch(
        url,
        {
          cache:'no-store'
        }
      );

    const data =
      await response.json();

    if(
      requestId !==
      S.chartRequest
    ){
      return;
    }

    if(!data.success){
      throw new Error(
        data.error ||
        'Grafik yok'
      );
    }

    S.candles =
      data.candles || [];

    $('chartname').textContent =
      sym(
        data.symbol
      ) +
      ' · ' +
      S.tf.toUpperCase();

    draw(
      data.candles,
      data.price,
      S.selected
    );

  }catch(error){

    emptyChart(
      'Grafik verisi alınamadı'
    );
  }
}

/* =========================================================
   CANVAS
   ========================================================= */

function setupCanvas(){

  const canvas =
    $('chart');

  const rect =
    canvas.getBoundingClientRect();

  const dpr =
    window.devicePixelRatio || 1;

  const width =
    Math.max(
      1,
      Math.floor(
        rect.width * dpr
      )
    );

  const height =
    Math.max(
      1,
      Math.floor(
        rect.height * dpr
      )
    );

  if(
    canvas.width !== width ||
    canvas.height !== height
  ){

    canvas.width =
      width;

    canvas.height =
      height;
  }

  const ctx =
    canvas.getContext('2d');

  ctx.setTransform(
    dpr,
    0,
    0,
    dpr,
    0,
    0
  );

  return {
    canvas,
    ctx,
    width:rect.width,
    height:rect.height
  };
}

function emptyChart(text){

  const area =
    setupCanvas();

  const ctx =
    area.ctx;

  ctx.clearRect(
    0,
    0,
    area.width,
    area.height
  );

  ctx.fillStyle =
    '#070a0f';

  ctx.fillRect(
    0,
    0,
    area.width,
    area.height
  );

  ctx.fillStyle =
    '#687487';

  ctx.font =
    '12px Arial';

  ctx.fillText(
    text,
    25,
    75
  );
}

/* =========================================================
   CHART DRAW
   ========================================================= */

function draw(
  candles,
  current,
  signal
){

  if(
    !candles ||
    candles.length < 2
  ){

    emptyChart(
      'Grafik verisi yok'
    );

    return;
  }

  const area =
    setupCanvas();

  const ctx =
    area.ctx;

  const width =
    area.width;

  const height =
    area.height;

  ctx.clearRect(
    0,
    0,
    width,
    height
  );

  ctx.fillStyle =
    '#070a0f';

  ctx.fillRect(
    0,
    0,
    width,
    height
  );

  /*
   * Grafik alanı.
   */

  const pad = {
    left:55,
    right:105,
    top:45,
    bottom:35
  };

  const cw =
    width -
    pad.left -
    pad.right;

  const ch =
    height -
    pad.top -
    pad.bottom;

  if(cw <= 20 || ch <= 20){
    return;
  }

  /*
   * High / Low değerleri.
   */

  const values = [];

  candles.forEach(
    candle => {

      values.push(
        Number(candle.high)
      );

      values.push(
        Number(candle.low)
      );
    }
  );

  [
    signal &&
    signal.giris,

    signal &&
    signal.sl,

    signal &&
    signal.tp1,

    signal &&
    signal.tp2,

    signal &&
    signal.tp3,

    current

  ].forEach(
    value => {

      const n =
        Number(value);

      if(
        Number.isFinite(n)
      ){
        values.push(n);
      }
    }
  );

  let low =
    Math.min(
      ...values
    );

  let high =
    Math.max(
      ...values
    );

  if(
    !Number.isFinite(low) ||
    !Number.isFinite(high)
  ){
    emptyChart(
      'Grafik verisi hatalı'
    );
    return;
  }

  let range =
    high - low;

  if(range <= 0){
    range =
      Math.abs(high) * 0.01 ||
      1;
  }

  const margin =
    range * 0.08;

  low -= margin;
  high += margin;

  range =
    high - low;

  /*
   * X.
   */

  function X(i){

    return (
      pad.left +
      (
        i /
        (candles.length - 1)
      ) *
      cw
    );
  }

  /*
   * Y.
   */

  function Y(value){

    return (
      pad.top +
      (
        1 -
        (
          value - low
        ) /
        range
      ) *
      ch
    );
  }

  /*
   * GRID
   */

  ctx.strokeStyle =
    '#17202c';

  ctx.lineWidth =
    1;

  for(let i=0;i<=6;i++){

    const y =
      pad.top +
      (
        i / 6
      ) * ch;

    ctx.beginPath();
    ctx.moveTo(
      pad.left,
      y
    );
    ctx.lineTo(
      pad.left + cw,
      y
    );
    ctx.stroke();

    const value =
      high -
      (
        i / 6
      ) * range;

    ctx.fillStyle =
      '#667386';

    ctx.font =
      '10px Arial';

    ctx.fillText(
      formatPrice(value),
      pad.left + cw + 8,
      y + 3
    );
  }

  for(let i=0;i<=6;i++){

    const x =
      pad.left +
      (
        i / 6
      ) * cw;

    ctx.beginPath();
    ctx.moveTo(
      x,
      pad.top
    );
    ctx.lineTo(
      x,
      pad.top + ch
    );
    ctx.stroke();
  }

  /*
   * CANDLE WIDTH
   */

  const step =
    cw /
    candles.length;

  const body =
    Math.max(
      2,
      Math.min(
        12,
        step * 0.65
      )
    );

  /*
   * CANDLES
   */

  candles.forEach(
    (candle,i) => {

      const open =
        Number(candle.open);

      const highValue =
        Number(candle.high);

      const lowValue =
        Number(candle.low);

      const close =
        Number(candle.close);

      const x =
        X(i);

      const yHigh =
        Y(highValue);

      const yLow =
        Y(lowValue);

      const yOpen =
        Y(open);

      const yClose =
        Y(close);

      const up =
        close >= open;

      ctx.strokeStyle =
        up
          ? '#2be19b'
          : '#ff5d6d';

      ctx.fillStyle =
        up
          ? '#2be19b'
          : '#ff5d6d';

      /*
       * Wick
       */

      ctx.beginPath();

      ctx.moveTo(
        x,
        yHigh
      );

      ctx.lineTo(
        x,
        yLow
      );

      ctx.stroke();

      /*
       * Body
       */

      const top =
        Math.min(
          yOpen,
          yClose
        );

      const bodyHeight =
        Math.max(
          1,
          Math.abs(
            yClose -
            yOpen
          )
        );

      ctx.fillRect(
        x - body / 2,
        top,
        body,
        bodyHeight
      );
    }
  );

  /*
   * PRICE LINE
   */

  if(
    Number.isFinite(
      Number(current)
    )
  ){

    const y =
      Y(
        Number(current)
      );

    ctx.strokeStyle =
      '#2be19b';

    ctx.setLineDash([
      5,
      5
    ]);

    ctx.beginPath();

    ctx.moveTo(
      pad.left,
      y
    );

    ctx.lineTo(
      pad.left + cw,
      y
    );

    ctx.stroke();

    ctx.setLineDash([]);

    drawLabel(
      ctx,
      'ŞU AN ' +
      formatPrice(current),
      pad.left + cw + 5,
      y,
      '#2be19b'
    );
  }

  /*
   * SIGNAL LEVELS
   */

  if(signal){

    drawLevel(
      ctx,
      Y(signal.giris),
      'GİRİŞ ' +
      formatPrice(signal.giris),
      '#2be19b',
      pad.left,
      pad.left + cw
    );

    drawLevel(
      ctx,
      Y(signal.sl),
      'STOP ' +
      formatPrice(signal.sl),
      '#ff5d6d',
      pad.left,
      pad.left + cw
    );

    drawLevel(
      ctx,
      Y(signal.tp1),
      'TP1 ' +
      formatPrice(signal.tp1),
      '#409cff',
      pad.left,
      pad.left + cw
    );

    drawLevel(
      ctx,
      Y(signal.tp2),
      'TP2 ' +
      formatPrice(signal.tp2),
      '#409cff',
      pad.left,
      pad.left + cw
    );

    drawLevel(
      ctx,
      Y(signal.tp3),
      'TP3 ' +
      formatPrice(signal.tp3),
      '#409cff',
      pad.left,
      pad.left + cw
    );
  }

  /*
   * Üst coin adı.
   */

  ctx.fillStyle =
    '#eef3f8';

  ctx.font =
    'bold 13px Arial';

  ctx.fillText(
    sym(
      signal &&
      (
        signal.coin ||
        signal.symbol
      )
    ),
    pad.left,
    22
  );
}

/* =========================================================
   CHART LABEL
   ========================================================= */

function drawLabel(
  ctx,
  text,
  x,
  y,
  color
){

  const width =
    ctx.measureText(
      text
    ).width;

  ctx.fillStyle =
    color;

  ctx.font =
    'bold 10px Arial';

  ctx.fillText(
    text,
    x,
    y - 4
  );
}

function drawLevel(
  ctx,
  y,
  text,
  color,
  left,
  right
){

  if(
    !Number.isFinite(y)
  ){
    return;
  }

  ctx.strokeStyle =
    color;

  ctx.lineWidth =
    1;

  ctx.setLineDash([
    5,
    5
  ]);

  ctx.beginPath();

  ctx.moveTo(
    left,
    y
  );

  ctx.lineTo(
    right,
    y
  );

  ctx.stroke();

  ctx.setLineDash([]);

  ctx.fillStyle =
    color;

  ctx.font =
    'bold 10px Arial';

  ctx.fillText(
    text,
    right + 6,
    y - 4
  );
}

/* =========================================================
   TIMEFRAME
   ========================================================= */

document
  .querySelectorAll(
    '.tf button'
  )
  .forEach(button => {

    button.onclick = () => {

      document
        .querySelectorAll(
          '.tf button'
        )
        .forEach(
          b =>
            b.classList.remove(
              'active'
            )
        );

      button.classList.add(
        'active'
      );

      S.tf =
        button.dataset.tf;

      details();
      loadChart();
    };
  });

/* =========================================================
   CLOCK
   ========================================================= */

setInterval(
  () => {

    $('clock').textContent =
      new Date()
        .toLocaleTimeString(
          'tr-TR'
        );

  },
  1000
);

/* =========================================================
   AUTO STATUS
   ========================================================= */

loadStatus();

setInterval(
  loadStatus,
  5000
);

/* =========================================================
   WEBSOCKET
   ========================================================= */

function connectWS(){

  try{

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
      event => {

        try{

          const message =
            JSON.parse(
              event.data
            );

          if(
            message.type ===
            'snapshot'
          ){

            status(
              message.data
            );
          }

        }catch(_){}
      };

    ws.onclose =
      () => {

        setTimeout(
          connectWS,
          3000
        );
      };

  }catch(_){

    setTimeout(
      connectWS,
      3000
    );
  }
}

connectWS();

/* =========================================================
   RESIZE
   ========================================================= */

let resizeTimer = null;

window.addEventListener(
  'resize',
  () => {

    clearTimeout(
      resizeTimer
    );

    resizeTimer =
      setTimeout(
        () => {

          if(
            S.selected &&
            S.candles.length
          ){

            draw(
              S.candles,
              S.selected.livePrice,
              S.selected
            );
          }

        },
        100
      );
  }
);

</script>

</body>
</html>`;

/* =========================================================
   FRONTEND ROUTE
   ========================================================= */

app.get(
  '/',
  (req, res) => {

    res
      .type('html')
      .send(HTML);
  }
);

/* =========================================================
   START
   ========================================================= */

server.listen(
  PORT,
  async () => {

    console.log('');
    console.log(
      '================================================='
    );

    console.log(
      '🚀 Sonny AI Trader FINAL'
    );

    console.log(
      '📡 Bitget Futures'
    );

    console.log(
      '📊 4H + 2H Destek/Direnç'
    );

    console.log(
      '🕐 15M Yapı Onayı'
    );

    console.log(
      '💰 Minimum Hacim: $' +
      CFG.MIN_VOLUME_USD.toLocaleString()
    );

    console.log(
      '📈 Minimum 24H Hareket: ' +
      CFG.MIN_24H_MOVE_PCT +
      '%'
    );

    console.log(
      '🛰️ Maksimum Radar: ' +
      CFG.MAX_COINS +
      ' coin'
    );

    console.log(
      '⏱️ Tarama: ' +
      CFG.SCAN_MS / 1000 +
      ' saniye'
    );

    console.log(
      '🌐 Port: ' +
      PORT
    );

    console.log(
      '================================================='
    );

    try {

      await exchange.loadMarkets();

      console.log(
        `Bitget hazır | Market=${Object.keys(exchange.markets).length}`
      );

      await runScan();

      setInterval(
        runScan,
        CFG.SCAN_MS
      );

    } catch (error) {

      lastError =
        error.message;

      console.error(
        'Başlangıç hatası:',
        error.message
      );

      /*
       * İlk bağlantı başarısız olsa bile
       * servis kapanmasın.
       */

      setTimeout(
        runScan,
        5000
      );

      setInterval(
        runScan,
        CFG.SCAN_MS
      );
    }
  }
);
