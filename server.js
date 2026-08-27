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
   SONNY AI TRADER — BREAKOUT ENGINE v3

   ANA STRATEJİ:
   4H / 2H SEVİYE
        ↓
   15M GERÇEK BREAKOUT
        ↓
   RETEST
        ↓
   15M RETEST TUTULUMU
        ↓
   GİRİŞ BÖLGESİ
        ↓
   SİNYAL

   5M = ZORUNLU DEĞİL
   5M teyidi varsa kalite bonusu verir.
   ========================================================= */

const CFG = {

  /* ALTCOINLERİ KAÇIRMAMAK İÇİN */
  MIN_VOLUME_USD: 2_000_000,

  MIN_24H_MOVE: 1.2,

  MAX_COINS: 160,

  MAX_SIGNALS: 15,

  SCAN_MS: 60_000,

  /* SEVİYE */
  LEVEL_TOLERANCE: 0.012,

  CLUSTER_TOLERANCE: 0.004,

  /* RETEST */
  RETEST_WINDOW_MIN: 90,

  RETEST_TOLERANCE: 0.0045,

  /* BREAKOUT */
  MIN_BREAKOUT_VOLUME_RATIO: 1.15,

  /* SİNYAL */
  MIN_SCORE: 70,

  /* 5M ZORUNLU DEĞİL */
  OPTIONAL_5M_BONUS: 8,

  /* FİYAT GİRİŞTEN ÇOK UZAKSA SİNYAL YOK */
  MAX_ENTRY_DISTANCE: 0.006,

  /* KIRILAN SEVİYENİN TERSİNE 15M KAPANIŞ */
  INVALIDATE_CLOSE_DISTANCE: 0.0015,

  /* STOP */
  LEVEL_BUFFER_ATR: 0.35,

  /* TP1 R:R */
  MIN_RR_TP1: 1.5,

  /* GRAFİK */
  MAX_CHART_CANDLES: 180,

  /* API */
  REQUEST_CONCURRENCY: 8,

  REQUEST_DELAY: 60,

  /* STOP OLAN AYNI SEVİYEYİ HEMEN TEKRAR DENEME */
  LEVEL_COOLDOWN_MS:
    4 * 60 * 60 * 1000

};


/* =========================================================
   STATE MACHINE
   ========================================================= */

const STATE = {

  /*
   breakout tespit edildi,
   retest bekleniyor
  */
  pendingBreakouts: new Map(),

  /*
   gerçek aktif sinyaller
  */
  activeSignals: new Map(),

  /*
   stop / başarısız breakout sonrası cooldown
  */
  cooldowns: new Map()

};


let exchange = null;

let marketRows = [];

let signals = [];

let lastScan = 0;

let scanRunning = false;

let lastError = null;

let stats = {

  universe: 0,

  analyzed: 0,

  pending: 0,

  signals: 0,

  seconds: 0

};


let marketSentiment = {

  label:
    'YATAY / KARIŞIK',

  direction:
    'NEUTRAL',

  reason:
    'Piyasa verisi bekleniyor.',

  breadthPct:
    50

};


/* =========================================================
   HELPERS
   ========================================================= */

function sleep(ms) {

  return new Promise(
    resolve => setTimeout(resolve, ms)
  );

}


function n(value, fallback = 0) {

  const x =
    Number(value);

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

    .replace(
      /[^A-Z0-9]/gi,
      ''
    )

    .toUpperCase()

    + 'USDT';

}


function symbolForMarket(symbol) {

  if (!symbol) {
    return null;
  }

  const wanted =
    clean(symbol);

  if (
    !exchange ||
    !exchange.markets
  ) {

    return (
      wanted.replace('USDT', '') +
      '/USDT:USDT'
    );

  }

  return Object.keys(
    exchange.markets
  ).find(
    key =>
      clean(key) === wanted
  ) || null;

}


function fmtPrice(value) {

  const x =
    Number(value);

  if (
    !Number.isFinite(x)
  ) {

    return null;

  }

  if (x >= 1000) {

    return Number(
      x.toFixed(2)
    );

  }

  if (x >= 100) {

    return Number(
      x.toFixed(3)
    );

  }

  if (x >= 1) {

    return Number(
      x.toFixed(5)
    );

  }

  if (x >= 0.01) {

    return Number(
      x.toFixed(6)
    );

  }

  return Number(
    x.toFixed(10)
  );

}


/* =========================================================
   ATR
   ========================================================= */

function atr(
  candles,
  period = 14
) {

  if (
    !candles ||
    candles.length <
      period + 1
  ) {

    return null;

  }

  const trs = [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {

    const high =
      n(candles[i][2]);

    const low =
      n(candles[i][3]);

    const previousClose =
      n(candles[i - 1][4]);

    const tr =
      Math.max(
        high - low,

        Math.abs(
          high -
          previousClose
        ),

        Math.abs(
          low -
          previousClose
        )
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
      (sum, value) =>
        sum + value,
      0
    ) /
    last.length;

  return (
    Number.isFinite(result) &&
    result > 0
  )
    ? result
    : null;

}


/* =========================================================
   RSI
   ========================================================= */

function rsi(
  candles,
  period = 14
) {

  if (
    !candles ||
    candles.length <
      period + 1
  ) {

    return null;

  }

  let gain = 0;

  let loss = 0;

  for (
    let i =
      candles.length - period;
    i < candles.length;
    i++
  ) {

    const change =
      n(candles[i][4]) -
      n(candles[i - 1][4]);

    if (change >= 0) {

      gain += change;

    } else {

      loss -= change;

    }

  }

  if (loss === 0) {

    return 100;

  }

  const rs =
    gain / loss;

  return (
    100 -
    (
      100 /
      (1 + rs)
    )
  );

}


/* =========================================================
   SWING HIGH / LOW
   ========================================================= */

function pivots(
  candles,
  lookback = 3
) {

  const result = [];

  for (
    let i = lookback;
    i <
      candles.length -
      lookback;
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
        high <=
          n(
            candles[i - j][2]
          ) ||

        high <=
          n(
            candles[i + j][2]
          )
      ) {

        isHigh = false;

      }

      if (
        low >=
          n(
            candles[i - j][3]
          ) ||

        low >=
          n(
            candles[i + j][3]
          )
      ) {

        isLow = false;

      }

    }

    if (isHigh) {

      result.push({

        price:
          high,

        type:
          'resistance',

        time:
          candles[i][0]

      });

    }

    if (isLow) {

      result.push({

        price:
          low,

        type:
          'support',

        time:
          candles[i][0]

      });

    }

  }

  return result;

}


