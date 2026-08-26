const http = require("http");
const { URL } = require("url");

/*
  ============================================================
  SONNY AI TRADER V10
  ============================================================

  Node 20+ / Node 26
  Harici npm paketi gerektirmez.
  dotenv YOK
  express YOK

  VERİ:
  Bitget USDT Futures

  STRATEJİ:
  4H Destek / Direnç
  2H Destek / Direnç doğrulaması
  15M yapı yönü
  Otomatik LONG / SHORT

  PANEL:
  Sol: aktif sinyaller
  Sağ: canlı grafik
  Giriş / Stop / TP çizgileri
  Sinyal yaşı
  Canlı fiyat

  ============================================================
*/

const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";

const BITGET_API = "https://api.bitget.com";
const PRODUCT_TYPE = "USDT-FUTURES";

/* ------------------------------------------------------------
   AYARLAR
------------------------------------------------------------ */

const MAX_SIGNALS = 10;

const SCAN_INTERVAL = 60 * 1000;
const LIVE_INTERVAL = 10 * 1000;

const CANDLE_LIMIT = 180;

const MIN_VOLUME_USDT = 1_000_000;

/*
  Güncel fiyat ile destek/direnç arasındaki maksimum mesafe.
  Örn. %0.65 => seviyeye %0.65 veya daha yakın coinler.
*/
const MAX_LEVEL_DISTANCE = 0.65;

/*
  Birbirine %0.35'ten yakın seviyeler aynı bölge kabul edilir.
*/
const LEVEL_MERGE_DISTANCE = 0.35;

/*
  Sinyal 90 dakika içerisinde girişe dönüşmezse kaldırılır.
*/
const SIGNAL_MAX_AGE = 90 * 60 * 1000;

/*
  Giriş bölgesi seviyenin ±%0.18'i.
*/
const ENTRY_ZONE_PERCENT = 0.18;

/*
  Stop seviyeden %1.25.
*/
const STOP_PERCENT = 1.25;

/*
  TP'ler risk katları.
*/
const TP1_R = 1;
const TP2_R = 2;
const TP3_R = 3;

/* ------------------------------------------------------------
   GLOBAL STATE
------------------------------------------------------------ */

let universe = [];
let tickerMap = new Map();

let activeSignals = new Map();

let lastScan = null;
let scanning = false;
let liveUpdating = false;

let scanStats = {
  universe: 0,
  analysed: 0,
  signals: 0,
  errors: 0
};

let lastError = "";

