const http = require('http');
const { URL } = require('url');

/*
=========================================================
SONNY AI TRADER — FINAL
=========================================================

DATA:
Bitget USDT Futures

STRATEGY:
4H SUPPORT / RESISTANCE
+
2H SUPPORT / RESISTANCE
+
15M STRUCTURE
+
HIGH VOLUME
+
HIGH ACTIVITY

AMAÇ:
Hacimsiz / ölü / anlamsız coinleri ele.
4H ve 2H'de gerçek destek-direnç bölgelerini bul.
Bu bölgeler çakışıyorsa LONG veya SHORT kararı üret.
Giriş / Stop / TP seviyelerini göster.

NOT:
Bu sistem otomatik emir açmaz.
Sadece sinyal üretir.

=========================================================
*/

const PORT = Number(process.env.PORT || 10000);
const HOST = '0.0.0.0';

const CFG = {

  PRODUCT: 'usdt-futures',

  REFRESH_MS: 60 * 1000,

  /*
  Sinyal 20 dakika boyunca girişe dönüşmezse
  otomatik olarak geçersiz.
  */
  SIGNAL_TTL_MS: 20 * 60 * 1000,

  MAX_SIGNALS: 12,

  /*
  Hacimli coin havuzu.
  */
  MAX_UNIVERSE: 160,

  /*
  24 saatlik minimum USDT hacmi.
  25 milyon doların altında coin taranmıyor.
  */
  MIN_24H_USDT_VOLUME: 3_000_000,

  /*
  Gün içinde gerçekten hareket eden coinleri istiyoruz.
  High-low aralığı minimum %1.5.
  */
  MIN_24H_RANGE_PCT: 1.5,

  /*
  4H ATR minimum hareketlilik.
  Çok ölü coinleri eler.
  */
  MIN_4H_ATR_PCT: 0.45,

  /*
  Güncel fiyat seviyeden en fazla %1 uzakta olabilir.
  */
  LEVEL_DISTANCE_PCT: 1.00,

  /*
  4H ve 2H seviyeleri birbirine
  maksimum %0.65 yakınsa aynı bölge kabul edilir.
  */
  CONFLUENCE_PCT: 0.65,

  /*
  Giriş bölgesi.
  */
  ENTRY_ZONE_PCT: 0.35,

  /*
  Stop bölgesi için ekstra pay.
  */
  STOP_BUFFER_PCT: 0.35,

  TP1_R: 1.0,
  TP2_R: 2.0,
  TP3_R: 3.0,

  /*
  Minimum sinyal puanı.
  */
  MIN_SCORE: 72,

  /*
  Aynı anda kaç coin analiz edilecek.
  */
  BATCH: 8,

  REQUEST_TIMEOUT_MS: 10_000
};


/*
=========================================================
GLOBAL STATE
=========================================================
*/

let universe = [];

let signals = [];

let lastScan = null;

let scanning = false;

let scanError = null;


/*
=========================================================
UTILITY
=========================================================
*/

function log(message) {

  console.log(
    '[' +
    new Date().toISOString() +
    '] ' +
    message
  );

}


function sleep(ms) {

  return new Promise(
    resolve => setTimeout(resolve, ms)
  );

}


function num(value, fallback = 0) {

  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;

}


function clamp(value, min, max) {

  return Math.max(
    min,
    Math.min(max, value)
  );

}


function pct(value, base) {

  if (!base) {
    return 0;
  }

  return (
    value /
    base
  ) * 100;

}


function distancePct(a, b) {

  if (!b) {
    return 999;
  }

  return (
    Math.abs(a - b) /
    b
  ) * 100;

}


function esc(value) {

  return String(
    value == null
      ? ''
      : value
  )
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

}


function fmt(value) {

  const n = num(value);

  if (!n) {
    return '0';
  }

  if (n >= 1000) {

    return n.toLocaleString(
      'en-US',
      {
        maximumFractionDigits: 2
      }
    );

  }

  if (n >= 1) {

    return n.toLocaleString(
      'en-US',
      {
        maximumFractionDigits: 4
      }
    );

  }

  return n.toLocaleString(
    'en-US',
    {
      maximumSignificantDigits: 6
    }
  );

}


function age(ms) {

  const seconds =
    Math.max(
      0,
      Math.floor(ms / 1000)
    );

  if (seconds < 60) {

    return seconds + 's';

  }

  const minutes =
    Math.floor(
      seconds / 60
    );

  if (minutes < 60) {

    return minutes + 'dk';

  }

  return (
    Math.floor(minutes / 60) +
    'sa ' +
    (minutes % 60) +
    'dk'
  );

}


function normalizeSymbol(symbol) {

  return String(
    symbol || ''
  ).toUpperCase();

}


/*
=========================================================
BITGET PUBLIC API
=========================================================
*/

async function fetchJson(
  path,
  params = {}
) {

  const url =
    new URL(
      'https://api.bitget.com' +
      path
    );

  for (
    const [key, value]
    of Object.entries(params)
  ) {

    url.searchParams.set(
      key,
      String(value)
    );

  }

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      CFG.REQUEST_TIMEOUT_MS
    );

  try {

    const response =
      await fetch(
        url,
        {
          signal:
            controller.signal,

          headers: {
            accept:
              'application/json'
          }
        }
      );

    if (!response.ok) {

      throw new Error(
        'Bitget HTTP ' +
        response.status
      );

    }

    const json =
      await response.json();

    if (
      json.code !==
      '00000'
    ) {

      throw new Error(
        json.msg ||
        'Bitget API error'
      );

    }

    return json.data;

  } finally {

    clearTimeout(timeout);

  }

}


/*
=========================================================
CANDLE NORMALIZATION
=========================================================
*/

function candleRows(raw) {

  if (
    !Array.isArray(raw)
  ) {

    return [];

  }

  return raw
    .map(
      row => ({

        t:
          num(row[0]),

        o:
          num(row[1]),

        h:
          num(row[2]),

        l:
          num(row[3]),

        c:
          num(row[4]),

        v:
          num(row[5]),

        q:
          num(row[6])

      })
    )
    .filter(
      candle =>
        candle.t &&
        candle.c > 0
    )
    .sort(
      (a, b) =>
        a.t - b.t
    );

}