/* =========================================================
   LEVEL CLUSTER
   ========================================================= */

function clusterLevels(levels) {

  const groups = [];

  const sorted =
    [...levels].sort(
      (a, b) =>
        a.price -
        b.price
    );

  for (
    const level of sorted
  ) {

    const existing =
      groups.find(
        group =>

          group.type ===
            level.type &&

          Math.abs(
            level.price -
            group.price
          ) /
            group.price <=
            CFG.CLUSTER_TOLERANCE
      );

    if (existing) {

      existing.items.push(
        level
      );

      existing.price =
        existing.items.reduce(
          (
            sum,
            item
          ) =>
            sum +
            item.price,
          0
        ) /
        existing.items.length;

    } else {

      groups.push({

        type:
          level.type,

        price:
          level.price,

        items:
          [level]

      });

    }

  }

  return groups.map(
    group => ({

      type:
        group.type,

      price:
        group.price,

      touches:
        group.items.length,

      time:
        group.items[
          group.items.length - 1
        ]?.time || 0

    })
  );

}


/* =========================================================
   15M STRUCTURE
   ========================================================= */

function structure15m(
  candles
) {

  if (
    !candles ||
    candles.length < 8
  ) {

    return 'NEUTRAL';

  }

  const c =
    candles.slice(-8);

  const highs =
    c.map(
      x => n(x[2])
    );

  const lows =
    c.map(
      x => n(x[3])
    );

  const closes =
    c.map(
      x => n(x[4])
    );

  const rising =

    highs[7] >
      highs[4] &&

    lows[7] >
      lows[4] &&

    closes[7] >
      closes[4];

  const falling =

    highs[7] <
      highs[4] &&

    lows[7] <
      lows[4] &&

    closes[7] <
      closes[4];

  if (rising) {

    return 'LONG';

  }

  if (falling) {

    return 'SHORT';

  }

  return 'NEUTRAL';

}


/* =========================================================
   VOLUME RATIO
   ========================================================= */

function volumeRatioAt(
  candles,
  index
) {

  if (
    index < 20
  ) {

    return 0;

  }

  const current =
    n(
      candles[index][5]
    );

  const average =
    candles
      .slice(
        index - 20,
        index
      )
      .reduce(
        (
          sum,
          candle
        ) =>
          sum +
          n(candle[5]),
        0
      ) /
      20;

  if (
    average <= 0
  ) {

    return 0;

  }

  return (
    current /
    average
  );

}


/* =========================================================
   CLOSED CANDLE
   ========================================================= */

function latestClosedIndex(
  candles
) {

  return Math.max(
    0,
    candles.length - 2
  );

}


/* =========================================================
   LEVEL HELPERS
   ========================================================= */

function sameLevel(
  a,
  b
) {

  return (
    Math.abs(a - b) /
      Math.max(
        Math.abs(b),
        1e-12
      ) <=
    CFG.CLUSTER_TOLERANCE
  );

}


function sideForLevel(
  type
) {

  return (
    type === 'support'
      ? 'LONG'
      : 'SHORT'
  );

}


/* =========================================================
   BREAKOUT TESPİTİ

   Önceki kapanış seviyenin diğer tarafında,
   son kapanmış 15M mum seviyenin öbür tarafında.
   ========================================================= */

function isBreakout(
  previous,
  current,
  level,
  side
) {

  const previousClose =
    n(previous[4]);

  const close =
    n(current[4]);

  const high =
    n(current[2]);

  const low =
    n(current[3]);

  const open =
    n(current[1]);

  const body =
    Math.abs(
      close - open
    );

  const range =
    Math.max(
      high - low,
      1e-12
    );

  const bodyRatio =
    body / range;

  if (
    bodyRatio < 0.35
  ) {

    return false;

  }

  if (
    side === 'LONG'
  ) {

    return (

      previousClose <=
        level &&

      close >
        level &&

      high >
        level

    );

  }

  return (

    previousClose >=
      level &&

    close <
      level &&

    low <
      level

  );

}


/* =========================================================
   BREAKOUT QUALITY
   ========================================================= */

function breakoutQuality(
  candles,
  index,
  level
) {

  const candle =
    candles[index];

  const open =
    n(candle[1]);

  const close =
    n(candle[4]);

  const high =
    n(candle[2]);

  const low =
    n(candle[3]);

  const body =
    Math.abs(
      close - open
    );

  const range =
    Math.max(
      high - low,
      1e-12
    );

  return {

    volumeRatio:
      volumeRatioAt(
        candles,
        index
      ),

    bodyRatio:
      body / range,

    closeDistance:
      Math.abs(
        close - level
      ) /
      level

  };

}


/* =========================================================
   ENTRY ZONE
   ========================================================= */

function entryZone(
  level,
  side
) {

  const center =
    level *
    (
      side === 'LONG'
        ? 1.0015
        : 0.9985
    );

  const half =
    Math.max(
      level * 0.0025,
      level * 0.0015
    );

  return {

    low:
      center - half,

    high:
      center + half

  };

}


function inEntryZone(
  price,
  zone
) {

  return (

    price >= zone.low &&

    price <= zone.high

  );

}


/* =========================================================
   INVALIDATION
   ========================================================= */

function invalidateByClose(
  lastClose,
  level,
  side
) {

  if (
    side === 'LONG'
  ) {

    return (
      lastClose <
      level *
      (
        1 -
        CFG.INVALIDATE_CLOSE_DISTANCE
      )
    );

  }

  return (
    lastClose >
    level *
    (
      1 +
      CFG.INVALIDATE_CLOSE_DISTANCE
    )
  );

}


