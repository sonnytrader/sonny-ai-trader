const express = require('express');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const BASE = 'https://api.bitget.com';
const PRODUCT = 'usdt-futures';

/*
Basit admin koruması. Render'da ADMIN_SECRET env var'ı tanımla,
tanımlamazsan /api/scan herkese açık kalır (uyarı loglanır).
*/
const ADMIN_SECRET = process.env.ADMIN_SECRET || null;

/*
=========================================================
SONNY AI SIGNAL SCANNER V7.0
=========================================================

4H BREAKOUT
2H CONFIRMATION
RETEST
15M RSI
5M RSI
VOLUME
BOLLINGER WIDTH
ADX REJIM FILTRESI (YENİ)
KORELASYON / ÇEŞİTLENDİRME FİLTRESİ (YENİ)
SİNYAL YAŞ LİMİTİ + KAPASİTE ROTASYONU (YENİ)
BAĞIMSIZ ARKA PLAN FİYAT TAKİBİ (YENİ)
LIVE ENTRY TRACKING

ÖNEMLİ:
PREPARING YOK
MISSED YOK
AKTİF SİNYAL SADECE GİRİŞ BÖLGESİNDEYKEN GÖRÜNÜR

V7 DEĞİŞİKLİK ÖZETİ:
- "Gerçek performans" paneli kullanıcı arayüzünden kaldırıldı.
  TP1/TP2/TP3 artık ayrı ayrı performans kaydı OLUŞTURMUYOR
  (eski sistemde aynı işlem 3 kez sayılıyordu, R şişiyordu).
  Sadece nihai kapanış (STOP ya da TP3 ya da zaman aşımı)
  konsola sessizce loglanır; API'de veya arayüzde gösterilmez.
  Bu, parametre kalibrasyonu için minimum bir geri bildirim
  bırakır ama kullanıcıyı yanıltıcı istatistiklerle meşgul etmez.
- Aktif sinyal havuzu artık gerçekten CFG.MAX_SIGNALS ile
  sınırlı (eskiden sadece görüntülemede kesiliyordu, arka planda
  sınırsız büyüyebiliyordu).
- Girişe hiç dönüşmeyen sinyaller artık CFG.SIGNAL_MAX_AGE_MS
  sonra otomatik düşüyor (eskiden sonsuza kadar ekranda/ Map'te
  kalabiliyordu).
- Sinyal üretim anında fiyatın gerçekten giriş bandına yakın
  olup olmadığı kontrol ediliyor (eskiden retest toleransı ile
  giriş bandı tutarsızdı, bazı sinyaller doğar doğmaz EXPIRED
  oluyordu).
- ADX tabanlı rejim filtresi: piyasa yatay/trendsizken (düşük ADX)
  breakout sinyalleri büyük oranda yalancı çıkar, bu yüzden
  filtrelenir.
- Korelasyon / çeşitlendirme filtresi: aynı anda aktif sinyallerin
  en fazla belirli bir oranı aynı yönde olabilir. Böylece BTC tek
  bir yöne sert hareket ettiğinde 8 slotun hepsi birbirine yüksek
  korelasyonlu "tek bir bahis"e dönüşmüyor.
- updateLiveSignals artık HTTP isteğine bağlı değil, kendi
  arka plan interval'ında çalışıyor. Böylece kaç kullanıcı sayfayı
  açık tutarsa tutsun Bitget'e giden istek sayısı sabit kalıyor.
- /api/scan artık opsiyonel ADMIN_SECRET ile korunabiliyor.
- Ölü / işlevsiz kod (registerSignal içindeki anahtar uyuşmazlığı)
  temizlendi, isLongEntry/isShortEntry tek fonksiyona indirgendi.
=========================================================
*/

const CFG = {

  REFRESH_MS: 60000,

  /*
  Canlı fiyat takibi artık kendi bağımsız döngüsünde çalışıyor.
  Tarama (radar) döngüsünden çok daha sık, ama Bitget'i
  yormayacak kadar seyrek.
  */
  LIVE_TRACK_MS: 15000,

  MARKET_LIMIT: 762,

  FAST_RADAR: 500,

  ANALYZE_LIMIT: 120,

  MIN_VOLUME: 3000000,

  LOOKBACK_4H: 30,
  LOOKBACK_2H: 30,

  FOUR_H_LIMIT: 100,
  TWO_H_LIMIT: 100,
  M15_LIMIT: 150,
  M5_LIMIT: 100,

  RETEST_PERCENT: 0.80,

  RSI_PERIOD: 14,

  LONG_RSI_MIN: 48,
  LONG_RSI_MAX: 68,

  SHORT_RSI_MIN: 32,
  SHORT_RSI_MAX: 52,

  MIN_SIGNAL_SCORE: 75,

  MAX_SIGNALS: 8,

  /*
  YENİ: Aynı anda aktif sinyallerin en fazla bu ORANI aynı
  yönde (LONG ya da SHORT) olabilir. 0.65 -> 8 sinyalde en
  fazla 5'i aynı yönde, kalan slotlar diğer yöne ya da boş
  kalır. Bu, tek bir BTC hareketinin tüm panoyu tek yönlü
  ve yüksek korelasyonlu hale getirmesini engeller.
  */
  MAX_SAME_DIRECTION_RATIO: 0.65,

  /*
  YENİ: Girişe hiç dönüşmeyen bir sinyal bu süre sonunda
  otomatik olarak düşürülür. Piyasa yapısı değişmiş olabilir,
  eski seviye artık anlamsızdır.
  */
  SIGNAL_MAX_AGE_MS: 4 * 60 * 60 * 1000, // 4 saat

  /*
  YENİ: ADX rejim filtresi. ADX periyodu ve minimum eşik.
  4H mumları üzerinden hesaplanır (yapısal trend gücü).
  Eşiğin altında breakout sinyali üretilmez.
  */
  ADX_PERIOD: 14,
  ADX_MIN: 20,

  /*
  API güvenliği
  */
  BATCH: 5,
  DELAY: 350,

  SIGNAL_COOLDOWN_MS: 30 * 60 * 1000,
};


/*
=========================================================
STATE
=========================================================
*/

let market = [];

let resultCache = null;

let scanning = false;

let lastScan = null;

let lastError = null;

const activeSignals = new Map();

/*
Sessiz iç kalibrasyon logu. API/arayüz tarafından
kullanılmıyor, sadece konsola yazılıyor. İstersen bu
bloğu ve addSilentOutcome çağrılarını tamamen silebilirsin.
*/
let silentOutcomeCount = 0;


/*
=========================================================
GENEL
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


function n(value, decimals = 6) {

  return Number.isFinite(value)
    ? Number(value.toFixed(decimals))
    : 0;
}


function pct(value, base) {

  if (!base) {
    return 0;
  }

  return (value / base) * 100;
}


function clamp(value, min, max) {

  return Math.max(
    min,
    Math.min(max, value)
  );
}


/*
=========================================================
BITGET API
=========================================================
*/