async function candles(
  symbol,
  granularity,
  limit = 100
) {

  const raw =
    await fetchJson(
      '/api/v2/mix/market/candles',
      {

        symbol,

        granularity,

        limit,

        productType:
          CFG.PRODUCT

      }
    );

  return candleRows(raw);

}


/*
=========================================================
ATR
=========================================================
*/

function atrPercent(
  candlesData,
  period = 14
) {

  if (
    candlesData.length <
    period + 2
  ) {

    return 0;

  }

  const trueRanges = [];

  for (
    let i = 1;
    i < candlesData.length;
    i++
  ) {

    const current =
      candlesData[i];

    const previous =
      candlesData[i - 1];

    const tr =
      Math.max(

        current.h -
        current.l,

        Math.abs(
          current.h -
          previous.c
        ),

        Math.abs(
          current.l -
          previous.c
        )

      );

    trueRanges.push(tr);

  }

  const recent =
    trueRanges.slice(
      -period
    );

  const average =
    recent.reduce(
      (sum, value) =>
        sum + value,
      0
    ) /
    recent.length;

  const price =
    candlesData[
      candlesData.length - 1
    ].c;

  return pct(
    average,
    price
  );

}


/*
=========================================================
PIVOTLAR
=========================================================
*/

function pivots(
  candlesData,
  type,
  left = 2,
  right = 2
) {

  const result = [];

  for (
    let i = left;
    i <
    candlesData.length - right;
    i++
  ) {

    let valid = true;

    /*
    DESTEK
    */
    if (
      type ===
      'support'
    ) {

      for (
        let j = 1;
        j <= left;
        j++
      ) {

        if (
          candlesData[i].l >=
          candlesData[i - j].l
        ) {

          valid = false;

        }

      }

      for (
        let j = 1;
        j <= right;
        j++
      ) {

        if (
          candlesData[i].l >
          candlesData[i + j].l
        ) {

          valid = false;

        }

      }

    }


    /*
    DİRENÇ
    */
    if (
      type ===
      'resistance'
    ) {

      for (
        let j = 1;
        j <= left;
        j++
      ) {

        if (
          candlesData[i].h <=
          candlesData[i - j].h
        ) {

          valid = false;

        }

      }

      for (
        let j = 1;
        j <= right;
        j++
      ) {

        if (
          candlesData[i].h <
          candlesData[i + j].h
        ) {

          valid = false;

        }

      }

    }


    if (valid) {

      result.push({

        price:
          type === 'support'
            ? candlesData[i].l
            : candlesData[i].h,

        t:
          candlesData[i].t

      });

    }

  }

  return result;

}


/*
=========================================================
SEVİYE BİRLEŞTİRME
=========================================================
*/

function clusterLevels(
  points,
  mergePct = 0.35
) {

  const sorted =
    points
      .slice()
      .sort(
        (a, b) =>
          a.price -
          b.price
      );

  const groups = [];

  for (
    const point
    of sorted
  ) {

    const last =
      groups[
        groups.length - 1
      ];

    if (
      !last ||
      distancePct(
        point.price,
        last.price
      ) >
      mergePct
    ) {

      groups.push({

        price:
          point.price,

        touches:
          1,

        lastTouch:
          point.t

      });

    } else {

      last.price =
        (
          last.price *
          last.touches +
          point.price
        ) /
        (
          last.touches +
          1
        );

      last.touches++;

      last.lastTouch =
        Math.max(
          last.lastTouch,
          point.t
        );

    }

  }

  return groups;

}


/*
=========================================================
EN YAKIN DESTEK / DİRENÇ
=========================================================
*/

function nearestLevel(
  levels,
  price,
  side
) {

  const candidates =
    levels.filter(
      level => {

        if (
          side ===
          'support'
        ) {

          return (
            level.price <=
            price *
            (
              1 +
              CFG.LEVEL_DISTANCE_PCT /
              100
            )
          );

        }

        return (
          level.price >=
          price *
          (
            1 -
            CFG.LEVEL_DISTANCE_PCT /
            100
          )
        );

      }
    );

  candidates.sort(
    (a, b) =>
      Math.abs(
        a.price - price
      ) -
      Math.abs(
        b.price - price
      )
  );

  return (
    candidates[0] ||
    null
  );

}


/*
=========================================================
15M YAPI

Burada RSI/ADX/Bollinger gibi
10 tane indikatör kullanmıyoruz.

Sadece fiyat yapısına bakıyoruz.
=========================================================
*/

function structure15(
  candlesData
) {

  if (
    candlesData.length <
    12
  ) {

    return 'NEUTRAL';

  }

  const recent =
    candlesData.slice(
      -10
    );

  const current =
    recent[
      recent.length - 1
    ];

  const old =
    recent[0];

  const recentHighs =
    recent
      .slice(-5)
      .map(
        x => x.h
      );

  const recentLows =
    recent
      .slice(-5)
      .map(
        x => x.l
      );

  const previousHigh =
    Math.max(
      ...recent
        .slice(0, 5)
        .map(
          x => x.h
        )
    );

  const previousLow =
    Math.min(
      ...recent
        .slice(0, 5)
        .map(
          x => x.l
        )
    );

  const bullish =
    current.c >
      old.c &&

    Math.max(
      ...recentHighs
    ) >=
      previousHigh &&

    Math.min(
      ...recentLows
    ) >=
      previousLow *
      0.998;


  const bearish =
    current.c <
      old.c &&

    Math.min(
      ...recentLows
    ) <=
      previousLow &&

    Math.max(
      ...recentHighs
    ) <=
      previousHigh *
      1.002;


  if (
    bullish &&
    !bearish
  ) {

    return 'LONG';

  }


  if (
    bearish &&
    !bullish
  ) {

    return 'SHORT';

  }


  return 'NEUTRAL';

}


/*
=========================================================
TRADE PLAN
=========================================================
*/

