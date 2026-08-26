const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 10000;

/* =========================================================
   SONNY AI TRADER FINAL
   4H / 2H DESTEK-DİRENÇ
   15M YAPI ONAYI
   HACİM FİLTRESİ
   CANLI GRAFİK
   ========================================================= */

const CFG = {
  MIN_VOLUME_USD: 5_000_000,

  MAX_COINS: 120,

  MAX_SIGNALS: 15,

  SCAN_MS: 60_000,

  LEVEL_TOLERANCE: 0.012,

  CLUSTER_TOLERANCE: 0.004,

  MIN_SCORE: 68,

  MAX_CHART_CANDLES: 160,

  REQUEST_CONCURRENCY: 8,

  REQUEST_DELAY: 80
};


/* =========================================================
   GLOBAL STATE
   ========================================================= */

let exchange = null;

let marketRows = [];

let signals = [];

let lastScan = 0;

let scanRunning = false;

let lastError = null;

let stats = {
  universe: 0,
  analyzed: 0,
  signals: 0,
  seconds: 0
};

let marketSentiment = {
  label: 'YATAY / KARIŞIK',
  direction: 'NEUTRAL',
  reason: 'Piyasa verisi bekleniyor.'
};


/* =========================================================
   HELPERS
   ========================================================= */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


function n(value, fallback = 0) {
  const x = Number(value);

  return Number.isFinite(x)
    ? x
    : fallback;
}


function clean(symbol) {

  return String(symbol || '')
    .replace('/USDT:USDT', '')
    .replace('/USDT', '')
    .replace(':USDT', '')
    .replace('USDT', '')
    .replace(/[^A-Z0-9]/gi, '')
    .toUpperCase() + 'USDT';

}


function symbolForMarket(symbol) {

  if (!symbol) {
    return null;
  }

  const wanted = clean(symbol);

  if (!exchange || !exchange.markets) {
    return wanted.replace('USDT', '') + '/USDT:USDT';
  }

  const found = Object.keys(exchange.markets)
    .find(key => clean(key) === wanted);

  return found || null;
}


function fmtPrice(value) {

  const x = Number(value);

  if (!Number.isFinite(x)) {
    return null;
  }

  if (x >= 1000) {
    return Number(x.toFixed(2));
  }

  if (x >= 100) {
    return Number(x.toFixed(3));
  }

  if (x >= 1) {
    return Number(x.toFixed(5));
  }

  if (x >= 0.01) {
    return Number(x.toFixed(6));
  }

  return Number(x.toFixed(10));
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

    const high = n(candles[i][2]);

    const low = n(candles[i][3]);

    const previousClose =
      n(candles[i - 1][4]);

    const tr = Math.max(
      high - low,
      Math.abs(high - previousClose),
      Math.abs(low - previousClose)
    );

    trs.push(tr);
  }

  const last =
    trs.slice(-period);

  if (!last.length) {
    return null;
  }

  const result =
    last.reduce(
      (sum, value) => sum + value,
      0
    ) / last.length;

  return Number.isFinite(result) && result > 0
    ? result
    : null;
}


/* =========================================================
   SWING HIGH / LOW
   ========================================================= */