async function api(path, params = {}) {

  const url =
    new URL(BASE + path);

  Object.entries(params).forEach(
    ([key, value]) => {

      if (
        value !== undefined &&
        value !== null &&
        value !== ''
      ) {

        url.searchParams.set(
          key,
          String(value)
        );
      }
    }
  );


  let lastErrorLocal = null;


  for (let attempt = 0; attempt < 3; attempt++) {

    try {

      const response =
        await fetch(url);


      const text =
        await response.text();


      if (!response.ok) {

        if (
          response.status === 429 &&
          attempt < 2
        ) {

          await sleep(
            1200 * (attempt + 1)
          );

          continue;
        }


        throw new Error(
          'Bitget HTTP ' +
          response.status +
          ' - ' +
          text.slice(0, 250)
        );
      }


      const json =
        JSON.parse(text);


      if (
        json.code !== '00000'
      ) {

        throw new Error(
          'Bitget ' +
          json.code +
          ' - ' +
          (
            json.msg ||
            'Unknown error'
          )
        );
      }


      return json.data;

    } catch (error) {

      lastErrorLocal = error;


      if (
        attempt < 2
      ) {

        await sleep(
          500 * (attempt + 1)
        );

      }

    }
  }


  throw lastErrorLocal;
}


/*
=========================================================
CANDLE PARSER
=========================================================
*/

function candles(data) {

  if (!Array.isArray(data)) {
    return [];
  }


  return data
    .map(row => ({

      time: +row[0],

      open: +row[1],

      high: +row[2],

      low: +row[3],

      close: +row[4],

      volume: +row[5]

    }))


    .filter(
      x =>
        Number.isFinite(x.close)
    )


    .sort(
      (a, b) =>
        a.time - b.time
    );
}


/*
=========================================================
RSI
=========================================================
*/

function rsi(
  values,
  period = 14
) {

  if (
    !values ||
    values.length <= period
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

    const change =
      values[i] -
      values[i - 1];


    if (change >= 0) {

      gain += change;

    } else {

      loss -= change;
    }
  }


  let avgGain =
    gain / period;


  let avgLoss =
    loss / period;


  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {

    const change =
      values[i] -
      values[i - 1];


    avgGain =
      (
        avgGain * (period - 1) +
        Math.max(change, 0)
      ) / period;


    avgLoss =
      (
        avgLoss * (period - 1) +
        Math.max(-change, 0)
      ) / period;
  }


  if (avgLoss === 0) {
    return 100;
  }


  return (
    100 -
    100 /
    (
      1 +
      avgGain / avgLoss
    )
  );
}


/*
=========================================================
BOLLINGER WIDTH
=========================================================
*/

function bollingerWidth(
  values,
  period = 20
) {

  if (
    !values ||
    values.length < period
  ) {

    return null;
  }


  const data =
    values.slice(-period);


  const mean =
    data.reduce(
      (sum, x) =>
        sum + x,
      0
    ) / period;


  const variance =
    data.reduce(
      (sum, x) =>
        sum +
        Math.pow(x - mean, 2),
      0
    ) / period;


  const deviation =
    Math.sqrt(variance);


  if (!mean) {
    return null;
  }


  return (
    ((deviation * 4) / mean) *
    100
  );
}


/*
=========================================================
ADX (YENİ) - Wilder'ın ortalama yön endeksi
Trend gücünü ölçer. Düşük ADX = yatay / zayıf trend piyasası,
bu koşulda breakout sinyalleri çoğunlukla yalancı çıkar.
=========================================================
*/

function adx(
  candleList,
  period = 14
) {

  if (
    !candleList ||
    candleList.length < period * 2 + 1
  ) {

    return null;
  }


  const c = candleList;

  const plusDM = [];
  const minusDM = [];
  const tr = [];


  for (
    let i = 1;
    i < c.length;
    i++
  ) {

    const upMove =
      c[i].high - c[i - 1].high;

    const downMove =
      c[i - 1].low - c[i].low;


    plusDM.push(
      (upMove > downMove && upMove > 0)
        ? upMove
        : 0
    );


    minusDM.push(
      (downMove > upMove && downMove > 0)
        ? downMove
        : 0
    );


    tr.push(
      Math.max(
        c[i].high - c[i].low,
        Math.abs(c[i].high - c[i - 1].close),
        Math.abs(c[i].low - c[i - 1].close)
      )
    );
  }


  function wilderSmooth(values, period) {

    const out = [];

    let sum =
      values
        .slice(0, period)
        .reduce((a, b) => a + b, 0);


    out.push(sum);


    for (
      let i = period;
      i < values.length;
      i++
    ) {

      sum =
        sum -
        (sum / period) +
        values[i];


      out.push(sum);
    }


    return out;
  }


  const smoothTR =
    wilderSmooth(tr, period);

  const smoothPlusDM =
    wilderSmooth(plusDM, period);

  const smoothMinusDM =
    wilderSmooth(minusDM, period);


  const dxValues = [];


  for (
    let i = 0;
    i < smoothTR.length;
    i++
  ) {

    if (!smoothTR[i]) {
      continue;
    }


    const plusDI =
      (smoothPlusDM[i] / smoothTR[i]) * 100;

    const minusDI =
      (smoothMinusDM[i] / smoothTR[i]) * 100;


    const diSum =
      plusDI + minusDI;


    const dx =
      diSum
        ? (Math.abs(plusDI - minusDI) / diSum) * 100
        : 0;


    dxValues.push(dx);
  }


  if (dxValues.length < period) {
    return null;
  }


  const lastPeriod =
    dxValues.slice(-period);


  const adxValue =
    lastPeriod.reduce(
      (a, b) => a + b,
      0
    ) / period;


  return Number.isFinite(adxValue)
    ? adxValue
    : null;
}


/*
=========================================================
VOLUME RATIO
=========================================================
*/

function volumeRatio(c) {

  if (
    !c ||
    c.length < 21
  ) {

    return 1;
  }


  const closed =
    c.slice(0, -1);


  const recent =
    closed.at(-1);


  const previous =
    closed.slice(-21, -1);


  if (
    !recent ||
    !previous.length
  ) {

    return 1;
  }


  const average =
    previous.reduce(
      (sum, x) =>
        sum + x.volume,
      0
    ) / previous.length;


  if (!average) {
    return 1;
  }


  return recent.volume / average;
}


/*
=========================================================
MARKET DISCOVERY
=========================================================
*/

async function discover() {

  const [
    contracts,
    tickers
  ] = await Promise.all([

    api(
      '/api/v2/mix/market/contracts',
      {
        productType: PRODUCT
      }
    ),

    api(
      '/api/v2/mix/market/tickers',
      {
        productType: PRODUCT
      }
    )

  ]);


  const valid =
    new Set(

      contracts

        .filter(
          c =>
            c.symbolType === 'perpetual' &&
            c.symbolStatus === 'normal' &&
            c.quoteCoin === 'USDT'
        )

        .map(
          c =>
            c.symbol
        )
    );


  market =

    tickers

      .filter(
        t =>
          valid.has(t.symbol)
      )


      .map(
        t => {

          const rawChange =
            Number(t.change24h) || 0;


          const change =
            Math.abs(rawChange) <= 1
              ? rawChange * 100
              : rawChange;


          return {

            symbol:
              t.symbol,

            price:
              Number(t.lastPr),

            volume24h:
              Number(t.quoteVolume) || 0,

            change24h:
              change
          };
        }
      )


      .filter(
        x =>
          Number.isFinite(x.price) &&
          x.volume24h >= CFG.MIN_VOLUME
      )


      .sort(
        (a, b) =>
          b.volume24h -
          a.volume24h
      )


      .slice(
        0,
        CFG.MARKET_LIMIT
      );


  log(
    'Discovery tamamlandı. ' +
    market.length +
    ' uygun coin bulundu.'
  );
}