function makePlan(
  symbol,
  price,
  direction,
  level,
  touches,
  h4Atr,
  volume,
  change24h,
  range24h,
  structure
) {

  const zone =
    CFG.ENTRY_ZONE_PCT /
    100;

  let entryLow;

  let entryHigh;

  let stop;


  /*
  LONG
  */

  if (
    direction ===
    'LONG'
  ) {

    entryLow =
      level.price *
      (1 - zone);

    entryHigh =
      level.price *
      (1 + zone);

    stop =
      level.price *
      (
        1 -
        (
          CFG.ENTRY_ZONE_PCT +
          CFG.STOP_BUFFER_PCT
        ) /
        100
      );

  }


  /*
  SHORT
  */

  else {

    entryLow =
      level.price *
      (1 - zone);

    entryHigh =
      level.price *
      (1 + zone);

    stop =
      level.price *
      (
        1 +
        (
          CFG.ENTRY_ZONE_PCT +
          CFG.STOP_BUFFER_PCT
        ) /
        100
      );

  }


  const entry =
    clamp(
      price,
      entryLow,
      entryHigh
    );


  const risk =
    Math.abs(
      stop -
      entry
    );


  if (
    !risk ||
    !Number.isFinite(risk)
  ) {

    return null;

  }


  const tp1 =
    direction === 'LONG'

      ? entry +
        risk *
        CFG.TP1_R

      : entry -
        risk *
        CFG.TP1_R;


  const tp2 =
    direction === 'LONG'

      ? entry +
        risk *
        CFG.TP2_R

      : entry -
        risk *
        CFG.TP2_R;


  const tp3 =
    direction === 'LONG'

      ? entry +
        risk *
        CFG.TP3_R

      : entry -
        risk *
        CFG.TP3_R;


  const createdAt =
    Date.now();


  return {

    symbol,

    direction,

    price,

    level:
      level.price,

    touches,

    entryLow,

    entryHigh,

    entry,

    stop,

    tp1,

    tp2,

    tp3,

    h4Atr,

    vol:
      volume,

    change24h,

    range24h,

    structure,

    createdAt,

    updatedAt:
      createdAt,

    expiresAt:
      createdAt +
      CFG.SIGNAL_TTL_MS,

    status:
      price >= entryLow &&
      price <= entryHigh

        ? 'GİRİŞ HAZIR'

        : 'BEKLE',

    score:
      0

  };

}


/*
=========================================================
SİNYAL SKORU

100 = çok güçlü bölge

Skor yön kararı için kullanılıyor.
İndikatör kalabalığı yok.
=========================================================
*/

function scoreSignal(
  signal,
  confluenceDistance
) {

  let score = 0;


  /*
  4H + 2H bölgesi
  */

  score += 40;


  /*
  Seviyeler ne kadar iyi çakışıyor?
  */

  if (
    confluenceDistance <=
    0.25
  ) {

    score += 25;

  }

  else if (
    confluenceDistance <=
    0.45
  ) {

    score += 18;

  }

  else {

    score += 10;

  }


  /*
  Temas sayısı
  */

  if (
    signal.touches >=
    5
  ) {

    score += 15;

  }

  else if (
    signal.touches >=
    3
  ) {

    score += 10;

  }

  else {

    score += 5;

  }


  /*
  4H hareketlilik
  */

  if (
    signal.h4Atr >=
    1.0
  ) {

    score += 10;

  }

  else if (
    signal.h4Atr >=
    0.65
  ) {

    score += 7;

  }

  else {

    score += 4;

  }


  /*
  24H hareket
  */

  if (
    Math.abs(
      signal.change24h
    ) >=
    3
  ) {

    score += 10;

  }

  else if (
    Math.abs(
      signal.change24h
    ) >=
    1.5
  ) {

    score += 7;

  }

  else {

    score += 4;

  }


  /*
  15M yapı da aynı yöndeyse bonus.
  */

  if (

    (
      signal.direction ===
      'LONG' &&

      signal.structure ===
      'LONG'
    )

    ||

    (
      signal.direction ===
      'SHORT' &&

      signal.structure ===
      'SHORT'
    )

  ) {

    score += 10;

  }


  return clamp(
    score,
    0,
    100
  );

}


/*
=========================================================
COIN ANALİZİ
=========================================================
*/