function pivots(candles, lookback = 3) {

  const result = [];

  for (
    let i = lookback;
    i < candles.length - lookback;
    i++
  ) {

    const high =
      n(candles[i][2]);

    const low =
      n(candles[i][3]);

    let isHigh = true;

    let isLow = true;

    for (
      let j = 1;
      j <= lookback;
      j++
    ) {

      if (
        high <= n(candles[i - j][2]) ||
        high <= n(candles[i + j][2])
      ) {
        isHigh = false;
      }

      if (
        low >= n(candles[i - j][3]) ||
        low >= n(candles[i + j][3])
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

  const sorted =
    [...levels].sort(
      (a, b) => a.price - b.price
    );

  const groups = [];

  for (const level of sorted) {

    const existing =
      groups.find(
        group =>
          group.type === level.type &&
          Math.abs(
            level.price - group.price
          ) / group.price
          <= CFG.CLUSTER_TOLERANCE
      );

    if (existing) {

      existing.items.push(level);

      existing.price =
        existing.items.reduce(
          (sum, item) =>
            sum + item.price,
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

  if (!candles || candles.length < 8) {
    return 'NEUTRAL';
  }

  const c =
    candles.slice(-8);

  const highs =
    c.map(x => n(x[2]));

  const lows =
    c.map(x => n(x[3]));

  const closes =
    c.map(x => n(x[4]));

  const rising =
    highs[7] > highs[4] &&
    lows[7] > lows[4] &&
    closes[7] > closes[4];

  const falling =
    highs[7] < highs[4] &&
    lows[7] < lows[4] &&
    closes[7] < closes[4];

  if (rising) {
    return 'LONG';
  }

  if (falling) {
    return 'SHORT';
  }

  return 'NEUTRAL';
}


/* =========================================================
   15M VOLUME RATIO
   ========================================================= */

function volumeRatio(candles) {

  if (!candles || candles.length < 21) {
    return 0;
  }

  const recent =
    n(candles[candles.length - 1][5]);

  const average =
    candles
      .slice(-21, -1)
      .reduce(
        (sum, candle) =>
          sum + n(candle[5]),
        0
      ) / 20;

  if (average <= 0) {
    return 0;
  }

  return recent / average;
}


/* =========================================================
   OHLCV
   ========================================================= */

async function fetchOHLCV(
  symbol,
  timeframe,
  limit
) {

  return exchange.fetchOHLCV(
    symbol,
    timeframe,
    undefined,
    limit
  );

}


/* =========================================================
   COIN ANALYSIS
   ========================================================= */

async function analyzeSymbol(row) {

  const symbol =
    row.symbol;

  try {

    const [
      h4,
      h2,
      m15
    ] = await Promise.all([

      fetchOHLCV(
        symbol,
        '4h',
        90
      ),

      fetchOHLCV(
        symbol,
        '2h',
        90
      ),

      fetchOHLCV(
        symbol,
        '15m',
        100
      )

    ]);


    if (
      h4.length < 40 ||
      h2.length < 40 ||
      m15.length < 30
    ) {
      return null;
    }


    const price =
      n(
        row.last ||
        m15[m15.length - 1][4]
      );


    if (!price) {
      return null;
    }


    /* -----------------------------------------------------
       4H SEVİYELERİ
       ----------------------------------------------------- */

    const levels4 =
      clusterLevels(
        pivots(h4, 3)
      );


    /* -----------------------------------------------------
       2H SEVİYELERİ
       ----------------------------------------------------- */

    const levels2 =
      clusterLevels(
        pivots(h2, 3)
      );


    const allLevels = [

      ...levels4.map(
        level => ({
          ...level,
          tf: '4H'
        })
      ),

      ...levels2.map(
        level => ({
          ...level,
          tf: '2H'
        })
      )

    ];


    /* -----------------------------------------------------
       FİYATA YAKIN SEVİYELER
       ----------------------------------------------------- */

    const nearby =
      allLevels

        .map(level => ({

          ...level,

          distance:
            Math.abs(
              price - level.price
            ) / price

        }))

        .filter(
          level =>
            level.distance
            <= CFG.LEVEL_TOLERANCE
        )

        .sort(
          (a, b) =>
            a.distance -
            b.distance
        );


    if (!nearby.length) {
      return null;
    }


    const chosen =
      nearby[0];


    /* -----------------------------------------------------
       4H + 2H AYNI BÖLGE
       ----------------------------------------------------- */

    const sameZone =
      allLevels.filter(
        level =>
          level.type === chosen.type &&
          Math.abs(
            level.price -
            chosen.price
          ) /
          chosen.price
          <= CFG.CLUSTER_TOLERANCE
      );


    const has4 =
      sameZone.some(
        level =>
          level.tf === '4H'
      );


    const has2 =
      sameZone.some(
        level =>
          level.tf === '2H'
      );


    const confluence =
      has4 && has2;


    /* -----------------------------------------------------
       15M YAPI
       ----------------------------------------------------- */

    const structure =
      structure15m(m15);


    /* -----------------------------------------------------
       HACİM
       ----------------------------------------------------- */

    const vol =
      volumeRatio(m15);


    /* -----------------------------------------------------
       YÖN
       ----------------------------------------------------- */

    let side =
      chosen.type === 'support'
        ? 'LONG'
        : 'SHORT';


    /* -----------------------------------------------------
       PUAN
       ----------------------------------------------------- */

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


    if (vol >= 1.2) {

      score += 8;

    } else if (vol >= 0.8) {

      score += 4;

    }


    score -= Math.min(
      10,
      (
        chosen.distance /
        CFG.LEVEL_TOLERANCE
      ) * 10
    );


    score =
      Math.round(
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


    /* -----------------------------------------------------
       ATR
       ----------------------------------------------------- */

    const currentATR =
      atr(
        m15,
        14
      ) ||
      price * 0.006;


    const buffer =
      Math.max(
        currentATR * 0.35,
        price * 0.0025
      );


    /* -----------------------------------------------------
       İŞLEM PLANLARI
       ----------------------------------------------------- */

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


      tp1 =
        price +
        risk * 1.4;


      tp2 =
        price +
        risk * 2.2;


      tp3 =
        price +
        risk * 3.0;

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


      tp1 =
        price -
        risk * 1.4;


      tp2 =
        price -
        risk * 2.2;


      tp3 =
        price -
        risk * 3.0;

    }


    const now =
      Date.now();


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
        fmtPrice(
          chosen.price
        ),

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
        n(row.quoteVolume),

      volumeRatio:
        Number(
          vol.toFixed(2)
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
            : chosen.tf + ' seviye'
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
        )

    };

  } catch (error) {

    return null;

  }

}


/* =========================================================
   MARKET DISCOVERY
   ========================================================= */

async function discover() {

  await exchange.loadMarkets(true);


  const markets =
    Object.values(
      exchange.markets
    ).filter(
      market =>
        market &&
        market.active !== false &&
        market.quote === 'USDT' &&
        (
          market.swap ||
          market.future
        ) &&
        market.settle === 'USDT'
    );


  const result = [];


  for (
    let i = 0;
    i < markets.length;
    i += 40
  ) {

    const batch =
      markets
        .slice(
          i,
          i + 40
        )
        .map(
          market =>
            market.symbol
        );


    try {

      const tickers =
        await exchange.fetchTickers(
          batch
        );


      for (
        const ticker of
        Object.values(
          tickers || {}
        )
      ) {

        const volume =
          n(
            ticker.quoteVolume
          );


        if (
          ticker &&
          ticker.symbol &&
          volume >=
            CFG.MIN_VOLUME_USD &&
          n(ticker.last) > 0
        ) {

          result.push({

            symbol:
              ticker.symbol,

            last:
              n(ticker.last),

            quoteVolume:
              volume,

            percentage:
              n(ticker.percentage)

          });

        }

      }

    } catch (error) {

      console.log(
        'Ticker batch hatası:',
        error.message
      );

    }


    await sleep(
      CFG.REQUEST_DELAY
    );

  }


  return result

    .sort(
      (a, b) =>
        b.quoteVolume -
        a.quoteVolume
    )

    .slice(
      0,
      CFG.MAX_COINS
    );

}


/* =========================================================
   GENERAL MARKET
   ========================================================= */

async function calculateMarketSentiment(
  rows
) {

  const btc =
    rows.find(
      row =>
        clean(row.symbol) ===
        'BTCUSDT'
    );


  const eth =
    rows.find(
      row =>
        clean(row.symbol) ===
        'ETHUSDT'
    );


  const average =
    rows.length
      ? rows.reduce(
          (sum, row) =>
            sum +
            n(row.percentage),
          0
        ) / rows.length
      : 0;


  const majors =
    [btc, eth]
      .filter(Boolean);


  const majorAverage =
    majors.length
      ? majors.reduce(
          (sum, row) =>
            sum +
            n(row.percentage),
          0
        ) /
        majors.length
      : average;


  if (
    majorAverage >
    1.2
  ) {

    return {

      label:
        'YÜKSELİŞ',

      direction:
        'LONG',

      reason:
        'BTC / ETH ve piyasa ortalaması pozitif.'

    };

  }


  if (
    majorAverage <
    -1.2
  ) {

    return {

      label:
        'DÜŞÜŞ',

      direction:
        'SHORT',

      reason:
        'BTC / ETH ve piyasa ortalaması negatif.'

    };

  }


  return {

    label:
      'YATAY / KARIŞIK',

    direction:
      'NEUTRAL',

    reason:
      'Genel piyasa yönü net değil.'

  };

}


/* =========================================================
   MAIN RADAR
   ========================================================= */

async function runScan() {

  if (scanRunning) {
    return;
  }


  scanRunning =
    true;


  const started =
    Date.now();


  try {

    console.log(
      'Bitget piyasası taranıyor...'
    );


    const rows =
      await discover();


    marketRows =
      rows;


    marketSentiment =
      await calculateMarketSentiment(
        rows
      );


    const found = [];


    for (
      let i = 0;
      i < rows.length;
      i +=
        CFG.REQUEST_CONCURRENCY
    ) {

      const batch =
        rows.slice(
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


      for (
        const signal of
        results
      ) {

        if (signal) {
          found.push(signal);
        }

      }

    }


    found.sort(
      (a, b) =>
        b.confidence -
        a.confidence ||
        a.distance -
        b.distance
    );


    signals =
      found.slice(
        0,
        CFG.MAX_SIGNALS
      );


    stats = {

      universe:
        rows.length,

      analyzed:
        rows.length,

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
      `RADAR tamamlandı | Universe=${rows.length} | Analiz=${rows.length} | SIGNAL=${signals.length}`
    );

  } catch (error) {

    lastError =
      error.message;


    console.error(
      'RADAR ERROR:',
      error.message
    );

  } finally {

    scanRunning =
      false;

  }

}


/* =========================================================
   SIGNAL AGE
   ========================================================= */

function ageSignal(signal) {

  return Math.max(
    0,
    Math.floor(
      (
        Date.now() -
        n(
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
   WEBSOCKET
   ========================================================= */

function broadcast() {

  const payload =
    JSON.stringify({

      type:
        'snapshot',

      data: {

        signals:
          publicSignals(),

        stats,

        market:
          marketSentiment,

        lastScan,

        lastError

      }

    });


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


/* =========================================================
   STATUS API
   ========================================================= */

app.get(
  '/api/status',
  (req, res) => {

    res.json({

      success:
        true,

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

        maxCoins:
          CFG.MAX_COINS,

        scanSeconds:
          Math.round(
            CFG.SCAN_MS /
            1000
          )

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
        symbolForMarket(
          req.query.symbol
        );


      const allowedTimeframes = [

        '5m',

        '15m',

        '1h',

        '2h',

        '4h'

      ];


      const timeframe =
        allowedTimeframes.includes(
          req.query.timeframe
        )
          ? req.query.timeframe
          : '15m';


      if (!symbol) {

        return res
          .status(404)
          .json({

            success:
              false,

            error:
              'Coin bulunamadı.'

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

        success:
          true,

        symbol:
          clean(symbol),

        timeframe,

        price:
          n(
            ticker.last ||
            candles[
              candles.length - 1
            ]?.[4]
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

          success:
            false,

          error:
            error.message

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

      ok:
        true,

      lastScan,

      lastError

    });

  }
);


/* =========================================================
   WEB SOCKET CONNECTION
   ========================================================= */

wss.on(
  'connection',
  ws => {

    ws.send(
      JSON.stringify({

        type:
          'snapshot',

        data: {

          signals:
            publicSignals(),

          stats,

          market:
            marketSentiment,

          lastScan,

          lastError

        }

      })
    );

  }
);


/* =========================================================
   FRONTEND
   ========================================================= */

const HTML = String.raw`

<!doctype html>

<html lang="tr">

<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>
  Sonny AI Trader FINAL
</title>

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

  background:#070a0f;

  color:#eef3f8;

  font-family:
    Arial,
    Helvetica,
    sans-serif;

}

.app{

  height:100vh;

  display:grid;

  grid-template-columns:
    285px
    1fr;

}

.side{

  background:#0b0f16;

  border-right:
    1px solid #202936;

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

  border:
    1px solid #202b39;

  border-radius:14px;

  padding:12px;

  cursor:pointer;

}

.card:hover{

  border-color:#4776ff;

}

.card.active{

  border-color:#4776ff;

  box-shadow:
    0 0 0 1px #244a9c;

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

  border-bottom:
    1px solid #202936;

  padding:
    0 18px;

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

  grid-template-columns:
    minmax(0,1fr)
    270px;

}

.chartwrap{

  position:relative;

  min-width:0;

  min-height:0;

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

  border:
    1px solid #273241;

  border-radius:5px;

  padding:
    5px 8px;

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

  border-left:
    1px solid #202936;

  padding:12px;

  overflow:auto;

}

.box{

  background:#0f151e;

  border:
    1px solid #202b39;

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

.row{

  display:flex;

  justify-content:space-between;

  border-bottom:
    1px solid #1b2430;

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

    grid-template-columns:
      220px
      1fr;
  }

  .work{

    grid-template-columns:
      1fr;
  }

  .right{

    display:none;
  }

}

</style>

</head>


<body>

<div class="app">


<!-- =====================================================
     SOL
===================================================== -->

<aside class="side">

  <div class="brand">

    🚀 Sonny AI Trader

    <small>
      4H/2H DESTEK-DİRENÇ ·
      15M ONAY ·
      CANLI
    </small>

  </div>


  <div
    id="cards"
    class="cards"
  >

    <div class="empty">
      Sinyaller yükleniyor...
    </div>

  </div>

</aside>


<!-- =====================================================
     ANA
===================================================== -->

<main class="main">


<header class="head">

  <div>

    <div class="title">
      SİNYAL GRAFİĞİ
    </div>

    <div
      id="sub"
      class="sub"
    >
      Son tarama bekleniyor...
    </div>

  </div>


  <div class="stats">

    <span>
      EVREN
      <b id="universe">-</b>
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


<!-- =====================================================
     GRAFİK
===================================================== -->

<div class="chartwrap">

  <div class="toolbar">

    <div
      id="chartname"
      class="chartname"
    >
      Sinyal seçin
    </div>


    <div class="tf">

      <button
        data-tf="5m"
      >
        5M
      </button>

      <button
        data-tf="15m"
        class="active"
      >
        15M
      </button>

      <button
        data-tf="1h"
      >
        1H
      </button>

      <button
        data-tf="4h"
      >
        4H
      </button>

    </div>

  </div>


  <canvas
    id="chart"
  ></canvas>

</div>


<!-- =====================================================
     SAĞ
===================================================== -->

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

    <span>
      Hacim filtresi
    </span>

    <b id="volume">
      -
    </b>

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

    <span>
      ŞU AN
    </span>

    <b id="p">
      —
    </b>

  </div>


  <div class="row">

    <span>
      GİRİŞ
    </span>

    <b
      id="e"
      class="green"
    >
      —
    </b>

  </div>


  <div class="row">

    <span>
      STOP
    </span>

    <b
      id="sl"
      class="red"
    >
      —
    </b>

  </div>


  <div class="row">

    <span>
      KÂR 1
    </span>

    <b
      id="tp1"
      class="blue"
    >
      —
    </b>

  </div>


  <div class="row">

    <span>
      KÂR 2
    </span>

    <b
      id="tp2"
      class="blue"
    >
      —
    </b>

  </div>


  <div class="row">

    <span>
      KÂR 3
    </span>

    <b
      id="tp3"
      class="blue"
    >
      —
    </b>

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
   STATE
========================================================= */

var S = {

  signals: [],

  selected: null,

  tf: '15m',

  candles: []

};


/* =========================================================
   HELPERS
========================================================= */

function $(id) {

  return document.getElementById(id);

}


function sym(s) {

  return String(s || '')

    .replace('/USDT:USDT', '')

    .replace('/USDT', '')

    .replace('USDT', '')

    .toUpperCase()

    + 'USDT';

}


function num(v) {

  var x =
    Number(v);

  return Number.isFinite(x)
    ? x
    : null;

}


function price(v) {

  var x =
    num(v);

  if (x === null) {
    return '—';
  }

  if (x >= 1000) {

    return x.toLocaleString(
      'tr-TR',
      {
        maximumFractionDigits: 2
      }
    );

  }

  if (x >= 100) {
    return x.toFixed(3);
  }

  if (x >= 1) {
    return x.toFixed(5);
  }

  if (x >= 0.01) {
    return x.toFixed(6);
  }

  return x.toFixed(10);

}


function side(signal) {

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


/* =========================================================
   AGE
========================================================= */

function ageText(seconds) {

  var s =
    Math.max(
      0,
      Number(seconds) || 0
    );


  if (s < 60) {

    return (
      s +
      ' sn'
    );

  }


  return (
    Math.floor(
      s / 60
    ) +
    ' dk ' +
    (
      s % 60
    ) +
    ' sn'
  );

}


/* =========================================================
   SIGNAL LIST
========================================================= */

function render() {

  var box =
    $('cards');


  if (!S.signals.length) {

    box.innerHTML =
      '<div class="empty">' +
      'Şu an uygun sinyal yok.' +
      '</div>';

    return;

  }


  box.innerHTML =
    S.signals.map(
      function(signal, index) {

        var direction =
          side(signal);


        return (

          '<div ' +

          'class="card ' +

          (
            S.selected &&
            S.selected.id ===
              signal.id
              ? 'active'
              : ''
          ) +

          '" ' +

          'data-i="' +
          index +
          '">' +


          '<div class="top">' +

          '<span class="coin">' +

          sym(
            signal.coin ||
            signal.symbol
          ) +

          '</span>' +


          '<span class="badge ' +

          (
            direction === 'LONG'
              ? 'long'
              : 'short'
          ) +

          '">' +

          direction +

          '</span>' +

          '</div>' +


          '<div class="price">' +

          price(
            signal.livePrice
          ) +

          '</div>' +


          '<div class="meta">' +

          'Güven ' +

          (
            signal.confidence ||
            0
          ) +

          '/100 · Seviye ' +

          price(
            signal.level
          ) +

          '</div>' +


          '<div class="ready">' +

          '● GİRİŞ HAZIR · ' +

          ageText(
            signal.ageSeconds
          ) +

          '</div>' +


          '</div>'

        );

      }
    ).join('');


  Array.prototype.forEach.call(

    box.querySelectorAll(
      '.card'
    ),

    function(card) {

      card.onclick =
        function() {

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

    }

  );

}


/* =========================================================
   DETAILS
========================================================= */

function details() {

  var signal =
    S.selected;


  if (!signal) {
    return;
  }


  var direction =
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
    price(
      signal.livePrice
    );


  $('e').textContent =
    price(
      signal.giris
    );


  $('sl').textContent =
    price(
      signal.sl
    );


  $('tp1').textContent =
    price(
      signal.tp1
    );


  $('tp2').textContent =
    price(
      signal.tp2
    );


  $('tp3').textContent =
    price(
      signal.tp3
    );


  $('age').innerHTML =

    'Sinyal yaşı: <b>' +

    ageText(
      signal.ageSeconds
    ) +

    '</b><br>' +

    signal.reason +

    '<br>' +

    '15M yapı: <b>' +

    signal.structure15m +

    '</b>';


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

function market(data) {

  var el =
    $('market');


  el.textContent =
    data.label ||
    'YATAY / KARIŞIK';


  el.className =
    'market ' +

    (
      data.direction === 'LONG'
        ? 'up'
        : data.direction === 'SHORT'
          ? 'down'
          : 'flat'
    );


  $('reason').textContent =
    data.reason || '';

}


/* =========================================================
   STATUS
========================================================= */

function status(data) {

  S.signals =
    data.signals || [];


  $('count').textContent =
    S.signals.length;


  $('universe').textContent =
    (
      data.stats &&
      data.stats.universe
    ) || 0;


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

    (
      (
        data.config &&
        data.config.minVolumeUSD
      ) ||

      5000000

    ).toLocaleString(
      'en-US'
    ) +

    ' $+';


  market(
    data.market || {}
  );


  if (
    !S.selected ||
    !S.signals.some(
      function(signal) {

        return (
          signal.id ===
          S.selected.id
        );

      }
    )
  ) {

    S.selected =
      S.signals[0] ||
      null;

  }


  render();

  details();


  if (S.selected) {
    loadChart();
  }

}


/* =========================================================
   LOAD STATUS
========================================================= */

function loadStatus() {

  fetch(
    '/api/status',
    {
      cache:
        'no-store'
    }
  )

  .then(
    function(response) {

      return response.json();

    }
  )

  .then(
    status
  )

  .catch(
    function() {

      $('sub').textContent =
        'Sunucu bağlantısı bekleniyor...';

    }
  );

}


/* =========================================================
   LOAD CHART
========================================================= */

function loadChart() {

  if (!S.selected) {
    return;
  }


  var url =

    '/api/chart?symbol=' +

    encodeURIComponent(
      S.selected.coin ||
      S.selected.symbol
    ) +

    '&timeframe=' +

    S.tf +

    '&limit=160';


  fetch(
    url,
    {
      cache:
        'no-store'
    }
  )

  .then(
    function(response) {

      return response.json();

    }
  )

  .then(
    function(data) {

      if (!data.success) {

        throw new Error(
          data.error ||
          'Grafik yok'
        );

      }


      S.candles =
        data.candles ||
        [];


      draw(
        data.candles,
        data.price,
        S.selected
      );

    }
  )

  .catch(
    function() {

      emptyChart(
        'Grafik verisi alınamadı'
      );

    }
  );

}


/* =========================================================
   CANVAS SETUP
========================================================= */

function setup() {

  var canvas =
    $('chart');


  var rect =
    canvas.getBoundingClientRect();


  var dpr =
    window.devicePixelRatio ||
    1;


  canvas.width =
    Math.max(
      1,
      Math.floor(
        rect.width *
        dpr
      )
    );


  canvas.height =
    Math.max(
      1,
      Math.floor(
        rect.height *
        dpr
      )
    );


  var context =
    canvas.getContext(
      '2d'
    );


  context.setTransform(
    dpr,
    0,
    0,
    dpr,
    0,
    0
  );


  return {

    x:
      context,

    w:
      rect.width,

    h:
      rect.height

  };

}


/* =========================================================
   EMPTY CHART
========================================================= */

function emptyChart(text) {

  var area =
    setup();


  var ctx =
    area.x;


  ctx.fillStyle =
    '#070a0f';


  ctx.fillRect(
    0,
    0,
    area.w,
    area.h
  );


  ctx.fillStyle =
    '#687487';


  ctx.font =
    '12px Arial';


  ctx.fillText(
    text,
    20,
    70
  );

}


/* =========================================================
   DRAW CHART
========================================================= */

function draw(
  candles,
  current,
  signal
) {

  if (
    !candles ||
    candles.length < 2
  ) {

    emptyChart(
      'Grafik verisi yok'
    );

    return;

  }


  var area =
    setup();


  var ctx =
    area.x;


  var width =
    area.w;


  var height =
    area.h;


  var pad = {

    left:
      20,

    right:
      90,

    top:
      55,

    bottom:
      30

  };


  var chartWidth =
    width -
    pad.left -
    pad.right;


  var chartHeight =
    height -
    pad.top -
    pad.bottom;


  var values = [];


  candles.forEach(
    function(candle) {

      values.push(
        Number(
          candle.high
        )
      );

      values.push(
        Number(
          candle.low
        )
      );

    }
  );


  [

    signal.giris,

    signal.sl,

    signal.tp1,

    signal.tp2,

    signal.tp3,

    current

  ].forEach(
    function(value) {

      if (
        num(value) !==
        null
      ) {

        values.push(
          Number(value)
        );

      }

    }
  );


  var low =
    Math.min.apply(
      null,
      values
    );


  var high =
    Math.max.apply(
      null,
      values
    );


  var margin =
    (
      high -
      low
    ) * 0.08 || 1;


  low -= margin;

  high += margin;


  var range =
    high -
    low;


  function X(index) {

    return (

      pad.left +

      (
        index /
        (
          candles.length -
          1
        )
      ) *

      chartWidth

    );

  }


  function Y(value) {

    return (

      pad.top +

      (
        (
          high -
          value
        ) /
        range
      ) *

      chartHeight

    );

  }


  /* -------------------------------------------------------
     BACKGROUND
  ------------------------------------------------------- */

  ctx.fillStyle =
    '#070a0f';


  ctx.fillRect(
    0,
    0,
    width,
    height
  );


  /* -------------------------------------------------------
     GRID
  ------------------------------------------------------- */

  ctx.strokeStyle =
    '#17202b';


  ctx.lineWidth =
    1;


  for (
    var i = 0;
    i <= 6;
    i++
  ) {

    var yy =

      pad.top +

      chartHeight *
      i /
      6;


    ctx.beginPath();

    ctx.moveTo(
      pad.left,
      yy
    );

    ctx.lineTo(
      width -
      pad.right,
      yy
    );

    ctx.stroke();

  }


  for (
    var j = 0;
    j < 6;
    j++
  ) {

    var xx =

      pad.left +

      chartWidth *
      j /
      5;


    ctx.beginPath();

    ctx.moveTo(
      xx,
      pad.top
    );

    ctx.lineTo(
      xx,
      height -
      pad.bottom
    );

    ctx.stroke();

  }


  /* -------------------------------------------------------
     PRICE SCALE
  ------------------------------------------------------- */

  ctx.fillStyle =
    '#7e899a';


  ctx.font =
    '10px Arial';


  for (
    var q = 0;
    q <= 6;
    q++
  ) {

    var priceValue =
      high -
      range *
      q /
      6;


    var priceY =
      pad.top +
      chartHeight *
      q /
      6;


    ctx.fillText(
      price(
        priceValue
      ),
      width -
      pad.right +
      7,
      priceY + 3
    );

  }


  /* -------------------------------------------------------
     CANDLES
  ------------------------------------------------------- */

  var candleWidth =
    Math.max(
      2,
      Math.min(
        10,
        chartWidth /
        candles.length *
        0.65
      )
    );


  candles.forEach(
    function(candle, index) {

      var open =
        Number(
          candle.open
        );


      var close =
        Number(
          candle.close
        );


      var highValue =
        Number(
          candle.high
        );


      var lowValue =
        Number(
          candle.low
        );


      var x =
        X(index);


      var bullish =
        close >= open;


      var color =
        bullish
          ? '#18d995'
          : '#ff5364';


      ctx.strokeStyle =
        color;


      ctx.fillStyle =
        color;


      /* WICK */

      ctx.beginPath();

      ctx.moveTo(
        x,
        Y(highValue)
      );

      ctx.lineTo(
        x,
        Y(lowValue)
      );

      ctx.stroke();


      /* BODY */

      var top =
        Y(
          Math.max(
            open,
            close
          )
        );


      var bottom =
        Y(
          Math.min(
            open,
            close
          )
        );


      ctx.fillRect(

        x -
        candleWidth /
        2,

        top,

        candleWidth,

        Math.max(
          1,
          bottom -
          top
        )

      );

    }
  );


  /* -------------------------------------------------------
     LEVEL LINE
  ------------------------------------------------------- */

  function line(
    value,
    label,
    color
  ) {

    if (
      num(value) ===
      null
    ) {
      return;
    }


    var y =
      Y(
        Number(value)
      );


    ctx.strokeStyle =
      color;


    ctx.setLineDash(
      [7, 6]
    );


    ctx.beginPath();

    ctx.moveTo(
      pad.left,
      y
    );

    ctx.lineTo(
      width -
      pad.right,
      y
    );

    ctx.stroke();


    ctx.setLineDash([]);


    ctx.fillStyle =
      color;


    ctx.font =
      'bold 10px Arial';


    ctx.fillText(

      label +
      ' ' +
      price(value),

      width -
      pad.right +
      7,

      y + 3

    );

  }


  line(
    signal.giris,
    'GİRİŞ',
    '#19df98'
  );


  line(
    signal.sl,
    'STOP',
    '#ff5364'
  );


  line(
    signal.tp1,
    'TP1',
    '#409cff'
  );


  line(
    signal.tp2,
    'TP2',
    '#409cff'
  );


  line(
    signal.tp3,
    'TP3',
    '#409cff'
  );


  /* -------------------------------------------------------
     LIVE PRICE
  ------------------------------------------------------- */

  if (
    num(current) !==
    null
  ) {

    var liveY =
      Y(
        Number(current)
      );


    ctx.strokeStyle =
      '#ff6875';


    ctx.setLineDash(
      [3, 5]
    );


    ctx.beginPath();

    ctx.moveTo(
      pad.left,
      liveY
    );

    ctx.lineTo(
      width -
      pad.right,
      liveY
    );

    ctx.stroke();


    ctx.setLineDash([]);


    ctx.fillStyle =
      '#ff6875';


    ctx.font =
      'bold 10px Arial';


    ctx.fillText(

      'ŞU AN ' +
      price(current),

      width -
      pad.right +
      7,

      liveY - 7

    );

  }


  /* -------------------------------------------------------
     TITLE
  ------------------------------------------------------- */

  ctx.fillStyle =
    side(signal) === 'LONG'
      ? '#18d995'
      : '#ff5364';


  ctx.font =
    'bold 15px Arial';


  ctx.fillText(

    sym(
      signal.coin ||
      signal.symbol
    ) +

    ' · ' +

    side(signal),

    pad.left,

    30

  );

}


/* =========================================================
   TIMEFRAME BUTTONS
========================================================= */

Array.prototype.forEach.call(

  document.querySelectorAll(
    '[data-tf]'
  ),

  function(button) {

    button.onclick =
      function() {

        Array.prototype.forEach.call(

          document.querySelectorAll(
            '[data-tf]'
          ),

          function(other) {

            other.classList.remove(
              'active'
            );

          }

        );


        button.classList.add(
          'active'
        );


        S.tf =
          button.dataset.tf;


        details();

        loadChart();

      };

  }

);


/* =========================================================
   CLOCK
========================================================= */

setInterval(
  function() {

    $('clock').textContent =
      new Date()
        .toLocaleTimeString(
          'tr-TR'
        );

  },
  1000
);


/* =========================================================
   STATUS REFRESH
========================================================= */

setInterval(
  loadStatus,
  5000
);


/* =========================================================
   CHART REFRESH
========================================================= */

setInterval(
  function() {

    if (S.selected) {
      loadChart();
    }

  },
  15000
);


/* =========================================================
   RESIZE
========================================================= */

window.addEventListener(
  'resize',
  function() {

    if (S.selected) {
      loadChart();
    }

  }
);


/* =========================================================
   START
========================================================= */

loadStatus();


/* =========================================================
   WEBSOCKET
========================================================= */

try {

  var ws =
    new WebSocket(

      (
        location.protocol ===
        'https:'

          ? 'wss://'

          : 'ws://'

      ) +

      location.host

    );


  ws.onmessage =
    function(event) {

      try {

        var message =
          JSON.parse(
            event.data
          );


        if (
          message.type ===
          'snapshot'
        ) {

          status(
            message.data
          );

        }

      } catch (error) {

        console.error(
          'WebSocket mesaj hatası:',
          error
        );

      }

    };


} catch (error) {

  console.error(
    'WebSocket başlatılamadı:',
    error
  );

}

</script>

</body>

</html>

`;


/* =========================================================
   EXCHANGE
========================================================= */

exchange =
  new ccxt.bitget({

    apiKey:
      process.env.BITGET_API_KEY ||
      '',

    secret:
      process.env.BITGET_SECRET ||
      '',

    password:
      process.env.BITGET_PASSPHRASE ||
      '',

    enableRateLimit:
      true,

    timeout:
      20_000,

    options: {

      defaultType:
        'swap'

    }

  });


/* =========================================================
   ROOT
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
   SERVER START
========================================================= */

server.listen(
  PORT,
  () => {

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
      '⏱️ Tarama: ' +
      (
        CFG.SCAN_MS /
        1000
      ) +
      ' saniye'
    );

    console.log(
      '🌐 Port: ' +
      PORT
    );

    console.log(
      '================================================='
    );


    runScan();


    setInterval(
      runScan,
      CFG.SCAN_MS
    );

  }
);