/*
=========================================================
CANDLES
=========================================================
*/

async function getCandles(
  symbol,
  timeframe,
  limit
) {

  const data =
    await api(
      '/api/v2/mix/market/candles',
      {

        symbol,

        productType:
          PRODUCT,

        granularity:
          timeframe,

        limit
      }
    );


  return candles(data);
}


/*
=========================================================
BREAKOUT
=========================================================
*/

function breakoutInfo(
  c,
  lookback
) {

  if (
    c.length <
    lookback + 5
  ) {

    return null;
  }


  const closed =
    c.slice(0, -1);


  const recent =
    Math.min(
      8,
      closed.length - lookback
    );


  let longBreak = false;

  let shortBreak = false;

  let longLevel = null;

  let shortLevel = null;


  for (
    let i =
      closed.length - recent;

    i <
      closed.length;

    i++
  ) {

    const history =
      closed.slice(
        i - lookback,
        i
      );


    if (
      history.length <
      lookback
    ) {

      continue;
    }


    const resistance =
      Math.max(
        ...history.map(
          x => x.high
        )
      );


    const support =
      Math.min(
        ...history.map(
          x => x.low
        )
      );


    const current =
      closed[i];


    const previous =
      closed[i - 1];


    if (
      current.close >
        resistance &&
      previous.close <=
        resistance
    ) {

      longBreak = true;

      longLevel =
        resistance;
    }


    if (
      current.close <
        support &&
      previous.close >=
        support
    ) {

      shortBreak = true;

      shortLevel =
        support;
    }
  }


  const last =
    closed.slice(-lookback);


  return {

    current:
      closed.at(-1),

    resistance:
      longLevel ||
      Math.max(
        ...last.map(
          x => x.high
        )
      ),

    support:
      shortLevel ||
      Math.min(
        ...last.map(
          x => x.low
        )
      ),

    longBreak,

    shortBreak,

    longLevel,

    shortLevel
  };
}


/*
=========================================================
RETEST
=========================================================
*/

function near(
  price,
  level
) {

  if (!level) {
    return false;
  }


  return (
    Math.abs(
      pct(
        price - level,
        level
      )
    ) <=
    CFG.RETEST_PERCENT
  );
}


/*
=========================================================
SCORE
=========================================================
*/

function score(
  breakout4H,
  breakout2H,
  retest,
  rsiOk,
  rv,
  direction,
  rv5,
  volumeRatioValue,
  bbWidth,
  adxValue
) {

  let s = 0;


  if (breakout4H) {
    s += 35;
  }


  if (breakout2H) {

    s += 30;

  } else if (breakout4H) {

    s += 15;
  }


  if (retest) {
    s += 20;
  }


  if (rsiOk) {
    s += 10;
  }


  if (
    direction === 'LONG' &&
    rv >= 52 &&
    rv <= 63
  ) {

    s += 5;
  }


  if (
    direction === 'SHORT' &&
    rv >= 37 &&
    rv <= 48
  ) {

    s += 5;
  }


  if (
    direction === 'LONG' &&
    Number.isFinite(rv5) &&
    rv5 >= 45 &&
    rv5 <= 70
  ) {

    s += 3;
  }


  if (
    direction === 'SHORT' &&
    Number.isFinite(rv5) &&
    rv5 >= 30 &&
    rv5 <= 55
  ) {

    s += 3;
  }


  if (
    Number.isFinite(volumeRatioValue) &&
    volumeRatioValue >= 1.2
  ) {

    s += 5;
  }


  if (
    Number.isFinite(bbWidth) &&
    bbWidth >= 1
  ) {

    s += 3;
  }


  /*
  YENİ: ADX bonusu. Güçlü trend rejiminde ekstra puan.
  ADX_MIN altındaki durumlar zaten makeSignal aşamasında
  tamamen elenir, bu sadece güçlü trendi ödüllendirir.
  */
  if (
    Number.isFinite(adxValue) &&
    adxValue >= 30
  ) {

    s += 4;
  }


  return Math.min(
    100,
    s
  );
}


/*
=========================================================
TRADE PLAN
=========================================================
*/

function plan(
  m,
  direction,
  level,
  rv,
  rv5,
  sc,
  volumeRatioValue,
  bbWidth,
  adxValue,
  reason
) {

  let entryLow;
  let entryHigh;


  if (
    direction === 'LONG'
  ) {

    entryLow =
      level * 0.998;

    entryHigh =
      level * 1.004;

  } else {

    entryLow =
      level * 1.002;

    entryHigh =
      level * 0.996;
  }


  const low =
    Math.min(
      entryLow,
      entryHigh
    );


  const high =
    Math.max(
      entryLow,
      entryHigh
    );


  const stop =
    direction === 'LONG'
      ? level * 0.982
      : level * 1.018;


  const risk =
    Math.abs(
      level - stop
    );


  const tp1 =
    direction === 'LONG'
      ? level + risk * 1.5
      : level - risk * 1.5;


  const tp2 =
    direction === 'LONG'
      ? level + risk * 2
      : level - risk * 2;


  const tp3 =
    direction === 'LONG'
      ? level + risk * 3
      : level - risk * 3;


  const now = Date.now();


  return {

    id:
      m.symbol +
      '_' +
      direction +
      '_' +
      Math.round(level * 1000000) +
      '_' +
      now,

    symbol:
      m.symbol,

    direction,

    strategy:
      '4H BREAKOUT + 2H CONFIRMATION + RETEST + RSI + ADX',

    score:
      sc,

    price:
      n(m.price, 8),

    entryLow:
      n(low, 8),

    entryHigh:
      n(high, 8),

    stop:
      n(stop, 8),

    tp1:
      n(tp1, 8),

    tp2:
      n(tp2, 8),

    tp3:
      n(tp3, 8),

    rsi:
      n(rv, 1),

    rsi5:
      n(rv5, 1),

    volumeRatio:
      n(volumeRatioValue, 2),

    bbWidth:
      n(bbWidth, 2),

    adx:
      n(adxValue, 1),

    level:
      n(level, 8),

    change24h:
      n(m.change24h, 2),

    reason,

    createdAt:
      now,

    /*
    YENİ: yaş limiti için son geçerlilik zamanı.
    */
    expiresAt:
      now + CFG.SIGNAL_MAX_AGE_MS,

    enteredAt:
      null,

    exitAt:
      null,

    status:
      'ACTIVE',

    tp1Hit:
      false,

    tp2Hit:
      false,

    tp3Hit:
      false,

    stopHit:
      false,

    currentPrice:
      n(m.price, 8),

    tradingView:
      'https://www.tradingview.com/symbols/' +
      encodeURIComponent(m.symbol) +
      '/?exchange=BITGET'
  };
}


/*
=========================================================
MAKE SIGNAL
=========================================================
*/