/* =========================================================
   TP / STOP
   ========================================================= */

function findOppositeLevel(
  levels,
  side,
  price
) {

  const candidates =
    levels.filter(
      level =>

        side === 'LONG'

          ? (
              level.type ===
                'resistance' &&
              level.price >
                price
            )

          : (
              level.type ===
                'support' &&
              level.price <
                price
            )
    );

  candidates.sort(
    (a, b) =>
      Math.abs(
        a.price -
        price
      ) -
      Math.abs(
        b.price -
        price
      )
  );

  return (
    candidates[0]?.price ||
    null
  );

}


function calcPlan(
  side,
  price,
  level,
  atrValue,
  opposite
) {

  const buffer =
    Math.max(

      (
        atrValue ||
        price * 0.006
      ) *
        CFG.LEVEL_BUFFER_ATR,

      price * 0.0025

    );

  let stop;

  if (
    side === 'LONG'
  ) {

    stop =
      level -
      buffer;

  } else {

    stop =
      level +
      buffer;

  }

  const risk =
    Math.max(
      Math.abs(
        price -
        stop
      ),

      price * 0.002
    );

  let tp1;

  let tp2;

  let tp3;

  if (
    side === 'LONG'
  ) {

    tp1 =
      price +
      risk *
      CFG.MIN_RR_TP1;

    tp2 =
      price +
      risk * 2.2;

    tp3 =
      price +
      risk * 3.0;

    if (opposite) {

      tp1 =
        Math.min(
          tp1,
          opposite
        );

      tp2 =
        Math.min(
          tp2,
          opposite
        );

      tp3 =
        Math.min(
          tp3,
          opposite
        );

    }

  } else {

    tp1 =
      price -
      risk *
      CFG.MIN_RR_TP1;

    tp2 =
      price -
      risk * 2.2;

    tp3 =
      price -
      risk * 3.0;

    if (opposite) {

      tp1 =
        Math.max(
          tp1,
          opposite
        );

      tp2 =
        Math.max(
          tp2,
          opposite
        );

      tp3 =
        Math.max(
          tp3,
          opposite
        );

    }

  }

  const rr =
    Math.abs(
      tp1 - price
    ) /
    risk;

  if (
    rr <
    CFG.MIN_RR_TP1
  ) {

    return null;

  }

  if (
    side === 'LONG'
  ) {

    if (
      !(
        stop <
          price &&

        price <
          tp1 &&

        tp1 <=
          tp2 &&

        tp2 <=
          tp3
      )
    ) {

      return null;

    }

  } else {

    if (
      !(
        stop >
          price &&

        price >
          tp1 &&

        tp1 >=
          tp2 &&

        tp2 >=
          tp3
      )
    ) {

      return null;

    }

  }

  return {

    stop,

    tp1,

    tp2,

    tp3,

    risk,

    rr

  };

}


/* =========================================================
   STATE TEMİZLEME
   ========================================================= */

function cleanupState() {

  const now =
    Date.now();

  for (
    const [
      key,
      pending
    ] of
      STATE.pendingBreakouts
  ) {

    if (
      now -
      pending.createdAt >
      CFG.RETEST_WINDOW_MIN *
      60 *
      1000
    ) {

      STATE.pendingBreakouts
        .delete(key);

    }

  }

  for (
    const [
      key,
      timestamp
    ] of
      STATE.cooldowns
  ) {

    if (
      now -
      timestamp >
      CFG.LEVEL_COOLDOWN_MS
    ) {

      STATE.cooldowns
        .delete(key);

    }

  }

}


/* =========================================================
   COIN ANALYSIS
   ========================================================= */

