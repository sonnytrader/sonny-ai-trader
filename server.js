const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 10000);
const HOST = '0.0.0.0';

const BASE = 'https://api.bitget.com';
const PRODUCT = 'USDT-FUTURES';

const REFRESH_MS = 60_000;

// Geniş hızlı tarama
const FAST_TOP = 500;

// Derin analiz
const MAX_DEEP = 250;

// Bitget rate-limit için kontrollü paralellik
const CONCURRENCY = 5;

// Geçmiş performans
const HISTORY_FILE = path.join(__dirname, 'sonny-history.json');

let universe = [];
let marketRows = [];

let activeSignals = new Map();
let history = [];

let lastScan = 0;
let scanning = false;
let scanError = '';

let marketState = {
  label: 'VERİ BEKLENİYOR',
  score: 0,
  text: 'Piyasa hesaplanıyor...'
};


// ============================================================
// HISTORY
// ============================================================

try {
  if (fs.existsSync(HISTORY_FILE)) {
    history = JSON.parse(
      fs.readFileSync(HISTORY_FILE, 'utf8')
    ) || [];
  }
} catch (e) {
  history = [];
}


function saveHistory() {
  try {
    fs.writeFileSync(
      HISTORY_FILE,
      JSON.stringify(history.slice(-500), null, 2)
    );
  } catch (e) {}
}


// ============================================================
// HELPERS
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}


function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}


function fmt(v) {
  const n = num(v);

  if (!n) return '-';

  if (Math.abs(n) >= 1000) {
    return n.toFixed(2);
  }

  if (Math.abs(n) >= 100) {
    return n.toFixed(2);
  }

  if (Math.abs(n) >= 1) {
    return n.toFixed(4);
  }

  if (Math.abs(n) >= 0.01) {
    return n.toFixed(5);
  }

  return n
    .toFixed(8)
    .replace(/0+$/, '')
    .replace(/\.$/, '');
}