function makeSignal(
  m,
  h4,
  h2,
  m15,
  m5,
  adxValue
) {

  const rv =
    rsi(
      m15
        .slice(0, -1)
        .map(
          x => x.close
        ),
      CFG.RSI_PERIOD
    );


  const rv5 =
    rsi(
      m5
        .slice(0, -1)
        .map(
          x => x.close
        ),
      CFG.RSI_PERIOD
    );


  if (rv === null) {
    return null;
  }


  /*
  YENİ: ADX rejim filtresi. Piyasa yeterince trendli değilse
  breakout stratejisi güvenilir değildir, hiç sinyal üretme.
  */
  if (
    !Number.isFinite(adxValue) ||
    adxValue < CFG.ADX_MIN
  ) {

    return null;
  }


  const price =
    m.price;


  const h2Price =
    h2.current.close;


  const volumeRatioValue =
    volumeRatio(m15);


  const bbWidth =
    bollingerWidth(
      m15
        .slice(0, -1)
        .map(
          x => x.close
        )
    );


  /*
  ========================================================
  LONG
  ========================================================
  */

  if (
    h4.longBreak ||
    h2.longBreak
  ) {

    const level =
      h4.longBreak
        ? (
            h4.longLevel ||
            h4.resistance
          )
        : (
            h2.longLevel ||
            h2.resistance
          );


    const h4ok =
      h4.longBreak ||
      price >=
      h4.resistance * 0.997;


    const h2ok =
      h2.longBreak ||
      h2Price >=
      h2.resistance * 0.997;


    const rsiOk =
      rv >= CFG.LONG_RSI_MIN &&
      rv <= CFG.LONG_RSI_MAX;


    const retest =
      near(
        price,
        level
      );


    if (
      h4ok &&
      h2ok &&
      retest &&
      rsiOk
    ) {

      const sc =
        score(
          h4.longBreak,
          h2.longBreak,
          true,
          true,
          rv,
          'LONG',
          rv5,
          volumeRatioValue,
          bbWidth,
          adxValue
        );


      if (
        sc >=
        CFG.MIN_SIGNAL_SCORE
      ) {

        const candidate =
          plan(

            m,

            'LONG',

            level,

            rv,

            rv5,

            sc,

            volumeRatioValue,

            bbWidth,

            adxValue,

            (
              h4.longBreak
                ? '4H kırılımı'
                : '4H yapı onayı'
            ) +
            ' + ' +
            (
              h2.longBreak
                ? '2H kırılım onayı'
                : '2H yapı onayı'
            ) +
            ' + retest + RSI + ADX(' +
            n(adxValue, 0) +
            ') LONG giriş bölgesi.'
          );


        /*
        YENİ: sinyal doğar doğmaz fiyatın gerçekten giriş
        bandına yakın olup olmadığını kontrol et. Eskiden
        RETEST_PERCENT toleransı (%0.8) ile giriş bandı
        (%0.2-%0.4) tutarsızdı; bazı sinyaller doğduğu anda
        zaten bandın dışındaydı ve ilk canlı güncellemede
        anında EXPIRED oluyordu, boşuna slot işgal ediyordu.
        */
        if (isNearEntryZone(candidate, price)) {

          return {
            type: 'SIGNAL',
            data: candidate
          };
        }


        return null;
      }
    }
  }


  /*
  ========================================================
  SHORT
  ========================================================
  */

  if (
    h4.shortBreak ||
    h2.shortBreak
  ) {

    const level =
      h4.shortBreak
        ? (
            h4.shortLevel ||
            h4.support
          )
        : (
            h2.shortLevel ||
            h2.support
          );


    const h4ok =
      h4.shortBreak ||
      price <=
      h4.support * 1.003;


    const h2ok =
      h2.shortBreak ||
      h2Price <=
      h2.support * 1.003;


    const rsiOk =
      rv >= CFG.SHORT_RSI_MIN &&
      rv <= CFG.SHORT_RSI_MAX;


    const retest =
      near(
        price,
        level
      );


    if (
      h4ok &&
      h2ok &&
      retest &&
      rsiOk
    ) {

      const sc =
        score(
          h4.shortBreak,
          h2.shortBreak,
          true,
          true,
          rv,
          'SHORT',
          rv5,
          volumeRatioValue,
          bbWidth,
          adxValue
        );


      if (
        sc >=
        CFG.MIN_SIGNAL_SCORE
      ) {

        const candidate =
          plan(

            m,

            'SHORT',

            level,

            rv,

            rv5,

            sc,

            volumeRatioValue,

            bbWidth,

            adxValue,

            (
              h4.shortBreak
                ? '4H kırılımı'
                : '4H yapı onayı'
            ) +
            ' + ' +
            (
              h2.shortBreak
                ? '2H kırılım onayı'
                : '2H yapı onayı'
            ) +
            ' + retest + RSI + ADX(' +
            n(adxValue, 0) +
            ') SHORT giriş bölgesi.'
          );


        if (isNearEntryZone(candidate, price)) {

          return {
            type: 'SIGNAL',
            data: candidate
          };
        }


        return null;
      }
    }
  }


  return null;
}


/*
YENİ: fiyat, giriş bandının makul bir yakınında mı?
Bandın tam içinde olması şart değil (o zaman zaten ENTERED
olurdu) ama bandın çok dışında doğan bir sinyal anlamsızdır.
Bant genişliğinin +-1 katı kadar tolerans veriyoruz.
*/
function isNearEntryZone(signal, price) {

  const width =
    signal.entryHigh - signal.entryLow;

  const tolerance =
    Math.max(width, signal.entryLow * 0.003);


  return (
    price >= signal.entryLow - tolerance &&
    price <= signal.entryHigh + tolerance
  );
}


/*
=========================================================
ANALYZE
=========================================================
*/

async function analyze(m) {

  try {

    const [
      c4,
      c2,
      c15,
      c5
    ] =
      await Promise.all([

        getCandles(
          m.symbol,
          '4H',
          CFG.FOUR_H_LIMIT
        ),

        getCandles(
          m.symbol,
          '2H',
          CFG.TWO_H_LIMIT
        ),

        getCandles(
          m.symbol,
          '15m',
          CFG.M15_LIMIT
        ),

        getCandles(
          m.symbol,
          '5m',
          CFG.M5_LIMIT
        )

      ]);


    if (
      c4.length < 40 ||
      c2.length < 40 ||
      c15.length < 50 ||
      c5.length < 30
    ) {

      return null;
    }


    const h4 =
      breakoutInfo(
        c4,
        CFG.LOOKBACK_4H
      );


    const h2 =
      breakoutInfo(
        c2,
        CFG.LOOKBACK_2H
      );


    if (!h4 || !h2) {
      return null;
    }


    /*
    YENİ: ADX'i 4H mumları üzerinden hesapla (yapısal /
    daha az gürültülü trend gücü ölçümü).
    */
    const adxValue =
      adx(c4, CFG.ADX_PERIOD);


    const signal =
      makeSignal(
        m,
        h4,
        h2,
        c15,
        c5,
        adxValue
      );


    if (!signal) {
      return null;
    }


    return signal;


  } catch (error) {

    log(
      'Analiz hatası ' +
      m.symbol +
      ': ' +
      error.message
    );


    return null;
  }
}


/*
=========================================================
MARKET DIRECTION
=========================================================
*/

function marketDirection() {

  const btc =
    market.find(
      x =>
        x.symbol === 'BTCUSDT'
    );


  const eth =
    market.find(
      x =>
        x.symbol === 'ETHUSDT'
    );


  const list =
    [
      btc,
      eth
    ].filter(Boolean);


  if (!list.length) {

    return {

      direction:
        'YATAY',

      label:
        'PİYASA YATAY',

      reason:
        'Piyasa verisi bekleniyor.'
    };
  }


  const up =
    list.filter(
      x =>
        x.change24h > 1
    ).length;


  const down =
    list.filter(
      x =>
        x.change24h < -1
    ).length;


  if (up > down) {

    return {

      direction:
        'LONG',

      label:
        'PİYASA YUKARI',

      reason:
        'BTC / ETH yükseliş ağırlıklı.'
    };
  }


  if (down > up) {

    return {

      direction:
        'SHORT',

      label:
        'PİYASA AŞAĞI',

      reason:
        'BTC / ETH düşüş ağırlıklı.'
    };
  }


  return {

    direction:
      'YATAY',

    label:
      'PİYASA YATAY',

    reason:
      'Genel piyasa yönü net değil.'
  };
}