/* ------------------------------------------------------------
   HELPERS
------------------------------------------------------------ */

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function percentageDistance(a, b) {
  if (!b) return 999;
  return Math.abs(a - b) / b * 100;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/* ------------------------------------------------------------
   BITGET API
------------------------------------------------------------ */

async function bitgetRequest(path, params = {}) {

  const url = new URL(BITGET_API + path);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Bitget HTTP ${response.status}`);
  }

  const json = await response.json();

  if (json.code && json.code !== "00000") {
    throw new Error(
      `Bitget ${json.code}: ${json.msg || "API error"}`
    );
  }

  return json.data;
}

/* ------------------------------------------------------------
   CANDLE NORMALIZATION
------------------------------------------------------------ */

function normalizeCandle(row) {

  return {
    time: Math.floor(Number(row[0]) / 1000),

    open: num(row[1]),
    high: num(row[2]),
    low: num(row[3]),
    close: num(row[4]),

    volume: num(row[5]) || 0
  };
}

/* ------------------------------------------------------------
   GET CANDLES
------------------------------------------------------------ */

async function getCandles(
  symbol,
  granularity,
  limit = CANDLE_LIMIT
) {

  const data = await bitgetRequest(
    "/api/v2/mix/market/candles",
    {
      symbol,
      granularity,
      limit,
      productType: PRODUCT_TYPE
    }
  );

  return (Array.isArray(data) ? data : [])
    .map(normalizeCandle)
    .filter(c =>
      c.open !== null &&
      c.high !== null &&
      c.low !== null &&
      c.close !== null
    )
    .sort((a, b) => a.time - b.time);
}

/* ------------------------------------------------------------
   DISCOVERY
------------------------------------------------------------ */

async function discoverUniverse() {

  const [
    contracts,
    tickers
  ] = await Promise.all([

    bitgetRequest(
      "/api/v2/mix/market/contracts",
      {
        productType: PRODUCT_TYPE
      }
    ),

    bitgetRequest(
      "/api/v2/mix/market/tickers",
      {
        productType: PRODUCT_TYPE
      }
    )
  ]);

  const tickerLookup = new Map();

  for (const ticker of tickers || []) {
    tickerLookup.set(ticker.symbol, ticker);
  }

  tickerMap = tickerLookup;

  universe = (contracts || [])
    .filter(contract =>
      contract.symbolStatus === "normal" &&
      contract.symbolType === "perpetual" &&
      contract.quoteCoin === "USDT"
    )
    .map(contract => {

      const ticker =
        tickerLookup.get(contract.symbol);

      return {
        symbol: contract.symbol,

        pricePlace:
          Number(contract.pricePlace || 8),

        last:
          num(ticker?.lastPr),

        volume:
          num(ticker?.usdtVolume) ||
          num(ticker?.quoteVolume) ||
          0
      };
    })
    .filter(item =>
      item.last !== null &&
      item.volume >= MIN_VOLUME_USDT
    )
    .sort((a, b) =>
      b.volume - a.volume
    );

  log(
    `Discovery tamamlandı | Universe=${universe.length}`
  );
}

/* ------------------------------------------------------------
   SWING HIGH / LOW
------------------------------------------------------------ */

function findSwingLevels(
  candles,
  left = 2,
  right = 2
) {

  const levels = [];

  for (
    let i = left;
    i < candles.length - right;
    i++
  ) {

    const current = candles[i];

    let isHigh = true;
    let isLow = true;

    for (let j = 1; j <= left; j++) {

      if (
        candles[i - j].high >=
        current.high
      ) {
        isHigh = false;
      }

      if (
        candles[i - j].low <=
        current.low
      ) {
        isLow = false;
      }
    }

    for (let j = 1; j <= right; j++) {

      if (
        candles[i + j].high >
        current.high
      ) {
        isHigh = false;
      }

      if (
        candles[i + j].low <
        current.low
      ) {
        isLow = false;
      }
    }

    if (isHigh) {

      levels.push({
        price: current.high,
        type: "resistance",
        time: current.time
      });
    }

    if (isLow) {

      levels.push({
        price: current.low,
        type: "support",
        time: current.time
      });
    }
  }

  return levels;
}

/* ------------------------------------------------------------
   LEVEL MERGING
------------------------------------------------------------ */

function mergeLevels(levels) {

  const sorted =
    [...levels].sort(
      (a, b) => a.price - b.price
    );

  const groups = [];

  for (const level of sorted) {

    const last =
      groups[groups.length - 1];

    if (
      !last ||
      percentageDistance(
        level.price,
        last.price
      ) > LEVEL_MERGE_DISTANCE
    ) {

      groups.push({

        price: level.price,

        support:
          level.type === "support"
            ? 1
            : 0,

        resistance:
          level.type === "resistance"
            ? 1
            : 0,

        touches: 1,

        lastTime: level.time

      });

    } else {

      last.price =
        (
          last.price * last.touches +
          level.price
        ) /
        (last.touches + 1);

      if (level.type === "support") {
        last.support++;
      }

      if (level.type === "resistance") {
        last.resistance++;
      }

      last.touches++;

      last.lastTime =
        Math.max(
          last.lastTime,
          level.time
        );
    }
  }

  return groups;
}

/* ------------------------------------------------------------
   FIND NEAREST IMPORTANT LEVEL
------------------------------------------------------------ */

function findNearestLevel(
  price,
  candles4H,
  candles2H
) {

  const levels4H =
    findSwingLevels(candles4H)
      .map(level => ({
        ...level,
        timeframe: "4H"
      }));

  const levels2H =
    findSwingLevels(candles2H)
      .map(level => ({
        ...level,
        timeframe: "2H"
      }));

  const allLevels = [
    ...levels4H,
    ...levels2H
  ];

  const merged =
    mergeLevels(allLevels);

  const candidates = [];

  for (const level of merged) {

    /*
      Fiyat seviyenin altındaysa:
      destek -> LONG

      Fiyat seviyenin üstündeyse:
      direnç -> SHORT
    */

    const type =
      level.price < price
        ? "support"
        : "resistance";

    const distance =
      percentageDistance(
        price,
        level.price
      );

    if (
      distance >
      MAX_LEVEL_DISTANCE
    ) {
      continue;
    }

    const has4H =
      levels4H.some(x =>
        percentageDistance(
          x.price,
          level.price
        ) <= LEVEL_MERGE_DISTANCE
      );

    const has2H =
      levels2H.some(x =>
        percentageDistance(
          x.price,
          level.price
        ) <= LEVEL_MERGE_DISTANCE
      );

    const confluence =
      has4H && has2H;

    let touches =
      level.touches;

    if (confluence) {
      touches += 2;
    }

    candidates.push({

      price: level.price,

      type,

      distance,

      touches,

      confluence,

      lastTime: level.lastTime

    });
  }

  candidates.sort((a, b) => {

    if (
      a.confluence !==
      b.confluence
    ) {
      return b.confluence - a.confluence;
    }

    if (
      a.touches !==
      b.touches
    ) {
      return b.touches - a.touches;
    }

    return a.distance - b.distance;
  });

  return candidates[0] || null;
}

/* ------------------------------------------------------------
   EMA
------------------------------------------------------------ */

function calculateEMA(
  candles,
  period
) {

  if (!candles.length) {
    return null;
  }

  const k =
    2 / (period + 1);

  let ema =
    candles[0].close;

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {

    ema =
      candles[i].close * k +
      ema * (1 - k);
  }

  return ema;
}

/* ------------------------------------------------------------
   15M STRUCTURE
------------------------------------------------------------ */

function detect15MStructure(
  candles
) {

  if (candles.length < 20) {
    return "NEUTRAL";
  }

  const recent =
    candles.slice(-60);

  const ema20 =
    calculateEMA(
      recent,
      20
    );

  const ema50 =
    calculateEMA(
      recent,
      50
    );

  const last =
    candles[candles.length - 1].close;

  const previous =
    candles.slice(-8, -1);

  const previousHigh =
    Math.max(
      ...previous.map(x => x.high)
    );

  const previousLow =
    Math.min(
      ...previous.map(x => x.low)
    );

  if (
    last > previousHigh &&
    ema20 > ema50
  ) {
    return "LONG";
  }

  if (
    last < previousLow &&
    ema20 < ema50
  ) {
    return "SHORT";
  }

  if (
    ema20 > ema50 &&
    last > ema20
  ) {
    return "LONG";
  }

  if (
    ema20 < ema50 &&
    last < ema20
  ) {
    return "SHORT";
  }

  return "NEUTRAL";
}

/* ------------------------------------------------------------
   BUILD SIGNAL
------------------------------------------------------------ */

function createSignal(
  symbol,
  price,
  level,
  structure15
) {

  const direction =
    level.type === "support"
      ? "LONG"
      : "SHORT";

  const center =
    level.price;

  const zone =
    center *
    ENTRY_ZONE_PERCENT /
    100;

  const entryLow =
    center - zone;

  const entryHigh =
    center + zone;

  const risk =
    center *
    STOP_PERCENT /
    100;

  let stop;
  let tp1;
  let tp2;
  let tp3;

  if (direction === "LONG") {

    stop = center - risk;

    tp1 =
      center +
      risk * TP1_R;

    tp2 =
      center +
      risk * TP2_R;

    tp3 =
      center +
      risk * TP3_R;

  } else {

    stop = center + risk;

    tp1 =
      center -
      risk * TP1_R;

    tp2 =
      center -
      risk * TP2_R;

    tp3 =
      center -
      risk * TP3_R;
  }

  /*
    SCORE
    ------------------------------------------------
    Temel seviye        55
    4H + 2H             +25
    Temas                +3 / temas
    15M aynı yön        +10
    15M ters yön        -15
  */

  let score = 55;

  if (level.confluence) {
    score += 25;
  }

  score +=
    Math.min(
      15,
      Math.max(
        0,
        level.touches - 1
      ) * 3
    );

  if (
    structure15 ===
    direction
  ) {
    score += 10;
  }

  if (
    structure15 !== "NEUTRAL" &&
    structure15 !== direction
  ) {
    score -= 15;
  }

  score =
    clamp(
      Math.round(score),
      50,
      99
    );

  const now =
    Date.now();

  return {

    id:
      `${symbol}_${direction}_${Math.round(center * 100000000)}`,

    symbol,

    direction,

    score,

    price,

    level: center,

    levelType: level.type,

    strength:
      level.confluence
        ? "ÇOK GÜÇLÜ"
        : level.touches >= 3
          ? "GÜÇLÜ"
          : "NORMAL",

    distance:
      level.distance,

    touches:
      level.touches,

    confluence:
      level.confluence,

    structure15,

    entryLow,

    entryHigh,

    stop,

    tp1,

    tp2,

    tp3,

    createdAt: now,

    updatedAt: now,

    status: "WAITING"
  };
}

/* ------------------------------------------------------------
   UPDATE SIGNAL STATUS
------------------------------------------------------------ */

function updateSignalPrice(
  signal,
  price
) {

  signal.price =
    price;

  signal.updatedAt =
    Date.now();

  const inside =
    price >= signal.entryLow &&
    price <= signal.entryHigh;

  if (inside) {

    signal.status =
      "READY";

    return signal;
  }

  /*
    LONG:
    fiyat giriş bölgesinin üstüne kaçarsa
    fırsat kaçmıştır.

    SHORT:
    fiyat giriş bölgesinin altına kaçarsa
    fırsat kaçmıştır.
  */

  if (
    signal.direction === "LONG"
  ) {

    if (
      price > signal.entryHigh
    ) {

      signal.status =
        "MISSED";

    } else {

      signal.status =
        "WAITING";
    }

  } else {

    if (
      price < signal.entryLow
    ) {

      signal.status =
        "MISSED";

    } else {

      signal.status =
        "WAITING";
    }
  }

  return signal;
}

/* ------------------------------------------------------------
   REMOVE OLD / MISSED
------------------------------------------------------------ */

function cleanupSignals() {

  const now =
    Date.now();

  for (
    const [id, signal]
    of activeSignals
  ) {

    const expired =
      now -
      signal.createdAt >
      SIGNAL_MAX_AGE;

    if (
      expired ||
      signal.status === "MISSED"
    ) {

      activeSignals.delete(id);
    }
  }
}

/* ------------------------------------------------------------
   CONCURRENT MAP
------------------------------------------------------------ */

async function concurrentMap(
  items,
  concurrency,
  worker
) {

  const results = [];

  let index = 0;

  async function runWorker() {

    while (true) {

      const current =
        index++;

      if (
        current >=
        items.length
      ) {
        return;
      }

      try {

        const result =
          await worker(
            items[current]
          );

        if (result) {
          results.push(result);
        }

      } catch (error) {

        scanStats.errors++;

      }
    }
  }

  const workers =
    Array.from(
      {
        length:
          Math.min(
            concurrency,
            items.length
          )
      },
      () => runWorker()
    );

  await Promise.all(workers);

  return results;
}

/* ------------------------------------------------------------
   ANALYSE COIN
------------------------------------------------------------ */

async function analyseCoin(
  item
) {

  /*
    Önce sadece 4H + 2H.
  */

  const [
    candles4H,
    candles2H
  ] = await Promise.all([

    getCandles(
      item.symbol,
      "4H"
    ),

    getCandles(
      item.symbol,
      "2H"
    )

  ]);

  if (
    candles4H.length < 30 ||
    candles2H.length < 30
  ) {
    return null;
  }

  const price =
    item.last;

  const level =
    findNearestLevel(
      price,
      candles4H,
      candles2H
    );

  /*
    Seviyeye yakın değilse
    15M verisi çekmiyoruz.
    Böylece gereksiz API yükü yok.
  */

  if (!level) {
    return null;
  }

  const candles15M =
    await getCandles(
      item.symbol,
      "15m",
      80
    );

  const structure15 =
    detect15MStructure(
      candles15M
    );

  return createSignal(
    item.symbol,
    price,
    level,
    structure15
  );
}

/* ------------------------------------------------------------
   MAIN SCANNER
------------------------------------------------------------ */

async function scan() {

  if (scanning) {
    return;
  }

  scanning = true;

  try {

    await discoverUniverse();

    scanStats = {
      universe:
        universe.length,

      analysed: 0,

      signals: 0,

      errors: 0
    };

    log(
      `RADAR başladı | Universe=${universe.length} | DeepAnalysis=${universe.length}`
    );

    /*
      Evreni geniş tutuyoruz.
      Önceki sistemdeki sabit 8/10 mantığı yok.
    */

    const candidates =
      await concurrentMap(
        universe.slice(0, 300),
        8,
        async item => {

          const signal =
            await analyseCoin(
              item
            );

          scanStats.analysed++;

          return signal;
        }
      );

    /*
      EN İYİ SİNYALLER
    */

    candidates.sort(
      (a, b) => {

        if (
          b.score !==
          a.score
        ) {
          return (
            b.score -
            a.score
          );
        }

        return (
          a.distance -
          b.distance
        );
      }
    );

    const selected = [];

    const usedSymbols =
      new Set();

    for (
      const signal
      of candidates
    ) {

      /*
        Aynı coinden iki farklı sinyal
        göstermiyoruz.
      */

      if (
        usedSymbols.has(
          signal.symbol
        )
      ) {
        continue;
      }

      usedSymbols.add(
        signal.symbol
      );

      selected.push(
        signal
      );

      if (
        selected.length >=
        MAX_SIGNALS
      ) {
        break;
      }
    }

    /*
      Yeni state.
    */

    const nextSignals =
      new Map();

    for (
      const signal
      of selected
    ) {

      /*
        Aynı coin + yön daha önce varsa
        sinyal yaşını koru.
      */

      const previous =
        [...activeSignals.values()]
          .find(existing =>
            existing.symbol ===
              signal.symbol &&
            existing.direction ===
              signal.direction
          );

      if (previous) {

        signal.createdAt =
          previous.createdAt;

        signal.status =
          previous.status;
      }

      updateSignalPrice(
        signal,
        signal.price
      );

      /*
        Kaçmış sinyali sisteme koyma.
      */

      if (
        signal.status ===
        "MISSED"
      ) {
        continue;
      }

      if (
        Date.now() -
          signal.createdAt >
        SIGNAL_MAX_AGE
      ) {
        continue;
      }

      nextSignals.set(
        signal.id,
        signal
      );
    }

    activeSignals =
      nextSignals;

    cleanupSignals();

    scanStats.signals =
      activeSignals.size;

    lastScan =
      Date.now();

    log(
      `RADAR tamamlandı | Universe=${scanStats.universe} | Analiz=${scanStats.analysed} | SIGNAL=${activeSignals.size}`
    );

  } catch (error) {

    lastError =
      error.message;

    log(
      `RADAR HATASI | ${error.message}`
    );

  } finally {

    scanning = false;
  }
}

/* ------------------------------------------------------------
   LIVE SIGNAL UPDATE
------------------------------------------------------------ */

async function updateLiveSignals() {

  if (
    liveUpdating ||
    activeSignals.size === 0
  ) {
    return;
  }

  liveUpdating = true;

  try {

    const tickers =
      await bitgetRequest(
        "/api/v2/mix/market/tickers",
        {
          productType:
            PRODUCT_TYPE
        }
      );

    tickerMap =
      new Map(
        (tickers || [])
          .map(ticker => [
            ticker.symbol,
            ticker
          ])
      );

    for (
      const [
        id,
        signal
      ]
      of activeSignals
    ) {

      const ticker =
        tickerMap.get(
          signal.symbol
        );

      const price =
        num(
          ticker?.lastPr
        );

      if (
        price === null
      ) {
        continue;
      }

      updateSignalPrice(
        signal,
        price
      );
    }

    cleanupSignals();

  } catch (error) {

    lastError =
      error.message;

  } finally {

    liveUpdating = false;
  }
}

/* ------------------------------------------------------------
   SERIALIZE SIGNAL
------------------------------------------------------------ */

function serializeSignal(
  signal
) {

  const now =
    Date.now();

  return {

    ...signal,

    ageSec:
      Math.max(
        0,
        Math.floor(
          (
            now -
            signal.createdAt
          ) / 1000
        )
      ),

    remainingSec:
      Math.max(
        0,
        Math.floor(
          (
            SIGNAL_MAX_AGE -
            (
              now -
              signal.createdAt
            )
          ) / 1000
        )
      )
  };
}

/* ------------------------------------------------------------
   NUMBER FORMAT
------------------------------------------------------------ */

function formatNumber(
  value,
  maxDecimals = 8
) {

  if (
    !Number.isFinite(value)
  ) {
    return "-";
  }

  return value.toLocaleString(
    "en-US",
    {
      maximumFractionDigits:
        maxDecimals
    }
  );
}

/* ============================================================
   FRONTEND
============================================================ */

const INDEX_HTML = String.raw`<!DOCTYPE html>
<html lang="tr">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
>

<title>Sonny AI Trader V10</title>

<script src="https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js"></script>

<style>

* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #070a0f;
  color: #e8edf5;
  font-family:
    Inter,
    Arial,
    sans-serif;
}

button {
  font-family: inherit;
}

.app {
  width: 100%;
  height: 100vh;

  display: grid;

  grid-template-columns:
    360px
    minmax(0, 1fr);

  grid-template-rows:
    64px
    minmax(0, 1fr);
}

/* ------------------------------------------------------------
   TOP BAR
------------------------------------------------------------ */

.topbar {

  grid-column:
    1 / 3;

  height: 64px;

  display: flex;
  align-items: center;

  padding:
    0 20px;

  gap: 20px;

  background: #0d1118;

  border-bottom:
    1px solid #202733;
}

.logo {

  font-size: 19px;

  font-weight: 900;
}

.logo span {
  color: #4da3ff;
}

.subtitle {

  color: #7f8b9d;

  font-size: 11px;

  margin-top: 3px;
}

.market-stats {

  margin-left: auto;

  display: flex;

  gap: 24px;

  font-size: 11px;

  color: #7f8b9d;
}

.market-stat b {

  color: #edf2f7;

  margin-left: 5px;
}

/* ------------------------------------------------------------
   LEFT PANEL
------------------------------------------------------------ */

.sidebar {

  min-height: 0;

  overflow-y: auto;

  background: #0b0f15;

  border-right:
    1px solid #202733;
}

.sidebar-head {

  height: 56px;

  padding:
    0 15px;

  display: flex;

  align-items: center;

  justify-content: space-between;

  border-bottom:
    1px solid #202733;
}

.sidebar-title {

  font-size: 12px;

  font-weight: 900;

  letter-spacing: .03em;
}

.badge {

  background: #172131;

  border:
    1px solid #2a3a4e;

  border-radius: 7px;

  padding:
    4px 8px;

  font-size: 11px;
}

.signal-list {

  padding: 10px;
}

.signal-card {

  background:
    linear-gradient(
      135deg,
      #10151d,
      #0e131b
    );

  border:
    1px solid #202a36;

  border-radius: 12px;

  padding: 12px;

  margin-bottom: 8px;

  cursor: pointer;

  transition:
    .15s ease;
}

.signal-card:hover {

  border-color:
    #3b82f6;

  transform:
    translateY(-1px);
}

.signal-card.active {

  border-color:
    #3b82f6;

  box-shadow:
    0 0 0 1px
    rgba(59,130,246,.15);
}

.card-row {

  display: flex;

  align-items: center;

  justify-content: space-between;

  gap: 8px;
}

.symbol {

  font-size: 14px;

  font-weight: 900;
}

.direction {

  font-size: 10px;

  font-weight: 900;

  border-radius: 6px;

  padding:
    4px 7px;
}

.direction.long {

  color: #38d996;

  background:
    rgba(56,217,150,.1);
}

.direction.short {

  color: #ff6575;

  background:
    rgba(255,101,117,.1);
}

.card-price {

  font-size: 15px;

  font-weight: 800;

  margin-top: 9px;
}

.card-score {

  color: #9aa6b5;

  font-size: 10px;
}

.card-meta {

  color: #788597;

  font-size: 10px;

  margin-top: 5px;
}

.status-ready {

  color: #38d996;

  font-weight: 800;
}

.status-waiting {

  color: #f5bd43;

  font-weight: 800;
}

.age {

  color: #b7c2d0;
}

/* ------------------------------------------------------------
   MAIN
------------------------------------------------------------ */

.main {

  min-width: 0;

  min-height: 0;

  position: relative;

  background: #070a0f;
}

.chart-header {

  height: 72px;

  display: flex;

  align-items: center;

  gap: 14px;

  padding:
    0 18px;

  border-bottom:
    1px solid #202733;

  background: #0b0f15;

  position: relative;

  z-index: 10;
}

.chart-title {

  font-size: 19px;

  font-weight: 900;
}

.pill {

  border:
    1px solid #2a3442;

  background: #111721;

  color: #aeb9c7;

  border-radius: 7px;

  padding:
    5px 8px;

  font-size: 10px;

  font-weight: 800;
}

.pill.long {

  color: #38d996;
}

.pill.short {

  color: #ff6575;
}

.header-actions {

  margin-left: auto;

  display: flex;

  gap: 7px;
}

.header-actions button {

  border:
    1px solid #2a3442;

  background: #111721;

  border-radius: 7px;

  padding:
    7px 10px;

  color: #dce3ec;

  cursor: pointer;

  font-size: 11px;
}

.header-actions button:hover {

  background: #1a2230;
}

/* ------------------------------------------------------------
   CHART
------------------------------------------------------------ */

.chart-area {

  position: absolute;

  top: 72px;

  left: 0;

  right: 0;

  bottom: 0;
}

/* ------------------------------------------------------------
   DETAIL BOX
------------------------------------------------------------ */

.detail-box {

  position: absolute;

  right: 18px;

  top: 88px;

  width: 285px;

  z-index: 20;

  background:
    rgba(12,17,24,.95);

  border:
    1px solid #283241;

  border-radius: 12px;

  padding: 14px;

  backdrop-filter:
    blur(10px);
}

.detail-symbol {

  font-size: 18px;

  font-weight: 900;
}

.detail-direction {

  font-size: 24px;

  font-weight: 900;

  margin-top: 4px;
}

.detail-direction.long {

  color: #38d996;
}

.detail-direction.short {

  color: #ff6575;
}

.detail-section {

  color: #697689;

  font-size: 9px;

  letter-spacing: .1em;

  margin-top: 13px;

  margin-bottom: 5px;
}

.detail-row {

  display: flex;

  justify-content: space-between;

  gap: 10px;

  padding:
    7px 0;

  border-bottom:
    1px solid #1e2631;

  font-size: 10px;
}

.detail-row span {

  color: #778496;
}

.detail-row b {

  color: #e6ecf3;

  text-align: right;
}

.stop {

  color: #ff6575 !important;
}

.tp {

  color: #6da8ff !important;
}

.entry {

  color: #38d996 !important;
}

.empty {

  height: 240px;

  display: flex;

  align-items: center;

  justify-content: center;

  text-align: center;

  color: #667386;

  font-size: 12px;

  line-height: 1.7;
}

.footer {

  position: absolute;

  left: 16px;

  bottom: 10px;

  z-index: 30;

  color: #566273;

  font-size: 9px;
}

.live-dot {

  display: inline-block;

  width: 6px;

  height: 6px;

  border-radius: 50%;

  background: #38d996;

  margin-right: 5px;
}

@media(max-width: 900px) {

  .app {

    grid-template-columns:
      300px
      minmax(0,1fr);
  }

  .market-stats {

    display: none;
  }

  .detail-box {

    width: 250px;
  }
}

</style>

</head>

<body>

<div class="app">

  <header class="topbar">

    <div>

      <div class="logo">
        🚀 Sonny <span>AI Trader</span> V10
      </div>

      <div class="subtitle">
        4H Destek/Direnç · 2H Onay · 15M Yapı · Canlı Sinyal
      </div>

    </div>

    <div class="market-stats">

      <div class="market-stat">
        EVREN
        <b id="universe">-</b>
      </div>

      <div class="market-stat">
        ANALİZ
        <b id="analysed">-</b>
      </div>

      <div class="market-stat">
        SİNYAL
        <b id="signalCount">-</b>
      </div>

      <div class="market-stat">
        SON TARAMA
        <b id="lastScan">-</b>
      </div>

    </div>

  </header>


  <aside class="sidebar">

    <div class="sidebar-head">

      <div class="sidebar-title">
        🚨 AKTİF SİNYALLER
      </div>

      <div
        class="badge"
        id="signalBadge"
      >
        0
      </div>

    </div>

    <div
      class="signal-list"
      id="signalList"
    ></div>

  </aside>


  <main class="main">

    <div class="chart-header">

      <div
        class="chart-title"
        id="chartTitle"
      >
        Sinyal seç
      </div>

      <div
        class="pill"
        id="directionPill"
      >
        -
      </div>

      <div
        class="pill"
        id="statusPill"
      >
        -
      </div>

      <div class="header-actions">

        <button id="tradingViewButton">
          Binance TradingView
        </button>

        <button id="refreshButton">
          Yenile
        </button>

      </div>

    </div>


    <div
      class="chart-area"
      id="chartArea"
    ></div>


    <div
      class="detail-box"
      id="detailBox"
      style="display:none"
    ></div>


    <div class="footer">

      <span class="live-dot"></span>

      Bitget canlı veri · Tarama 60 sn · Fiyat 10 sn ·
      Kaçan sinyal otomatik kaldırılır

    </div>

  </main>

</div>


<script>

let appState = {

  signals: [],

  selectedId: null,

  chart: null,

  candleSeries: null

};


/* ------------------------------------------------------------
   HELPERS
------------------------------------------------------------ */

function escapeHtml(value) {

  return String(value)
    .replace(/[&<>'"]/g, function(char) {

      const map = {

        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "'": "&#39;",
        '"': "&quot;"

      };

      return map[char];

    });
}


function number(value) {

  return Number(value).toLocaleString(
    "en-US",
    {
      maximumFractionDigits: 8
    }
  );
}


function age(seconds) {

  if (seconds < 60) {

    return seconds + " sn";

  }

  const minutes =
    Math.floor(seconds / 60);

  if (minutes < 60) {

    return minutes + " dk";

  }

  const hours =
    Math.floor(minutes / 60);

  const remaining =
    minutes % 60;

  return (
    hours +
    " sa " +
    remaining +
    " dk"
  );
}


function selectedSignal() {

  return appState.signals.find(
    signal =>
      signal.id ===
      appState.selectedId
  ) || appState.signals[0] || null;
}


/* ------------------------------------------------------------
   RENDER LIST
------------------------------------------------------------ */

function renderSignals() {

  const list =
    document.getElementById(
      "signalList"
    );

  const count =
    appState.signals.length;

  document.getElementById(
    "signalBadge"
  ).textContent = count;

  document.getElementById(
    "signalCount"
  ).textContent = count;


  if (!count) {

    list.innerHTML =

      '<div class="empty">' +

      'Şu an aktif sinyal yok.<br>' +

      'Sistem yeni 4H / 2H seviyelerini tarıyor.' +

      '</div>';

    document.getElementById(
      "detailBox"
    ).style.display = "none";

    return;
  }


  if (
    !appState.selectedId ||
    !appState.signals.some(
      signal =>
        signal.id ===
        appState.selectedId
    )
  ) {

    appState.selectedId =
      appState.signals[0].id;
  }


  list.innerHTML =
    appState.signals
      .map(function(signal) {

        const directionClass =
          signal.direction === "LONG"
            ? "long"
            : "short";

        const status =
          signal.status === "READY"

            ? '<span class="status-ready">GİRİŞ HAZIR</span>'

            : '<span class="status-waiting">GİRİŞ BEKLİYOR</span>';


        return (

          '<div ' +

          'class="signal-card ' +

          (
            signal.id ===
            appState.selectedId
              ? "active"
              : ""
          ) +

          '" ' +

          'data-id="' +

          escapeHtml(
            signal.id
          ) +

          '">' +

          '<div class="card-row">' +

          '<div class="symbol">' +

          escapeHtml(
            signal.symbol
          ) +

          '</div>' +

          '<div class="direction ' +

          directionClass +

          '">' +

          signal.direction +

          '</div>' +

          '</div>' +

          '<div class="card-row">' +

          '<div class="card-price">' +

          number(
            signal.price
          ) +

          '</div>' +

          '<div class="card-score">' +

          signal.score +

          '/100' +

          '</div>' +

          '</div>' +

          '<div class="card-meta">' +

          'Seviye ' +

          number(
            signal.level
          ) +

          ' · ' +

          number(
            signal.distance
          ) +

          '% uzaklık' +

          '</div>' +

          '<div class="card-meta">' +

          status +

          ' · ' +

          '<span class="age">' +

          age(
            signal.ageSec
          ) +

          '</span>' +

          '</div>' +

          '</div>'

        );

      })
      .join("");


  Array.from(
    document.querySelectorAll(
      ".signal-card"
    )
  ).forEach(function(card) {

    card.onclick =
      function() {

        appState.selectedId =
          card.getAttribute(
            "data-id"
          );

        renderSignals();

        loadChart(
          selectedSignal()
        );
      };

  });


  showDetail(
    selectedSignal()
  );
}


/* ------------------------------------------------------------
   DETAIL
------------------------------------------------------------ */

function showDetail(signal) {

  const box =
    document.getElementById(
      "detailBox"
    );

  if (!signal) {

    box.style.display =
      "none";

    return;
  }

  box.style.display =
    "block";


  const directionClass =
    signal.direction === "LONG"
      ? "long"
      : "short";


  document.getElementById(
    "chartTitle"
  ).textContent =
    signal.symbol;


  const directionPill =
    document.getElementById(
      "directionPill"
    );

  directionPill.textContent =
    signal.direction;

  directionPill.className =
    "pill " +
    directionClass;


  document.getElementById(
    "statusPill"
  ).textContent =
    signal.status === "READY"
      ? "GİRİŞ HAZIR"
      : "GİRİŞ BEKLİYOR";


  box.innerHTML =

    '<div class="detail-symbol">' +

    escapeHtml(
      signal.symbol
    ) +

    '</div>' +

    '<div class="detail-direction ' +

    directionClass +

    '">' +

    signal.direction +

    '</div>' +


    '<div class="detail-section">' +
    'CANLI VERİ' +
    '</div>' +

    '<div class="detail-row">' +
    '<span>Fiyat</span>' +
    '<b>' +
    number(signal.price) +
    '</b>' +
    '</div>' +

    '<div class="detail-row">' +
    '<span>4H / 2H seviye</span>' +
    '<b>' +
    number(signal.level) +
    '</b>' +
    '</div>' +

    '<div class="detail-row">' +
    '<span>Seviye</span>' +
    '<b>' +
    signal.levelType +
    '</b>' +
    '</div>' +

    '<div class="detail-row">' +
    '<span>Mesafe</span>' +
    '<b>' +
    number(signal.distance) +
    '%' +
    '</b>' +
    '</div>' +


    '<div class="detail-section">' +
    'İŞLEM PLANI' +
    '</div>' +

    '<div class="detail-row">' +
    '<span>Giriş</span>' +
    '<b class="entry">' +
    number(signal.entryLow) +
    ' - ' +
    number(signal.entryHigh) +
    '</b>' +
    '</div>' +

    '<div class="detail-row">' +
    '<span>STOP</span>' +
    '<b class="stop">' +
    number(signal.stop) +
    '</b>' +
    '</div>' +

    '<div class="detail-row">' +
    '<span>TP1</span>' +
    '<b class="tp">' +
    number(signal.tp1) +
    '</b>' +
    '</div>' +

    '<div class="detail-row">' +
    '<span>TP2</span>' +
    '<b class="tp">' +
    number(signal.tp2) +
    '</b>' +
    '</div>' +

    '<div class="detail-row">' +
    '<span>TP3</span>' +
    '<b class="tp">' +
    number(signal.tp3) +
    '</b>' +
    '</div>' +


    '<div class="detail-section">' +
    'ONAY' +
    '</div>' +

    '<div class="detail-row">' +
    '<span>15M yapı</span>' +
    '<b>' +
    signal.structure15 +
    '</b>' +
    '</div>' +

    '<div class="detail-row">' +
    '<span>Seviye gücü</span>' +
    '<b>' +
    signal.strength +
    '</b>' +
    '</div>' +

    '<div class="detail-row">' +
    '<span>Temas</span>' +
    '<b>' +
    signal.touches +
    '</b>' +
    '</div>' +

    '<div class="detail-row">' +
    '<span>Sinyal yaşı</span>' +
    '<b>' +
    age(signal.ageSec) +
    '</b>' +
    '</div>' +


    '<div class="detail-section">' +
    'SİNYAL KURALI' +
    '</div>' +

    '<div class="card-meta">' +
    'Fiyat giriş bölgesine gelirse ' +
    'GİRİŞ HAZIR olur. Bölge geçilirse ' +
    'sinyal otomatik kaldırılır.' +
    '</div>';

}


/* ------------------------------------------------------------
   LOAD CHART
------------------------------------------------------------ */

async function loadChart(
  signal
) {

  if (!signal) {
    return;
  }


  const container =
    document.getElementById(
      "chartArea"
    );


  if (
    !window.LightweightCharts
  ) {

    container.innerHTML =
      '<div class="empty">' +
      'Grafik kütüphanesi yüklenemedi.' +
      '</div>';

    return;
  }


  if (appState.chart) {

    appState.chart.remove();

    appState.chart =
      null;

    appState.candleSeries =
      null;
  }


  container.innerHTML =
    "";


  appState.chart =
    LightweightCharts.createChart(
      container,
      {

        layout: {

          background: {
            color: "#070a0f"
          },

          textColor:
            "#9aa6b5"

        },

        grid: {

          vertLines: {
            color:
              "#151b24"
          },

          horzLines: {
            color:
              "#151b24"
          }

        },

        rightPriceScale: {

          borderColor:
            "#252d39"

        },

        timeScale: {

          borderColor:
            "#252d39",

          timeVisible:
            true,

          secondsVisible:
            false

        },

        crosshair: {

          mode:
            1

        }

      }
    );


  appState.candleSeries =
    appState.chart.addCandlestickSeries(
      {

        upColor:
          "#26a269",

        downColor:
          "#ef5b67",

        borderUpColor:
          "#26a269",

        borderDownColor:
          "#ef5b67",

        wickUpColor:
          "#26a269",

        wickDownColor:
          "#ef5b67"

      }
    );


  try {

    const response =
      await fetch(
        "/api/candles?symbol=" +
        encodeURIComponent(
          signal.symbol
        ) +
        "&tf=2H"
      );


    const data =
      await response.json();


    if (!data.ok) {

      throw new Error(
        data.error
      );
    }


    appState.candleSeries
      .setData(
        data.candles
      );


    /*
      4H / 2H SEVİYE
    */

    createPriceLine(
      signal.level,
      "#f5c542",
      "4H / 2H"
    );


    /*
      GİRİŞ
    */

    createPriceLine(
      signal.entryLow,
      "#38d996",
      "GİRİŞ ALT"
    );

    createPriceLine(
      signal.entryHigh,
      "#38d996",
      "GİRİŞ ÜST"
    );


    /*
      STOP
    */

    createPriceLine(
      signal.stop,
      "#ff5f6d",
      "STOP"
    );


    /*
      TP
    */

    createPriceLine(
      signal.tp1,
      "#70a7ff",
      "TP1"
    );

    createPriceLine(
      signal.tp2,
      "#70a7ff",
      "TP2"
    );

    createPriceLine(
      signal.tp3,
      "#70a7ff",
      "TP3"
    );


    appState.chart
      .timeScale()
      .fitContent();


  } catch (error) {

    container.innerHTML =

      '<div class="empty">' +

      'Grafik verisi alınamadı.<br>' +

      escapeHtml(
        error.message
      ) +

      '</div>';
  }

}


/* ------------------------------------------------------------
   PRICE LINE
------------------------------------------------------------ */

function createPriceLine(
  price,
  color,
  title
) {

  if (
    !appState.candleSeries
  ) {
    return;
  }


  appState.candleSeries
    .createPriceLine({

      price:
        Number(price),

      color:
        color,

      lineWidth:
        1,

      lineStyle:
        2,

      axisLabelVisible:
        true,

      title:
        title

    });
}


/* ------------------------------------------------------------
   API POLLING
------------------------------------------------------------ */

async function refreshState() {

  try {

    const response =
      await fetch(
        "/api/state?ts=" +
        Date.now()
      );


    const data =
      await response.json();


    if (!data.ok) {
      return;
    }


    const previousSelected =
      appState.selectedId;


    appState.signals =
      data.signals;


    document.getElementById(
      "universe"
    ).textContent =
      data.stats.universe;


    document.getElementById(
      "analysed"
    ).textContent =
      data.stats.analysed;


    document.getElementById(
      "lastScan"
    ).textContent =
      data.lastScan
        ? new Date(
            data.lastScan
          ).toLocaleTimeString(
            "tr-TR"
          )
        : "-";


    renderSignals();


    /*
      Seçili coin hâlâ varsa
      detay bilgisi canlı güncellensin.
    */

    if (
      previousSelected &&
      appState.signals.some(
        signal =>
          signal.id ===
          previousSelected
      )
    ) {

      showDetail(
        selectedSignal()
      );
    }

  } catch (error) {

    /*
      UI'yi çökertme.
    */
  }
}


/* ------------------------------------------------------------
   BUTTONS
------------------------------------------------------------ */

document.getElementById(
  "refreshButton"
).onclick =
  function() {

    refreshState();

  };


document.getElementById(
  "tradingViewButton"
).onclick =
  function() {

    const signal =
      selectedSignal();

    if (!signal) {
      return;
    }


    /*
      TradingView:
      BINANCE üzerinden açılıyor.
    */

    const url =
      "https://www.tradingview.com/chart/?symbol=BINANCE%3A" +
      encodeURIComponent(
        signal.symbol
      );


    window.open(
      url,
      "_blank"
    );

  };


/* ------------------------------------------------------------
   WINDOW RESIZE
------------------------------------------------------------ */

window.addEventListener(
  "resize",
  function() {

    if (
      appState.chart
    ) {

      appState.chart.resize(
        document
          .getElementById(
            "chartArea"
          )
          .clientWidth,

        document
          .getElementById(
            "chartArea"
          )
          .clientHeight
      );
    }

  }
);


/* ------------------------------------------------------------
   START FRONTEND
------------------------------------------------------------ */

refreshState();

setInterval(
  refreshState,
  5000
);


/*
  Sinyal yaşı saniye saniye
  güncellensin.
*/

setInterval(
  function() {

    const signal =
      selectedSignal();

    if (signal) {

      showDetail(
        signal
      );
    }

  },
  1000
);

</script>

</body>

</html>`;


/* ============================================================
   HTTP SERVER
============================================================ */

function sendResponse(
  response,
  status,
  body,
  contentType =
    "application/json; charset=utf-8"
) {

  response.writeHead(
    status,
    {

      "Content-Type":
        contentType,

      "Cache-Control":
        "no-store",

      "Access-Control-Allow-Origin":
        "*"

    }
  );

  response.end(body);
}


/* ------------------------------------------------------------
   ROUTER
------------------------------------------------------------ */

async function router(
  request,
  response
) {

  const url =
    new URL(
      request.url,
      `http://${request.headers.host || "localhost"}`
    );


  try {

    /*
      ANA SAYFA
    */

    if (
      url.pathname === "/" ||
      url.pathname === "/index.html"
    ) {

      return sendResponse(
        response,
        200,
        INDEX_HTML,
        "text/html; charset=utf-8"
      );
    }


    /*
      HEALTH
    */

    if (
      url.pathname ===
      "/health"
    ) {

      return sendResponse(
        response,
        200,
        JSON.stringify({
          ok: true,

          service:
            "sonny-ai-trader-v10",

          uptime:
            process.uptime(),

          lastScan

        })
      );
    }


    /*
      STATE
    */

    if (
      url.pathname ===
      "/api/state"
    ) {

      const signals =
        [...activeSignals.values()]
          .map(
            serializeSignal
          )
          .sort(
            (a, b) =>
              b.score -
              a.score
          );


      return sendResponse(
        response,
        200,
        JSON.stringify({

          ok: true,

          signals,

          stats:
            scanStats,

          lastScan,

          lastError

        })
      );
    }


    /*
      CANDLES
    */

    if (
      url.pathname ===
      "/api/candles"
    ) {

      const symbol =
        url.searchParams.get(
          "symbol"
        );

      const timeframe =
        url.searchParams.get(
          "tf"
        ) || "2H";


      if (!symbol) {

        return sendResponse(
          response,
          400,
          JSON.stringify({
            ok: false,
            error:
              "symbol gerekli"
          })
        );
      }


      const candles =
        await getCandles(
          symbol,
          timeframe,
          180
        );


      return sendResponse(
        response,
        200,
        JSON.stringify({

          ok: true,

          candles

        })
      );
    }


    /*
      MANUEL SCAN
    */

    if (
      url.pathname ===
      "/api/scan"
    ) {

      scan();

      return sendResponse(
        response,
        202,
        JSON.stringify({

          ok: true,

          message:
            "scan started"

        })
      );
    }


    /*
      404
    */

    return sendResponse(
      response,
      404,
      JSON.stringify({

        ok: false,

        error:
          "Not found"

      })
    );

  } catch (error) {

    return sendResponse(
      response,
      500,
      JSON.stringify({

        ok: false,

        error:
          error.message

      })
    );
  }
}