function esc(value) {
  return String(value ?? '')
    .replace(/[&<>"']/g, c => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[c]));
}


// ============================================================
// BITGET API
// ============================================================

async function bitget(endpoint, params = {}, tries = 4) {

  const query = new URLSearchParams(params).toString();

  const url = `${BASE}${endpoint}?${query}`;

  let lastError = null;

  for (let attempt = 0; attempt < tries; attempt++) {

    try {

      const response = await fetch(url, {
        headers: {
          accept: 'application/json'
        }
      });

      const text = await response.text();

      if (response.status === 429) {

        await sleep(700 * (attempt + 1));

        continue;
      }

      if (!response.ok) {

        throw new Error(
          `Bitget HTTP ${response.status} - ${text.slice(0, 180)}`
        );
      }

      const json = JSON.parse(text);

      if (
        json.code &&
        json.code !== '00000'
      ) {

        throw new Error(
          `Bitget ${json.code}: ${json.msg || 'API error'}`
        );
      }

      return json.data;

    } catch (error) {

      lastError = error;

      if (attempt < tries - 1) {
        await sleep(300 * (attempt + 1));
      }
    }
  }

  throw lastError || new Error('Bitget request failed');
}


// ============================================================
// MARKET DISCOVERY
// ============================================================

async function discover() {

  const data = await bitget(
    '/api/v2/mix/market/contracts',
    {
      productType: PRODUCT
    }
  );

  const rows = Array.isArray(data)
    ? data
    : [];

  universe = rows
    .filter(x => {

      if (!x.symbol) return false;

      const quote =
        String(x.quoteCoin || '').toUpperCase();

      const status =
        String(x.symbolStatus || 'normal')
          .toLowerCase();

      return (
        quote === 'USDT' &&
        status === 'normal'
      );
    })
    .map(x => ({
      symbol: x.symbol,
      base:
        x.baseCoin ||
        x.symbol.replace(/USDT$/, ''),
      minSize: num(x.minTradeUSDT),
      pricePlace: num(x.pricePlace)
    }))
    .sort((a, b) =>
      a.symbol.localeCompare(b.symbol)
    );

  return universe;
}


// ============================================================
// TICKERS
// ============================================================

async function getTickers() {

  const data = await bitget(
    '/api/v2/mix/market/tickers',
    {
      productType: PRODUCT
    }
  );

  return (
    Array.isArray(data)
      ? data
      : []
  ).map(x => ({
    symbol: x.symbol,

    last: num(x.lastPr),

    high: num(x.high24h),

    low: num(x.low24h),

    change: num(x.change24h),

    quoteVol: num(x.quoteVolume),

    baseVol: num(x.baseVolume)
  }));
}


// ============================================================
// OHLCV
// ============================================================

async function candles(
  symbol,
  granularity,
  limit = 120
) {

  const data = await bitget(
    '/api/v2/mix/market/candles',
    {
      productType: PRODUCT,
      symbol,
      granularity,
      limit: String(limit)
    }
  );

  return (
    Array.isArray(data)
      ? data
      : []
  )
    .map(row => ({
      t: num(row[0]),
      o: num(row[1]),
      h: num(row[2]),
      l: num(row[3]),
      c: num(row[4]),
      v: num(row[5])
    }))
    .sort((a, b) => a.t - b.t);
}


// ============================================================
// RSI
// ============================================================

function rsi(closes, period = 14) {

  if (
    !closes ||
    closes.length < period + 2
  ) {
    return null;
  }

  let gain = 0;
  let loss = 0;

  for (
    let i = 1;
    i <= period;
    i++
  ) {

    const diff =
      closes[i] - closes[i - 1];

    if (diff >= 0) {
      gain += diff;
    } else {
      loss -= diff;
    }
  }

  let avgGain =
    gain / period;

  let avgLoss =
    loss / period;

  for (
    let i = period + 1;
    i < closes.length;
    i++
  ) {

    const diff =
      closes[i] - closes[i - 1];

    const currentGain =
      Math.max(diff, 0);

    const currentLoss =
      Math.max(-diff, 0);

    avgGain =
      (
        avgGain * (period - 1) +
        currentGain
      ) / period;

    avgLoss =
      (
        avgLoss * (period - 1) +
        currentLoss
      ) / period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs =
    avgGain / avgLoss;

  return 100 - (100 / (1 + rs));
}


// ============================================================
// ATR
// ============================================================

function atr(rows, period = 14) {

  if (
    !rows ||
    rows.length < period + 2
  ) {
    return null;
  }

  const tr = [];

  for (
    let i = 1;
    i < rows.length;
    i++
  ) {

    tr.push(
      Math.max(
        rows[i].h - rows[i].l,

        Math.abs(
          rows[i].h -
          rows[i - 1].c
        ),

        Math.abs(
          rows[i].l -
          rows[i - 1].c
        )
      )
    );
  }

  let value =
    tr
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      ) / period;

  for (
    let i = period;
    i < tr.length;
    i++
  ) {

    value =
      (
        value * (period - 1) +
        tr[i]
      ) / period;
  }

  return value;
}


// ============================================================
// VOLUME
// ============================================================

function averageVolume(
  rows,
  period = 20
) {

  const values =
    rows
      .slice(-period)
      .map(x => x.v);

  if (!values.length) {
    return 0;
  }

  return (
    values.reduce(
      (a, b) => a + b,
      0
    ) / values.length
  );
}


// ============================================================
// BOLLINGER WIDTH
// ============================================================

function bbWidth(
  rows,
  period = 20
) {

  const closes =
    rows
      .slice(-period)
      .map(x => x.c);

  if (closes.length < period) {
    return null;
  }

  const mean =
    closes.reduce(
      (a, b) => a + b,
      0
    ) / period;

  const variance =
    closes.reduce(
      (a, b) =>
        a + Math.pow(b - mean, 2),
      0
    ) / period;

  const deviation =
    Math.sqrt(variance);

  if (!mean) {
    return null;
  }

  return (
    4 * deviation
  ) / mean;
}


// ============================================================
// BREAKOUT
// ============================================================

function lastClosedBreakout(
  rows,
  side
) {

  if (!rows || rows.length < 45) {
    return null;
  }

  // Son mumu breakout hesabından çıkartıyoruz.
  const index =
    rows.length - 2;

  const previous =
    rows.slice(
      Math.max(0, index - 41),
      index
    );

  if (previous.length < 20) {
    return null;
  }

  const level =
    side === 'LONG'
      ? Math.max(
          ...previous.map(x => x.h)
        )
      : Math.min(
          ...previous.map(x => x.l)
        );

  const candle =
    rows[index];

  const broke =
    side === 'LONG'
      ? candle.c > level
      : candle.c < level;

  return {
    level,
    candle,
    broke
  };
}


// ============================================================
// MARKET DIRECTION
// ============================================================

function calculateMarketDirection(
  rows
) {

  if (!rows.length) {

    return {
      label: 'VERİ BEKLENİYOR',
      score: 0,
      text: 'Piyasa hesaplanıyor...'
    };
  }

  let score = 0;

  const limited =
    rows.slice(0, 60);

  for (const coin of limited) {

    if (coin.change > 0) {
      score++;
    }

    if (coin.change < 0) {
      score--;
    }
  }

  const btc =
    rows.find(
      x => x.symbol === 'BTCUSDT'
    );

  const eth =
    rows.find(
      x => x.symbol === 'ETHUSDT'
    );

  if (btc) {

    if (btc.change > 0.003) {
      score += 3;
    }

    if (btc.change < -0.003) {
      score -= 3;
    }
  }

  if (eth) {

    if (eth.change > 0.003) {
      score += 2;
    }

    if (eth.change < -0.003) {
      score -= 2;
    }
  }

  const ratio =
    score /
    Math.max(1, limited.length);

  if (ratio > 0.12) {

    return {
      label: 'PİYASA YUKARI',
      score,
      text:
        'BTC / ETH ve piyasa genişliği yükseliş ağırlıklı.'
    };
  }

  if (ratio < -0.12) {

    return {
      label: 'PİYASA AŞAĞI',
      score,
      text:
        'BTC / ETH ve piyasa genişliği düşüş ağırlıklı.'
    };
  }

  return {
    label: 'PİYASA YATAY',
    score,
    text:
      'Piyasada net bir yön üstünlüğü yok.'
  };
}


// ============================================================
// SIGNAL BUILDER
// ============================================================

function buildSignal(
  symbol,
  ticker,
  h4,
  h2,
  m15,
  m5
) {

  const price =
    ticker.last;

  if (
    !price ||
    h4.length < 50 ||
    h2.length < 50 ||
    m15.length < 30
  ) {
    return null;
  }

  const candidates = [];

  for (
    const side of ['LONG', 'SHORT']
  ) {

    // --------------------------------------------------------
    // 4H BREAKOUT - ZORUNLU
    // --------------------------------------------------------

    const breakout4H =
      lastClosedBreakout(
        h4,
        side
      );

    if (
      !breakout4H ||
      !breakout4H.broke
    ) {
      continue;
    }


    // --------------------------------------------------------
    // 2H CONFIRMATION - ZORUNLU
    // --------------------------------------------------------

    const breakout2H =
      lastClosedBreakout(
        h2,
        side
      );

    if (
      !breakout2H ||
      !breakout2H.broke
    ) {
      continue;
    }


    // --------------------------------------------------------
    // RSI
    // --------------------------------------------------------

    const rsi15 =
      rsi(
        m15.map(x => x.c),
        14
      );

    const rsi5 =
      m5.length
        ? rsi(
            m5.map(x => x.c),
            14
          )
        : null;

    if (rsi15 === null) {
      continue;
    }


    // --------------------------------------------------------
    // RETEST
    // --------------------------------------------------------

    const atr15 =
      atr(m15, 14) ||
      Math.abs(price) * 0.01;

    const level =
      (
        breakout4H.level +
        breakout2H.level
      ) / 2;

    const zone =
      clamp(
        atr15 * 0.65,
        Math.abs(level) * 0.0025,
        Math.abs(level) * 0.012
      );

    let entryLow;
    let entryHigh;

    if (side === 'LONG') {

      entryLow =
        level - zone;

      entryHigh =
        level + zone;

    } else {

      entryLow =
        level - zone;

      entryHigh =
        level + zone;
    }

    const inRetest =
      price >= entryLow &&
      price <= entryHigh;

    if (!inRetest) {
      continue;
    }


    // --------------------------------------------------------
    // 15M RSI - ZORUNLU
    //
    // Aşırı filtrelemiyoruz.
    // --------------------------------------------------------

    let rsiOK = false;

    if (side === 'LONG') {

      rsiOK =
        rsi15 >= 48 &&
        rsi15 <= 72;

    } else {

      rsiOK =
        rsi15 >= 28 &&
        rsi15 <= 52;
    }

    if (!rsiOK) {
      continue;
    }


    // --------------------------------------------------------
    // 5M RSI - SADECE PUAN
    // --------------------------------------------------------

    let score = 84;

    if (
      Math.abs(
        breakout4H.level -
        breakout2H.level
      ) /
      Math.max(price, 1)
      < 0.01
    ) {

      score += 5;
    }


    // 15M RSI ideal bölge
    if (
      side === 'LONG' &&
      rsi15 >= 52 &&
      rsi15 <= 68
    ) {

      score += 4;
    }

    if (
      side === 'SHORT' &&
      rsi15 >= 32 &&
      rsi15 <= 48
    ) {

      score += 4;
    }


    // 5M RSI yardımcı
    if (rsi5 !== null) {

      if (
        side === 'LONG' &&
        rsi5 >= 45 &&
        rsi5 <= 75
      ) {

        score += 3;
      }

      if (
        side === 'SHORT' &&
        rsi5 >= 25 &&
        rsi5 <= 55
      ) {

        score += 3;
      }
    }


    // --------------------------------------------------------
    // HACİM - SADECE PUAN
    // --------------------------------------------------------

    const avgVol =
      averageVolume(
        m15,
        20
      );

    const currentVol =
      m15.length
        ? m15[m15.length - 1].v
        : 0;

    const volumeRatio =
      avgVol > 0
        ? currentVol / avgVol
        : 0;

    if (volumeRatio >= 1.2) {
      score += 4;
    } else if (
      volumeRatio >= 0.8
    ) {
      score += 2;
    }


    // --------------------------------------------------------
    // BOLLINGER WIDTH
    // --------------------------------------------------------

    const width =
      bbWidth(
        m15,
        20
      ) || 0;

    if (width > 0.01) {
      score += 1;
    }


    // --------------------------------------------------------
    // GENEL PİYASA YÖNÜ
    // --------------------------------------------------------

    if (
      side === 'LONG' &&
      marketState.label === 'PİYASA YUKARI'
    ) {

      score += 2;
    }

    if (
      side === 'SHORT' &&
      marketState.label === 'PİYASA AŞAĞI'
    ) {

      score += 2;
    }


    score =
      clamp(
        score,
        0,
        100
      );


    // --------------------------------------------------------
    // STOP / TP
    // --------------------------------------------------------

    const stopDistance =
      Math.max(
        atr15 * 1.15,
        Math.abs(level) * 0.008
      );

    let stop;

    if (side === 'LONG') {

      stop =
        entryLow -
        stopDistance;

    } else {

      stop =
        entryHigh +
        stopDistance;
    }

    const risk =
      Math.abs(
        (
          side === 'LONG'
            ? entryLow
            : entryHigh
        ) -
        stop
      );


    let tp1;
    let tp2;
    let tp3;

    if (side === 'LONG') {

      tp1 =
        entryHigh +
        risk * 1.5;

      tp2 =
        entryHigh +
        risk * 2.2;

      tp3 =
        entryHigh +
        risk * 3.2;

    } else {

      tp1 =
        entryLow -
        risk * 1.5;

      tp2 =
        entryLow -
        risk * 2.2;

      tp3 =
        entryLow -
        risk * 3.2;
    }


    // Aynı coin + yön + seviye için stabil ID
    const id =
      `${symbol}:${side}:${Math.round(level * 1e8)}`;


    candidates.push({
      id,

      symbol,

      side,

      score,

      price,

      entryLow,

      entryHigh,

      stop,

      tp1,

      tp2,

      tp3,

      level,

      rsi15,

      rsi5,

      volumeRatio,

      bbWidth: width,

      createdAt: Date.now(),

      status: 'ACTIVE'
    });
  }


  if (!candidates.length) {
    return null;
  }

  candidates.sort(
    (a, b) =>
      b.score - a.score
  );

  return candidates[0];
}


// ============================================================
// CONCURRENCY
// ============================================================

async function mapLimit(
  items,
  limit,
  fn
) {

  const output =
    new Array(items.length);

  let index = 0;

  async function worker() {

    while (true) {

      const i = index++;

      if (i >= items.length) {
        return;
      }

      try {

        output[i] =
          await fn(
            items[i],
            i
          );

      } catch (e) {

        output[i] = null;
      }

      await sleep(90);
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
      () => worker()
    );

  await Promise.all(
    workers
  );

  return output;
}


// ============================================================
// ANALYZE COIN
// ============================================================

async function analyzeSymbol(
  row
) {

  const [
    h4,
    h2,
    m15,
    m5
  ] = await Promise.all([

    candles(
      row.symbol,
      '4H',
      100
    ),

    candles(
      row.symbol,
      '2H',
      100
    ),

    candles(
      row.symbol,
      '15m',
      100
    ),

    candles(
      row.symbol,
      '5m',
      80
    )
  ]);


  const ticker =
    marketRows.find(
      x =>
        x.symbol ===
        row.symbol
    );


  if (!ticker) {
    return null;
  }


  return buildSignal(
    row.symbol,
    ticker,
    h4,
    h2,
    m15,
    m5
  );
}


// ============================================================
// PERFORMANCE
// ============================================================

function performance() {

  const recent =
    history
      .filter(
        x =>
          [
            'TP1',
            'TP2',
            'TP3',
            'STOP'
          ].includes(x.result)
      )
      .slice(-50);


  const wins =
    recent.filter(
      x =>
        x.result === 'TP1' ||
        x.result === 'TP2' ||
        x.result === 'TP3'
    ).length;


  const stops =
    recent.filter(
      x =>
        x.result === 'STOP'
    ).length;


  const totalR =
    recent.reduce(
      (sum, x) =>
        sum + num(x.r),
      0
    );


  return {

    resolved:
      recent.length,

    wins,

    stops,

    tp1Rate:
      recent.length
        ? wins / recent.length * 100
        : 0,

    stopRate:
      recent.length
        ? stops / recent.length * 100
        : 0,

    totalR
  };
}


// ============================================================
// RECORD RESULT
// ============================================================

function recordResult(
  signal,
  result,
  exit
) {

  if (
    history.some(
      x =>
        x.id ===
        signal.id
    )
  ) {
    return;
  }


  let r = 0;

  if (result === 'STOP') {
    r = -1;
  }

  if (result === 'TP1') {
    r = 1.5;
  }

  if (result === 'TP2') {
    r = 2.2;
  }

  if (result === 'TP3') {
    r = 3.2;
  }


  history.push({

    id:
      signal.id,

    symbol:
      signal.symbol,

    side:
      signal.side,

    result,

    entry:
      signal.side === 'LONG'
        ? signal.entryHigh
        : signal.entryLow,

    exit,

    r,

    at:
      Date.now()
  });


  history =
    history.slice(-500);

  saveHistory();
}


// ============================================================
// LIVE ACTIVE SIGNAL TRACKER
// ============================================================

function updateActiveSignals() {

  for (
    const [id, signal]
    of activeSignals
  ) {

    const ticker =
      marketRows.find(
        x =>
          x.symbol ===
          signal.symbol
      );


    if (!ticker) {
      continue;
    }


    signal.price =
      ticker.last;


    const price =
      ticker.last;


    // STOP
    const hitStop =
      signal.side === 'LONG'
        ? price <= signal.stop
        : price >= signal.stop;


    // TP3
    const hitTP3 =
      signal.side === 'LONG'
        ? price >= signal.tp3
        : price <= signal.tp3;


    // TP2
    const hitTP2 =
      signal.side === 'LONG'
        ? price >= signal.tp2
        : price <= signal.tp2;


    // TP1
    const hitTP1 =
      signal.side === 'LONG'
        ? price >= signal.tp1
        : price <= signal.tp1;


    if (hitStop) {

      recordResult(
        signal,
        'STOP',
        price
      );

      activeSignals.delete(id);

    } else if (hitTP3) {

      recordResult(
        signal,
        'TP3',
        price
      );

      activeSignals.delete(id);

    } else if (hitTP2) {

      recordResult(
        signal,
        'TP2',
        price
      );

      activeSignals.delete(id);

    } else if (hitTP1) {

      recordResult(
        signal,
        'TP1',
        price
      );

      activeSignals.delete(id);
    }
  }
}


// ============================================================
// MAIN SCAN
// ============================================================

async function scan() {

  if (scanning) {
    return;
  }

  scanning = true;

  scanError = '';

  try {

    marketRows =
      await getTickers();


    marketState =
      calculateMarketDirection(
        marketRows
      );


    const tickerMap =
      new Map(
        marketRows.map(
          x =>
            [
              x.symbol,
              x
            ]
        )
      );


    // Universe içindeki coinleri
    // hacme göre sırala
    const candidates =
      universe
        .filter(
          x =>
            tickerMap.has(
              x.symbol
            )
        )
        .map(
          x => ({
            ...x,
            ...tickerMap.get(
              x.symbol
            )
          })
        )
        .sort(
          (a, b) =>
            b.quoteVol -
            a.quoteVol
        );


    // İlk geniş radar
    const fast =
      candidates.slice(
        0,
        FAST_TOP
      );


    // Derin analiz
    const deep =
      fast.slice(
        0,
        MAX_DEEP
      );


    console.log(
      `RADAR başladı | Universe=${universe.length} | FastRadar=${fast.length} | DeepAnalysis=${deep.length}`
    );


    const results =
      await mapLimit(
        deep,
        CONCURRENCY,
        analyzeSymbol
      );


    const found =
      results.filter(
        Boolean
      );


    for (
      const signal
      of found
    ) {

      // Aynı geçmiş sinyali yeniden üretme
      if (
        history.some(
          x =>
            x.id ===
            signal.id
        )
      ) {
        continue;
      }


      // Aynı coin + yön aktifse
      // yeniden oluşturma
      const existing =
        [
          ...activeSignals.values()
        ].find(
          x =>
            x.symbol ===
              signal.symbol &&
            x.side ===
              signal.side
        );


      if (!existing) {

        activeSignals.set(
          signal.id,
          signal
        );
      }
    }


    updateActiveSignals();


    lastScan =
      Date.now();


    const perf =
      performance();


    console.log(
      `RADAR tamamlandı | Universe=${universe.length} | Analiz=${deep.length} | SIGNAL=${activeSignals.size} | PERFORMANCE=${perf.resolved}`
    );

  } catch (error) {

    scanError =
      error.message;

    console.error(
      'SCAN ERROR:',
      error.message
    );

  } finally {

    scanning = false;
  }
}


// ============================================================
// LIVE PRICE REFRESH
// ============================================================

async function refreshPrices() {

  try {

    marketRows =
      await getTickers();


    marketState =
      calculateMarketDirection(
        marketRows
      );


    updateActiveSignals();

  } catch (error) {

    scanError =
      error.message;
  }
}


// ============================================================
// TRADINGVIEW
// ============================================================

function tradingViewUrl(
  symbol
) {

  return (
    'https://www.tradingview.com/symbols/' +
    encodeURIComponent(symbol) +
    '/?exchange=BITGET'
  );
}


// ============================================================
// HTML
// ============================================================

function renderHTML() {

  const perf =
    performance();


  const signals =
    [
      ...activeSignals.values()
    ]
      .sort(
        (a, b) =>
          b.score -
          a.score
      );


  const lastScanText =
    lastScan
      ? new Date(
          lastScan
        ).toLocaleTimeString(
          'tr-TR'
        )
      : '-';


  let marketClass =
    'flat';


  if (
    marketState.label
      .includes('YUKARI')
  ) {

    marketClass =
      'up';
  }


  if (
    marketState.label
      .includes('AŞAĞI')
  ) {

    marketClass =
      'down';
  }


  const signalCards =
    signals.length

      ? signals.map(
          signal => {

            return `
<div class="signal-card ${signal.side.toLowerCase()}">

  <div class="signal-header">

    <div>

      <div class="coin-name">
        ${esc(signal.symbol)}
        ·
        ${esc(signal.side)}
      </div>

      <div class="score">
        GÜÇ ${signal.score}/100
      </div>

    </div>

    <div class="direction">
      ${esc(signal.side)}
    </div>

  </div>


  <div class="live-price">

    Canlı fiyat:
    <strong>
      ${fmt(signal.price)}
    </strong>

    · 15M RSI:
    <strong>
      ${fmt(signal.rsi15)}
    </strong>

    · 5M RSI:
    <strong>
      ${fmt(signal.rsi5)}
    </strong>

    · Hacim:
    <strong>
      ${fmt(signal.volumeRatio)}x
    </strong>

  </div>


  <div class="levels">

    <div>
      <span>GİRİŞ</span>
      <b>
        ${fmt(signal.entryLow)}
        -
        ${fmt(signal.entryHigh)}
      </b>
    </div>

    <div>
      <span>STOP</span>
      <b>
        ${fmt(signal.stop)}
      </b>
    </div>

    <div>
      <span>TP1</span>
      <b>
        ${fmt(signal.tp1)}
      </b>
    </div>

    <div>
      <span>TP2</span>
      <b>
        ${fmt(signal.tp2)}
      </b>
    </div>

    <div>
      <span>TP3</span>
      <b>
        ${fmt(signal.tp3)}
      </b>
    </div>

    <div>
      <span>KIRILAN SEVİYE</span>
      <b>
        ${fmt(signal.level)}
      </b>
    </div>

  </div>


  <div class="reason">

    4H kırılımı +
    2H onayı +
    retest +
    15M RSI giriş şartı.

    5M RSI ve hacim
    kalite puanını etkiler.

  </div>


  <a
    class="tv-button"
    target="_blank"
    rel="noopener"
    href="${tradingViewUrl(signal.symbol)}"
  >
    📊 TRADINGVIEW AÇ
  </a>

</div>
`;
          }
        ).join('')

      : `
<div class="empty">
  Şu anda aktif sinyal yok.
  Sistem piyasayı tarıyor.
</div>
`;


  return `
<!DOCTYPE html>

<html lang="tr">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
/>

<meta
  http-equiv="refresh"
  content="60"
/>

<title>
  Sonny AI Signal Scanner V6.2
</title>


<style>

* {
  box-sizing: border-box;
}


body {

  margin: 0;

  background:
    #090d13;

  color:
    #e8edf5;

  font-family:
    Arial,
    Helvetica,
    sans-serif;
}


.container {

  max-width:
    1050px;

  margin:
    auto;

  padding:
    24px;
}


.top {

  display:
    flex;

  justify-content:
    space-between;

  align-items:
    flex-start;

  gap:
    20px;
}


.title {

  font-size:
    24px;

  font-weight:
    800;

  margin-bottom:
    6px;
}


.subtitle {

  color:
    #8b96a7;

  font-size:
    13px;
}


.live {

  background:
    #0b2519;

  border:
    1px solid #245f42;

  color:
    #63e5a0;

  padding:
    8px 12px;

  border-radius:
    999px;

  font-size:
    12px;

  font-weight:
    700;
}


.market {

  margin-top:
    20px;

  padding:
    20px;

  border:
    1px solid #202a39;

  background:
    #0e141d;

  border-radius:
    16px;
}


.label {

  color:
    #7f899a;

  font-size:
    12px;

  font-weight:
    700;
}


.market-state {

  font-size:
    28px;

  font-weight:
    800;

  margin:
    7px 0;
}


.up {
  color:
    #43df91;
}


.down {
  color:
    #ff6478;
}


.flat {
  color:
    #e3bd5c;
}


.market-text {

  color:
    #8f9aaa;

  font-size:
    13px;
}


.stats {

  display:
    grid;

  grid-template-columns:
    repeat(4, 1fr);

  gap:
    10px;

  margin-top:
    16px;
}


.stat {

  background:
    #111925;

  border:
    1px solid #202a39;

  border-radius:
    12px;

  padding:
    13px;
}


.stat-title {

  color:
    #7f899a;

  font-size:
    11px;
}


.stat-value {

  display:
    block;

  margin-top:
    5px;

  font-size:
    21px;

  font-weight:
    800;
}


.section {

  margin-top:
    26px;
}


.section-title {

  font-size:
    17px;

  font-weight:
    800;

  margin-bottom:
    7px;
}


.section-info {

  color:
    #7f899a;

  font-size:
    12px;

  margin-bottom:
    12px;
}


.signal-card {

  background:
    #0e141d;

  border:
    1px solid #273246;

  border-radius:
    15px;

  padding:
    18px;

  margin:
    10px 0;
}


.signal-card.long {

  border-left:
    4px solid #3dde8d;
}


.signal-card.short {

  border-left:
    4px solid #ff5d73;
}


.signal-header {

  display:
    flex;

  justify-content:
    space-between;

  align-items:
    center;

  gap:
    10px;
}


.coin-name {

  font-size:
    20px;

  font-weight:
    800;
}


.score {

  color:
    #9ba6b6;

  font-size:
    12px;

  margin-top:
    4px;
}


.direction {

  padding:
    6px 10px;

  border-radius:
    999px;

  background:
    #182233;

  font-size:
    12px;

  font-weight:
    800;
}


.live-price {

  margin:
    14px 0;

  color:
    #aeb8c7;

  font-size:
    13px;
}


.levels {

  display:
    grid;

  grid-template-columns:
    repeat(3, 1fr);

  gap:
    8px;
}


.levels > div {

  background:
    #111925;

  border-radius:
    10px;

  padding:
    10px;
}


.levels span {

  display:
    block;

  color:
    #758094;

  font-size:
    10px;

  margin-bottom:
    4px;
}


.levels b {

  font-size:
    13px;
}


.reason {

  margin:
    13px 0;

  color:
    #aeb8c7;

  font-size:
    12px;

  line-height:
    1.5;
}


.tv-button {

  display:
    inline-block;

  text-decoration:
    none;

  color:
    #e9eef8;

  background:
    #1a2637;

  border:
    1px solid #2b3a51;

  padding:
    9px 13px;

  border-radius:
    9px;

  font-size:
    12px;

  font-weight:
    700;
}


.empty {

  border:
    1px dashed #2a3547;

  padding:
    22px;

  border-radius:
    13px;

  color:
    #818c9e;

  text-align:
    center;
}


.performance {

  display:
    grid;

  grid-template-columns:
    repeat(4, 1fr);

  gap:
    10px;
}


.footer {

  text-align:
    center;

  color:
    #667285;

  font-size:
    11px;

  margin-top:
    25px;
}


@media(max-width:700px) {

  .container {
    padding:
      14px;
  }

  .stats,
  .performance {

    grid-template-columns:
      repeat(2, 1fr);
  }

  .levels {

    grid-template-columns:
      repeat(2, 1fr);
  }

  .top {

    flex-direction:
      column;
  }
}

</style>

</head>


<body>

<div class="container">


<div class="top">

  <div>

    <div class="title">
      🚀 Sonny AI Signal Scanner V6.2
    </div>

    <div class="subtitle">
      4H Kırılım · 2H Onay · Retest ·
      15M RSI · 5M RSI · Hacim
    </div>

  </div>


  <div class="live">
    ● SÜREKLİ AKTİF
  </div>

</div>


<div class="market">

  <div class="label">
    GENEL PİYASA DURUMU
  </div>


  <div class="market-state ${marketClass}">
    ${esc(marketState.label)}
  </div>


  <div class="market-text">
    ${esc(marketState.text)}
  </div>


  <div class="stats">

    <div class="stat">

      <div class="stat-title">
        PİYASA
      </div>

      <span class="stat-value">
        ${universe.length || '-'}
      </span>

    </div>


    <div class="stat">

      <div class="stat-title">
        ANALİZ
      </div>

      <span class="stat-value">
        ${Math.min(
          MAX_DEEP,
          Math.min(
            FAST_TOP,
            universe.length
          )
        )}
      </span>

    </div>


    <div class="stat">

      <div class="stat-title">
        AKTİF SİNYAL
      </div>

      <span class="stat-value">
        ${signals.length}
      </span>

    </div>


    <div class="stat">

      <div class="stat-title">
        SON TARAMA
      </div>

      <span class="stat-value">
        ${lastScanText}
      </span>

    </div>

  </div>

</div>


<div class="section">

  <div class="section-title">
    🚨 AKTİF SİNYALLER
  </div>


  <div class="section-info">
    Yalnızca gerçek giriş bölgesine gelmiş
    sinyaller gösterilir.
    Hazırlanan ve kaçan fırsatlar ekranda tutulmaz.
  </div>


  ${signalCards}

</div>


<div class="section">

  <div class="section-title">
    📊 GERÇEK PERFORMANS · SON 50
  </div>


  <div class="section-info">
    Yalnızca gerçekten aktif olmuş ve
    TP veya STOP sonucu oluşmuş işlemler hesaba katılır.
  </div>


  <div class="performance">

    <div class="stat">

      <div class="stat-title">
        TP1+
      </div>

      <span class="stat-value">
        ${perf.tp1Rate.toFixed(1)}%
      </span>

    </div>


    <div class="stat">

      <div class="stat-title">
        STOP
      </div>

      <span class="stat-value">
        ${perf.stopRate.toFixed(1)}%
      </span>

    </div>


    <div class="stat">

      <div class="stat-title">
        TOPLAM R
      </div>

      <span class="stat-value">
        ${perf.totalR.toFixed(2)}R
      </span>

    </div>


    <div class="stat">

      <div class="stat-title">
        ÇÖZÜLEN
      </div>

      <span class="stat-value">
        ${perf.resolved}
      </span>

    </div>

  </div>

</div>


<div class="footer">

  Sonny V6.2 · Bitget Perpetual ·
  Her 60 saniyede tarama ·
  Son tarama: ${lastScanText}

  ${
    scanError
      ? ` · Hata: ${esc(scanError)}`
      : ''
  }

</div>


</div>

</body>

</html>
`;
}


// ============================================================
// SERVER
// ============================================================

const server =
  http.createServer(
    (req, res) => {

      if (
        req.url.startsWith(
          '/api/status'
        )
      ) {

        const perf =
          performance();


        res.writeHead(
          200,
          {
            'content-type':
              'application/json; charset=utf-8',

            'cache-control':
              'no-store'
          }
        );


        res.end(
          JSON.stringify({

            universe:
              universe.length,

            active:
              [
                ...activeSignals.values()
              ],

            performance:
              perf,

            market:
              marketState,

            lastScan,

            scanning,

            scanError
          })
        );


        return;
      }


      res.writeHead(
        200,
        {
          'content-type':
            'text/html; charset=utf-8',

          'cache-control':
            'no-store'
        }
      );


      res.end(
        renderHTML()
      );
    }
  );


// ============================================================
// BOOT
// ============================================================

async function boot() {

  console.log(
    'Sonny AI Signal Scanner V6.2 started'
  );

  console.log(
    'Data source: BITGET'
  );

  console.log(
    'Strategy: 4H BREAKOUT + 2H CONFIRMATION + RETEST + 15M RSI + 5M RSI + VOLUME'
  );

  console.log(
    'Refresh: Every 60 seconds'
  );

  console.log(
    `Server listening on port ${PORT}`
  );

  console.log(
    `Signal history: ${history.length} kayıt`
  );


  try {

    await discover();

    await scan();

  } catch (error) {

    console.error(
      'BOOT ERROR:',
      error.message
    );
  }


  // Market discovery 5 dakikada bir
  setInterval(
    async () => {

      try {

        await discover();

      } catch (error) {

        console.error(
          'DISCOVERY ERROR:',
          error.message
        );
      }

    },
    5 * 60_000
  );


  // Ana radar her dakika
  setInterval(
    async () => {

      await scan();

    },
    REFRESH_MS
  );


  // Aktif sinyallerin fiyatı
  // 15 saniyede bir güncellenecek
  setInterval(
    async () => {

      await refreshPrices();

    },
    15_000
  );
}


server.listen(
  PORT,
  HOST,
  () => {

    boot();

  }
);
