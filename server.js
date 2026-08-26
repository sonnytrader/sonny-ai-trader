const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

const SYSTEM_NAME = "Sonny AI Signal Scanner V8";
const BITGET_BASE = "https://api.bitget.com";
const PRODUCT_TYPE = "usdt-futures";

/*
=========================================================
SONNY V8

ANA MANTIK:

4H  -> ANA DESTEK / DİRENÇ
2H  -> İKİNCİL DESTEK / DİRENÇ
15M -> YÖN TEYİDİ

SİSTEMİN AMACI:

"Şu coin şu anda güçlü bir seviyeye geliyor.
Buradan LONG mu SHORT mu?"

RSI YOK
ADX YOK
BOLLINGER YOK
MACD YOK
ORDERBOOK YOK
GEREKSİZ SKOR YOK

Kararın temeli fiyat yapısıdır.
=========================================================
*/

const CONFIG = {
  REFRESH_MS: 60 * 1000,

  // Evren
  MARKET_LIMIT: 600,
  MIN_VOLUME_USDT: 500000,

  // Derin analiz
  DEEP_ANALYSIS_LIMIT: 300,

  // API kontrolü
  CONCURRENCY: 6,
  REQUEST_DELAY_MS: 80,
  REQUEST_TIMEOUT_MS: 10000,

  // Mum sayıları
  FOUR_HOUR_LIMIT: 120,
  TWO_HOUR_LIMIT: 120,
  FIFTEEN_MIN_LIMIT: 100,

  // Seviye arama
  SWING_LEFT: 2,
  SWING_RIGHT: 2,

  // Seviyelerin bir bölge olarak birleşmesi
  LEVEL_CLUSTER_PERCENT: 0.45,

  // Fiyatın seviyeye yaklaşma mesafesi
  MAX_LEVEL_DISTANCE_PERCENT: 1.20,

  // Güçlü seviye için minimum temas
  MIN_LEVEL_TOUCHES: 2,

  // Aynı anda gösterilecek sinyal
  MAX_SIGNALS: 10,

  // Sinyal girişinden bu kadar uzaklaşırsa kaldır
  MISSED_BUFFER_PERCENT: 0.35,

  // Aynı coin tekrar sinyal üretmeden önce
  SIGNAL_COOLDOWN_MS: 30 * 60 * 1000,

  // TP oranları
  TP1_R: 1.0,
  TP2_R: 2.0,
  TP3_R: 3.0,

  // Stop için seviye dışı tampon
  STOP_BUFFER_PERCENT: 0.35,

  // 15M yön teyidi
  CONFIRMATION_LOOKBACK: 12,

  // Minimum risk
  MIN_RISK_PERCENT: 0.20,

  // Maksimum risk
  MAX_RISK_PERCENT: 3.00
};

let marketCache = [];
let lastScan = null;
let lastError = null;
let scanRunning = false;
let cachedResult = null;
let discoveryTime = null;

const activeSignals = new Map();
const cooldowns = new Map();

/*
=========================================================
GENEL YARDIMCILAR
=========================================================
*/

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function round(value, digits = 8) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(digits));
}

function percentDistance(price, level) {
  if (!price || !level) return Infinity;
  return Math.abs(price - level) / level * 100;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values) {
  if (!values.length) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2) {
    return sorted[middle];
  }

  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function normalizeCandles(raw) {
  if (!Array.isArray(raw)) return [];

  return raw
    .map(row => ({
      time: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
      quoteVolume: Number(row[6])
    }))
    .filter(c =>
      Number.isFinite(c.time) &&
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close)
    )
    .sort((a, b) => a.time - b.time);
}

/*
=========================================================
HTTP
=========================================================
*/

async function fetchJSON(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();

    const timer = setTimeout(() => {
      controller.abort();
    }, CONFIG.REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": "Sonny-AI-Trader/8.0"
        },
        signal: controller.signal
      });

      clearTimeout(timer);

      if (response.status === 429) {
        const wait = 700 + attempt * 900;
        await sleep(wait);
        continue;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const json = await response.json();

      if (json.code && json.code !== "00000") {
        throw new Error(`${json.code}: ${json.msg || "Bitget error"}`);
      }

      return json;
    } catch (error) {
      clearTimeout(timer);

      if (attempt === retries) {
        throw error;
      }

      await sleep(400 + attempt * 500);
    }
  }

  throw new Error("Request failed");
}

/*
=========================================================
MARKET DISCOVERY
=========================================================
*/

async function discoverMarket() {
  const url =
    `${BITGET_BASE}/api/v2/mix/market/tickers` +
    `?productType=${PRODUCT_TYPE}`;

  const json = await fetchJSON(url);

  const rows = Array.isArray(json.data) ? json.data : [];

  const coins = rows
    .filter(row => {
      const symbol = String(row.symbol || "");

      if (!symbol.endsWith("USDT")) return false;

      const volume = Number(row.usdtVolume || row.quoteVolume || 0);

      if (!Number.isFinite(volume)) return false;

      if (volume < CONFIG.MIN_VOLUME_USDT) return false;

      const last = Number(row.lastPr);

      if (!Number.isFinite(last) || last <= 0) return false;

      return true;
    })
    .map(row => ({
      symbol: row.symbol,
      price: Number(row.lastPr),
      volume24h: Number(row.usdtVolume || row.quoteVolume || 0),
      change24h: Number(row.change24h || 0),
      high24h: Number(row.high24h || 0),
      low24h: Number(row.low24h || 0)
    }))
    .sort((a, b) => b.volume24h - a.volume24h)
    .slice(0, CONFIG.MARKET_LIMIT);

  marketCache = coins;
  discoveryTime = Date.now();

  log(`Discovery tamamlandı. ${coins.length} uygun coin bulundu.`);

  return coins;
}