async function analyzeSymbol(
  row
) {

  const symbol =
    row.symbol;

  const coin =
    clean(symbol);

  try {

    const [
      h4,
      h2,
      m15
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
          140
        )

      ]);

    if (
      h4.length < 45 ||
      h2.length < 45 ||
      m15.length < 35
    ) {

      return null;

    }

    const lastClosed =
      latestClosedIndex(
        m15
      );

    const lastC =
      m15[lastClosed];

    const previousC =
      m15[
        lastClosed - 1
      ];

    const live =
      n(
        row.last ||
        m15[
          m15.length - 1
        ][4]
      );

    if (!live) {

      return null;

    }


    /* =====================================================
       LEVELS
       ===================================================== */

    const levels4 =
      clusterLevels(
        pivots(
          h4,
          3
        )
      ).map(
        level => ({
          ...level,
          tf: '4H'
        })
      );


    const levels2 =
      clusterLevels(
        pivots(
          h2,
          3
        )
      ).map(
        level => ({
          ...level,
          tf: '2H'
        })
      );


    const levels =
      [
        ...levels4,
        ...levels2
      ];


    /* =====================================================
       ACTIVE SIGNAL VAR MI?
       ===================================================== */

    const active =
      STATE.activeSignals
        .get(coin);

    if (active) {

      active.livePrice =
        fmtPrice(live);

      active.ageSeconds =
        Math.floor(
          (
            Date.now() -
            active.signalAt
          ) /
          1000
        );


      const invalidated =
        invalidateByClose(

          n(lastC[4]),

          active.levelRaw,

          active.direction

        );


      const stopHit =
        active.direction ===
        'LONG'

          ? live <=
            active.stopRaw

          : live >=
            active.stopRaw;


      const tp3Hit =
        active.direction ===
        'LONG'

          ? live >=
            active.tp3Raw

          : live <=
            active.tp3Raw;


      if (
        invalidated ||
        stopHit ||
        tp3Hit
      ) {

        STATE.activeSignals
          .delete(coin);

        STATE.cooldowns.set(
          active.cooldownKey,
          Date.now()
        );

        return null;

      }

      return active;

    }


    /* =====================================================
       YENİ BREAKOUT ARA
       ===================================================== */

    for (
      const level of
        levels
    ) {

      const side =
        sideForLevel(
          level.type
        );

      const key =
        coin +
        '|' +
        level.type +
        '|' +
        level.price.toFixed(8);


      if (
        STATE.cooldowns
          .has(key)
      ) {

        continue;

      }


      if (
        isBreakout(
          previousC,
          lastC,
          level.price,
          side
        )
      ) {

        const quality =
          breakoutQuality(
            m15,
            lastClosed,
            level.price
          );


        /*
         * BREAKOUT HACMİ
         *
         * Burada retest hacmi değil,
         * breakout mumunun hacmi kullanılır.
         */

        if (
          quality.volumeRatio <
          CFG.MIN_BREAKOUT_VOLUME_RATIO
        ) {

          continue;

        }


        STATE.pendingBreakouts
          .set(

            key,

            {

              coin,

              symbol,

              level:
                level.price,

              levelType:
                level.type,

              side,

              breakoutAt:
                n(lastC[0]),

              breakoutIndex:
                lastClosed,

              createdAt:
                Date.now(),

              volumeRatio:
                quality.volumeRatio,

              bodyRatio:
                quality.bodyRatio,

              timeframeLevel:
                level.tf,

              touches:
                level.touches

            }

          );

      }

    }


    /* =====================================================
       RETEST ARA

       ÖNEMLİ:
       breakout mumundan önceki mumlar
       retest olarak sayılmaz.
       ===================================================== */

    let pending = null;

    for (
      const p of
        STATE.pendingBreakouts
          .values()
    ) {

      if (
        p.coin !==
        coin
      ) {

        continue;

      }


      const age =
        Date.now() -
        p.breakoutAt;


      if (
        age < 0 ||
        age >
          CFG.RETEST_WINDOW_MIN *
          60 *
          1000
      ) {

        continue;

      }


      const start =
        p.breakoutIndex +
        1;

      const end =
        lastClosed;


      for (
        let i = start;
        i <= end;
        i++
      ) {

        const candle =
          m15[i];

        const high =
          n(candle[2]);

        const low =
          n(candle[3]);

        const close =
          n(candle[4]);


        const touched =

          low <=
            p.level *
            (
              1 +
              CFG.RETEST_TOLERANCE
            ) &&

          high >=
            p.level *
            (
              1 -
              CFG.RETEST_TOLERANCE
            );


        const held =

          p.side ===
          'LONG'

            ? close >=
              p.level *
              (
                1 -
                CFG.RETEST_TOLERANCE
              )

            : close <=
              p.level *
              (
                1 +
                CFG.RETEST_TOLERANCE
              );


        if (
          touched &&
          held
        ) {

          pending = {

            ...p,

            retestIndex:
              i,

            retestAt:
              n(candle[0])

          };

          break;

        }

      }


      if (pending) {

        break;

      }

    }


    if (!pending) {

      return null;

    }


    /* =====================================================
       GİRİŞ BÖLGESİ
       ===================================================== */

    const zone =
      entryZone(
        pending.level,
        pending.side
      );


    /*
     * Fiyat seviyeden çok uzaksa
     * artık bu retest giriş fırsatı değildir.
     */

    if (
      Math.abs(
        live -
        pending.level
      ) /
        pending.level >
        CFG.MAX_ENTRY_DISTANCE
    ) {

      return null;

    }


    /*
     * En önemli filtre:
     * fiyat gerçekten giriş bölgesinde mi?
     */

    if (
      !inEntryZone(
        live,
        zone
      )
    ) {

      return null;

    }


    /* =====================================================
       15M + RSI
       ===================================================== */

    const structure =
      structure15m(
        m15
      );

    const currentRSI =
      rsi(
        m15
      );

    const currentATR =
      atr(
        m15,
        14
      ) ||
      live * 0.006;


    /* =====================================================
       5M

       ZORUNLU DEĞİL.

       Sadece bonus.
       ===================================================== */

    const m5 =
      await fetchOHLCV(
        symbol,
        '5m',
        50
      ).catch(
        () => []
      );


    let fiveConfirmed =
      false;

    let fiveBonus =
      0;


    if (
      m5.length >= 12
    ) {

      const i =
        latestClosedIndex(
          m5
        );

      const c =
        m5[i];

      const prev =
        m5[i - 1];


      if (
        pending.side ===
        'LONG'
      ) {

        fiveConfirmed =

          n(c[4]) >
            n(prev[4]) &&

          n(c[4]) >
            n(c[1]);

      } else {

        fiveConfirmed =

          n(c[4]) <
            n(prev[4]) &&

          n(c[4]) <
            n(c[1]);

      }


      if (
        fiveConfirmed
      ) {

        fiveBonus =
          CFG.OPTIONAL_5M_BONUS;

      }

    }


    /* =====================================================
       SCORE

       5M yok diye sinyal öldürülmez.
       ===================================================== */

    let score = 55;


    if (
      pending.timeframeLevel ===
      '4H'
    ) {

      score += 8;

    } else {

      score += 5;

    }


    if (
      pending.touches >= 4
    ) {

      score += 10;

    } else if (
      pending.touches >= 2
    ) {

      score += 6;

    }


    if (
      structure ===
      pending.side
    ) {

      score += 10;

    } else if (
      structure ===
      'NEUTRAL'
    ) {

      score += 4;

    } else {

      score -= 4;

    }


    if (
      pending.volumeRatio >=
      1.5
    ) {

      score += 7;

    } else if (
      pending.volumeRatio >=
      1.15
    ) {

      score += 4;

    }


    if (
      currentRSI !== null
    ) {

      const rsiGood =

        pending.side ===
        'LONG'

          ? (
              currentRSI >= 50 &&
              currentRSI <= 72
            )

          : (
              currentRSI >= 28 &&
              currentRSI <= 50
            );


      if (rsiGood) {

        score += 4;

      }

    }


    /*
     * 5M SADECE BONUS
     */

    score +=
      fiveBonus;


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


    /* =====================================================
       TP / STOP
       ===================================================== */

    const opposite =
      findOppositeLevel(
        levels,
        pending.side,
        live
      );


    const plan =
      calcPlan(

        pending.side,

        live,

        pending.level,

        currentATR,

        opposite

      );


    if (!plan) {

      return null;

    }


    /* =====================================================
       4H + 2H CONFLUENCE
       ===================================================== */

    const sameZone =
      levels.filter(
        level =>

          level.type ===
            pending.levelType &&

          sameLevel(
            level.price,
            pending.level
          )
      );


    const confluence =

      sameZone.some(
        level =>
          level.tf ===
          '4H'
      ) &&

      sameZone.some(
        level =>
          level.tf ===
          '2H'
      );


    /* =====================================================
       SIGNAL
       ===================================================== */

    const now =
      Date.now();


    const signal = {

      id:
        coin +
        '-' +
        now,

      coin,

      symbol:
        coin,

      ccxt_symbol:
        symbol,

      taraf:
        pending.side,

      direction:
        pending.side,

      confidence:
        score,

      livePrice:
        fmtPrice(live),

      /*
       * GERÇEK GİRİŞ:
       * Sinyal oluşturulduğu anda
       * fiyat hâlâ giriş bölgesindedir.
       */

      giris:
        fmtPrice(live),

      entryLow:
        fmtPrice(
          zone.low
        ),

      entryHigh:
        fmtPrice(
          zone.high
        ),

      sl:
        fmtPrice(
          plan.stop
        ),

      stop:
        fmtPrice(
          plan.stop
        ),

      tp1:
        fmtPrice(
          plan.tp1
        ),

      tp2:
        fmtPrice(
          plan.tp2
        ),

      tp3:
        fmtPrice(
          plan.tp3
        ),

      level:
        fmtPrice(
          pending.level
        ),

      levelRaw:
        pending.level,

      levelType:
        pending.levelType,

      timeframeLevel:
        confluence
          ? '4H + 2H'
          : pending.timeframeLevel,

      distance:
        Number(
          (
            Math.abs(
              live -
              pending.level
            ) /
            pending.level *
            100
          ).toFixed(3)
        ),

      touches:
        pending.touches,

      confluence,

      structure15m:
        structure,

      volume24h:
        n(
          row.quoteVolume
        ),

      volumeRatio:
        Number(
          pending.volumeRatio
            .toFixed(2)
        ),

      rsi:
        currentRSI === null
          ? null
          : Number(
              currentRSI.toFixed(1)
            ),

      fiveMinuteConfirmed:
        fiveConfirmed,

      signalAt:
        now,

      timestamp:
        now,

      ageSeconds:
        0,

      status:
        'ACTIVE',

      statusText:
        'GİRİŞ AKTİF',

      rr:
        Number(
          plan.rr.toFixed(2)
        ),

      reason:

        (
          confluence
            ? '4H + 2H aynı bölge'
            : pending.timeframeLevel +
              ' kırılımı'
        ) +

        ' + 15M retest' +

        (
          structure ===
          pending.side
            ? ' + 15M yönü'
            : ''
        ) +

        (
          fiveConfirmed
            ? ' + 5M teyit'
            : ''
        )

    };


    signal.stopRaw =
      plan.stop;

    signal.tp3Raw =
      plan.tp3;

    signal.cooldownKey =

      coin +
      '|' +
      pending.levelType +
      '|' +
      pending.level.toFixed(8);


    STATE.activeSignals.set(
      coin,
      signal
    );


    STATE.pendingBreakouts.delete(

      coin +
      '|' +
      pending.levelType +
      '|' +
      pending.level.toFixed(8)

    );


    return signal;

  } catch (error) {

    return null;

  }

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
   MARKET DISCOVERY
   ========================================================= */