/*
=========================================================
SESSİZ KALİBRASYON LOGU
(Kullanıcı arayüzünde / API'de gösterilmez.
Sadece Render loglarında iz bırakır.)
=========================================================
*/

function logSilentOutcome(signal, result, exitPrice) {

  silentOutcomeCount++;


  const risk =
    Math.abs(signal.level - signal.stop);


  const r =
    risk
      ? n(
          (
            signal.direction === 'LONG'
              ? (exitPrice - signal.level)
              : (signal.level - exitPrice)
          ) / risk,
          2
        )
      : 0;


  log(
    '[KALİBRASYON] #' +
    silentOutcomeCount +
    ' ' +
    signal.symbol +
    ' ' +
    signal.direction +
    ' -> ' +
    result +
    ' | R=' +
    r +
    ' | skor=' +
    signal.score +
    ' | adx=' +
    signal.adx
  );
}


/*
=========================================================
LIVE SIGNAL TRACKING
=========================================================
*/

function isEntry(signal, price) {

  return (
    price >= signal.entryLow &&
    price <= signal.entryHigh
  );
}


function updateActiveSignal(
  signal,
  price
) {

  signal.currentPrice =
    n(price, 8);


  if (!signal.enteredAt) {

    if (
      isEntry(
        signal,
        price
      )
    ) {

      signal.enteredAt =
        Date.now();

      signal.status =
        'ENTERED';

      log(
        'GİRİŞ AKTİF | ' +
        signal.symbol +
        ' | ' +
        signal.direction +
        ' | ' +
        price
      );


      return true;
    }


    const missedLong =
      signal.direction === 'LONG' &&
      price > signal.entryHigh;


    const missedShort =
      signal.direction === 'SHORT' &&
      price < signal.entryLow;


    if (
      missedLong ||
      missedShort
    ) {

      signal.status =
        'EXPIRED';

      log(
        'GİRİŞ KAÇTI | ' +
        signal.symbol
      );


      return false;
    }


    /*
    YENİ: girişe hiç dönüşmeden yaş limitini aşan sinyaller
    otomatik düşer. Eskiden bu kontrol yoktu, sonsuza kadar
    "GİRİŞ BEKLENİYOR" olarak slot işgal edebiliyordu.
    */
    if (
      signal.expiresAt &&
      Date.now() > signal.expiresAt
    ) {

      signal.status =
        'EXPIRED';

      log(
        'YAŞ LİMİTİ DOLDU | ' +
        signal.symbol
      );


      return false;
    }


    return true;
  }


  if (
    signal.direction === 'LONG'
  ) {

    if (
      price <= signal.stop
    ) {

      signal.stopHit =
        true;

      signal.status =
        'STOP';

      signal.exitAt =
        Date.now();

      logSilentOutcome(
        signal,
        'STOP',
        price
      );

      return false;
    }


    if (
      !signal.tp1Hit &&
      price >= signal.tp1
    ) {

      signal.tp1Hit =
        true;

      log(
        'TP1 | ' +
        signal.symbol
      );
    }


    if (
      !signal.tp2Hit &&
      price >= signal.tp2
    ) {

      signal.tp2Hit =
        true;

      log(
        'TP2 | ' +
        signal.symbol
      );
    }


    if (
      !signal.tp3Hit &&
      price >= signal.tp3
    ) {

      signal.tp3Hit =
        true;

      signal.status =
        'TP3';

      signal.exitAt =
        Date.now();

      logSilentOutcome(
        signal,
        'TP3',
        price
      );

      return false;
    }

  } else {

    if (
      price >= signal.stop
    ) {

      signal.stopHit =
        true;

      signal.status =
        'STOP';

      signal.exitAt =
        Date.now();

      logSilentOutcome(
        signal,
        'STOP',
        price
      );

      return false;
    }


    if (
      !signal.tp1Hit &&
      price <= signal.tp1
    ) {

      signal.tp1Hit =
        true;

      log(
        'TP1 | ' +
        signal.symbol
      );
    }


    if (
      !signal.tp2Hit &&
      price <= signal.tp2
    ) {

      signal.tp2Hit =
        true;

      log(
        'TP2 | ' +
        signal.symbol
      );
    }


    if (
      !signal.tp3Hit &&
      price <= signal.tp3
    ) {

      signal.tp3Hit =
        true;

      signal.status =
        'TP3';

      signal.exitAt =
        Date.now();

      logSilentOutcome(
        signal,
        'TP3',
        price
      );

      return false;
    }
  }


  return true;
}


/*
=========================================================
UPDATE LIVE PRICES
Artık HTTP isteklerinden bağımsız, kendi interval'inde
çalışıyor (bkz. dosya sonu). Bu fonksiyon sadece mevcut
aktif sinyalleri günceller.
=========================================================
*/

async function updateLiveSignals() {

  if (
    activeSignals.size === 0
  ) {

    return;
  }


  try {

    const tickers =
      await api(
        '/api/v2/mix/market/tickers',
        {
          productType:
            PRODUCT
        }
      );


    const prices =
      new Map();


    if (Array.isArray(tickers)) {

      tickers.forEach(
        ticker => {

          const price =
            Number(
              ticker.lastPr
            );


          if (
            Number.isFinite(price)
          ) {

            prices.set(
              ticker.symbol,
              price
            );
          }
        }
      );
    }


    for (
      const [
        id,
        signal
      ]
      of activeSignals
    ) {

      const price =
        prices.get(
          signal.symbol
        );


      if (
        !Number.isFinite(price)
      ) {

        continue;
      }


      const keep =
        updateActiveSignal(
          signal,
          price
        );


      if (!keep) {

        activeSignals.delete(
          id
        );
      }
    }


  } catch (error) {

    log(
      'Canlı fiyat güncelleme hatası: ' +
      error.message
    );
  }
}


/*
=========================================================
REGISTER NEW SIGNAL
YENİ: gerçek kapasite sınırı + yön bazlı çeşitlendirme +
zayıf sinyal rotasyonu.
=========================================================
*/

function countByDirection(direction) {

  let count = 0;


  for (
    const s
    of activeSignals.values()
  ) {

    if (s.direction === direction) {
      count++;
    }
  }


  return count;
}


function weakestEntry(direction) {

  let weakest = null;


  for (
    const s
    of activeSignals.values()
  ) {

    /*
    Zaten girişe dönüşmüş (ENTERED) sinyalleri rotasyonla
    çıkarmıyoruz, sadece hâlâ "bekleyen" sinyaller arasından
    en zayıfını çıkarıyoruz.
    */
    if (s.enteredAt) {
      continue;
    }


    if (
      direction &&
      s.direction !== direction
    ) {
      continue;
    }


    if (
      !weakest ||
      s.score < weakest.score
    ) {

      weakest = s;
    }
  }


  return weakest;
}