async function analyze(
  market
) {

  try {

    const [

      candles4H,

      candles2H,

      candles15M

    ] =

      await Promise.all([

        candles(
          market.symbol,
          '4H',
          100
        ),

        candles(
          market.symbol,
          '2H',
          100
        ),

        candles(
          market.symbol,
          '15m',
          80
        )

      ]);


    if (
      candles4H.length <
      40 ||

      candles2H.length <
      40 ||

      candles15M.length <
      30
    ) {

      return null;

    }


    /*
    Son mum henüz kapanmamış olabilir.
    Bu yüzden analizde son mumu kullanmıyoruz.
    */

    const closed4H =
      candles4H.slice(
        0,
        -1
      );

    const closed2H =
      candles2H.slice(
        0,
        -1
      );

    const closed15M =
      candles15M.slice(
        0,
        -1
      );


    const price =
      market.price;


    /*
    4H hareketlilik filtresi
    */

    const h4Atr =
      atrPercent(
        closed4H
      );


    if (
      h4Atr <
      CFG.MIN_4H_ATR_PCT
    ) {

      return null;

    }


    /*
    4H seviyeleri
    */

    const supports4H =
      clusterLevels(
        pivots(
          closed4H,
          'support'
        )
      );


    const resistances4H =
      clusterLevels(
        pivots(
          closed4H,
          'resistance'
        )
      );


    /*
    2H seviyeleri
    */

    const supports2H =
      clusterLevels(
        pivots(
          closed2H,
          'support'
        )
      );


    const resistances2H =
      clusterLevels(
        pivots(
          closed2H,
          'resistance'
        )
      );


    /*
    Güncel fiyata en yakın seviyeler
    */

    const support4H =
      nearestLevel(
        supports4H,
        price,
        'support'
      );


    const resistance4H =
      nearestLevel(
        resistances4H,
        price,
        'resistance'
      );


    const support2H =
      nearestLevel(
        supports2H,
        price,
        'support'
      );


    const resistance2H =
      nearestLevel(
        resistances2H,
        price,
        'resistance'
      );


    /*
    15M fiyat yapısı
    */

    const structure =
      structure15(
        closed15M
      );


    const candidates = [];


    /*
    =====================================================
    LONG
    =====================================================
    */

    if (
      support4H &&
      support2H
    ) {

      const confluence =
        distancePct(
          support4H.price,
          support2H.price
        );


      if (
        confluence <=
        CFG.CONFLUENCE_PCT
      ) {

        const level = {

          price:
            (
              support4H.price +
              support2H.price
            ) / 2,

          touches:
            support4H.touches +
            support2H.touches

        };


        const distance =
          distancePct(
            price,
            level.price
          );


        /*
        Fiyat desteğe gerçekten yakın mı?
        */

        if (
          distance <=
          CFG.LEVEL_DISTANCE_PCT
        ) {


          /*
          15M ters yöndeyse LONG yok.
          Neutral olabilir.
          */

          if (
            structure ===
            'LONG' ||

            structure ===
            'NEUTRAL'
          ) {

            const plan =
              makePlan(

                market.symbol,

                price,

                'LONG',

                level,

                level.touches,

                h4Atr,

                market.usdtVolume,

                market.change24h,

                market.range24h,

                structure

              );


            if (plan) {

              plan.score =
                scoreSignal(
                  plan,
                  confluence
                );


              candidates.push(
                plan
              );

            }

          }

        }

      }

    }


    /*
    =====================================================
    SHORT
    =====================================================
    */

    if (
      resistance4H &&
      resistance2H
    ) {

      const confluence =
        distancePct(
          resistance4H.price,
          resistance2H.price
        );


      if (
        confluence <=
        CFG.CONFLUENCE_PCT
      ) {

        const level = {

          price:
            (
              resistance4H.price +
              resistance2H.price
            ) / 2,

          touches:
            resistance4H.touches +
            resistance2H.touches

        };


        const distance =
          distancePct(
            price,
            level.price
          );


        if (
          distance <=
          CFG.LEVEL_DISTANCE_PCT
        ) {

          /*
          15M LONG ise SHORT yok.
          */

          if (
            structure ===
            'SHORT' ||

            structure ===
            'NEUTRAL'
          ) {

            const plan =
              makePlan(

                market.symbol,

                price,

                'SHORT',

                level,

                level.touches,

                h4Atr,

                market.usdtVolume,

                market.change24h,

                market.range24h,

                structure

              );


            if (plan) {

              plan.score =
                scoreSignal(
                  plan,
                  confluence
                );


              candidates.push(
                plan
              );

            }

          }

        }

      }

    }


    candidates.sort(
      (a, b) =>
        b.score -
        a.score
    );


    const best =
      candidates[0];


    if (
      !best ||
      best.score <
      CFG.MIN_SCORE
    ) {

      return null;

    }


    if (
      best.direction ===
      'LONG'
    ) {

      best.reason =
        '4H + 2H destek aynı bölgede';

    }

    else {

      best.reason =
        '4H + 2H direnç aynı bölgede';

    }


    /*
    TradingView Binance grafik adresi.
    */

    best.binanceUrl =
      'https://www.tradingview.com/symbols/' +
      encodeURIComponent(
        best.symbol
      ) +
      '/?exchange=BINANCE';


    return best;

  }

  catch (error) {

    log(
      'Analiz hatası ' +
      market.symbol +
      ': ' +
      error.message
    );

    return null;

  }

}


/*
=========================================================
MARKET DISCOVERY
=========================================================
*/

async function discover() {

  const [

    tickers,

    contracts

  ] =

    await Promise.all([

      fetchJson(
        '/api/v2/mix/market/tickers',
        {
          productType:
            CFG.PRODUCT
        }
      ),

      fetchJson(
        '/api/v2/mix/market/contracts',
        {
          productType:
            CFG.PRODUCT
        }
      )

    ]);


  const contractMap =
    new Map(

      (
        Array.isArray(
          contracts
        )
          ? contracts
          : []
      )
      .map(
        contract =>
          [
            contract.symbol,
            contract
          ]
      )

    );


  const rows = [];


  for (
    const ticker
    of (
      Array.isArray(
        tickers
      )
        ? tickers
        : []
    )
  ) {

    const contract =
      contractMap.get(
        ticker.symbol
      );


    /*
    SADECE:

    USDT

    PERPETUAL

    NORMAL

    */

    if (
      !contract ||

      contract.symbolType !==
      'perpetual' ||

      contract.symbolStatus !==
      'normal' ||

      contract.quoteCoin !==
      'USDT'
    ) {

      continue;

    }


    const volume =
      num(
        ticker.usdtVolume
      );


    const price =
      num(
        ticker.lastPr
      );


    const high24 =
      num(
        ticker.high24h
      );


    const low24 =
      num(
        ticker.low24h
      );


    if (
      !price ||
      !volume ||
      !high24 ||
      !low24
    ) {

      continue;

    }


    /*
    24H fiyat hareket alanı
    */

    const range =
      pct(
        high24 -
        low24,

        price
      );


    /*
    HACİMSİZLERİ AT
    */

    if (
      volume <
      CFG.MIN_24H_USDT_VOLUME
    ) {

      continue;

    }


    /*
    HAREKETSİZLERİ AT
    */

    if (
      range <
      CFG.MIN_24H_RANGE_PCT
    ) {

      continue;

    }


    rows.push({

      symbol:
        normalizeSymbol(
          ticker.symbol
        ),

      price,

      usdtVolume:
        volume,

      change24h:
        num(
          ticker.change24h
        ) * 100,

      range24h:
        range

    });

  }


  /*
  En yüksek hacimlileri önce al.
  */

  rows.sort(
    (a, b) =>
      b.usdtVolume -
      a.usdtVolume
  );


  universe =
    rows.slice(
      0,
      CFG.MAX_UNIVERSE
    );


  log(
    'Discovery tamamlandı | ' +
    'Hacimli+hareketli evren=' +
    universe.length +
    ' | Min hacim=$' +
    (
      CFG.MIN_24H_USDT_VOLUME /
      1000000
    ).toFixed(0) +
    'M'
  );

}