async function discover() {

  await exchange.loadMarkets(
    true
  );


  const markets =
    Object.values(
      exchange.markets
    ).filter(

      market =>

        market &&

        market.active !==
          false &&

        market.quote ===
          'USDT' &&

        (
          market.swap ||
          market.future
        ) &&

        market.settle ===
          'USDT'

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
        await exchange
          .fetchTickers(
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
            ticker?.quoteVolume
          );


        const move =
          Math.abs(
            n(
              ticker?.percentage
            )
          );


        /*
         * ALTCOINLERİ KAÇIRMAMAK İÇİN
         *
         * Hem hacim hem hareket filtresi
         * nispeten geniş tutuluyor.
         */

        if (

          ticker?.symbol &&

          volume >=
            CFG.MIN_VOLUME_USD &&

          n(ticker.last) > 0 &&

          move >=
            CFG.MIN_24H_MOVE

        ) {

          result.push({

            symbol:
              ticker.symbol,

            last:
              n(ticker.last),

            quoteVolume:
              volume,

            percentage:
              n(
                ticker.percentage
              )

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

   SADECE BTC/ETH'E BAKMAZ.

   BREADTH:
   piyasadaki yeşil coin oranı.
   ========================================================= */

async function calculateMarketSentiment(
  rows
) {

  const average =
    rows.length

      ? rows.reduce(
          (
            sum,
            row
          ) =>
            sum +
            n(
              row.percentage
            ),
          0
        ) /
        rows.length

      : 0;


  const green =
    rows.filter(
      row =>
        n(
          row.percentage
        ) > 0
    ).length;


  const breadthPct =
    rows.length

      ? (
          green /
          rows.length
        ) *
        100

      : 50;


  const btc =
    rows.find(
      row =>
        clean(
          row.symbol
        ) ===
        'BTCUSDT'
    );


  const eth =
    rows.find(
      row =>
        clean(
          row.symbol
        ) ===
        'ETHUSDT'
    );


  const majors =
    [
      btc,
      eth
    ].filter(Boolean);


  const majorAverage =
    majors.length

      ? majors.reduce(
          (
            sum,
            row
          ) =>
            sum +
            n(
              row.percentage
            ),
          0
        ) /
        majors.length

      : average;


  /*
   * GÜÇLÜ YÜKSELİŞ
   */

  if (

    majorAverage >=
      0.7 &&

    breadthPct >=
      58

  ) {

    return {

      label:
        'YÜKSELİŞ',

      direction:
        'LONG',

      breadthPct:
        Number(
          breadthPct.toFixed(1)
        ),

      reason:

        `BTC/ETH ortalaması ` +
        `${majorAverage.toFixed(2)}% · ` +
        `${breadthPct.toFixed(0)}% coin pozitif.`

    };

  }


  /*
   * GÜÇLÜ DÜŞÜŞ
   */

  if (

    majorAverage <=
      -0.7 &&

    breadthPct <=
      42

  ) {

    return {

      label:
        'DÜŞÜŞ',

      direction:
        'SHORT',

      breadthPct:
        Number(
          breadthPct.toFixed(1)
        ),

      reason:

        `BTC/ETH ortalaması ` +
        `${majorAverage.toFixed(2)}% · ` +
        `${(
          100 -
          breadthPct
        ).toFixed(0)}% coin negatif.`

    };

  }


  /*
   * GENİŞ TABANLI YÜKSELİŞ
   */

  if (

    breadthPct >=
      62 &&

    average >
      0.5

  ) {

    return {

      label:
        'GENİŞ TABANLI YÜKSELİŞ',

      direction:
        'LONG',

      breadthPct:
        Number(
          breadthPct.toFixed(1)
        ),

      reason:

        `Piyasanın %` +
        `${breadthPct.toFixed(0)}` +
        `'ı pozitif · ` +
        `ortalama hareket ` +
        `${average.toFixed(2)}%.`

    };

  }


  /*
   * GENİŞ TABANLI DÜŞÜŞ
   */

  if (

    breadthPct <=
      38 &&

    average <
      -0.5

  ) {

    return {

      label:
        'GENİŞ TABANLI DÜŞÜŞ',

      direction:
        'SHORT',

      breadthPct:
        Number(
          breadthPct.toFixed(1)
        ),

      reason:

        `Piyasanın %` +
        `${(
          100 -
          breadthPct
        ).toFixed(0)}` +
        `'ı negatif · ` +
        `ortalama hareket ` +
        `${average.toFixed(2)}%.`

    };

  }


  return {

    label:
      'YATAY / KARIŞIK',

    direction:
      'NEUTRAL',

    breadthPct:
      Number(
        breadthPct.toFixed(1)
      ),

    reason:

      `Yön filtresi ayrışıyor · ` +
      `piyasa ortalaması ` +
      `${average.toFixed(2)}%.`

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


  cleanupState();


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


    let analyzed = 0;


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


      analyzed +=
        batch.length;


      for (
        const signal of
          results
      ) {

        if (signal) {

          found.push(
            signal
          );

        }

      }

    }


    /*
     * Aktif sinyal analyzeSymbol tarafından
     * döndürülmediyse ama state içinde hâlâ
     * aktifse koru.
     */

    for (
      const [
        coin,
        active
      ] of
        STATE.activeSignals
    ) {

      if (
        !found.some(
          signal =>
            signal.coin ===
            coin
        )
      ) {

        found.push(
          active
        );

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

      analyzed,

      pending:
        STATE.pendingBreakouts
          .size,

      signals:
        signals.length,

      seconds:
        Number(
          (
            (
              Date.now() -
              started
            ) /
            1000
          ).toFixed(1)
        )

    };


    lastScan =
      Date.now();


    lastError =
      null;


    broadcast();


    console.log(

      `RADAR tamamlandı | ` +

      `Universe=${rows.length} | ` +

      `Analiz=${analyzed} | ` +

      `Pending=${STATE.pendingBreakouts.size} | ` +

      `SIGNAL=${signals.length}`

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

function ageSignal(
  signal
) {

  return Math.max(

    0,

    Math.floor(

      (
        Date.now() -
        n(
          signal.signalAt ||
          signal.timestamp
        )
      ) /
      1000

    )

  );

}


function publicSignals() {

  return signals.map(

    signal => ({

      ...signal,

      ageSeconds:
        ageSignal(
          signal
        )

    })

  );

}


/* =========================================================
   SNAPSHOT
   ========================================================= */

function snapshot() {

  return {

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

      min24hMove:
        CFG.MIN_24H_MOVE,

      maxCoins:
        CFG.MAX_COINS,

      minScore:
        CFG.MIN_SCORE,

      retestMinutes:
        CFG.RETEST_WINDOW_MIN,

      minRR:
        CFG.MIN_RR_TP1

    }

  };

}


/* =========================================================
   WEBSOCKET
   ========================================================= */

function broadcast() {

  const payload =
    JSON.stringify({

      type:
        'snapshot',

      data:
        snapshot()

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

      ...snapshot()

    });

  }
);


/* =========================================================
   CHART API
   ========================================================= */

app.get(
  '/api/chart',
  async (
    req,
    res
  ) => {

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
        await exchange
          .fetchOHLCV(

            symbol,

            timeframe,

            undefined,

            CFG.MAX_CHART_CANDLES

          );


      const ticker =
        await exchange
          .fetchTicker(
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
  (
    req,
    res
  ) => {

    res.json({

      ok:
        true,

      lastScan,

      lastError

    });

  }
);


/* =========================================================
   WEBSOCKET CONNECTION
   ========================================================= */

wss.on(
  'connection',
  ws => {

    ws.send(

      JSON.stringify({

        type:
          'snapshot',

        data:
          snapshot()

      })

    );

  }
);


/* =========================================================
   RESPONSIVE FRONTEND
   ========================================================= */

const HTML =
String.raw`

<!doctype html>

<html lang="tr">

<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1,viewport-fit=cover"
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

  background:#070a0f;

  color:#eef3f8;

  font-family:
    Arial,
    Helvetica,
    sans-serif;

  overflow:hidden;

}

.app{

  height:100dvh;

  display:grid;

  grid-template-columns:
    285px
    minmax(0,1fr);

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

  line-height:1.4;

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

.card.active{

  border-color:#4776ff;

  box-shadow:
    0 0 0 1px #244a9c;

}

.top{

  display:flex;

  justify-content:
    space-between;

  gap:8px;

}

.coin{

  font-weight:900;

}

.badge{

  font-size:10px;

  font-weight:900;

  padding:
    4px 7px;

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

.state{

  font-size:10px;

  color:#a9b3c2;

  margin-top:5px;

}

.main{

  min-width:0;

  min-height:0;

  display:flex;

  flex-direction:column;

}

.head{

  min-height:72px;

  border-bottom:
    1px solid #202936;

  padding:
    10px 18px;

  display:flex;

  align-items:center;

  justify-content:
    space-between;

  gap:15px;

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

  white-space:nowrap;

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

  justify-content:
    space-between;

  align-items:center;

  gap:10px;

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

  border-radius:6px;

  padding:
    6px 9px;

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

  font-size:18px;

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

  justify-content:
    space-between;

  border-bottom:
    1px solid #1b2430;

  padding:8px 0;

  font-size:10px;

  gap:8px;

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


/* =========================================================
   TABLET
   ========================================================= */

@media(max-width:900px){

  html,
  body{

    overflow:auto;

  }

  .app{

    height:auto;

    min-height:100dvh;

    display:block;

  }

  .side{

    border-right:0;

    border-bottom:
      1px solid #202936;

    padding:
      10px 10px 8px;

    overflow:hidden;

  }

  .brand{

    font-size:16px;

  }

  .brand small{

    font-size:9px;

  }

  .cards{

    display:flex;

    overflow-x:auto;

    gap:8px;

    margin-top:10px;

    padding-bottom:4px;

    scroll-snap-type:x mandatory;

  }

  .card{

    flex:
      0 0 190px;

    scroll-snap-align:start;

    padding:10px;

  }

  .price{

    font-size:16px;

  }

  .main{

    min-height:
      calc(100dvh - 145px);

  }

  .head{

    min-height:62px;

    padding:
      8px 10px;

  }

  .title{

    font-size:15px;

  }

  .sub{

    font-size:9px;

  }

  .stats{

    gap:9px;

    font-size:9px;

  }

  .work{

    display:flex;

    flex-direction:column;

    min-height:0;

  }

  .chartwrap{

    height:58dvh;

    min-height:360px;

  }

  .right{

    border-left:0;

    border-top:
      1px solid #202936;

    padding:10px;

    overflow:visible;

  }

  .toolbar{

    top:9px;

    left:10px;

    right:10px;

  }

  .chartname{

    font-size:11px;

  }

  .tf button{

    padding:
      6px 8px;

  }

}


/* =========================================================
   TELEFON
   ========================================================= */

@media(max-width:520px){

  .stats span:nth-child(1){

    display:none;

  }

  .head{

    align-items:
      flex-start;

  }

  .chartwrap{

    height:52dvh;

    min-height:330px;

  }

  .toolbar{

    align-items:
      flex-start;

  }

  .chartname{

    max-width:42%;

    line-height:1.25;

  }

  .tf{

    gap:3px;

  }

  .tf button{

    padding:
      5px 6px;

    font-size:9px;

  }

  .card{

    flex-basis:178px;

  }

  .side{

    padding-bottom:6px;

  }

}

</style>

</head>

<body>

<div class="app">


<!-- =====================================================
     SOL PANEL
===================================================== -->

<aside class="side">

  <div class="brand">

    🚀 Sonny AI Trader

    <small>
      4H/2H KIRILIM ·
      15M RETEST ·
      5M BONUS ·
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
      <b id="universe">
        -
      </b>
    </span>

    <span>
      SİNYAL
      <b id="count">
        0
      </b>
    </span>

    <span>
      SON
      <b id="clock">
        --:--:--
      </b>
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
     SAĞ PANEL
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


  <div class="row">

    <span>
      24H hareket
    </span>

    <b id="move">
      -
    </b>

  </div>


  <div class="row">

    <span>
      Yeşil oranı
    </span>

    <b id="breadth">
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
   FRONTEND STATE
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

    .replace(
      '/USDT:USDT',
      ''
    )

    .replace(
      '/USDT',
      ''
    )

    .replace(
      'USDT',
      ''
    )

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
    )

  )
    .toUpperCase() ===
    'SHORT'

      ? 'SHORT'

      : 'LONG';

}


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
   SIGNAL CARDS
========================================================= */

function render() {

  var box =
    $('cards');


  if (
    !S.signals.length
  ) {

    box.innerHTML =

      '<div class="empty">' +

      'Şu an aktif sinyal yok.' +

      '</div>';

    return;

  }


  box.innerHTML =

    S.signals.map(

      function(
        signal,
        index
      ) {

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
            direction ===
            'LONG'

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

          '/100 · R:R ' +

          (
            signal.rr ||
            '—'
          ) +

          '</div>' +


          '<div class="ready">' +

          '● ' +

          (
            signal.statusText ||
            'GİRİŞ AKTİF'
          ) +

          '</div>' +


          '<div class="state">' +

          'Seviye ' +

          price(
            signal.level
          ) +

          ' · ' +

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

    'Durum: <b>' +

    String(
      signal.statusText ||
      'AKTİF'
    ) +

    '</b><br>' +

    'Sinyal yaşı: <b>' +

    ageText(
      signal.ageSeconds
    ) +

    '</b><br>' +

    'R:R: <b>' +

    String(
      signal.rr ||
      '—'
    ) +

    '</b><br>' +

    String(
      signal.reason ||
      ''
    ) +

    '<br>' +

    '15M yapı: <b>' +

    String(
      signal.structure15m ||
      'NEUTRAL'
    ) +

    '</b> · 5M: <b>' +

    (
      signal.fiveMinuteConfirmed

        ? 'TEYİT'

        : 'BONUS YOK'

    ) +

    '</b>';


  $('chartname').textContent =

    sym(
      signal.coin ||
      signal.symbol
    ) +

    ' · ' +

    S.tf.toUpperCase() +

    ' · ' +

    direction;

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
      data.direction ===
      'LONG'

        ? 'up'

        : data.direction ===
          'SHORT'

          ? 'down'

          : 'flat'

    );


  $('reason').textContent =
    data.reason ||
    '';


  $('breadth').textContent =

    (
      data.breadthPct ??
      '—'
    ) +

    '%';

}


/* =========================================================
   STATUS
========================================================= */

function status(data) {

  S.signals =
    data.signals ||
    [];


  $('count').textContent =
    S.signals.length;


  $('universe').textContent =

    (
      data.stats &&
      data.stats.universe
    ) ||

    0;


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

      2000000

    ).toLocaleString(
      'en-US'
    ) +

    ' $+';


  $('move').textContent =

    (
      (
        data.config &&
        data.config.min24hMove
      ) ||

      1.2

    ) +

    '%+';


  market(
    data.market ||
    {}
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

    S.tf;


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

   Mobilde cihaz genişliğini gerçek olarak
   ölçer ve DPR uygular.
========================================================= */

function setup() {

  var canvas =
    $('chart');


  var rect =
    canvas.getBoundingClientRect();


  var dpr =
    window.devicePixelRatio ||
    1;


  var width =
    Math.max(
      1,
      Math.floor(
        rect.width *
        dpr
      )
    );


  var height =
    Math.max(
      1,
      Math.floor(
        rect.height *
        dpr
      )
    );


  if (
    canvas.width !==
      width ||
    canvas.height !==
      height
  ) {

    canvas.width =
      width;

    canvas.height =
      height;

  }


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

function emptyChart(
  text
) {

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

    16,
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


  var mobile =
    width < 600;


  /*
   * MOBİLDE SAĞ FİYAT ETİKETLERİ İÇİN
   * DAHA AZ BOŞLUK.
   */

  var pad = {

    left:
      mobile
        ? 8
        : 20,

    right:
      mobile
        ? 64
        : 90,

    top:
      mobile
        ? 42
        : 55,

    bottom:
      24

  };


  var chartWidth =
    width -
    pad.left -
    pad.right;


  var chartHeight =
    height -
    pad.top -
    pad.bottom;


  if (
    chartWidth < 80 ||
    chartHeight < 100
  ) {

    emptyChart(
      'Grafik alanı çok küçük'
    );

    return;

  }


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
    ) *
    0.08 ||
    1;


  low -=
    margin;

  high +=
    margin;


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


  /* =====================================================
     BACKGROUND
  ===================================================== */

  ctx.fillStyle =
    '#070a0f';


  ctx.fillRect(

    0,
    0,
    width,
    height

  );


  /* =====================================================
     GRID
  ===================================================== */

  ctx.strokeStyle =
    '#17202b';


  ctx.lineWidth =
    1;


  for (
    var i = 0;
    i <= 5;
    i++
  ) {

    var yy =

      pad.top +

      chartHeight *
      i /
      5;


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


  /* =====================================================
     PRICE SCALE
  ===================================================== */

  ctx.fillStyle =
    '#7e899a';


  ctx.font =
    (
      mobile
        ? '9px'
        : '10px'
    ) +
    ' Arial';


  for (
    var q = 0;
    q <= 5;
    q++
  ) {

    var priceValue =

      high -

      range *
      q /
      5;


    var priceY =

      pad.top +

      chartHeight *
      q /
      5;


    ctx.fillText(

      price(
        priceValue
      ),

      width -
      pad.right +
      5,

      priceY + 3

    );

  }


  /* =====================================================
     CANDLES
  ===================================================== */

  var candleWidth =

    Math.max(

      2,

      Math.min(

        mobile
          ? 6
          : 10,

        chartWidth /
        candles.length *
        0.72

      )

    );


  candles.forEach(

    function(
      candle,
      index
    ) {

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
        close >=
        open;


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


  /* =====================================================
     LEVEL LINE
  ===================================================== */

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
      [6, 5]
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

      'bold ' +

      (
        mobile
          ? '8'
          : '10'
      ) +

      'px Arial';


    ctx.fillText(

      label +
      ' ' +
      price(value),

      width -
      pad.right +
      5,

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


  /* =====================================================
     LIVE PRICE
  ===================================================== */

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

      'bold ' +

      (
        mobile
          ? '8'
          : '10'
      ) +

      'px Arial';


    ctx.fillText(

      'ŞU AN ' +
      price(current),

      width -
      pad.right +
      5,

      Math.max(
        12,
        liveY - 6
      )

    );

  }


  /* =====================================================
     TITLE
  ===================================================== */

  ctx.fillStyle =

    side(signal) ===
    'LONG'

      ? '#18d995'

      : '#ff5364';


  ctx.font =

    'bold ' +

    (
      mobile
        ? '12'
        : '15'
    ) +

    'px Arial';


  ctx.fillText(

    sym(
      signal.coin ||
      signal.symbol
    ) +

    ' · ' +

    side(signal),

    pad.left,

    24

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
   RESPONSIVE RESIZE
========================================================= */

window.addEventListener(

  'resize',

  function() {

    if (
      S.selected
    ) {

      draw(

        S.candles,

        S.selected.livePrice,

        S.selected

      );

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
   BITGET
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
  (
    req,
    res
  ) => {

    res
      .type('html')
      .send(
        HTML
      );

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
      '🚀 Sonny AI Trader — BREAKOUT ENGINE v3'
    );

    console.log(
      '📡 Bitget USDT Futures'
    );

    console.log(
      '📊 4H/2H Kırılım → 15M Retest → 5M Bonus'
    );

    console.log(

      '💰 Minimum Hacim: $' +

      CFG.MIN_VOLUME_USD
        .toLocaleString()

    );

    console.log(

      '📈 Minimum 24H hareket: %' +

      CFG.MIN_24H_MOVE

    );

    console.log(

      '🛰️ Maksimum Radar: ' +

      CFG.MAX_COINS +

      ' coin'

    );

    console.log(

      '🎯 Retest: ' +

      CFG.RETEST_WINDOW_MIN +

      ' dakika'

    );

    console.log(

      '🎯 Minimum R:R (TP1): 1:' +

      CFG.MIN_RR_TP1

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
      '🤖 Otomatik emir: KAPALI'
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