function registerSignal(signal) {

  for (
    const existing
    of activeSignals.values()
  ) {

    if (
      existing.symbol === signal.symbol &&
      existing.direction === signal.direction
    ) {

      return;
    }
  }


  const maxSameDirection =
    Math.max(
      1,
      Math.round(
        CFG.MAX_SIGNALS *
        CFG.MAX_SAME_DIRECTION_RATIO
      )
    );


  if (
    countByDirection(signal.direction) >=
    maxSameDirection
  ) {

    /*
    Bu yönde zaten çok fazla sinyal var (korelasyon riski).
    Sadece yeni sinyal, mevcut en zayıf bekleyen sinyalden
    belirgin şekilde güçlüyse yer değiştir.
    */

    const weak =
      weakestEntry(signal.direction);


    if (
      !weak ||
      signal.score <= weak.score + 5
    ) {

      return;
    }


    activeSignals.delete(weak.id);

    log(
      'ROTASYON (YÖN LİMİTİ) | ' +
      weak.symbol +
      ' çıkarıldı, ' +
      signal.symbol +
      ' eklendi.'
    );
  }


  if (
    activeSignals.size >=
    CFG.MAX_SIGNALS
  ) {

    const weak =
      weakestEntry(null);


    if (
      !weak ||
      signal.score <= weak.score
    ) {

      return;
    }


    activeSignals.delete(weak.id);

    log(
      'ROTASYON (KAPASİTE) | ' +
      weak.symbol +
      ' çıkarıldı, ' +
      signal.symbol +
      ' eklendi.'
    );
  }


  activeSignals.set(
    signal.id,
    signal
  );


  log(
    'YENİ SİNYAL | ' +
    signal.symbol +
    ' | ' +
    signal.direction +
    ' | Güç: ' +
    signal.score
  );
}


/*
=========================================================
PRUNE EXPIRED
Arka plan interval'inde çağrılır, girişe dönüşmeden yaş
limitini aşan sinyalleri temizler (updateActiveSignal zaten
bunu fiyat güncellemesi sırasında yapıyor, bu ekstra bir
güvenlik ağı - fiyat verisi gelmeyen sembollerde de çalışır).
=========================================================
*/

function pruneExpiredSignals() {

  const now = Date.now();


  for (
    const [id, s]
    of activeSignals
  ) {

    if (
      !s.enteredAt &&
      s.expiresAt &&
      now > s.expiresAt
    ) {

      activeSignals.delete(id);

      log(
        'YAŞ LİMİTİ DOLDU (prune) | ' +
        s.symbol
      );
    }
  }
}


/*
=========================================================
RADAR
=========================================================
*/

async function runRadar() {

  if (scanning) {

    return resultCache;
  }


  scanning = true;

  lastError = null;


  const started =
    Date.now();


  try {

    await discover();


    const fastCandidates =
      market.slice(
        0,
        Math.min(
          CFG.FAST_RADAR,
          market.length
        )
      );


    const candidates =
      fastCandidates.slice(
        0,
        Math.min(
          CFG.ANALYZE_LIMIT,
          fastCandidates.length
        )
      );


    log(
      'RADAR başladı | Universe=' +
      market.length +
      ' | FastRadar=' +
      fastCandidates.length +
      ' | DeepAnalysis=' +
      candidates.length
    );


    const foundSignals = [];


    for (
      let i = 0;
      i < candidates.length;
      i += CFG.BATCH
    ) {

      const batch =
        candidates.slice(
          i,
          i + CFG.BATCH
        );


      const rows =
        await Promise.all(
          batch.map(
            analyze
          )
        );


      rows.forEach(
        result => {

          if (
            result &&
            result.type === 'SIGNAL'
          ) {

            foundSignals.push(
              result.data
            );
          }
        }
      );


      await sleep(
        CFG.DELAY
      );
    }


    foundSignals.sort(
      (a, b) =>
        b.score -
        a.score
    );


    foundSignals.forEach(
      registerSignal
    );


    pruneExpiredSignals();


    await updateLiveSignals();


    const active =
      Array.from(
        activeSignals.values()
      )
      .sort(
        (a, b) =>
          b.score -
          a.score
      )
      .slice(
        0,
        CFG.MAX_SIGNALS
      );


    resultCache = {

      success:
        true,

      system:
        'Sonny AI Signal Scanner V7.0',

      timestamp:
        new Date().toISOString(),

      market:
        marketDirection(),

      stats: {

        market:
          market.length,

        fastRadar:
          fastCandidates.length,

        analyzed:
          candidates.length,

        signals:
          active.length
      },


      signals:
        active,


      preparing:
        [],


      missed:
        [],


      strategy:
        '4H BREAKOUT + 2H CONFIRMATION + RETEST + 15M RSI + 5M RSI + VOLUME + ADX',

      refresh:
        '60 SECONDS',

      scanSeconds:
        n(
          (
            Date.now() -
            started
          ) / 1000,
          1
        )
    };


    lastScan =
      resultCache.timestamp;


    log(
      'RADAR tamamlandı | Universe=' +
      market.length +
      ' | FastRadar=' +
      fastCandidates.length +
      ' | OHLCV=' +
      candidates.length +
      ' | SIGNAL=' +
      active.length
    );


    return resultCache;


  } catch (error) {

    lastError =
      error.message;


    log(
      'RADAR ERROR: ' +
      error.message
    );


    return {

      success:
        false,

      error:
        error.message
    };


  } finally {

    scanning =
      false;
  }
}


/*
=========================================================
HTML
=========================================================
*/