/*
=========================================================
RADAR
=========================================================
*/

async function runRadar() {

  if (
    scanning
  ) {

    return;

  }


  scanning =
    true;

  scanError =
    null;


  try {

    await discover();


    log(
      'RADAR başladı | Universe=' +
      universe.length +
      ' | DeepAnalysis=' +
      universe.length
    );


    const found =
      [];


    for (
      let i = 0;
      i < universe.length;
      i += CFG.BATCH
    ) {

      const batch =
        universe.slice(
          i,
          i + CFG.BATCH
        );


      const results =
        await Promise.all(
          batch.map(
            analyze
          )
        );


      for (
        const result
        of results
      ) {

        if (
          result
        ) {

          found.push(
            result
          );

        }

      }


      await sleep(
        120
      );

    }


    /*
    En güçlüler önce.
    */

    found.sort(
      (a, b) =>
        b.score -
        a.score
    );


    /*
    Yeni sinyaller.
    */

    for (
      const signal
      of found
    ) {

      const existing =
        signals.find(
          item =>
            item.symbol ===
              signal.symbol &&

            item.direction ===
              signal.direction
        );


      if (
        existing
      ) {

        /*
        Aynı sinyalin yaşı sıfırlanmaz.

        Böylece:
        "bu sinyal ne zaman geldi?"
        bilgisi korunur.
        */

        existing.price =
          signal.price;

        existing.updatedAt =
          Date.now();

        existing.status =

          signal.price >=
            existing.entryLow &&

          signal.price <=
            existing.entryHigh

            ? 'GİRİŞ HAZIR'

            : 'BEKLE';


        /*
        Yeni plan eskisinden daha güçlü
        ise seviyeleri güncelle.

        Ama createdAt korunur.
        */

        if (
          signal.score >
          existing.score
        ) {

          const created =
            existing.createdAt;

          const expires =
            existing.expiresAt;

          Object.assign(
            existing,
            signal
          );

          existing.createdAt =
            created;

          existing.expiresAt =
            expires;

        }


        continue;

      }


      signal.createdAt =
        Date.now();

      signal.expiresAt =
        Date.now() +
        CFG.SIGNAL_TTL_MS;

      signal.status =

        signal.price >=
          signal.entryLow &&

        signal.price <=
          signal.entryHigh

          ? 'GİRİŞ HAZIR'

          : 'BEKLE';


      signals.push(
        signal
      );


      log(
        'YENİ SİNYAL | ' +
        signal.symbol +
        ' | ' +
        signal.direction +
        ' | ' +
        signal.score +
        '/100'
      );

    }


    /*
    Süresi dolanları temizle.
    */

    const now =
      Date.now();


    signals =
      signals.filter(
        signal => {

          if (
            signal.expiresAt >
            now
          ) {

            return true;

          }


          /*
          İşleme girilmiş gibi
          işaretlenmiş bir sinyali
          burada silmiyoruz.
          */

          if (
            signal.status ===
            'İŞLEMDE'
          ) {

            return true;

          }


          log(
            'SİNYAL SÜRESİ DOLDU | ' +
            signal.symbol +
            ' | ' +
            signal.direction
          );


          return false;

        }
      );


    /*
    En güçlü 12.
    */

    signals.sort(
      (a, b) =>
        b.score -
        a.score
    );


    signals =
      signals.slice(
        0,
        CFG.MAX_SIGNALS
      );


    lastScan =
      new Date().toISOString();


    log(
      'RADAR tamamlandı | ' +
      'Universe=' +
      universe.length +
      ' | Analiz=' +
      universe.length +
      ' | SIGNAL=' +
      signals.length
    );

  }

  catch (error) {

    scanError =
      error.message;

    log(
      'RADAR ERROR: ' +
      error.message
    );

  }

  finally {

    scanning =
      false;

  }

}


/*
=========================================================
CANLI FİYAT
=========================================================
*/

function updatePricesFromTickers(
  tickers
) {

  const prices =
    new Map();


  for (
    const ticker
    of (
      Array.isArray(
        tickers
      )
        ? tickers
        : []
    )
  ) {

    prices.set(

      ticker.symbol,

      num(
        ticker.lastPr
      )

    );

  }


  for (
    const signal
    of signals
  ) {

    const price =
      prices.get(
        signal.symbol
      );


    if (
      !price
    ) {

      continue;

    }


    signal.price =
      price;


    /*
    Henüz giriş olmadıysa
    giriş durumu değişir.
    */

    if (
      signal.status !==
      'İŞLEMDE'
    ) {


      if (
        price >=
          signal.entryLow &&

        price <=
          signal.entryHigh
      ) {

        signal.status =
          'GİRİŞ HAZIR';

      }


      else if (

        (
          signal.direction ===
          'LONG' &&

          price <
          signal.stop
        )

        ||

        (
          signal.direction ===
          'SHORT' &&

          price >
          signal.stop
        )

      ) {

        signal.status =
          'STOP';

      }


      else if (

        (
          signal.direction ===
          'LONG' &&

          price >=
          signal.tp1
        )

        ||

        (
          signal.direction ===
          'SHORT' &&

          price <=
          signal.tp1
        )

      ) {

        signal.status =
          'TP1';

      }

    }

  }

}


async function liveUpdate() {

  try {

    const tickers =
      await fetchJson(
        '/api/v2/mix/market/tickers',
        {
          productType:
            CFG.PRODUCT
        }
      );


    updatePricesFromTickers(
      tickers
    );

  }

  catch (error) {

    log(
      'Canlı fiyat hatası: ' +
      error.message
    );

  }

}


/*
=========================================================
API RESPONSE
=========================================================
*/