/* ============================================================
   START SERVER
============================================================ */

const server =
  http.createServer(
    router
  );


server.listen(
  PORT,
  HOST,
  function() {

    console.log("");
    console.log(
      "=============================================="
    );

    console.log(
      "Sonny AI Trader V10 started"
    );

    console.log(
      "Data source: BITGET"
    );

    console.log(
      "Strategy: 4H SUPPORT/RESISTANCE + 2H CONFLUENCE + 15M STRUCTURE"
    );

    console.log(
      "Scan: every 60 seconds"
    );

    console.log(
      "Live price: every 10 seconds"
    );

    console.log(
      `Server listening on ${HOST}:${PORT}`
    );

    console.log(
      "=============================================="
    );

    console.log("");

    scan();

  }
);


/* ------------------------------------------------------------
   AUTOMATIC SCAN
------------------------------------------------------------ */

setInterval(
  function() {

    scan();

  },
  SCAN_INTERVAL
);


/* ------------------------------------------------------------
   LIVE PRICE UPDATE
------------------------------------------------------------ */

setInterval(
  function() {

    updateLiveSignals();

  },
  LIVE_INTERVAL
);


/* ------------------------------------------------------------
   ERROR HANDLING
------------------------------------------------------------ */

process.on(
  "unhandledRejection",
  function(error) {

    log(
      `UNHANDLED REJECTION | ${error?.message || error}`
    );

  }
);


process.on(
  "uncaughtException",
  function(error) {

    log(
      `UNCAUGHT EXCEPTION | ${error?.message || error}`
    );

  }
);