const HTML = `<!doctype html>

<html lang="tr">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>Sonny AI Signal Scanner V7.0</title>

<style>

*{
  box-sizing:border-box;
}

body{
  margin:0;
  background:#080b12;
  color:#f5f7fb;
  font-family:Arial,sans-serif;
}

.wrap{
  width:min(1200px,94%);
  margin:25px auto 50px;
}

.head{
  display:flex;
  justify-content:space-between;
  align-items:center;
  margin-bottom:18px;
}

.title{
  font-size:27px;
  font-weight:900;
}

.sub,
.muted{
  color:#7d8799;
}

.online{
  padding:9px 14px;
  border-radius:20px;
  background:#0d2118;
  color:#43e58b;
  border:1px solid #174d31;
  font-weight:800;
}

.market,
.stat,
.panel{
  background:#111722;
  border:1px solid #202b3b;
  border-radius:15px;
  padding:18px;
  margin-bottom:15px;
}

.marketLabel,
.label{
  color:#748095;
  font-size:11px;
  font-weight:800;
}

.marketDir{
  font-size:28px;
  font-weight:900;
  margin-top:5px;
}

.stats{
  display:grid;
  grid-template-columns:repeat(4,1fr);
  gap:12px;
}

.stat{
  margin:0;
}

.value{
  font-size:21px;
  font-weight:900;
  margin-top:7px;
}

.panel h2{
  margin:0 0 6px;
  font-size:19px;
}

.signal{
  background:#0c121d;
  border:1px solid #26354a;
  border-radius:13px;
  padding:16px;
  margin-top:12px;
}

.top{
  display:flex;
  justify-content:space-between;
  align-items:center;
}

.coin{
  font-size:20px;
  font-weight:900;
}

.long{
  color:#45e58d;
}

.short{
  color:#ff647a;
}

.score{
  background:#1c2635;
  padding:6px 9px;
  border-radius:7px;
  font-weight:900;
}

.plan{
  display:grid;
  grid-template-columns:repeat(5,1fr);
  gap:8px;
  margin-top:14px;
}

.box{
  background:#151d2a;
  border-radius:8px;
  padding:9px;
}

.box b{
  display:block;
  color:#68758a;
  font-size:10px;
  margin-bottom:4px;
}

.reason{
  margin-top:12px;
  background:#121a27;
  padding:10px;
  border-radius:8px;
  color:#a8b3c5;
  font-size:12px;
}

.tv{
  display:inline-block;
  margin-top:11px;
  padding:8px 12px;
  background:#e9edf4;
  color:#0b1018;
  border-radius:8px;
  text-decoration:none;
  font-size:12px;
  font-weight:900;
}

.status{
  margin-top:10px;
  color:#7e8b9e;
  font-size:12px;
}

.empty{
  margin-top:18px;
  padding:18px;
  background:#0c121d;
  border-radius:10px;
  color:#718096;
}

@media(max-width:800px){

  .stats{
    grid-template-columns:repeat(2,1fr);
  }

  .plan{
    grid-template-columns:repeat(2,1fr);
  }

  .head{
    display:block;
  }

  .online{
    display:inline-block;
    margin-top:10px;
  }
}

</style>

</head>

<body>

<div class="wrap">

<div class="head">

<div>

<div class="title">
🚀 Sonny AI Signal Scanner V7.0
</div>

<div class="sub">
4H Kırılım · 2H Onay · Retest · 15M RSI · 5M RSI · Hacim · ADX Rejim Filtresi
</div>

</div>

<div class="online">
● SÜREKLİ AKTİF
</div>

</div>


<div class="market">

<div class="marketLabel">
GENEL PİYASA DURUMU
</div>

<div
  id="md"
  class="marketDir"
>
VERİ BEKLENİYOR
</div>

<div
  id="mr"
  class="muted"
>
Piyasa hesaplanıyor...
</div>

</div>


<div class="stats">

<div class="stat">

<div class="label">
PİYASA
</div>

<div
  id="mc"
  class="value"
>
-
</div>

</div>


<div class="stat">

<div class="label">
ANALİZ
</div>

<div
  id="an"
  class="value"
>
-
</div>

</div>


<div class="stat">

<div class="label">
AKTİF SİNYAL
</div>

<div
  id="sc"
  class="value"
>
0
</div>

</div>


<div class="stat">

<div class="label">
SON TARAMA
</div>

<div
  id="ls"
  class="value"
>
-
</div>

</div>

</div>


<div class="panel">

<h2>
🚨 AKTİF SİNYALLER
</h2>

<div class="muted">
Yalnızca gerçek giriş bölgesinde bulunan sinyaller gösterilir.
Giriş fırsatı sona erdiğinde ya da 4 saat içinde girişe dönüşmezse
sinyal otomatik olarak ekrandan kaldırılır.
</div>

<div id="signals">

<div class="empty">
Tarama yapılıyor...
</div>

</div>

</div>


<div class="panel">

<h2>
🧠 SONNY KARAR SİSTEMİ
</h2>

<div class="muted">

1. 4H mumları üzerinden ADX ile trend gücü ölçülür; piyasa yeterince
trendli değilse (ADX düşük) o coin için sinyal üretilmez.<br><br>

2. 4H destek / direnç seviyesi bulunur.<br><br>

3. Son kapanmış mumlarda gerçek kırılım aranır.<br><br>

4. 2H aynı yönde kırılım veya yapı onayı kontrol edilir.<br><br>

5. Kırılan seviye retest edilir ve fiyatın gerçekten giriş
bandına yakın olduğu doğrulanır.<br><br>

6. 15M RSI giriş zamanını kontrol eder.<br><br>

7. 5M RSI kısa vadeli momentumu destekler.<br><br>

8. Hacim ve Bollinger genişliği kalite puanına katkı sağlar.<br><br>

9. Aynı yönde çok fazla korele sinyal birikirse (örn. BTC tek yöne
sert hareket ederse) en zayıf bekleyen sinyaller rotasyonla
çıkarılır, panonun tek bir bahse dönüşmesi engellenir.<br><br>

10. Sinyal oluştuktan sonra fiyat bağımsız bir döngüde canlı
takip edilir.<br><br>

11. Giriş bölgesinden çıkan ya da 4 saat içinde girişe dönüşmeyen
fırsat ekrandan kaldırılır.<br><br>

12. Gerçek giriş sonrası TP1 / TP2 / TP3 / STOP takip edilir.

</div>

</div>


<div
  id="status"
  class="status"
>
Sistem başlatılıyor...
</div>

</div>


<script>

function price(v){

  v=Number(v);

  if(
    !Number.isFinite(v)
  ){
    return "-";
  }

  if(v>=100){
    return v.toFixed(2);
  }

  if(v>=1){
    return v.toFixed(4);
  }

  if(v>=0.01){
    return v.toFixed(6);
  }

  return v.toFixed(8);
}


function render(d){

  if(
    d.market
  ){

    const md =
      document.getElementById("md");


    md.textContent =
      d.market.label;


    md.className =
      "marketDir " +
      (
        d.market.direction === "LONG"
          ? "long"
          : d.market.direction === "SHORT"
            ? "short"
            : ""
      );


    document.getElementById("mr")
      .textContent =
      d.market.reason;
  }


  if(
    d.stats
  ){

    document.getElementById("mc")
      .textContent =
      d.stats.market;


    document.getElementById("an")
      .textContent =
      d.stats.analyzed;


    document.getElementById("sc")
      .textContent =
      d.stats.signals;
  }


  if(
    d.timestamp
  ){

    document.getElementById("ls")
      .textContent =
      new Date(
        d.timestamp
      ).toLocaleTimeString(
        "tr-TR"
      );
  }


  const box =
    document.getElementById(
      "signals"
    );


  if(
    !d.signals ||
    !d.signals.length
  ){

    box.innerHTML =
      '<div class="empty">' +
      'Şu anda aktif giriş sinyali yok. ' +
      'Sistem piyasayı tarıyor.' +
      '</div>';

  } else {

    box.innerHTML =
      d.signals
        .map(
          function(x){

            const directionClass =
              x.direction === "LONG"
                ? "long"
                : "short";


            return (

              '<div class="signal">' +

              '<div class="top">' +

              '<div class="coin ' +
              directionClass +
              '">' +

              x.symbol +
              ' · ' +
              x.direction +

              '</div>' +

              '<div class="score">' +
              'GÜÇ ' +
              x.score +
              '/100' +
              '</div>' +

              '</div>' +


              '<div class="muted" style="margin-top:7px">' +

              'Canlı fiyat: <b>' +
              price(x.currentPrice || x.price) +
              '</b> · ' +

              '15M RSI: <b>' +
              x.rsi +
              '</b> · ' +

              '5M RSI: <b>' +
              (
                x.rsi5 !== undefined
                  ? x.rsi5
                  : "-"
              ) +
              '</b> · ' +

              'ADX: <b>' +
              (
                x.adx !== undefined
                  ? x.adx
                  : "-"
              ) +
              '</b> · ' +

              'Hacim: <b>' +
              (
                x.volumeRatio !== undefined
                  ? x.volumeRatio + "x"
                  : "-"
              ) +
              '</b>' +

              '</div>' +


              '<div class="plan">' +

              '<div class="box">' +
              '<b>GİRİŞ</b>' +
              price(x.entryLow) +
              ' - ' +
              price(x.entryHigh) +
              '</div>' +

              '<div class="box">' +
              '<b>STOP</b>' +
              price(x.stop) +
              '</div>' +

              '<div class="box">' +
              '<b>TP1</b>' +
              price(x.tp1) +
              '</div>' +

              '<div class="box">' +
              '<b>TP2</b>' +
              price(x.tp2) +
              '</div>' +

              '<div class="box">' +
              '<b>TP3</b>' +
              price(x.tp3) +
              '</div>' +

              '</div>' +


              '<div class="reason">' +

              '<b>Neden?</b> ' +
              x.reason +

              '<br><br>' +

              '<span>' +
              'Durum: ' +
              (
                x.enteredAt
                  ? "GİRİŞ AKTİF"
                  : "GİRİŞ BEKLENİYOR"
              ) +
              '</span>' +

              '</div>' +


              '<a ' +
              'class="tv" ' +
              'target="_blank" ' +
              'href="' +
              x.tradingView +
              '">' +

              '📊 TRADINGVIEW AÇ' +

              '</a>' +

              '</div>'
            );
          }
        )
        .join("");
  }
}


async function load(){

  try {

    document.getElementById(
      "status"
    ).textContent =
      "Yeni piyasa verileri kontrol ediliyor...";


    const response =
      await fetch(
        "/api/result?_=" +
        Date.now(),
        {
          cache:
            "no-store"
        }
      );


    const data =
      await response.json();


    if(
      data.result
    ){

      render(
        data.result
      );


      document.getElementById(
        "status"
      ).textContent =
        "Sistem aktif · canlı fiyatlar güncelleniyor.";

    } else {

      document.getElementById(
        "status"
      ).textContent =
        "İlk tarama yapılıyor...";

    }


  } catch(error){

    document.getElementById(
      "status"
    ).textContent =
      "Bağlantı hatası: " +
      error.message;
  }
}


load();


setInterval(
  load,
  10000
);

</script>

</body>

</html>`;