function snapshot() {

  const now =
    Date.now();


  return {

    ok:
      true,

    system:
      'Sonny AI Trader FINAL',

    timestamp:
      new Date().toISOString(),

    lastScan,

    scanning,

    error:
      scanError,

    stats: {

      universe:
        universe.length,

      analyzed:
        universe.length,

      signals:
        signals.length

    },

    signals:

      signals.map(
        signal => ({

          ...signal,

          ageMs:
            now -
            signal.createdAt,

          validForMs:
            Math.max(
              0,
              signal.expiresAt -
              now
            )

        })
      ),

    config: {

      minVolume:
        CFG.MIN_24H_USDT_VOLUME,

      minRange:
        CFG.MIN_24H_RANGE_PCT,

      minAtr4h:
        CFG.MIN_4H_ATR_PCT

    }

  };

}


/*
=========================================================
WEB UI

ÖNEMLİ:
HTML içinde iç içe backtick YOK.

Bu nedenle daha önceki:

Unexpected token 'class'

hatasını üretmez.
=========================================================
*/

function html() {

  return String.raw`<!doctype html>

<html lang="tr">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>Sonny AI Trader FINAL</title>

<style>

*{
  box-sizing:border-box;
}

body{

  margin:0;

  background:#070a0f;

  color:#eef2f7;

  font-family:
    Arial,
    sans-serif;

  height:100vh;

  overflow:hidden;

}


.app{

  height:100vh;

  display:grid;

  grid-template-columns:
    310px
    1fr;

  background:#070a0f;

}


.side{

  border-right:
    1px solid
    #202733;

  overflow:auto;

  padding:16px;

}


.main{

  position:relative;

  display:flex;

  flex-direction:column;

  min-width:0;

}


.brand{

  font-size:19px;

  font-weight:900;

  margin-bottom:3px;

}


.sub{

  color:#7f8a9b;

  font-size:11px;

  margin-bottom:14px;

}


.top{

  height:58px;

  border-bottom:
    1px solid
    #202733;

  display:flex;

  align-items:center;

  justify-content:space-between;

  padding:
    0 18px;

}


.stats{

  display:flex;

  gap:18px;

  color:#8792a4;

  font-size:11px;

}


.stats b{

  color:#fff;

  font-size:13px;

}


.signals{

  display:flex;

  flex-direction:column;

  gap:9px;

}


.card{

  border:
    1px solid
    #202733;

  background:#0d121a;

  border-radius:12px;

  padding:12px;

  cursor:pointer;

}


.card.active{

  border-color:#4d78ff;

  box-shadow:
    0 0 0 1px
    #4d78ff22;

}


.row{

  display:flex;

  align-items:center;

  justify-content:space-between;

}


.sym{

  font-weight:900;

  font-size:15px;

}


.badge{

  font-size:10px;

  font-weight:900;

  padding:
    4px 7px;

  border-radius:6px;

}


.long{

  color:#22d68a;

  background:#0d3023;

}


.short{

  color:#ff5d6c;

  background:#35131a;

}


.price{

  font-size:18px;

  font-weight:900;

  margin-top:8px;

}


.meta{

  font-size:10px;

  color:#7f8a9b;

  margin-top:5px;

}


.ready{

  color:#20d889;

  font-weight:900;

}


.wait{

  color:#f5c451;

  font-weight:900;

}


.chartTitle{

  font-size:18px;

  font-weight:900;

}


.chartSub{

  font-size:11px;

  color:#7f8a9b;

  margin-top:3px;

}


.chart{

  flex:1;

  position:relative;

  min-height:0;

}


.canvas{

  width:100%;

  height:100%;

  display:block;

}


.plan{

  position:absolute;

  right:18px;

  top:18px;

  width:230px;

  background:#0b1018ee;

  border:
    1px solid
    #2a3341;

  border-radius:12px;

  padding:13px;

  backdrop-filter:
    blur(7px);

}


.plan h2{

  margin:
    0 0 5px;

  font-size:17px;

}


.dir{

  font-size:23px;

  font-weight:900;

  margin-bottom:10px;

}


.line{

  display:flex;

  justify-content:space-between;

  padding:7px 0;

  border-bottom:
    1px solid
    #202733;

  font-size:11px;

}


.line b{

  font-size:12px;

}


.entry{

  color:#20d889;

}


.stop{

  color:#ff5d6c;

}


.tp{

  color:#58a6ff;

}


.agebox{

  margin-top:10px;

  padding:9px;

  background:#111925;

  border-radius:8px;

  font-size:11px;

}


.hint{

  position:absolute;

  left:18px;

  bottom:14px;

  color:#7f8a9b;

  font-size:11px;

}


.empty{

  color:#7f8a9b;

  text-align:center;

  padding:30px 10px;

  font-size:12px;

}


@media(max-width:800px){

  .app{

    grid-template-columns:
      1fr;

  }

  .side{

    display:none;

  }

  .plan{

    right:10px;

    width:210px;

  }

  .stats{

    gap:8px;

  }

}

</style>

</head>


<body>


<div class="app">


<aside class="side">


<div class="brand">

🚀 Sonny AI Trader

</div>


<div class="sub">

4H/2H DESTEK-DİRENÇ ·
15M YAPI ·
CANLI

</div>


<div
  id="signals"
  class="signals"
></div>


</aside>


<main class="main">


<div class="top">


<div>


<div class="chartTitle">

SİNYAL GRAFİĞİ

</div>


<div
  id="scan"
  class="chartSub"
>

Tarama bekleniyor...

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
-
</b>

</span>


<span>

SON

<b id="time">
-
</b>

</span>


</div>


</div>


<div class="chart">


<canvas
  id="cv"
  class="canvas"
></canvas>


<div
  id="plan"
  class="plan"
></div>


<div class="hint">

Yeşil = Giriş ·
Kırmızı = Stop ·
Mavi = Kâr hedefleri

</div>


</div>


</main>


</div>


<script>


let data = null;

let selected = 0;


const $ =
  id =>
    document.getElementById(id);


function fmt(v){

  if(
    !Number.isFinite(
      Number(v)
    )
  ){

    return "-";

  }


  const n =
    Number(v);


  if(
    n >= 1000
  ){

    return n.toLocaleString(
      "en-US",
      {
        maximumFractionDigits:2
      }
    );

  }


  if(
    n >= 1
  ){

    return n.toLocaleString(
      "en-US",
      {
        maximumFractionDigits:4
      }
    );

  }


  return n.toLocaleString(
    "en-US",
    {
      maximumSignificantDigits:6
    }
  );

}


function age(ms){

  let seconds =
    Math.floor(
      ms / 1000
    );


  if(
    seconds < 60
  ){

    return seconds +
      " sn";

  }


  let minutes =
    Math.floor(
      seconds / 60
    );


  if(
    minutes < 60
  ){

    return minutes +
      " dk";

  }


  return (
    Math.floor(
      minutes / 60
    ) +
    " sa " +
    (
      minutes % 60
    ) +
    " dk"
  );

}


async function load(){

  try{

    const response =
      await fetch(
        "/api/result",
        {
          cache:
            "no-store"
        }
      );


    data =
      await response.json();


    render();

  }

  catch(error){

    $(
      "scan"
    ).textContent =
      "Bağlantı hatası";

  }

}


function render(){

  if(!data){

    return;

  }


  const list =
    data.signals ||
    [];


  $(
    "universe"
  ).textContent =
    data.stats.universe;


  $(
    "count"
  ).textContent =
    list.length;


  $(
    "time"
  ).textContent =

    data.lastScan

      ? new Date(
          data.lastScan
        ).toLocaleTimeString(
          "tr-TR"
        )

      : "-";


  $(
    "scan"
  ).textContent =

    "Son tarama: " +

    (
      data.lastScan

        ? new Date(
            data.lastScan
          ).toLocaleTimeString(
            "tr-TR"
          )

        : "-"
    ) +

    (
      data.error

        ? " · " +
          data.error

        : ""
    );


  $(
    "signals"
  ).innerHTML =

    list.length

      ? list.map(
          (
            signal,
            index
          ) => {

            return (

              '<div class="card ' +

              (
                index === selected
                  ? "active"
                  : ""
              ) +

              '" onclick="pick(' +
              index +
              ')">' +

              '<div class="row">' +

              '<span class="sym">' +
              signal.symbol +
              '</span>' +

              '<span class="badge ' +

              (
                signal.direction ===
                "LONG"

                  ? "long"

                  : "short"
              ) +

              '">' +

              signal.direction +

              '</span>' +

              '</div>' +


              '<div class="price">' +

              fmt(
                signal.price
              ) +

              '</div>' +


              '<div class="meta">' +

              'Seviye ' +

              fmt(
                signal.level
              ) +

              ' · ' +

              signal.score +

              '/100' +

              '</div>' +


              '<div class="meta ' +

              (
                signal.status ===
                "GİRİŞ HAZIR"

                  ? "ready"

                  : "wait"
              ) +

              '">' +

              signal.status +

              ' · ' +

              age(
                signal.ageMs
              ) +

              '</div>' +


              '</div>'

            );

          }
        ).join("")

      :

        '<div class="empty">' +

        'Şu an kaliteli sinyal yok.' +

        '<br>' +

        'Hacim ve hareket filtresinden geçecek fırsat bekleniyor.' +

        '</div>';


  draw(
    list[selected]
  );

}


function pick(index){

  selected =
    index;

  render();

}


function draw(signal){

  const canvas =
    $("cv");


  const context =
    canvas.getContext(
      "2d"
    );


  const ratio =
    window.devicePixelRatio ||
    1;


  const width =
    canvas.clientWidth;


  const height =
    canvas.clientHeight;


  canvas.width =
    width *
    ratio;


  canvas.height =
    height *
    ratio;


  context.setTransform(
    ratio,
    0,
    0,
    ratio,
    0,
    0
  );


  context.clearRect(
    0,
    0,
    width,
    height
  );


  if(!signal){

    $(
      "plan"
    ).innerHTML =
      '<div class="empty">' +
      'Sinyal seç' +
      '</div>';

    return;

  }


  const minimum =
    Math.min(

      signal.stop,

      signal.tp1,

      signal.tp2,

      signal.tp3,

      signal.entryLow,

      signal.entryHigh,

      signal.price

    );


  const maximum =
    Math.max(

      signal.stop,

      signal.tp1,

      signal.tp2,

      signal.tp3,

      signal.entryLow,

      signal.entryHigh,

      signal.price

    );


  const padding =
    (
      maximum -
      minimum
    ) *
    0.16 ||
    1;


  const low =
    minimum -
    padding;


  const high =
    maximum +
    padding;


  const y =
    value =>

      height -
      45 -

      (
        (
          value -
          low
        ) /
        (
          high -
          low
        )
      ) *

      (
        height -
        80
      );


  context.strokeStyle =
    "#202733";

  context.lineWidth =
    1;


  for(
    let i = 0;
    i < 8;
    i++
  ){

    const yy =
      40 +

      i *
      (
        height -
        80
      ) /
      7;


    context.beginPath();

    context.moveTo(
      0,
      yy
    );

    context.lineTo(
      width,
      yy
    );

    context.stroke();

  }


  function drawLine(
    value,
    color,
    dash
  ){

    context.strokeStyle =
      color;

    context.lineWidth =
      2;

    context.setLineDash(
      dash ||
      []
    );


    context.beginPath();

    context.moveTo(
      0,
      y(value)
    );

    context.lineTo(
      width,
      y(value)
    );

    context.stroke();


    context.setLineDash(
      []
    );

  }


  /*
  STOP
  */

  drawLine(
    signal.stop,
    "#ff5364",
    [7,6]
  );


  /*
  GİRİŞ ALT
  */

  drawLine(
    signal.entryLow,
    "#20d889",
    [4,4]
  );


  /*
  GİRİŞ ÜST
  */

  drawLine(
    signal.entryHigh,
    "#20d889",
    [4,4]
  );


  /*
  TP
  */

  drawLine(
    signal.tp1,
    "#4e9cff",
    [5,5]
  );


  drawLine(
    signal.tp2,
    "#4e9cff",
    [5,5]
  );


  drawLine(
    signal.tp3,
    "#4e9cff",
    [5,5]
  );


  /*
  CANLI FİYAT
  */

  context.fillStyle =

    signal.direction ===
    "LONG"

      ? "#20d889"

      : "#ff5364";


  context.beginPath();

  context.arc(

    width *
    0.62,

    y(
      signal.price
    ),

    5,

    0,

    Math.PI * 2

  );

  context.fill();


  context.font =
    "bold 12px Arial";


  context.fillText(

    "ŞU AN " +
    fmt(
      signal.price
    ),

    width *
      0.62 +
      10,

    y(
      signal.price
    ) +
      4

  );


  /*
  SAĞ BİLGİ PANELİ
  */

  $(
    "plan"
  ).innerHTML =

    '<h2>' +
    signal.symbol +
    '</h2>' +


    '<div class="dir ' +

    (
      signal.direction ===
      "LONG"

        ? "long"

        : "short"
    ) +

    '">' +

    signal.direction +

    '</div>' +


    '<div class="line">' +

    '<span>Şu an</span>' +

    '<b>' +

    fmt(
      signal.price
    ) +

    '</b>' +

    '</div>' +


    '<div class="line entry">' +

    '<span>🟢 GİRİŞ</span>' +

    '<b>' +

    fmt(
      signal.entryLow
    ) +

    ' - ' +

    fmt(
      signal.entryHigh
    ) +

    '</b>' +

    '</div>' +


    '<div class="line stop">' +

    '<span>🔴 STOP</span>' +

    '<b>' +

    fmt(
      signal.stop
    ) +

    '</b>' +

    '</div>' +


    '<div class="line tp">' +

    '<span>🔵 KÂR 1</span>' +

    '<b>' +

    fmt(
      signal.tp1
    ) +

    '</b>' +

    '</div>' +


    '<div class="line tp">' +

    '<span>🔵 KÂR 2</span>' +

    '<b>' +

    fmt(
      signal.tp2
    ) +

    '</b>' +

    '</div>' +


    '<div class="line tp">' +

    '<span>🔵 KÂR 3</span>' +

    '<b>' +

    fmt(
      signal.tp3
    ) +

    '</b>' +

    '</div>' +


    '<div class="agebox">' +

    'Sinyal: ' +

    age(
      signal.ageMs
    ) +

    ' önce<br>' +

    'Geçerlilik: ' +

    age(
      signal.validForMs
    ) +

    '<br>' +

    'Hacim: $' +

    (
      signal.vol /
      1000000
    ).toFixed(1) +

    'M · 24S hareket: ' +

    signal.change24h.toFixed(
      2
    ) +

    '%' +

    '</div>';

}


load();


setInterval(
  load,
  10000
);


window.addEventListener(
  "resize",
  function(){

    if(
      data
    ){

      draw(
        (
          data.signals ||
          []
        )[selected]
      );

    }

  }
);

</script>

</body>

</html>`;

}