/*
=========================================================
CANDLE DATA
=========================================================
*/

async function fetchCandles(symbol, granularity, limit) {
  const url =
    `${BITGET_BASE}/api/v2/mix/market/candles` +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&granularity=${granularity}` +
    `&limit=${limit}` +
    `&productType=${PRODUCT_TYPE}`;

  const json = await fetchJSON(url);

  return normalizeCandles(json.data || []);
}

/*
=========================================================
SWING HIGH / LOW
=========================================================
*/

function isSwingHigh(candles, index) {
  const left = CONFIG.SWING_LEFT;
  const right = CONFIG.SWING_RIGHT;

  if (index < left || index >= candles.length - right) {
    return false;
  }

  const current = candles[index].high;

  for (let i = 1; i <= left; i++) {
    if (current <= candles[index - i].high) {
      return false;
    }
  }

  for (let i = 1; i <= right; i++) {
    if (current < candles[index + i].high) {
      return false;
    }
  }

  return true;
}

function isSwingLow(candles, index) {
  const left = CONFIG.SWING_LEFT;
  const right = CONFIG.SWING_RIGHT;

  if (index < left || index >= candles.length - right) {
    return false;
  }

  const current = candles[index].low;

  for (let i = 1; i <= left; i++) {
    if (current >= candles[index - i].low) {
      return false;
    }
  }

  for (let i = 1; i <= right; i++) {
    if (current > candles[index + i].low) {
      return false;
    }
  }

  return true;
}

/*
=========================================================
LEVEL OLUŞTURMA
=========================================================
*/

function buildRawLevels(candles, timeframe) {
  const highs = [];
  const lows = [];

  const start = Math.max(
    CONFIG.SWING_LEFT,
    candles.length - 80
  );

  const end = candles.length - CONFIG.SWING_RIGHT;

  for (let i = start; i < end; i++) {
    if (isSwingHigh(candles, i)) {
      highs.push({
        price: candles[i].high,
        time: candles[i].time,
        type: "RESISTANCE",
        timeframe
      });
    }

    if (isSwingLow(candles, i)) {
      lows.push({
        price: candles[i].low,
        time: candles[i].time,
        type: "SUPPORT",
        timeframe
      });
    }
  }

  return { highs, lows };
}

/*
=========================================================
LEVEL CLUSTERING

Birbirine çok yakın seviyeler tek bölge olur.
=========================================================
*/

function clusterLevels(levels) {
  if (!levels.length) return [];

  const sorted = [...levels].sort((a, b) => a.price - b.price);

  const clusters = [];

  for (const level of sorted) {
    const last = clusters[clusters.length - 1];

    if (!last) {
      clusters.push({
        prices: [level.price],
        times: [level.time],
        types: [level.type],
        timeframes: [level.timeframe]
      });
      continue;
    }

    const center = median(last.prices);

    const distance =
      Math.abs(level.price - center) / center * 100;

    if (distance <= CONFIG.LEVEL_CLUSTER_PERCENT) {
      last.prices.push(level.price);
      last.times.push(level.time);
      last.types.push(level.type);
      last.timeframes.push(level.timeframe);
    } else {
      clusters.push({
        prices: [level.price],
        times: [level.time],
        types: [level.type],
        timeframes: [level.timeframe]
      });
    }
  }

  return clusters.map(cluster => {
    const price = median(cluster.prices);

    const has4H =
      cluster.timeframes.includes("4H");

    const has2H =
      cluster.timeframes.includes("2H");

    const supportCount =
      cluster.types.filter(x => x === "SUPPORT").length;

    const resistanceCount =
      cluster.types.filter(x => x === "RESISTANCE").length;

    let type;

    if (supportCount > resistanceCount) {
      type = "SUPPORT";
    } else if (resistanceCount > supportCount) {
      type = "RESISTANCE";
    } else {
      type = cluster.types[cluster.types.length - 1];
    }

    return {
      price: round(price),
      touches: cluster.prices.length,
      supportCount,
      resistanceCount,
      has4H,
      has2H,
      type,
      strength: calculateLevelStrength(
        cluster.prices.length,
        has4H,
        has2H,
        supportCount,
        resistanceCount
      )
    };
  });
}

function calculateLevelStrength(
  touches,
  has4H,
  has2H,
  supportCount,
  resistanceCount
) {
  let score = 40;

  score += Math.min(touches * 5, 25);

  if (has4H) score += 15;
  if (has2H) score += 10;

  if (supportCount >= 2) score += 5;
  if (resistanceCount >= 2) score += 5;

  return clamp(Math.round(score), 0, 100);
}

/*
=========================================================
15M YÖN TEYİDİ

RSI YOK.
Sadece fiyat yapısı.
=========================================================
*/

function get15mDirection(candles) {
  if (!candles || candles.length < 20) {
    return "NEUTRAL";
  }

  const recent = candles.slice(
    -CONFIG.CONFIRMATION_LOOKBACK
  );

  const firstHalf = recent.slice(
    0,
    Math.floor(recent.length / 2)
  );

  const secondHalf = recent.slice(
    Math.floor(recent.length / 2)
  );

  const firstHigh = Math.max(
    ...firstHalf.map(c => c.high)
  );

  const secondHigh = Math.max(
    ...secondHalf.map(c => c.high)
  );

  const firstLow = Math.min(
    ...firstHalf.map(c => c.low)
  );

  const secondLow = Math.min(
    ...secondHalf.map(c => c.low)
  );

  const last = recent[recent.length - 1];

  const bullish =
    secondHigh >= firstHigh &&
    secondLow >= firstLow &&
    last.close >= last.open;

  const bearish =
    secondHigh <= firstHigh &&
    secondLow <= firstLow &&
    last.close <= last.open;

  if (bullish && !bearish) return "LONG";
  if (bearish && !bullish) return "SHORT";

  return "NEUTRAL";
}

/*
=========================================================
SEVİYE ADAYI

Fiyat desteğe yakınsa LONG.
Fiyat dirence yakınsa SHORT.

15M ters yöndeyse sinyal engellenir.
Nötr ise puan düşer ama tamamen engellenmez.
=========================================================
*/

function evaluateLevel(
  symbol,
  currentPrice,
  level,
  direction15m,
  ticker
) {
  const distance =
    percentDistance(currentPrice, level.price);

  if (
    !Number.isFinite(distance) ||
    distance > CONFIG.MAX_LEVEL_DISTANCE_PERCENT
  ) {
    return null;
  }

  if (
    level.touches < CONFIG.MIN_LEVEL_TOUCHES &&
    !level.has4H &&
    !level.has2H
  ) {
    return null;
  }

  let direction;

  if (level.type === "SUPPORT") {
    direction = "LONG";
  } else {
    direction = "SHORT";
  }

  /*
  15M karşı yöndeyse bu bölge henüz hazır değil.
  */
  if (
    direction15m !== "NEUTRAL" &&
    direction15m !== direction
  ) {
    return null;
  }

  let score = level.strength;

  /*
  Fiyat seviyeye yaklaştıkça puan artar.
  */
  const proximityBonus =
    Math.max(
      0,
      20 - distance * 12
    );

  score += proximityBonus;

  /*
  4H + 2H birleşimi çok değerli.
  */
  if (level.has4H && level.has2H) {
    score += 15;
  }

  if (direction15m === direction) {
    score += 10;
  }

  /*
  Hacim burada karar vermiyor.
  Sadece likidite kalitesini hafifçe etkiliyor.
  */
  if (ticker.volume24h >= 10000000) {
    score += 3;
  }

  score = clamp(Math.round(score), 0, 100);

  return {
    symbol,
    direction,
    level,
    distance,
    score,
    direction15m,
    ticker
  };
}

/*
=========================================================
GİRİŞ / STOP / TP

Giriş bölgesi seviyenin etrafında oluşturulur.
=========================================================
*/

function buildTradePlan(candidate, candles4h, candles2h) {
  const level = candidate.level;
  const price = candidate.ticker.price;
  const direction = candidate.direction;

  const recent4H = candles4h.slice(-20);
  const recent2H = candles2h.slice(-20);

  let structuralExtreme;

  if (direction === "LONG") {
    const lows = [
      ...recent4H.map(c => c.low),
      ...recent2H.map(c => c.low),
      level.price
    ];

    structuralExtreme = Math.min(...lows);

    const entryCenter = level.price;

    let stop =
      structuralExtreme *
      (1 - CONFIG.STOP_BUFFER_PERCENT / 100);

    let risk =
      entryCenter - stop;

    /*
    Çok küçük stop oluşursa minimum risk uygula.
    */
    const minRisk =
      entryCenter *
      (CONFIG.MIN_RISK_PERCENT / 100);

    if (risk < minRisk) {
      risk = minRisk;
      stop = entryCenter - risk;
    }

    /*
    Aşırı geniş stop varsa sinyali bozma,
    fakat stopu makul seviyeye çek.
    */
    const maxRisk =
      entryCenter *
      (CONFIG.MAX_RISK_PERCENT / 100);

    if (risk > maxRisk) {
      risk = maxRisk;
      stop = entryCenter - risk;
    }

    const entryLow =
      level.price *
      (1 - 0.15 / 100);

    const entryHigh =
      level.price *
      (1 + 0.20 / 100);

    return {
      entryLow: round(entryLow),
      entryHigh: round(entryHigh),
      stop: round(stop),
      tp1: round(entryCenter + risk * CONFIG.TP1_R),
      tp2: round(entryCenter + risk * CONFIG.TP2_R),
      tp3: round(entryCenter + risk * CONFIG.TP3_R),
      risk: round(risk),
      entryCenter: round(entryCenter)
    };
  }

  const highs = [
    ...recent4H.map(c => c.high),
    ...recent2H.map(c => c.high),
    level.price
  ];

  structuralExtreme = Math.max(...highs);

  const entryCenter = level.price;

  let stop =
    structuralExtreme *
    (1 + CONFIG.STOP_BUFFER_PERCENT / 100);

  let risk =
    stop - entryCenter;

  const minRisk =
    entryCenter *
    (CONFIG.MIN_RISK_PERCENT / 100);

  if (risk < minRisk) {
    risk = minRisk;
    stop = entryCenter + risk;
  }

  const maxRisk =
    entryCenter *
    (CONFIG.MAX_RISK_PERCENT / 100);

  if (risk > maxRisk) {
    risk = maxRisk;
    stop = entryCenter + risk;
  }

  const entryLow =
    level.price *
    (1 - 0.20 / 100);

  const entryHigh =
    level.price *
    (1 + 0.15 / 100);

  return {
    entryLow: round(entryLow),
    entryHigh: round(entryHigh),
    stop: round(stop),
    tp1: round(entryCenter - risk * CONFIG.TP1_R),
    tp2: round(entryCenter - risk * CONFIG.TP2_R),
    tp3: round(entryCenter - risk * CONFIG.TP3_R),
    risk: round(risk),
    entryCenter: round(entryCenter)
  };
}

/*
=========================================================
PLAN VALIDATION

LONG için TP'ler yukarıda olmalı.
SHORT için aşağıda olmalı.
=========================================================
*/

function validateTradePlan(candidate, plan) {
  if (!plan) return false;

  if (
    !Number.isFinite(plan.entryCenter) ||
    !Number.isFinite(plan.stop) ||
    !Number.isFinite(plan.tp1)
  ) {
    return false;
  }

  if (candidate.direction === "LONG") {
    if (plan.stop >= plan.entryCenter) return false;
    if (plan.tp1 <= plan.entryCenter) return false;
    if (plan.tp2 <= plan.tp1) return false;
    if (plan.tp3 <= plan.tp2) return false;
  } else {
    if (plan.stop <= plan.entryCenter) return false;
    if (plan.tp1 >= plan.entryCenter) return false;
    if (plan.tp2 >= plan.tp1) return false;
    if (plan.tp3 >= plan.tp2) return false;
  }

  return true;
}

/*
=========================================================
SİNYAL NEDENİ
=========================================================
*/

function buildReason(candidate) {
  const parts = [];

  if (
    candidate.level.has4H &&
    candidate.level.has2H
  ) {
    parts.push("4H + 2H aynı bölge");
  } else if (candidate.level.has4H) {
    parts.push("4H güçlü seviye");
  } else if (candidate.level.has2H) {
    parts.push("2H güçlü seviye");
  }

  if (candidate.level.touches >= 3) {
    parts.push(
      `${candidate.level.touches} temas`
    );
  }

  if (candidate.direction15m === candidate.direction) {
    parts.push("15M yapı yönü onaylıyor");
  }

  return parts.join(" + ");
}

/*
=========================================================
TEK COIN ANALİZİ
=========================================================
*/

async function analyzeCoin(ticker) {
  try {
    const [candles4h, candles2h, candles15m] =
      await Promise.all([
        fetchCandles(
          ticker.symbol,
          "4H",
          CONFIG.FOUR_HOUR_LIMIT
        ),
        fetchCandles(
          ticker.symbol,
          "2H",
          CONFIG.TWO_HOUR_LIMIT
        ),
        fetchCandles(
          ticker.symbol,
          "15m",
          CONFIG.FIFTEEN_MIN_LIMIT
        )
      ]);

    if (
      candles4h.length < 30 ||
      candles2h.length < 30
    ) {
      return null;
    }

    const levels4hRaw =
      buildRawLevels(candles4h, "4H");

    const levels2hRaw =
      buildRawLevels(candles2h, "2H");

    const allLevels = [
      ...levels4hRaw.highs,
      ...levels4hRaw.lows,
      ...levels2hRaw.highs,
      ...levels2hRaw.lows
    ];

    const levels =
      clusterLevels(allLevels);

    if (!levels.length) {
      return null;
    }

    const direction15m =
      get15mDirection(candles15m);

    const candidates = [];

    for (const level of levels) {
      const candidate =
        evaluateLevel(
          ticker.symbol,
          ticker.price,
          level,
          direction15m,
          ticker
        );

      if (!candidate) continue;

      const plan =
        buildTradePlan(
          candidate,
          candles4h,
          candles2h
        );

      if (
        !validateTradePlan(
          candidate,
          plan
        )
      ) {
        continue;
      }

      candidates.push({
        ...candidate,
        plan,
        reason: buildReason(candidate)
      });
    }

    if (!candidates.length) {
      return null;
    }

    /*
    En yakın + en güçlü bölgeyi seç.
    */
    candidates.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      return a.distance - b.distance;
    });

    return candidates[0];
  } catch (error) {
    log(
      `Analiz hatası ${ticker.symbol}: ${error.message}`
    );

    return null;
  }
}

/*
=========================================================
CONCURRENCY
=========================================================
*/

async function mapWithConcurrency(
  items,
  worker,
  concurrency
) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runner() {
    while (true) {
      const index = cursor++;

      if (index >= items.length) {
        return;
      }

      try {
        results[index] =
          await worker(items[index], index);
      } catch {
        results[index] = null;
      }

      if (CONFIG.REQUEST_DELAY_MS > 0) {
        await sleep(CONFIG.REQUEST_DELAY_MS);
      }
    }
  }

  const workers = [];

  for (
    let i = 0;
    i < Math.min(concurrency, items.length);
    i++
  ) {
    workers.push(runner());
  }

  await Promise.all(workers);

  return results;
}

/*
=========================================================
SİNYAL KİMLİĞİ
=========================================================
*/

function signalKey(signal) {
  return `${signal.symbol}_${signal.direction}`;
}

/*
=========================================================
COOLDOWN
=========================================================
*/

function isOnCooldown(symbol, direction) {
  const key = `${symbol}_${direction}`;

  const until = cooldowns.get(key);

  if (!until) return false;

  if (Date.now() >= until) {
    cooldowns.delete(key);
    return false;
  }

  return true;
}

/*
=========================================================
SİNYAL EKLEME
=========================================================
*/

function registerSignal(candidate) {
  const key =
    signalKey(candidate);

  const existing =
    activeSignals.get(key);

  /*
  Aynı sinyal zaten ekranda.
  */
  if (existing) {
    return existing;
  }

  /*
  Aynı coin/yön cooldown içindeyse tekrar üretme.
  */
  if (
    isOnCooldown(
      candidate.symbol,
      candidate.direction
    )
  ) {
    return null;
  }

  const signal = {
    id:
      `${candidate.symbol}_${candidate.direction}_${Date.now()}`,

    symbol: candidate.symbol,

    direction: candidate.direction,

    score: candidate.score,

    currentPrice: candidate.ticker.price,

    level: candidate.level.price,

    levelType: candidate.level.type,

    levelStrength: candidate.level.strength,

    distance: candidate.distance,

    direction15m: candidate.direction15m,

    entryLow: candidate.plan.entryLow,

    entryHigh: candidate.plan.entryHigh,

    entryCenter: candidate.plan.entryCenter,

    stop: candidate.plan.stop,

    tp1: candidate.plan.tp1,

    tp2: candidate.plan.tp2,

    tp3: candidate.plan.tp3,

    risk: candidate.plan.risk,

    reason: candidate.reason,

    createdAt: Date.now(),

    updatedAt: Date.now(),

    status: "ACTIVE"
  };

  /*
  Sinyal limiti.
  En zayıf sinyali çıkar.
  */
  if (
    activeSignals.size >=
    CONFIG.MAX_SIGNALS
  ) {
    const weakest =
      [...activeSignals.entries()]
        .sort(
          (a, b) =>
            a[1].score - b[1].score
        )[0];

    if (
      weakest &&
      weakest[1].score < signal.score
    ) {
      activeSignals.delete(
        weakest[0]
      );
    } else {
      return null;
    }
  }

  activeSignals.set(key, signal);

  return signal;
}

/*
=========================================================
AKTİF SİNYAL TEMİZLEME

Giriş bölgesinden uzaklaşırsa kaldırılır.
=========================================================
*/

function updateActiveSignals() {
  for (
    const [key, signal]
    of activeSignals.entries()
  ) {
    const ticker =
      marketCache.find(
        x => x.symbol === signal.symbol
      );

    if (!ticker) continue;

    const price = ticker.price;

    signal.currentPrice = price;
    signal.updatedAt = Date.now();

    const low =
      Math.min(
        signal.entryLow,
        signal.entryHigh
      );

    const high =
      Math.max(
        signal.entryLow,
        signal.entryHigh
      );

    let missed = false;

    if (signal.direction === "LONG") {
      if (
        price <
        low *
          (1 -
            CONFIG.MISSED_BUFFER_PERCENT /
              100)
      ) {
        missed = true;
      }

      if (
        price >
        high *
          (1 +
            CONFIG.MISSED_BUFFER_PERCENT /
              100)
      ) {
        missed = true;
      }
    } else {
      if (
        price >
        high *
          (1 +
            CONFIG.MISSED_BUFFER_PERCENT /
              100)
      ) {
        missed = true;
      }

      if (
        price <
        low *
          (1 -
            CONFIG.MISSED_BUFFER_PERCENT /
              100)
      ) {
        missed = true;
      }
    }

    if (missed) {
      activeSignals.delete(key);

      cooldowns.set(
        key,
        Date.now() +
          CONFIG.SIGNAL_COOLDOWN_MS
      );

      log(
        `${signal.symbol} ${signal.direction} sinyali kaldırıldı | Fiyat giriş bölgesinden uzaklaştı`
      );
    }
  }
}

/*
=========================================================
PİYASA YÖNÜ
Basit BTC / ETH 4H yapı karşılaştırması.
=========================================================
*/

function marketDirectionFromCandles(
  btc,
  eth
) {
  const directions = [];

  for (
    const candles of [btc, eth]
  ) {
    if (
      !candles ||
      candles.length < 20
    ) {
      continue;
    }

    const recent =
      candles.slice(-20);

    const first =
      recent.slice(0, 10);

    const second =
      recent.slice(10);

    const firstClose =
      average(
        first.map(x => x.close)
      );

    const secondClose =
      average(
        second.map(x => x.close)
      );

    if (
      secondClose >
      firstClose * 1.002
    ) {
      directions.push("UP");
    } else if (
      secondClose <
      firstClose * 0.998
    ) {
      directions.push("DOWN");
    } else {
      directions.push("SIDEWAYS");
    }
  }

  if (
    directions.length === 2 &&
    directions.every(
      x => x === "UP"
    )
  ) {
    return "YUKARI";
  }

  if (
    directions.length === 2 &&
    directions.every(
      x => x === "DOWN"
    )
  ) {
    return "AŞAĞI";
  }

  if (
    directions.includes("UP") &&
    directions.includes("DOWN")
  ) {
    return "KARIŞIK";
  }

  return "YATAY";
}

/*
=========================================================
TARAMA
=========================================================
*/

async function runScan() {
  if (scanRunning) {
    return cachedResult;
  }

  scanRunning = true;

  try {
    log("Bitget piyasası yeniden taranıyor...");

    const universe =
      await discoverMarket();

    updateActiveSignals();

    /*
    Hacim sıralı ilk 300 coin.
    600 coinlik evren korunur.
    Ağır analiz 300 coin üzerinde yapılır.
    */
    const candidates =
      universe.slice(
        0,
        CONFIG.DEEP_ANALYSIS_LIMIT
      );

    log(
      `RADAR başladı | Universe=${universe.length} | DeepAnalysis=${candidates.length}`
    );

    const analyzed =
      await mapWithConcurrency(
        candidates,
        ticker =>
          analyzeCoin(ticker),
        CONFIG.CONCURRENCY
      );

    let newSignals = 0;

    for (const candidate of analyzed) {
      if (!candidate) continue;

      const signal =
        registerSignal(candidate);

      if (signal) {
        newSignals++;
      }
    }

    /*
    Aktif sinyallerde fiyatı güncelle.
    */
    updateActiveSignals();

    /*
    Piyasa yönü.
    */
    let marketDirection =
      "VERİ BEKLENİYOR";

    try {
      const btcTicker =
        universe.find(
          x => x.symbol === "BTCUSDT"
        );

      const ethTicker =
        universe.find(
          x => x.symbol === "ETHUSDT"
        );

      if (btcTicker && ethTicker) {
        const [btc4h, eth4h] =
          await Promise.all([
            fetchCandles(
              "BTCUSDT",
              "4H",
              30
            ),
            fetchCandles(
              "ETHUSDT",
              "4H",
              30
            )
          ]);

        marketDirection =
          marketDirectionFromCandles(
            btc4h,
            eth4h
          );
      }
    } catch {
      marketDirection =
        "VERİ BEKLENİYOR";
    }

    const signals =
      [...activeSignals.values()]
        .sort((a, b) => {
          if (
            b.score !== a.score
          ) {
            return (
              b.score - a.score
            );
          }

          return (
            a.distance -
            b.distance
          );
        })
        .slice(
          0,
          CONFIG.MAX_SIGNALS
        );

    lastScan = Date.now();

    cachedResult = {
      system: SYSTEM_NAME,

      online: true,

      market: {
        direction:
          marketDirection,

        universe:
          universe.length,

        analyzed:
          candidates.length
      },

      signals,

      scan: {
        time: lastScan,

        newSignals,

        activeSignals:
          activeSignals.size
      }
    };

    lastError = null;

    log(
      `RADAR tamamlandı | Universe=${universe.length} | Analiz=${candidates.length} | SIGNAL=${activeSignals.size}`
    );

    return cachedResult;
  } catch (error) {
    lastError = error.message;

    log(
      `RADAR HATASI: ${error.message}`
    );

    if (!cachedResult) {
      cachedResult = {
        system: SYSTEM_NAME,
        online: false,
        market: {
          direction:
            "VERİ BEKLENİYOR",
          universe: 0,
          analyzed: 0
        },
        signals: [],
        scan: {
          time: null,
          newSignals: 0,
          activeSignals: 0
        }
      };
    }

    return cachedResult;
  } finally {
    scanRunning = false;
  }
}

/*
=========================================================
BINANCE TRADINGVIEW
=========================================================
*/

function tradingViewUrl(symbol) {
  /*
  Bitget değil.
  Kullanıcı Binance grafik istiyor.
  */
  return (
    "https://www.tradingview.com/symbols/" +
    encodeURIComponent(symbol) +
    "/?exchange=BINANCE"
  );
}

/*
=========================================================
HTML
=========================================================
*/

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function fmt(value) {
  if (!Number.isFinite(Number(value))) {
    return "-";
  }

  const n = Number(value);

  if (Math.abs(n) >= 1000) {
    return n.toLocaleString(
      "en-US",
      {
        maximumFractionDigits: 2
      }
    );
  }

  if (Math.abs(n) >= 1) {
    return n.toFixed(4);
  }

  if (Math.abs(n) >= 0.01) {
    return n.toFixed(6);
  }

  return n.toFixed(8);
}

function renderSignal(signal) {
  const long =
    signal.direction === "LONG";

  const colorClass =
    long ? "long" : "short";

  const arrow =
    long ? "🟢" : "🔴";

  const levelText =
    signal.levelType === "SUPPORT"
      ? "DESTEK"
      : "DİRENÇ";

  const strength =
    signal.levelStrength >= 85
      ? "ÇOK GÜÇLÜ"
      : signal.levelStrength >= 70
        ? "GÜÇLÜ"
        : "NORMAL";

  return `
    <div class="signal-card">

      <div class="signal-top">

        <div>
          <div class="symbol">
            ${arrow}
            ${escapeHtml(signal.symbol)}
          </div>

          <div class="direction ${colorClass}">
            ${escapeHtml(signal.direction)}
          </div>
        </div>

        <div class="score">
          ${signal.score}/100
        </div>

      </div>

      <div class="live">
        CANLI FİYAT:
        <strong>${fmt(signal.currentPrice)}</strong>
      </div>

      <div class="zone">
        <div>
          <span>4H / 2H SEVİYE</span>
          <strong>${fmt(signal.level)}</strong>
        </div>

        <div>
          <span>SEVİYE</span>
          <strong>${levelText}</strong>
        </div>

        <div>
          <span>GÜÇ</span>
          <strong>${strength}</strong>
        </div>

        <div>
          <span>UZAKLIK</span>
          <strong>%${signal.distance.toFixed(2)}</strong>
        </div>
      </div>

      <div class="trade-grid">

        <div class="trade-box">
          <span>GİRİŞ</span>
          <strong>
            ${fmt(signal.entryLow)}
            -
            ${fmt(signal.entryHigh)}
          </strong>
        </div>

        <div class="trade-box stop">
          <span>STOP</span>
          <strong>${fmt(signal.stop)}</strong>
        </div>

        <div class="trade-box tp">
          <span>TP1</span>
          <strong>${fmt(signal.tp1)}</strong>
        </div>

        <div class="trade-box tp">
          <span>TP2</span>
          <strong>${fmt(signal.tp2)}</strong>
        </div>

        <div class="trade-box tp">
          <span>TP3</span>
          <strong>${fmt(signal.tp3)}</strong>
        </div>

      </div>

      <div class="reason">
        <b>NEDEN?</b>
        ${escapeHtml(signal.reason)}
      </div>

      <div class="confirmation">
        15M YÖN:
        <strong>
          ${escapeHtml(signal.direction15m)}
        </strong>
      </div>

      <a
        class="chart"
        href="${tradingViewUrl(signal.symbol)}"
        target="_blank"
        rel="noopener noreferrer"
      >
        📊 BINANCE TRADINGVIEW AÇ
      </a>

    </div>
  `;
}

function renderPage(result) {
  const signals =
    result?.signals || [];

  const market =
    result?.market || {};

  const direction =
    market.direction ||
    "VERİ BEKLENİYOR";

  let marketClass = "";

  if (direction === "YUKARI") {
    marketClass = "market-up";
  } else if (
    direction === "AŞAĞI"
  ) {
    marketClass = "market-down";
  }

  const cards =
    signals.length
      ? signals.map(renderSignal).join("")
      : `
        <div class="empty">
          Şu anda karar kriterlerini karşılayan
          aktif LONG veya SHORT sinyal yok.
          Sistem taramaya devam ediyor.
        </div>
      `;

  const scanTime =
    lastScan
      ? new Date(lastScan)
          .toLocaleTimeString("tr-TR")
      : "-";

  return `
<!DOCTYPE html>

<html lang="tr">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
/>

<title>
  ${SYSTEM_NAME}
</title>

<style>

*{
  box-sizing:border-box;
}

body{
  margin:0;
  background:#070b12;
  color:#edf2f7;
  font-family:
    Inter,
    Arial,
    sans-serif;
}

.wrap{
  max-width:1100px;
  margin:auto;
  padding:25px;
}

.header{
  display:flex;
  justify-content:space-between;
  align-items:center;
  gap:20px;
  margin-bottom:20px;
}

.title{
  font-size:26px;
  font-weight:900;
}

.subtitle{
  margin-top:6px;
  color:#7f8da3;
  font-size:13px;
}

.online{
  color:#4de69a;
  font-weight:900;
  font-size:13px;
}

.market{
  background:#0c121d;
  border:1px solid #1d2a3c;
  border-radius:14px;
  padding:18px;
  margin-bottom:20px;
}

.market-title{
  color:#7f8da3;
  font-size:11px;
  font-weight:900;
  margin-bottom:8px;
}

.market-direction{
  font-size:22px;
  font-weight:900;
}

.market-up{
  color:#45e58d;
}

.market-down{
  color:#ff657a;
}

.stats{
  display:grid;
  grid-template-columns:
    repeat(4,1fr);
  gap:10px;
  margin-top:15px;
}

.stat{
  background:#111927;
  border-radius:10px;
  padding:13px;
}

.stat span{
  display:block;
  color:#66758b;
  font-size:10px;
  font-weight:900;
  margin-bottom:5px;
}

.stat strong{
  font-size:20px;
}

.section-title{
  font-size:17px;
  font-weight:900;
  margin:25px 0 10px;
}

.signal-card{
  background:#0c121d;
  border:1px solid #26354a;
  border-radius:14px;
  padding:17px;
  margin-bottom:12px;
}

.signal-top{
  display:flex;
  justify-content:space-between;
  align-items:flex-start;
}

.symbol{
  font-size:21px;
  font-weight:900;
}

.direction{
  margin-top:4px;
  font-size:14px;
  font-weight:900;
}

.long{
  color:#45e58d;
}

.short{
  color:#ff657a;
}

.score{
  background:#192335;
  padding:7px 10px;
  border-radius:8px;
  font-weight:900;
}

.live{
  margin-top:12px;
  color:#718097;
  font-size:12px;
}

.live strong{
  color:#fff;
  font-size:16px;
  margin-left:4px;
}

.zone{
  display:grid;
  grid-template-columns:
    repeat(4,1fr);
  gap:8px;
  margin-top:14px;
}

.zone div{
  background:#111927;
  padding:10px;
  border-radius:9px;
}

.zone span,
.trade-box span{
  display:block;
  color:#66758b;
  font-size:9px;
  font-weight:900;
  margin-bottom:5px;
}

.zone strong{
  font-size:13px;
}

.trade-grid{
  display:grid;
  grid-template-columns:
    repeat(5,1fr);
  gap:8px;
  margin-top:9px;
}

.trade-box{
  background:#151f2d;
  padding:11px;
  border-radius:9px;
}

.trade-box strong{
  font-size:13px;
}

.trade-box.stop{
  border:1px solid #5a2630;
}

.trade-box.tp{
  border:1px solid #214c3b;
}

.reason{
  margin-top:12px;
  background:#101925;
  border-radius:9px;
  padding:11px;
  color:#aeb9c8;
  font-size:12px;
}

.reason b{
  color:#fff;
  margin-right:6px;
}

.confirmation{
  margin-top:10px;
  color:#738198;
  font-size:11px;
}

.confirmation strong{
  color:#dbe5f0;
}

.chart{
  display:inline-block;
  margin-top:12px;
  background:#eef2f7;
  color:#0a0f17;
  text-decoration:none;
  border-radius:8px;
  padding:9px 13px;
  font-size:11px;
  font-weight:900;
}

.empty{
  background:#0c121d;
  border:1px solid #1d2a3c;
  border-radius:12px;
  padding:25px;
  color:#75839a;
  text-align:center;
}

.footer{
  margin-top:25px;
  color:#56657b;
  font-size:11px;
  text-align:center;
}

@media(max-width:800px){

  .header{
    display:block;
  }

  .stats{
    grid-template-columns:
      repeat(2,1fr);
  }

  .zone{
    grid-template-columns:
      repeat(2,1fr);
  }

  .trade-grid{
    grid-template-columns:
      repeat(2,1fr);
  }

}

</style>

</head>

<body>

<div class="wrap">

  <div class="header">

    <div>

      <div class="title">
        🚀 Sonny AI Signal Scanner V8
      </div>

      <div class="subtitle">
        4H Destek/Direnç · 2H Onay ·
        15M Yapı · Otomatik LONG/SHORT
      </div>

    </div>

    <div class="online">
      ● SÜREKLİ AKTİF
    </div>

  </div>

  <div class="market">

    <div class="market-title">
      GENEL PİYASA DURUMU
    </div>

    <div
      class="market-direction ${marketClass}"
    >
      ${escapeHtml(direction)}
    </div>

    <div class="stats">

      <div class="stat">
        <span>COIN EVRENİ</span>
        <strong>
          ${market.universe ?? "-"}
        </strong>
      </div>

      <div class="stat">
        <span>ANALİZ</span>
        <strong>
          ${market.analyzed ?? "-"}
        </strong>
      </div>

      <div class="stat">
        <span>AKTİF SİNYAL</span>
        <strong>
          ${signals.length}
        </strong>
      </div>

      <div class="stat">
        <span>SON TARAMA</span>
        <strong>
          ${scanTime}
        </strong>
      </div>

    </div>

  </div>

  <div class="section-title">
    🚨 AKTİF SİNYALLER
  </div>

  ${cards}

  <div class="footer">
    Sonny V8 aktif · Bitget veri kaynağı ·
    TradingView grafik Binance üzerinden açılır ·
    Her ${CONFIG.REFRESH_MS / 1000} saniyede tarama
  </div>

</div>

<script>

setTimeout(() => {
  location.reload();
}, ${10000});

</script>

</body>

</html>
  `;
}

/*
=========================================================
ROUTES
=========================================================
*/

app.get("/", (req, res) => {
  res
    .status(200)
    .send(
      renderPage(
        cachedResult || {
          market: {
            direction:
              "VERİ BEKLENİYOR",
            universe: 0,
            analyzed: 0
          },
          signals: []
        }
      )
    );
});

app.get("/api/result", (req, res) => {
  res.json(
    cachedResult || {
      system: SYSTEM_NAME,
      online: true,
      market: {
        direction:
          "VERİ BEKLENİYOR",
        universe: 0,
        analyzed: 0
      },
      signals: []
    }
  );
});

app.get("/api/signals", (req, res) => {
  res.json({
    system: SYSTEM_NAME,
    signals:
      [...activeSignals.values()]
  });
});

app.get("/api/status", (req, res) => {
  res.json({
    system: SYSTEM_NAME,
    online: true,
    scanning: scanRunning,
    lastScan,
    discoveryTime,
    marketSize:
      marketCache.length,
    activeSignals:
      activeSignals.size,
    error: lastError
  });
});

/*
Manuel tarama.
*/
app.get("/api/scan", async (req, res) => {
  if (scanRunning) {
    return res.json({
      ok: true,
      message:
        "Tarama zaten çalışıyor."
    });
  }

  const result =
    await runScan();

  res.json(result);
});

/*
=========================================================
ARKA PLAN DÖNGÜSÜ
=========================================================
*/

async function scanLoop() {
  try {
    await runScan();
  } catch (error) {
    log(
      `Loop hatası: ${error.message}`
    );
  } finally {
    setTimeout(
      scanLoop,
      CONFIG.REFRESH_MS
    );
  }
}

/*
=========================================================
START
=========================================================
*/

app.listen(PORT, async () => {

  log(
    `${SYSTEM_NAME} started`
  );

  log(
    "Data source: BITGET"
  );

  log(
    "Strategy: 4H SUPPORT/RESISTANCE + 2H CONFIRMATION + 15M STRUCTURE"
  );

  log(
    `Universe limit: ${CONFIG.MARKET_LIMIT}`
  );

  log(
    `Deep analysis: ${CONFIG.DEEP_ANALYSIS_LIMIT}`
  );

  log(
    `Refresh: ${CONFIG.REFRESH_MS / 1000} seconds`
  );

  log(
    `Server listening on port ${PORT}`
  );

  /*
  İlk tarama.
  */
  await runScan();

  /*
  Sonraki taramalar.
  */
  setTimeout(
    scanLoop,
    CONFIG.REFRESH_MS
  );
});

/*
=========================================================
HATALAR
=========================================================
*/

process.on(
  "unhandledRejection",
  error => {
    log(
      `UNHANDLED REJECTION: ${error?.message || error}`
    );
  }
);

process.on(
  "uncaughtException",
  error => {
    log(
      `UNCAUGHT EXCEPTION: ${error.message}`
    );
  }
);