/*
=========================================================
ROUTES
=========================================================
*/

app.get(
  '/',
  (req, res) => {

    res.setHeader(
      'Content-Type',
      'text/html; charset=utf-8'
    );


    res.setHeader(
      'Cache-Control',
      'no-store'
    );


    res.send(
      HTML
    );
  }
);


/*
=========================================================
HEALTH
=========================================================
*/

app.get(
  '/health',
  (req, res) => {

    res.json({

      success:
        true,

      status:
        'healthy',

      system:
        'Sonny AI Signal Scanner V7.0'
    });
  }
);


/*
=========================================================
STATUS
=========================================================
*/

app.get(
  '/api/status',
  (req, res) => {

    res.json({

      success:
        true,

      status:
        scanning
          ? 'SCANNING'
          : 'ONLINE',

      strategy:
        '4H BREAKOUT + 2H CONFIRMATION + RETEST + RSI + ADX',

      refresh:
        '60 SECONDS',

      lastScan,

      market:
        market.length,

      activeSignals:
        activeSignals.size,

      error:
        lastError
    });
  }
);


/*
=========================================================
MANUAL SCAN
YENİ: ADMIN_SECRET env var tanımlıysa ?secret= ile korunur.
=========================================================
*/

app.get(
  '/api/scan',
  async (req, res) => {

    if (
      ADMIN_SECRET &&
      req.query.secret !== ADMIN_SECRET
    ) {

      return res.status(401).json({

        success: false,

        error: 'Yetkisiz. ?secret= parametresi gerekli.'
      });
    }


    if (!ADMIN_SECRET) {

      log(
        'UYARI: ADMIN_SECRET tanımlı değil, /api/scan herkese açık.'
      );
    }


    res.json(
      await runRadar()
    );
  }
);


/*
=========================================================
RESULT
=========================================================
*/

app.get(
  '/api/result',
  async (req, res) => {

    res.setHeader(
      'Cache-Control',
      'no-store, no-cache, must-revalidate'
    );


    if (
      !resultCache &&
      !scanning
    ) {

      runRadar()
        .catch(
          error =>
            log(
              'İlk tarama hatası: ' +
              error.message
            )
        );
    }


    if (
      !resultCache
    ) {

      return res.json({

        success:
          true,

        scanning:
          true,

        result:
          null
      });
    }


    /*
    YENİ: Fiyat güncellemesi artık burada YAPILMIYOR.
    Bağımsız arka plan interval'i (LIVE_TRACK_MS) zaten
    activeSignals'ı güncel tutuyor. Bu endpoint sadece
    en güncel anlık görüntüyü (snapshot) döndürüyor.
    Böylece kaç istemci sayfayı açık tutarsa tutsun
    Bitget'e giden istek sayısı sabit kalıyor.
    */

    if (resultCache) {

      resultCache.signals =
        Array.from(
          activeSignals.values()
        )
        .sort(
          (a, b) =>
            b.score -
            a.score
        )
        .slice(
          0,
          CFG.MAX_SIGNALS
        );


      resultCache.stats.signals =
        resultCache.signals.length;
    }


    res.json({

      success:
        true,

      scanning,

      result:
        resultCache
    });
  }
);


/*
=========================================================
404
=========================================================
*/

app.use(
  (req, res) => {

    res.status(404).json({

      success:
        false,

      error:
        'Endpoint not found'
    });
  }
);


/*
=========================================================
SERVER
=========================================================
*/

app.listen(
  PORT,
  '0.0.0.0',
  () => {

    log(
      'Sonny AI Signal Scanner V7.0 started'
    );


    log(
      'Data source: BITGET'
    );


    log(
      'Strategy: 4H BREAKOUT + 2H CONFIRMATION + RETEST + 15M RSI + 5M RSI + VOLUME + ADX'
    );


    log(
      'Universe limit: ' +
      CFG.MARKET_LIMIT
    );


    log(
      'Fast radar: ' +
      CFG.FAST_RADAR
    );


    log(
      'Deep analysis: ' +
      CFG.ANALYZE_LIMIT
    );


    log(
      'ADX min eşik: ' +
      CFG.ADX_MIN
    );


    log(
      'Max aynı yön oranı: ' +
      CFG.MAX_SAME_DIRECTION_RATIO
    );


    log(
      'Sinyal yaş limiti (saat): ' +
      (CFG.SIGNAL_MAX_AGE_MS / 3600000)
    );


    log(
      'Radar döngüsü: her ' +
      (CFG.REFRESH_MS / 1000) +
      ' saniye'
    );


    log(
      'Canlı fiyat döngüsü: her ' +
      (CFG.LIVE_TRACK_MS / 1000) +
      ' saniye'
    );


    if (!ADMIN_SECRET) {

      log(
        'UYARI: ADMIN_SECRET env var tanımlı değil. /api/scan korumasız.'
      );
    }


    log(
      'Server listening on port ' +
      PORT
    );


    /*
    İlk tarama.
    */

    setTimeout(
      () => {

        runRadar();

      },
      3000
    );


    /*
    Her dakika yeni tarama (yeni sinyal keşfi).
    */

    setInterval(
      () => {

        runRadar();

      },
      CFG.REFRESH_MS
    );


    /*
    YENİ: canlı fiyat takibi artık kendi bağımsız,
    daha sık çalışan döngüsünde. Radar taramasından
    ayrı olduğu için TP/STOP tespiti taramalar arası
    beklemek zorunda kalmıyor.
    */

    setInterval(
      () => {

        updateLiveSignals();

        pruneExpiredSignals();

      },
      CFG.LIVE_TRACK_MS
    );

  }
);