/*
=========================================================
HTTP SERVER
=========================================================
*/

function send(
  response,
  status,
  body,
  contentType =
    'application/json'
) {

  response.writeHead(

    status,

    {

      'content-type':
        contentType +
        '; charset=utf-8',

      'cache-control':
        'no-store'

    }

  );


  response.end(
    body
  );

}


const server =
  http.createServer(
    async (
      request,
      response
    ) => {

      try {

        const url =
          new URL(

            request.url,

            'http://' +
            (
              request.headers.host ||
              'localhost'
            )

          );


        /*
        ANA SAYFA
        */

        if (
          request.method ===
            'GET' &&

          url.pathname ===
            '/'
        ) {

          return send(

            response,

            200,

            html(),

            'text/html'

          );

        }


        /*
        RESULT API
        */

        if (
          request.method ===
            'GET' &&

          url.pathname ===
            '/api/result'
        ) {

          await liveUpdate();


          return send(

            response,

            200,

            JSON.stringify(
              snapshot()
            )

          );

        }


        /*
        MANUEL SCAN
        */

        if (
          request.method ===
            'POST' &&

          url.pathname ===
            '/api/scan'
        ) {

          await runRadar();


          return send(

            response,

            200,

            JSON.stringify(
              snapshot()
            )

          );

        }


        /*
        HEALTH CHECK
        */

        if (
          request.method ===
            'GET' &&

          url.pathname ===
            '/health'
        ) {

          return send(

            response,

            200,

            JSON.stringify({
              ok:
                true,

              system:
                'Sonny AI Trader FINAL',

              timestamp:
                new Date().toISOString()
            })

          );

        }


        return send(

          response,

          404,

          JSON.stringify({
            error:
              'Not found'
          })

        );

      }

      catch(error){

        return send(

          response,

          500,

          JSON.stringify({

            error:
              error.message

          })

        );

      }

    }
  );


/*
=========================================================
START
=========================================================
*/

server.listen(

  PORT,

  HOST,

  async () => {

    console.log(
      '=============================================='
    );

    console.log(
      '🚀 Sonny AI Trader FINAL başladı'
    );

    console.log(
      '=============================================='
    );

    console.log(
      'Data source: BITGET'
    );

    console.log(
      'Strategy: 4H/2H SUPPORT-RESISTANCE + 15M STRUCTURE + HIGH VOLUME'
    );

    console.log(
      'Min 24h volume: $' +
      CFG.MIN_24H_USDT_VOLUME.toLocaleString()
    );

    console.log(
      'Min 24h range: ' +
      CFG.MIN_24H_RANGE_PCT +
      '%'
    );

    console.log(
      'Min 4H ATR: ' +
      CFG.MIN_4H_ATR_PCT +
      '%'
    );

    console.log(
      'Signal TTL: ' +
      (
        CFG.SIGNAL_TTL_MS /
        60000
      ) +
      ' minutes'
    );

    console.log(
      'Refresh: ' +
      (
        CFG.REFRESH_MS /
        1000
      ) +
      ' seconds'
    );

    console.log(
      'Server listening on port ' +
      PORT
    );

    console.log(
      '=============================================='
    );


    /*
    İlk tarama.
    */

    await runRadar();


    /*
    Her 60 saniyede yeniden tarama.
    */

    setInterval(

      runRadar,

      CFG.REFRESH_MS

    );

  }

);
