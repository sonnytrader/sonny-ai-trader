'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = Number(process.env.PORT || 10000);

app.use(express.json());

/* =========================================================
   SONNY AI TRADER V5.2
   500 RADAR
   150 ADAY
   40 DERİN
   4H + 2H -> 15M BREAKOUT -> RETEST -> 5M
   ========================================================= */

const CFG = {
    MAX_RADAR: 500,
    CANDIDATES: 150,
    DEEP: 40,

    MIN_VOLUME_USDT: Number(
        process.env.MIN_VOLUME_USDT || 750000
    ),

    SCAN_MS: 60000,
    LIVE_MS: 10000,

    CONCURRENCY: 5,

    M15_LIMIT: 180,
    M5_LIMIT: 120,
    H1_LIMIT: 240,

    BREAKOUT_LOOKBACK: 12,

    BREAKOUT_VOLUME: 1.15,

    RETEST_TOLERANCE: 0.005,

    RETEST_WINDOW_CANDLES: 8,

    MIN_SCORE: 68,

    MIN_RR: 1.50,

    TP2_RR: 2.25,

    TP3_RR: 3.25,

    ATR_STOP_MULTIPLIER: 1.20,

    SIGNAL_TTL: 45 * 60 * 1000,

    PENDING_TTL: 90 * 60 * 1000,

    REQUIRE_5M: false,

    AUTO_TRADE: false
};

const exchange = new ccxt.bitget({
    enableRateLimit: true,
    timeout: 25000,
    options: {
        defaultType: 'swap'
    }
});

const STATE = {
    markets: [],
    universe: [],
    candidates: [],
    deep: [],

    signals: new Map(),
    pending: new Map(),

    selected: 'BTC/USDT:USDT',
    selectedTimeframe: '15m',

    scanning: false,

    lastScan: 0,
    lastError: '',

    market: {
        label: 'YATAY',
        direction: 'FLAT',
        breadth: 50,
        green: 0,
        red: 0,
        average: 0,
        btc: 'NEUTRAL',
        eth: 'NEUTRAL'
    },

    stats: {
        universe: 0,
        candidates: 0,
        deep: 0,
        analyzed: 0,
        pending: 0,
        signals: 0,
        errors: 0
    }
};


/* =========================================================
   HELPERS
   ========================================================= */

function num(v, fallback = 0) {
    const x = Number(v);
    return Number.isFinite(x) ? x : fallback;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanSymbol(symbol) {
    return String(symbol || '')
        .replace(':USDT', '')
        .replace('/USDT', '') + 'USDT';
}

function normalizeSymbol(symbol) {
    const s = String(symbol || '').toUpperCase();

    if (s.includes('/USDT:USDT')) {
        return s;
    }

    if (s.includes('/USDT')) {
        return s.replace('/USDT', '/USDT:USDT');
    }

    if (s.endsWith('USDT')) {
        return s.slice(0, -4) + '/USDT:USDT';
    }

    return s + '/USDT:USDT';
}

function priceFormat(value) {
    const x = Number(value);

    if (!Number.isFinite(x)) {
        return '-';
    }

    if (x >= 1000) return x.toFixed(2);
    if (x >= 100) return x.toFixed(2);
    if (x >= 1) return x.toFixed(4);
    if (x >= 0.01) return x.toFixed(6);
    if (x >= 0.0001) return x.toFixed(8);

    return x.toFixed(10);
}

function closed(candles) {
    if (!Array.isArray(candles)) {
        return [];
    }

    if (candles.length < 2) {
        return candles;
    }

    return candles.slice(0, -1);
}

function average(values) {
    if (!values.length) return 0;

    return values.reduce(
        (sum, value) => sum + value,
        0
    ) / values.length;
}

function mapLimit(items, limit, worker) {
    const result = new Array(items.length);
    let cursor = 0;

    async function runner() {
        while (true) {
            const index = cursor++;

            if (index >= items.length) {
                return;
            }

            try {
                result[index] =
                    await worker(items[index], index);
            } catch (error) {
                result[index] = null;

                STATE.stats.errors += 1;

                console.error(
                    'ANALIZ ERROR:',
                    items[index] &&
                    items[index].symbol
                        ? items[index].symbol
                        : 'UNKNOWN',
                    '|',
                    error.message
                );
            }

            await sleep(35);
        }
    }

    const workers = Math.min(
        limit,
        items.length
    );

    return Promise.all(
        Array.from(
            { length: workers },
            () => runner()
        )
    ).then(
        () => result.filter(Boolean)
    );
}


/* =========================================================
   INDICATORS
   ========================================================= */

function ema(candles, period) {
    const c = closed(candles);

    if (c.length < period) {
        return null;
    }

    let value =
        average(
            c
                .slice(0, period)
                .map(x => num(x[4]))
        );

    const k = 2 / (period + 1);

    for (
        let i = period;
        i < c.length;
        i++
    ) {
        value =
            num(c[i][4]) * k +
            value * (1 - k);
    }

    return value;
}

function rsi(candles, period = 14) {
    const c = closed(candles);

    if (c.length < period + 1) {
        return 50;
    }

    let gain = 0;
    let loss = 0;

    for (
        let i = c.length - period;
        i < c.length;
        i++
    ) {
        const change =
            num(c[i][4]) -
            num(c[i - 1][4]);

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
        (gain / period) /
        (loss / period);

    return 100 - (
        100 / (1 + rs)
    );
}

function atr(candles, period = 14) {
    const c = closed(candles);

    if (c.length < period + 1) {
        return 0;
    }

    const values = [];

    for (let i = 1; i < c.length; i++) {
        const high = num(c[i][2]);
        const low = num(c[i][3]);
        const prev = num(c[i - 1][4]);

        values.push(
            Math.max(
                high - low,
                Math.abs(high - prev),
                Math.abs(low - prev)
            )
        );
    }

    return average(
        values.slice(-period)
    );
}

function volumeRatio(candles, period = 20) {
    const c = closed(candles);

    if (c.length < period + 1) {
        return 1;
    }

    const current =
        num(
            c[c.length - 1][5]
        );

    const previous =
        c
            .slice(
                -period - 1,
                -1
            )
            .map(x => num(x[5]))
            .filter(x => x > 0);

    if (!previous.length) {
        return 1;
    }

    const avg =
        average(previous);

    return avg > 0
        ? current / avg
        : 1;
}

function trend(candles) {
    const c = closed(candles);

    if (c.length < 55) {
        return 'NEUTRAL';
    }

    const e21 =
        ema(candles, 21);

    const e50 =
        ema(candles, 50);

    if (
        e21 === null ||
        e50 === null
    ) {
        return 'NEUTRAL';
    }

    const last =
        num(
            c[c.length - 1][4]
        );

    if (
        last > e21 &&
        e21 > e50
    ) {
        return 'LONG';
    }

    if (
        last < e21 &&
        e21 < e50
    ) {
        return 'SHORT';
    }

    return 'NEUTRAL';
}


/* =========================================================
   TIMEFRAME AGGREGATION
   1H -> 2H / 4H
   ========================================================= */

function aggregateCandles(
    candles,
    bucketHours
) {
    if (
        !Array.isArray(candles) ||
        !candles.length
    ) {
        return [];
    }

    const bucketMs =
        bucketHours *
        60 *
        60 *
        1000;

    const buckets = new Map();

    for (const candle of candles) {
        const ts = num(candle[0]);

        if (!ts) {
            continue;
        }

        const bucket =
            Math.floor(
                ts / bucketMs
            ) *
            bucketMs;

        if (!buckets.has(bucket)) {
            buckets.set(
                bucket,
                {
                    time: bucket,
                    open: num(candle[1]),
                    high: num(candle[2]),
                    low: num(candle[3]),
                    close: num(candle[4]),
                    volume: num(candle[5])
                }
            );
        } else {
            const item =
                buckets.get(bucket);

            item.high =
                Math.max(
                    item.high,
                    num(candle[2])
                );

            item.low =
                Math.min(
                    item.low,
                    num(candle[3])
                );

            item.close =
                num(candle[4]);

            item.volume +=
                num(candle[5]);
        }
    }

    return [
        ...buckets.values()
    ]
        .sort(
            (a, b) =>
                a.time - b.time
        )
        .map(
            item => [
                item.time,
                item.open,
                item.high,
                item.low,
                item.close,
                item.volume
            ]
        );
}


/* =========================================================
   LEVELS
   ========================================================= */

function levels(
    candles,
    lookback = 24
) {
    const c =
        closed(candles);

    if (
        c.length <
        lookback + 3
    ) {
        return null;
    }

    const base =
        c.slice(
            -(lookback + 1),
            -1
        );

    return {
        high:
            Math.max(
                ...base.map(
                    x => num(x[2])
                )
            ),

        low:
            Math.min(
                ...base.map(
                    x => num(x[3])
                )
            )
    };
}


/* =========================================================
   BITGET MARKETLERİ
   ========================================================= */

async function loadMarkets() {

    const markets =
        await exchange.loadMarkets(
            true
        );

    STATE.markets =
        Object.values(
            markets
        )
            .filter(
                market =>

                    market &&
                    market.active !== false &&
                    market.swap &&
                    market.linear &&
                    market.quote === 'USDT' &&
                    market.settle === 'USDT'
            );

    return STATE.markets;
}


/* =========================================================
   TICKERS
   ========================================================= */

async function fetchRadar() {

    const tickers =
        await exchange.fetchTickers();

    const rows = [];

    for (
        const market
        of STATE.markets
    ) {

        const ticker =
            tickers[
                market.symbol
            ];

        if (!ticker) {
            continue;
        }

        const last =
            num(
                ticker.last ||
                ticker.close
            );

        const volume =
            num(
                ticker.quoteVolume
            );

        const change =
            num(
                ticker.percentage
            );

        if (
            last <= 0 ||
            volume <= 0
        ) {
            continue;
        }

        rows.push({

            symbol:
                market.symbol,

            price:
                last,

            volume,

            change,

            high:
                num(ticker.high),

            low:
                num(ticker.low)
        });
    }

    rows.sort(
        (a, b) =>
            (
                b.volume *
                (
                    1 +
                    Math.abs(b.change) /
                    100
                )
            ) -
            (
                a.volume *
                (
                    1 +
                    Math.abs(a.change) /
                    100
                )
            )
    );

    return rows.slice(
        0,
        CFG.MAX_RADAR
    );
}


/* =========================================================
   MARKET DIRECTION
   ========================================================= */

async function updateMarketRegime(
    rows
) {

    const valid =
        rows.filter(
            item =>
                Number.isFinite(
                    item.change
                )
        );

    const green =
        valid.filter(
            item =>
                item.change > 0
        ).length;

    const red =
        valid.filter(
            item =>
                item.change < 0
        ).length;

    const avg =
        valid.length
            ? average(
                valid.map(
                    item =>
                        item.change
                )
            )
            : 0;

    const breadth =
        valid.length
            ? (
                green /
                valid.length
            ) * 100
            : 50;

    let btc =
        'NEUTRAL';

    let eth =
        'NEUTRAL';

    try {

        const btc =
            findMarket(
                'BTCUSDT'
            );

        if (btc) {
            const h1 =
                await getRawCandles(
                    btc.symbol,
                    '1h',
                    100
                );

            btc = trend(h1);
        }

    } catch (_) {}

    try {

        const eth =
            findMarket(
                'ETHUSDT'
            );

        if (eth) {
            const h1 =
                await getRawCandles(
                    eth.symbol,
                    '1h',
                    100
                );

            eth = trend(h1);
        }

    } catch (_) {}

    /*
    Genel piyasa durumunu aşırı katı yapmıyoruz.
    Çünkü altcoin scalp fırsatını sırf piyasa %55 green
    diye öldürmek istemiyoruz.
    */

    let direction =
        'FLAT';

    let label =
        'YATAY / KARIŞIK';

    if (
        breadth >= 62 &&
        avg >= 0.40
    ) {

        direction =
            'LONG';

        label =
            'YÜKSELİŞ';

    } else if (
        breadth <= 38 &&
        avg <= -0.40
    ) {

        direction =
            'SHORT';

        label =
            'DÜŞÜŞ';

    }

    STATE.market = {

        label,

        direction,

        breadth:
            Number(
                breadth.toFixed(1)
            ),

        green,

        red,

        average:
            Number(
                avg.toFixed(2)
            ),

        btc,
        eth,

        reason:
            `Breadth %${breadth.toFixed(1)} • ` +
            `Yeşil ${green} • Kırmızı ${red} • ` +
            `Ortalama ${avg.toFixed(2)}%`
    };
}


/* =========================================================
   RAW CANDLES
========================================================= */

async function getRawCandles(
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
   ANALİZ CANDLES
========================================================= */

async function getAnalysisData(
    symbol
) {

    /*
    Sadece desteklenen ve güvenli zaman
    dilimlerini doğrudan Bitget'ten alıyoruz.

    4H/2H:
    1H -> server tarafında aggregate.
    */

    const [
        h1,
        m15,
        m5
    ] =
        await Promise.all([

            getRawCandles(
                symbol,
                '1h',
                CFG.H1_LIMIT
            ),

            getRawCandles(
                symbol,
                '15m',
                CFG.M15_LIMIT
            ),

            getRawCandles(
                symbol,
                '5m',
                CFG.M5_LIMIT
            )
        ]);

    const h2 =
        aggregateCandles(
            h1,
            2
        );

    const h4 =
        aggregateCandles(
            h1,
            4
        );

    return {

        h1,
        h2,
        h4,
        m15,
        m5
    };
}


/* =========================================================
   BREAKOUT DETECTION
========================================================= */

function detectBreakout(
    candles,
    direction,
    level
) {

    const c =
        closed(candles);

    if (
        c.length < 20
    ) {
        return null;
    }

    const start =
        Math.max(
            1,
            c.length -
            CFG.RETEST_WINDOW_CANDLES
        );

    for (
        let i = start;
        i < c.length;
        i++
    ) {

        const candle =
            c[i];

        const previous =
            c[i - 1];

        const close =
            num(candle[4]);

        const volume =
            num(candle[5]);

        const body =
            Math.abs(
                num(candle[4]) -
                num(candle[1])
            );

        const candleRange =
            Math.max(
                num(candle[2]) -
                num(candle[3]),
                1e-12
            );

        /*
        Kırılım mumu hacmi.
        */

        const before =
            c.slice(
                Math.max(
                    0,
                    i - 20
                ),
                i
            );

        const avgVol =
            average(
                before
                    .map(
                        x =>
                            num(x[5])
                    )
                    .filter(
                        x => x > 0
                    )
            ) || volume;

        const vr =
            avgVol > 0
                ? volume / avgVol
                : 1;

        /*
        LONG
        */

        if (
            direction === 'LONG' &&

            close > level &&

            num(previous[4]) <= level &&

            vr >= CFG.BREAKOUT_VOLUME &&

            body / candleRange >= 0.20
        ) {

            return {

                time:
                    num(candle[0]),

                level,

                volumeRatio:
                    vr,

                close
            };
        }

        /*
        SHORT
        */

        if (
            direction === 'SHORT' &&

            close < level &&

            num(previous[4]) >= level &&

            vr >= CFG.BREAKOUT_VOLUME &&

            body / candleRange >= 0.20
        ) {

            return {

                time:
                    num(candle[0]),

                level,

                volumeRatio:
                    vr,

                close
            };
        }
    }

    return null;
}


/* =========================================================
   RETEST
========================================================= */

function findRetest(
    candles,
    breakout,
    direction
) {

    if (!breakout) {
        return null;
    }

    const c =
        closed(candles);

    const after =
        c.filter(
            candle =>
                num(candle[0]) >
                breakout.time
        )
        .slice(
            0,
            CFG.RETEST_WINDOW_CANDLES
        );

    if (!after.length) {
        return null;
    }

    const tolerance =
        breakout.level *
        CFG.RETEST_TOLERANCE;

    let touched =
        false;

    let survived =
        false;

    for (
        const candle
        of after
    ) {

        const high =
            num(candle[2]);

        const low =
            num(candle[3]);

        const close =
            num(candle[4]);

        const touches =
            high >=
                breakout.level -
                tolerance &&

            low <=
                breakout.level +
                tolerance;

        if (
            touches
        ) {

            touched =
                true;

            if (
                direction ===
                'LONG'
            ) {

                if (
                    close >=
                    breakout.level *
                    (
                        1 -
                        CFG.RETEST_TOLERANCE
                    )
                ) {

                    survived =
                        true;

                }

            } else {

                if (
                    close <=
                    breakout.level *
                    (
                        1 +
                        CFG.RETEST_TOLERANCE
                    )
                ) {

                    survived =
                        true;

                }

            }
        }
    }

    if (
        touched &&
        survived
    ) {

        return {
            ok:
                true,

            last:
                after[
                    after.length - 1
                ]
        };
    }

    return {
        ok:
            false
    };
}


/* =========================================================
   TRADE PLAN
========================================================= */

function createPlan(
    analysis,
    direction,
    level
) {

    const m15 =
        analysis.m15;

    const c =
        closed(m15);

    if (
        c.length < 20
    ) {
        return null;
    }

    const current =
        num(
            c[
                c.length - 1
            ][4]
        );

    const currentAtr =
        atr(
            m15,
            14
        ) ||
        current *
        0.006;

    const recent =
        c.slice(
            -6
        );

    const swingLow =
        Math.min(
            ...recent.map(
                x => num(x[3])
            )
        );

    const swingHigh =
        Math.max(
            ...recent.map(
                x => num(x[2])
            )
        );

    let entry;
    let stop;

    if (
        direction === 'LONG'
    ) {

        entry =
            Math.max(
                level,
                current
            );

        stop =
            Math.min(
                swingLow,
                level -
                currentAtr *
                CFG.ATR_STOP_MULTIPLIER
            );

        if (
            stop >= entry
        ) {

            stop =
                entry -
                currentAtr *
                CFG.ATR_STOP_MULTIPLIER;
        }

    } else {

        entry =
            Math.min(
                level,
                current
            );

        stop =
            Math.max(
                swingHigh,
                level +
                currentAtr *
                CFG.ATR_STOP_MULTIPLIER
            );

        if (
            stop <= entry
        ) {

            stop =
                entry +
                currentAtr *
                CFG.ATR_STOP_MULTIPLIER;
        }
    }

    const risk =
        Math.abs(
            entry -
            stop
        );

    if (
        !Number.isFinite(
            risk
        ) ||
        risk <= 0
    ) {

        return null;
    }

    let tp1;
    let tp2;
    let tp3;

    if (
        direction === 'LONG'
    ) {

        tp1 =
            entry +
            risk *
            CFG.MIN_RR;

        tp2 =
            entry +
            risk *
            CFG.TP2_RR;

        tp3 =
            entry +
            risk *
            CFG.TP3_RR;

    } else {

        tp1 =
            entry -
            risk *
            CFG.MIN_RR;

        tp2 =
            entry -
            risk *
            CFG.TP2_RR;

        tp3 =
            entry -
            risk *
            CFG.TP3_RR;
    }

    /*
    KESİN SIRALAMA.
    */

    if (
        direction === 'LONG'
    ) {

        if (
            !(
                stop <
                entry &&
                entry <
                tp1 &&
                tp1 <
                tp2 &&
                tp2 <
                tp3
            )
        ) {

            return null;
        }

    } else {

        if (
            !(
                tp3 <
                tp2 &&
                tp2 <
                tp1 &&
                tp1 <
                entry &&
                entry <
                stop
            )
        ) {

            return null;
        }
    }

    return {

        entry,

        entryLow:
            direction === 'LONG'
                ? level
                : entry,

        entryHigh:
            direction === 'LONG'
                ? entry
                : level,

        stop,

        tp1,

        tp2,

        tp3,

        rr:
            Number(
                (
                    Math.abs(
                        tp1 -
                        entry
                    ) /
                    risk
                )
                .toFixed(2)
            ),

        rsi:
            Number(
                rsi(
                    m15
                )
                .toFixed(1)
            )
    };
}


/* =========================================================
   ANALYZE ONE COIN
========================================================= */

async function analyzeCoin(
    row
) {

    const data =
        await getAnalysisData(
            row.symbol
        );

    if (
        data.h4.length < 55 ||
        data.h2.length < 55 ||
        data.m15.length < 40 ||
        data.m5.length < 25
    ) {

        return null;
    }

    const h4Trend =
        trend(
            data.h4
        );

    const h2Trend =
        trend(
            data.h2
        );

    const m15Trend =
        trend(
            data.m15
        );

    const m5Trend =
        trend(
            data.m5
        );

    const h4Levels =
        levels(
            data.h4,
            20
        );

    const h2Levels =
        levels(
            data.h2,
            20
        );

    if (
        !h4Levels ||
        !h2Levels
    ) {

        return null;
    }

    /*
    Adayı hem 4H hem 2H seviyesiyle
    kontrol ediyoruz.

    4H ana seviye.
    2H ise yakın destek/direnç.
    */

    const directions =
        [
            'LONG',
            'SHORT'
        ];

    let best =
        null;


    for (
        const direction
        of directions
    ) {

        /*
        4H ana seviye
        */

        const h4Level =
            direction ===
            'LONG'
                ? h4Levels.high
                : h4Levels.low;

        /*
        2H seviye
        */

        const h2Level =
            direction ===
            'LONG'
                ? h2Levels.high
                : h2Levels.low;

        /*
        Önce 4H breakout.
        */

        let breakout =
            detectBreakout(
                data.m15,
                direction,
                h4Level
            );

        /*
        4H yoksa 2H dene.
        Bu sayede altcoin fırsatları
        gereksiz şekilde kaçmıyor.
        */

        if (
            !breakout
        ) {

            breakout =
                detectBreakout(
                    data.m15,
                    direction,
                    h2Level
                );
        }

        if (
            !breakout
        ) {

            continue;
        }

        /*
        5M teyidi ZORUNLU DEĞİL.
        Skora bonus.
        */

        let fiveBonus =
            0;

        if (
            m5Trend ===
            direction
        ) {

            fiveBonus =
                10;
        }


        /*
        Trend uyumu.
        */

        let score =
            45;

        if (
            h4Trend ===
            direction
        ) {

            score +=
                18;
        }

        if (
            h2Trend ===
            direction
        ) {

            score +=
                15;
        }

        if (
            m15Trend ===
            direction
        ) {

            score +=
                8;
        }

        if (
            breakout.volumeRatio >=
            1.5
        ) {

            score +=
                8;
        }

        if (
            breakout.volumeRatio >=
            2
        ) {

            score +=
                5;
        }

        score +=
            fiveBonus;


        /*
        RSI.
        */

        const currentRsi =
            rsi(
                data.m15
            );

        if (
            direction ===
            'LONG' &&
            currentRsi >= 48 &&
            currentRsi <= 74
        ) {

            score +=
                5;
        }

        if (
            direction ===
            'SHORT' &&
            currentRsi >= 26 &&
            currentRsi <= 52
        ) {

            score +=
                5;
        }


        /*
        Genel piyasa açıkça ters değilse
        altcoin kendi setup'ını koruyabilir.

        Bu özellikle önemli:
        piyasa FLAT ise LONG/SHORT öldürme.
        */

        if (
            STATE.market.direction ===
            direction
        ) {

            score +=
                6;
        }

        /*
        Piyasa ters ve trend de tersse
        yalnızca güçlü setup'ları ele.
        */

        if (
            STATE.market.direction !==
            'FLAT' &&

            STATE.market.direction !==
            direction &&

            h4Trend !==
            direction
        ) {

            continue;
        }


        /*
        RETEST
        */

        const retest =
            findRetest(
                data.m15,
                breakout,
                direction
            );


        /*
        Retest oluşmadıysa
        pending bırak.
        */

        if (
            !retest ||
            !retest.ok
        ) {

            const key =
                row.symbol +
                '|' +
                direction +
                '|' +
                breakout.level;

            STATE.pending.set(
                key,
                {

                    symbol:
                        row.symbol,

                    direction,

                    level:
                        breakout.level,

                    price:
                        row.price,

                    volumeRatio:
                        breakout.volumeRatio,

                    status:
                        'RETEST BEKLENİYOR',

                    createdAt:
                        Date.now()
                }
            );

            continue;
        }


        if (
            score <
            CFG.MIN_SCORE
        ) {

            continue;
        }


        const plan =
            createPlan(
                data,
                direction,
                breakout.level
            );


        if (
            !plan
        ) {

            continue;
        }


        /*
        Plan hazır.
        */

        const signal = {

            symbol:
                row.symbol,

            marketSymbol:
                row.symbol,

            coin:
                cleanSymbol(
                    row.symbol
                ),

            direction,

            price:
                row.price,

            currentPrice:
                row.price,

            score:
                Math.min(
                    100,
                    Math.round(
                        score
                    )
                ),

            entry:
                plan.entry,

            entryLow:
                Math.min(
                    plan.entryLow,
                    plan.entryHigh
                ),

            entryHigh:
                Math.max(
                    plan.entryLow,
                    plan.entryHigh
                ),

            stop:
                plan.stop,

            stopLoss:
                plan.stop,

            tp1:
                plan.tp1,

            tp2:
                plan.tp2,

            tp3:
                plan.tp3,

            rr:
                plan.rr,

            rsi:
                plan.rsi,

            volumeRatio:
                breakout.volumeRatio,

            breakoutLevel:
                breakout.level,

            h4Trend,

            h2Trend,

            m15Trend,

            m5Trend,

            status:
                'GİRİŞ ALANI',

            reason:
                `4H ${h4Trend} • ` +
                `2H ${h2Trend} • ` +
                `15M BREAKOUT + RETEST • ` +
                `5M ${m5Trend} • ` +
                `VOL ${breakout.volumeRatio.toFixed(2)}x`,

            signalAt:
                Date.now(),

            timeframe:
                '15m',

            key:
                row.symbol +
                '|' +
                direction
        };


        if (
            !best ||
            signal.score >
            best.score
        ) {

            best =
                signal;
        }
    }

    return best;
}


/* =========================================================
   CLEANUP
========================================================= */

function cleanup() {

    const now =
        Date.now();

    for (
        const [
            key,
            signal
        ]
        of STATE.signals
    ) {

        if (
            now -
            signal.signalAt >
            CFG.SIGNAL_TTL
        ) {

            STATE.signals.delete(
                key
            );
        }
    }

    for (
        const [
            key,
            pending
        ]
        of STATE.pending
    ) {

        if (
            now -
            pending.createdAt >
            CFG.PENDING_TTL
        ) {

            STATE.pending.delete(
                key
            );
        }
    }

    STATE.stats.pending =
        STATE.pending.size;

    STATE.stats.signals =
        STATE.signals.size;
}


/* =========================================================
   RADAR
========================================================= */

async function runScan() {

    if (
        STATE.scanning
    ) {

        return;
    }

    STATE.scanning =
        true;

    STATE.lastError =
        '';

    const started =
        Date.now();

    /*
    Hata sayısını bu taramada sıfırla.
    */

    STATE.stats.errors =
        0;


    try {

        /*
        MARKETLER
        */

        if (
            !STATE.markets.length
        ) {

            await loadMarkets();

            console.log(
                'MARKETS | Gerçek USDT perpetual=' +
                STATE.markets.length
            );
        }


        /*
        500 RADAR
        */

        const rows =
            await fetchRadar();

        STATE.universe =
            rows;

        STATE.stats.universe =
            rows.length;


        /*
        PİYASA
        */

        await updateMarketRegime(
            rows
        );


        /*
        150 ADAY
        */

        STATE.candidates =
            rows
                .filter(
                    row =>
                        row.volume >=
                        CFG.MIN_VOLUME_USDT
                )
                .slice(
                    0,
                    CFG.CANDIDATES
                );

        STATE.stats.candidates =
            STATE.candidates.length;


        /*
        40 DERİN
        */

        STATE.deep =
            STATE.candidates.slice(
                0,
                CFG.DEEP
            );

        STATE.stats.deep =
            STATE.deep.length;


        /*
        DERİN ANALİZ
        */

        const analyzed =
            await mapLimit(
                STATE.deep,
                CFG.CONCURRENCY,
                analyzeCoin
            );

        STATE.stats.analyzed =
            analyzed.length;


        /*
        SİNYALLER
        */

        for (
            const signal
            of analyzed
        ) {

            if (
                !signal
            ) {

                continue;
            }

            STATE.signals.set(
                signal.key,
                signal
            );

            STATE.selected =
                signal.symbol;


            console.log(

                'SIGNAL | ' +
                cleanSymbol(
                    signal.symbol
                ) +
                ' | ' +
                signal.direction +
                ' | SCORE ' +
                signal.score +
                ' | RR 1:' +
                signal.rr

            );
        }


        cleanup();

        STATE.lastScan =
            Date.now();


        console.log(

            'RADAR tamamlandı | ' +

            'Universe=' +
            STATE.stats.universe +

            ' | Candidates=' +
            STATE.stats.candidates +

            ' | Deep=' +
            STATE.stats.deep +

            ' | Analiz=' +
            STATE.stats.analyzed +

            ' | Pending=' +
            STATE.pending.size +

            ' | SIGNAL=' +
            STATE.signals.size +

            ' | ERR=' +
            STATE.stats.errors +

            ' | ' +

            (
                (
                    Date.now() -
                    started
                ) /
                1000
            ).toFixed(1) +
            's'
        );


    } catch (
        error
    ) {

        STATE.lastError =
            error.message;

        console.error(
            'RADAR ERROR:',
            error.message
        );

    } finally {

        STATE.scanning =
            false;

        broadcast();
    }
}


/* =========================================================
   LIVE SIGNALS
========================================================= */

async function updateLive() {

    const signals =
        [
            ...STATE.signals.values()
        ];

    if (
        !signals.length
    ) {

        return;
    }


    await mapLimit(
        signals,
        4,
        async signal => {

            try {

                const market =
                    findMarket(
                        signal.symbol
                    );

                if (
                    !market
                ) {

                    return signal;
                }


                const ticker =
                    await exchange.fetchTicker(
                        market.symbol
                    );


                const current =
                    num(
                        ticker.last ||
                        ticker.close
                    );


                if (
                    !Number.isFinite(
                        current
                    )
                ) {

                    return signal;
                }


                signal.currentPrice =
                    current;


                if (
                    signal.direction ===
                    'LONG'
                ) {

                    if (
                        current <=
                        signal.stop
                    ) {

                        signal.status =
                            'STOP';

                    } else if (
                        current >=
                        signal.tp3
                    ) {

                        signal.status =
                            'TP3';

                    } else if (
                        current >=
                        signal.tp2
                    ) {

                        signal.status =
                            'TP2';

                    } else if (
                        current >=
                        signal.tp1
                    ) {

                        signal.status =
                            'TP1';

                    } else if (
                        current >=
                        signal.entryLow &&
                        current <=
                        signal.entryHigh
                    ) {

                        signal.status =
                            'GİRİŞ ALANI';
                    }

                } else {

                    if (
                        current >=
                        signal.stop
                    ) {

                        signal.status =
                            'STOP';

                    } else if (
                        current <=
                        signal.tp3
                    ) {

                        signal.status =
                            'TP3';

                    } else if (
                        current <=
                        signal.tp2
                    ) {

                        signal.status =
                            'TP2';

                    } else if (
                        current <=
                        signal.tp1
                    ) {

                        signal.status =
                            'TP1';

                    } else if (
                        current >=
                        signal.entryLow &&
                        current <=
                        signal.entryHigh
                    ) {

                        signal.status =
                            'GİRİŞ ALANI';
                    }
                }

                return signal;

            } catch (_) {

                return signal;
            }
        }
    );


    cleanup();

    broadcast();
}


/* =========================================================
   PUBLIC STATE
========================================================= */

function publicSignal(
    signal
) {

    return {

        ...signal,

        symbol:
            cleanSymbol(
                signal.symbol
            ),

        marketSymbol:
            signal.marketSymbol,

        ageSeconds:
            Math.floor(
                (
                    Date.now() -
                    signal.signalAt
                ) /
                1000
            )
    };
}


function statusData() {

    return {

        success:
            true,

        engine:
            'SONNY AI TRADER V5.2',

        autoTrade:
            CFG.AUTO_TRADE,

        lastScan:
            STATE.lastScan,

        scanning:
            STATE.scanning,

        error:
            STATE.lastError,

        stats: {

            universe:
                STATE.stats.universe,

            candidates:
                STATE.stats.candidates,

            deep:
                STATE.stats.deep,

            analyzed:
                STATE.stats.analyzed,

            pending:
                STATE.pending.size,

            signals:
                STATE.signals.size,

            errors:
                STATE.stats.errors
        },

        market:
            STATE.market,

        signals:

            [
                ...STATE.signals.values()
            ]
                .sort(
                    (
                        a,
                        b
                    ) =>
                        b.score -
                        a.score
                )
                .slice(
                    0,
                    CFG.MAX_SIGNALS
                )
                .map(
                    publicSignal
                ),

        pending:
            [
                ...STATE.pending.values()
            ]
                .sort(
                    (
                        a,
                        b
                    ) =>
                        b.createdAt -
                        a.createdAt
                )
                .slice(
                    0,
                    20
                )
                .map(
                    item => ({

                        symbol:
                            cleanSymbol(
                                item.symbol
                            ),

                        direction:
                            item.direction,

                        level:
                            item.level,

                        price:
                            item.price,

                        volumeRatio:
                            item.volumeRatio,

                        status:
                            item.status,

                        createdAt:
                            item.createdAt
                    })
                )
    };
}


/* =========================================================
   BROADCAST
========================================================= */

function broadcast() {

    const payload =
        JSON.stringify({

            type:
                'snapshot',

            data:
                statusData()
        });


    for (
        const client
        of wss.clients
    ) {

        if (
            client.readyState ===
            WebSocket.OPEN
        ) {

            try {

                client.send(
                    payload
                );

            } catch (_) {}
        }
    }
}


/* =========================================================
   API
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

            service:
                'Sonny AI Trader V5.2',

            uptime:
                process.uptime(),

            scanning:
                STATE.scanning,

            stats:
                STATE.stats,

            market:
                STATE.market,

            error:
                STATE.lastError
        });
    }
);


app.get(
    '/api/status',
    (
        req,
        res
    ) => {

        res.json(
            statusData()
        );
    }
);


app.get(
    '/api/signals',
    (
        req,
        res
    ) => {

        res.json(
            statusData()
        );
    }
);


app.get(
    '/api/scalp-radar',
    (
        req,
        res
    ) => {

        res.json(
            statusData()
        );
    }
);


app.get(
    '/api/scan',
    (
        req,
        res
    ) => {

        if (
            STATE.scanning
        ) {

            return res.json({

                success:
                    false,

                message:
                    'Tarama zaten devam ediyor.'
            });
        }


        runScan();


        res.json({

            success:
                true,

            message:
                'Tarama başlatıldı.'
        });
    }
);


/* =========================================================
   CHART
========================================================= */

app.get(
    '/api/chart',
    async (
        req,
        res
    ) => {

        try {

            const query =
                req.query.symbol ||
                STATE.selected;


            const market =
                findMarket(
                    query
                );


            if (
                !market
            ) {

                return res
                    .status(404)
                    .json({

                        success:
                            false,

                        error:
                            'Coin bulunamadı.'
                    });
            }


            const allowed = [

                '5m',
                '15m',
                '1h',
                '2h',
                '4h'

            ];


            const requested =
                String(
                    req.query.timeframe ||
                    '15m'
                );


            const timeframe =
                allowed.includes(
                    requested
                )
                    ? requested
                    : '15m';


            let candles;


            if (
                timeframe ===
                '2h'
            ) {

                const h1 =
                    await getRawCandles(
                        market.symbol,
                        '1h',
                        CFG.CHART_LIMIT * 2
                    );

                candles =
                    aggregateCandles(
                        h1,
                        2
                    );

            } else if (
                timeframe ===
                '4h'
            ) {

                const h1 =
                    await getRawCandles(
                        market.symbol,
                        '1h',
                        CFG.CHART_LIMIT * 4
                    );

                candles =
                    aggregateCandles(
                        h1,
                        4
                    );

            } else {

                candles =
                    await getRawCandles(
                        market.symbol,
                        timeframe,
                        CFG.CHART_LIMIT
                    );
            }


            const signal =
                [
                    ...STATE.signals.values()
                ]
                    .find(
                        item =>
                            item.symbol ===
                            market.symbol
                    ) ||
                null;


            STATE.selected =
                market.symbol;

            STATE.selectedTimeframe =
                timeframe;


            res.json({

                success:
                    true,

                symbol:
                    market.symbol,

                timeframe,

                candles:
                    candles.map(
                        item => ({

                            time:
                                item[0],

                            open:
                                item[1],

                            high:
                                item[2],

                            low:
                                item[3],

                            close:
                                item[4],

                            volume:
                                item[5]
                        })
                    ),

                signal:
                    signal
                        ? publicSignal(
                            signal
                        )
                        : null
            });


        } catch (
            error
        ) {

            console.error(
                'CHART ERROR:',
                error.message
            );


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
   FRONTEND
   Tek dosyada.
   ========================================================= */

const HTML =
String.raw`<!doctype html>

<html lang="tr">

<head>

<meta charset="utf-8">

<meta
    name="viewport"
    content="width=device-width,initial-scale=1"
>

<title>
SONNY AI TRADER V5.2
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

    background:#070b11;

    color:#eef3f8;

    font-family:
        Arial,
        Helvetica,
        sans-serif;

}

button{

    font:inherit;

}

.app{

    min-height:100vh;

    display:grid;

    grid-template-columns:
        235px
        minmax(0,1fr)
        285px;

}

.sidebar{

    border-right:
        1px solid #202936;

    background:#080d14;

    padding:12px 10px;

    overflow:auto;

}

.brand{

    font-size:19px;

    font-weight:900;

    margin:3px 4px 2px;

}

.sub{

    color:#718096;

    font-size:9px;

    margin:0 4px 12px;

}

.scan{

    width:100%;

    border:0;

    padding:10px;

    color:#fff;

    background:#172742;

    border-radius:7px;

    cursor:pointer;

    font-weight:800;

    margin-bottom:10px;

}

.stats{

    display:grid;

    grid-template-columns:
        repeat(3,1fr);

    gap:5px;

    margin-bottom:10px;

}

.stat{

    background:#0e151f;

    border:1px solid #202c3b;

    border-radius:6px;

    padding:7px;

    text-align:center;

}

.stat b{

    display:block;

    font-size:15px;

}

.stat span{

    color:#718096;

    font-size:8px;

}

.signal-list{

    display:flex;

    flex-direction:column;

    gap:7px;

}

.signal-card{

    background:#0e151f;

    border:1px solid #202c3b;

    border-left:3px solid #13e0a2;

    border-radius:8px;

    padding:10px;

    cursor:pointer;

}

.signal-card.short{

    border-left-color:#ff4d6d;

}

.signal-card.active{

    border-color:#3c72aa;

}

.card-top{

    display:flex;

    justify-content:space-between;

    align-items:center;

}

.coin{

    font-size:13px;

    font-weight:900;

}

.long{

    color:#13e0a2;

}

.short{

    color:#ff4d6d;

}

.badge{

    font-size:9px;

    padding:3px 6px;

    border-radius:4px;

}

.badge.long{

    color:#13e0a2;

    background:#073c2e;

}

.badge.short{

    color:#ff4d6d;

    background:#451322;

}

.card-price{

    font-size:18px;

    font-weight:900;

    margin:7px 0;

}

.card-meta{

    color:#718096;

    font-size:9px;

}

.empty{

    color:#718096;

    font-size:11px;

    padding:12px;

}

.main{

    min-width:0;

    padding:10px;

}

.header{

    height:55px;

    display:flex;

    align-items:center;

    justify-content:space-between;

}

.title{

    font-size:20px;

    font-weight:900;

}

.title small{

    display:block;

    margin-top:4px;

    color:#718096;

    font-size:9px;

    font-weight:500;

}

.market-pill{

    color:#13e0a2;

    background:#073323;

    border:1px solid #0b684a;

    border-radius:20px;

    padding:7px 10px;

    font-size:9px;

}

.chart-panel{

    border:1px solid #202c3b;

    border-radius:8px;

    overflow:hidden;

    background:#080e16;

}

.chart-head{

    height:45px;

    display:flex;

    align-items:center;

    justify-content:space-between;

    padding:0 10px;

    border-bottom:1px solid #202c3b;

}

.chart-name{

    font-size:12px;

    font-weight:900;

}

.tf{

    display:flex;

    gap:4px;

}

.tf button{

    color:#9aa8b8;

    background:#111b29;

    border:1px solid #26384f;

    border-radius:5px;

    padding:6px 8px;

    font-size:9px;

    cursor:pointer;

}

.tf button.active{

    color:#fff;

    border-color:#428cff;

    background:#172a47;

}

.canvas-wrap{

    height:
        calc(100vh - 130px);

    min-height:430px;

}

canvas{

    width:100%;

    height:100%;

    display:block;

}

.right{

    border-left:1px solid #202936;

    background:#080d14;

    padding:10px;

    overflow:auto;

}

.box{

    background:#0e151f;

    border:1px solid #202c3b;

    border-radius:8px;

    padding:11px;

    margin-bottom:9px;

}

.box-title{

    color:#8292a6;

    font-size:9px;

    font-weight:900;

    margin-bottom:8px;

    text-transform:uppercase;

}

.regime{

    color:#f4c84a;

    font-size:19px;

    font-weight:900;

}

.regime.long{

    color:#13e0a2;

}

.regime.short{

    color:#ff4d6d;

}

.market-info{

    color:#718096;

    font-size:9px;

    line-height:1.7;

    margin-top:6px;

}

.active-name{

    font-weight:900;

    font-size:15px;

    margin-bottom:8px;

}

.plan{

    display:grid;

    grid-template-columns:
        1fr
        1fr;

    gap:5px;

}

.level{

    border:1px solid #182534;

    background:#09111b;

    padding:7px;

    border-radius:5px;

}

.level span{

    display:block;

    color:#718096;

    font-size:8px;

}

.level b{

    display:block;

    font-size:11px;

    margin-top:2px;

}

.level.entry b{

    color:#13e0a2;

}

.level.stop b{

    color:#ff4d6d;

}

.level.tp b{

    color:#4da3ff;

}

.reason{

    color:#8997a8;

    font-size:9px;

    line-height:1.5;

    margin-top:8px;

}

.pending-item{

    border-left:2px solid #f4c84a;

    padding:7px;

    margin-bottom:5px;

    background:#09111b;

    border-radius:4px;

    color:#b8c3cf;

    font-size:9px;

}

@media(max-width:950px){

    .app{

        grid-template-columns:
            200px
            minmax(0,1fr);

    }

    .right{

        display:none;

    }

}

@media(max-width:650px){

    .app{

        display:block;

    }

    .sidebar{

        max-height:220px;

        border-right:0;

        border-bottom:
            1px solid #202936;

    }

    .signal-list{

        flex-direction:row;

        overflow-x:auto;

    }

    .signal-card{

        min-width:160px;

    }

    .main{

        padding:7px;

    }

    .header{

        height:45px;

    }

    .title{

        font-size:16px;

    }

    .market-pill{

        font-size:8px;

        padding:6px;

    }

    .canvas-wrap{

        height:58vh;

        min-height:340px;

    }

}

</style>

</head>


<body>


<div class="app">


<aside class="sidebar">


<div class="brand">

⚡ SONNY AI TRADER

</div>


<div class="sub">

4H/2H DESTEK-DİRENÇ •
15M BREAKOUT • RETEST •
5M SCALP

</div>


<button
    id="scan"
    class="scan"
>
RADARI YENİLE
</button>


<div class="stats">


<div class="stat">

<b id="universe">
0
</b>

<span>
RADAR
</span>

</div>


<div class="stat">

<b id="candidates">
0
</b>

<span>
ADAY
</span>

</div>


<div class="stat">

<b id="deep">
0
</b>

<span>
DERİN
</span>

</div>


</div>


<div
    id="signals"
    class="signal-list"
>

<div class="empty">

Teyit edilmiş sinyal yok.

</div>

</div>


</aside>


<main class="main">


<div class="header">


<div class="title">

<span id="pageSymbol">
BTCUSDT
</span>

•

<span id="pageTf">
15M
</span>


<small id="scanInfo">
Sistem hazırlanıyor...
</small>

</div>


<div class="market-pill">

● AUTO TRADE KAPALI

</div>


</div>


<section class="chart-panel">


<div class="chart-head">


<div
    id="chartName"
    class="chart-name"
>
BTCUSDT • 15M
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


<button data-tf="2h">
2H
</button>


<button data-tf="4h">
4H
</button>


</div>


</div>


<div class="canvas-wrap">

<canvas
    id="chart"
></canvas>

</div>


</section>


</main>


<aside class="right">


<div class="box">

<div class="box-title">
GENEL PİYASA
</div>


<div
    id="regime"
    class="regime"
>
YATAY / KARIŞIK
</div>


<div
    id="marketInfo"
    class="market-info"
>
Analiz ediliyor...
</div>

</div>


<div class="box">

<div class="box-title">
AKTİF SCALP SİNYALİ
</div>


<div id="active">

<div class="empty">
Henüz teyit edilmiş sinyal yok.
</div>

</div>

</div>


<div class="box">

<div class="box-title">
BEKLEYEN KIRILIM / RETEST
</div>


<div id="pending">

<div class="empty">
Bekleyen setup yok.
</div>

</div>

</div>


<div class="box">

<div class="box-title">
SİSTEM
</div>


<div
    id="system"
    class="market-info"
>
Bağlanıyor...
</div>

</div>


</aside>


</div>


<script>

(function(){

'use strict';


var state = {

    data:
        null,

    selected:
        'BTC/USDT:USDT',

    timeframe:
        '15m',

    candles:
        [],

    signal:
        null

};


/* =========================================================
   HELPERS
========================================================= */

function $(
    id
){

    return document.getElementById(
        id
    );

}


function esc(
    value
){

    return String(
        value == null
            ? ''
            : value
    )
    .replace(
        /[&<>"']/g,
        function(
            c
        ){

            return {

                '&':
                    '&amp;',

                '<':
                    '&lt;',

                '>':
                    '&gt;',

                '"':
                    '&quot;',

                "'":
                    '&#39;'

            }[c];

        }
    );

}


function price(
    value
){

    var x =
        Number(
            value
        );

    if (
        !Number.isFinite(
            x
        )
    ){

        return '-';

    }

    if (
        x >= 1000
    ) return x.toFixed(2);

    if (
        x >= 100
    ) return x.toFixed(2);

    if (
        x >= 1
    ) return x.toFixed(4);

    if (
        x >= 0.01
    ) return x.toFixed(6);

    if (
        x >= 0.0001
    ) return x.toFixed(8);

    return x.toFixed(10);

}


/* =========================================================
   RENDER
========================================================= */

function render(
    data
){

    state.data =
        data;


    var stats =
        data.stats ||
        {};


    $('universe')
        .textContent =
        stats.universe ||
        0;


    $('candidates')
        .textContent =
        stats.candidates ||
        0;


    $('deep')
        .textContent =
        stats.deep ||
        0;


    $('scanInfo')
        .textContent =

        data.lastScan

            ?

            'Son tarama: ' +
            new Date(
                data.lastScan
            ).toLocaleTimeString(
                'tr-TR'
            )

            :

            'Tarama bekleniyor...';


    /* =====================================================
       MARKET
    ===================================================== */

    var market =
        data.market ||
        {};


    $('regime')
        .textContent =
        market.label ||
        'YATAY / KARIŞIK';


    $('regime')
        .className =
        'regime ' +

        (
            market.direction ===
            'LONG'

                ? 'long'

                : market.direction ===
                  'SHORT'

                    ? 'short'

                    : ''
        );


    $('marketInfo')
        .innerHTML =

        'Breadth %' +
        esc(
            market.breadth
        ) +

        ' • Yeşil ' +
        esc(
            market.green
        ) +

        ' • Kırmızı ' +
        esc(
            market.red
        ) +

        '<br>Ortalama ' +
        esc(
            market.average
        ) +
        '%' +

        '<br>BTC 1H ' +
        esc(
            market.btc
        ) +

        ' • ETH 1H ' +
        esc(
            market.eth
        );


    /* =====================================================
       SIGNAL LIST
    ===================================================== */

    var signals =
        data.signals ||
        [];


    var list =
        $('signals');


    list.innerHTML =
        '';


    if (
        !signals.length
    ){

        list.innerHTML =
            '<div class="empty">' +
            'Teyit edilmiş sinyal yok.' +
            '</div>';

    }
    else {

        signals.forEach(
            function(
                signal
            ){

                var card =
                    document.createElement(
                        'div'
                    );


                card.className =
                    'signal-card ' +

                    (
                        signal.direction ===
                        'SHORT'
                            ? 'short'
                            : ''
                    ) +

                    (
                        signal.marketSymbol ===
                        state.selected
                            ? ' active'
                            : ''
                    );


                card.innerHTML =

                    '<div class="card-top">' +

                    '<div class="coin">' +

                        esc(
                            signal.symbol
                        ) +

                    '</div>' +

                    '<div class="badge ' +

                        (
                            signal.direction ===
                            'LONG'
                                ? 'long'
                                : 'short'
                        ) +

                    '">' +

                        esc(
                            signal.direction
                        ) +

                    '</div>' +

                    '</div>' +

                    '<div class="card-price">' +

                        price(
                            signal.currentPrice ||
                            signal.entry
                        ) +

                    '</div>' +

                    '<div class="card-meta">' +

                        'GİRİŞ ALANI • GÜÇ ' +

                        esc(
                            signal.score
                        ) +

                        '/100' +

                    '</div>';


                card.onclick =
                    function(){

                        state.selected =
                            signal.marketSymbol;

                        loadChart();

                    };


                list.appendChild(
                    card
                );

            }
        );

    }


    /* =====================================================
       ACTIVE
    ===================================================== */

    var selectedSignal =
        signals.find(
            function(
                signal
            ){

                return (
                    signal.marketSymbol ===
                    state.selected
                );

            }
        ) ||

        signals[0] ||

        null;


    if (
        selectedSignal
    ){

        state.selected =
            selectedSignal.marketSymbol;

        renderActive(
            selectedSignal
        );

    }
    else {

        renderActive(
            null
        );

    }


    /* =====================================================
       PENDING
    ===================================================== */

    renderPending(
        data.pending ||
        []
    );


    $('system')
        .textContent =

        data.error

            ?

            'HATA: ' +
            data.error

            :

            (
                data.scanning
                    ? 'Tarama devam ediyor...'
                    : 'SİSTEM AKTİF'
            );


    loadChart();

}


/* =========================================================
   ACTIVE SIGNAL
========================================================= */

function renderActive(
    signal
){

    if (
        !signal
    ){

        $('active')
            .innerHTML =
            '<div class="empty">' +
            'Henüz teyit edilmiş sinyal yok.' +
            '</div>';

        return;

    }


    var cls =
        signal.direction ===
        'LONG'
            ? 'long'
            : 'short';


    $('active')
        .innerHTML =

        '<div class="active-name ' +
        cls +
        '">' +

            esc(
                signal.symbol
            ) +

            ' • ' +

            esc(
                signal.direction
            ) +

        '</div>' +

        '<div class="plan">' +

            level(
                'GİRİŞ',
                price(
                    signal.entryLow
                ) +
                ' — ' +
                price(
                    signal.entryHigh
                ),
                'entry'
            ) +

            level(
                'STOP',
                price(
                    signal.stop
                ),
                'stop'
            ) +

            level(
                'TP1',
                price(
                    signal.tp1
                ),
                'tp'
            ) +

            level(
                'TP2',
                price(
                    signal.tp2
                ),
                'tp'
            ) +

            level(
                'TP3',
                price(
                    signal.tp3
                ),
                'tp'
            ) +

            level(
                'R:R',
                '1:' +
                signal.rr,
                ''
            ) +

        '</div>' +

        '<div class="reason">' +

            esc(
                signal.status
            ) +

            ' • SKOR ' +

            esc(
                signal.score
            ) +

            '/100' +

            '<br>' +

            'RSI ' +

            esc(
                signal.rsi
            ) +

            ' • VOL ' +

            esc(
                signal.volumeRatio
            ) +

            'x' +

            '<br>' +

            esc(
                signal.reason
            ) +

        '</div>';

}


function level(
    label,
    value,
    cls
){

    return (

        '<div class="level ' +
        cls +
        '">' +

            '<span>' +
            label +
            '</span>' +

            '<b>' +
            esc(
                value
            ) +
            '</b>' +

        '</div>'

    );

}


/* =========================================================
   PENDING
========================================================= */

function renderPending(
    items
){

    var box =
        $('pending');


    if (
        !items.length
    ){

        box.innerHTML =
            '<div class="empty">' +
            'Bekleyen setup yok.' +
            '</div>';

        return;

    }


    box.innerHTML =
        items.map(
            function(
                item
            ){

                return (

                    '<div class="pending-item">' +

                        '<b>' +

                            esc(
                                item.symbol
                            ) +

                            ' ' +

                            esc(
                                item.direction
                            ) +

                        '</b>' +

                        '<br>' +

                        'Seviye ' +

                        price(
                            item.level
                        ) +

                        ' • ' +

                        esc(
                            item.status
                        ) +

                    '</div>'

                );

            }
        ).join('');

}


/* =========================================================
   CHART
========================================================= */

async function loadChart(){

    try {

        var response =
            await fetch(

                '/api/chart?symbol=' +
                encodeURIComponent(
                    state.selected
                ) +

                '&timeframe=' +
                encodeURIComponent(
                    state.timeframe
                ),

                {
                    cache:
                        'no-store'
                }

            );


        var data =
            await response.json();


        if (
            !data.success
        ){

            return;

        }


        state.candles =
            data.candles ||
            [];


        state.signal =
            data.signal ||
            null;


        var symbol =
            (
                data.symbol ||
                state.selected
            )
            .replace(
                '/USDT:USDT',
                'USDT'
            );


        $('pageSymbol')
            .textContent =
            symbol;


        $('pageTf')
            .textContent =
            (
                data.timeframe ||
                state.timeframe
            )
            .toUpperCase();


        $('chartName')
            .textContent =
            symbol +
            ' • ' +
            $('pageTf')
                .textContent;


        draw();

    }
    catch (
        error
    ){

        console.error(
            'CHART:',
            error
        );

    }

}


/* =========================================================
   CHART DRAW
========================================================= */

function draw(){

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
            rect.width
        );


    var height =
        Math.max(
            1,
            rect.height
        );


    canvas.width =
        Math.floor(
            width *
            dpr
        );


    canvas.height =
        Math.floor(
            height *
            dpr
        );


    var ctx =
        canvas.getContext(
            '2d'
        );


    ctx.setTransform(
        dpr,
        0,
        0,
        dpr,
        0,
        0
    );


    ctx.clearRect(
        0,
        0,
        width,
        height
    );


    var candles =
        state.candles;


    if (
        !candles.length
    ){

        ctx.fillStyle =
            '#718096';

        ctx.font =
            '13px Arial';

        ctx.fillText(
            'Grafik verisi bekleniyor...',
            15,
            30
        );

        return;

    }


    var values =
        [];


    candles.forEach(
        function(
            candle
        ){

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


    var signal =
        state.signal;


    if (
        signal
    ){

        [

            signal.entryLow,
            signal.entryHigh,
            signal.stop,
            signal.tp1,
            signal.tp2,
            signal.tp3

        ].forEach(
            function(
                value
            ){

                if (
                    Number.isFinite(
                        Number(value)
                    )
                ){

                    values.push(
                        Number(value)
                    );

                }

            }
        );

    }


    var min =
        Math.min.apply(
            Math,
            values
        );


    var max =
        Math.max.apply(
            Math,
            values
        );


    var range =
        max -
        min;


    var padding =
        range *
        0.06 ||
        1;


    min -=
        padding;


    max +=
        padding;


    var left =
        52;


    var right =
        75;


    var top =
        15;


    var bottom =
        20;


    var plotWidth =
        Math.max(
            1,
            width -
            left -
            right
        );


    var plotHeight =
        Math.max(
            1,
            height -
            top -
            bottom
        );


    function y(
        value
    ){

        return (

            top +

            (
                max -
                Number(value)
            ) /
            (
                max -
                min
            ) *

            plotHeight

        );

    }


    function x(
        index
    ){

        return (

            left +

            (
                index /
                Math.max(
                    1,
                    candles.length - 1
                )
            ) *

            plotWidth

        );

    }


    /* GRID */

    ctx.strokeStyle =
        '#182330';

    ctx.lineWidth =
        1;


    for (
        var g = 0;
        g <= 5;
        g++
    ){

        var gy =
            top +
            plotHeight *
            g /
            5;


        ctx.beginPath();

        ctx.moveTo(
            left,
            gy
        );

        ctx.lineTo(
            width -
            right,
            gy
        );

        ctx.stroke();


        ctx.fillStyle =
            '#607083';

        ctx.font =
            '9px Arial';


        var pv =
            max -
            (
                max -
                min
            ) *
            g /
            5;


        ctx.fillText(
            price(pv),
            5,
            gy + 3
        );

    }


    /* CANDLE */

    var step =
        plotWidth /
        Math.max(
            1,
            candles.length - 1
        );


    var body =
        Math.max(
            2,
            Math.min(
                9,
                step * 0.65
            )
        );


    candles.forEach(
        function(
            candle,
            index
        ){

            var xx =
                x(index);


            var open =
                Number(
                    candle.open
                );


            var high =
                Number(
                    candle.high
                );


            var low =
                Number(
                    candle.low
                );


            var close =
                Number(
                    candle.close
                );


            var up =
                close >=
                open;


            ctx.strokeStyle =
                up
                    ? '#13e0a2'
                    : '#ff4d6d';


            ctx.fillStyle =
                up
                    ? '#13e0a2'
                    : '#ff4d6d';


            ctx.beginPath();

            ctx.moveTo(
                xx,
                y(high)
            );

            ctx.lineTo(
                xx,
                y(low)
            );

            ctx.stroke();


            var openY =
                y(open);


            var closeY =
                y(close);


            ctx.fillRect(

                xx -
                body /
                2,

                Math.min(
                    openY,
                    closeY
                ),

                body,

                Math.max(
                    1,
                    Math.abs(
                        closeY -
                        openY
                    )
                )

            );

        }
    );


    /* =====================================================
       LEVELS
    ===================================================== */

    if (
        signal
    ){

        drawLevel(
            signal.stop,
            '#ff4d6d',
            'STOP'
        );


        drawLevel(
            signal.entry,
            '#13e0a2',
            'GİRİŞ'
        );


        drawLevel(
            signal.tp1,
            '#4da3ff',
            'TP1'
        );


        drawLevel(
            signal.tp2,
            '#4da3ff',
            'TP2'
        );


        drawLevel(
            signal.tp3,
            '#4da3ff',
            'TP3'
        );


        if (
            signal.entryLow !==
            signal.entryHigh
        ){

            ctx.fillStyle =
                'rgba(19,224,162,.10)';


            var ea =
                y(
                    signal.entryLow
                );


            var eb =
                y(
                    signal.entryHigh
                );


            ctx.fillRect(

                left,

                Math.min(
                    ea,
                    eb
                ),

                plotWidth,

                Math.abs(
                    ea -
                    eb
                )

            );

        }

    }


    function drawLevel(
        value,
        color,
        label
    ){

        var nvalue =
            Number(value);


        if (
            !Number.isFinite(
                nvalue
            )
        ){

            return;

        }


        var yy =
            y(
                nvalue
            );


        ctx.save();


        ctx.strokeStyle =
            color;


        ctx.fillStyle =
            color;


        ctx.lineWidth =
            1.2;


        ctx.setLineDash(
            [
                6,
                4
            ]
        );


        ctx.beginPath();

        ctx.moveTo(
            left,
            yy
        );

        ctx.lineTo(
            width -
            right,
            yy
        );

        ctx.stroke();


        ctx.setLineDash(
            []
        );


        ctx.font =
            'bold 9px Arial';


        ctx.fillText(

            label +
            ' ' +
            price(
                nvalue
            ),

            width -
            right +
            5,

            yy + 3

        );


        ctx.restore();

    }

}


/* =========================================================
   TIMEFRAME
========================================================= */

Array.prototype.forEach.call(

    document.querySelectorAll(
        '[data-tf]'
    ),

    function(
        button
    ){

        button.onclick =
            function(){

                Array.prototype.forEach.call(

                    document.querySelectorAll(
                        '[data-tf]'
                    ),

                    function(
                        b
                    ){

                        b.classList.remove(
                            'active'
                        );

                    }

                );


                button.classList.add(
                    'active'
                );


                state.timeframe =
                    button.getAttribute(
                        'data-tf'
                    );


                loadChart();

            };

    }
);


/* =========================================================
   RADAR REFRESH
========================================================= */

$('scan')
    .onclick =
        function(){

            fetch(
                '/api/scan'
            )
            .catch(
                function(){}
            );

        };


/* =========================================================
   WEBSOCKET
========================================================= */

var ws;


function connect(){

    try {

        var protocol =
            location.protocol ===
            'https:'

                ? 'wss://'

                : 'ws://';


        ws =
            new WebSocket(
                protocol +
                location.host
            );


        ws.onmessage =
            function(
                event
            ){

                try {

                    var message =
                        JSON.parse(
                            event.data
                        );


                    if (
                        message.type ===
                        'snapshot'
                    ){

                        render(
                            message.data
                        );

                    }

                } catch (_) {}

            };


        ws.onclose =
            function(){

                setTimeout(
                    connect,
                    3000
                );

            };


    } catch (_) {

        setTimeout(
            connect,
            3000
        );

    }

}


connect();


fetch(
    '/api/status'
)
    .then(
        function(
            response
        ){

            return response.json();

        }
    )
    .then(
        function(
            data
        ){

            render(
                data
            );

        }
    )
    .catch(
        function(){}
    );


window.addEventListener(
    'resize',
    draw
);


setInterval(
    function(){

        if (
            state.selected
        ){

            loadChart();

        }

    },
    15000
);


})();

</script>

</body>

</html>`;


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
   SAFETY
========================================================= */

process.on(
    'unhandledRejection',
    error => {

        STATE.lastError =
            error &&
            error.message
                ? error.message
                : String(
                    error
                );

        console.error(
            'UNHANDLED:',
            STATE.lastError
        );
    }
);

process.on(
    'uncaughtException',
    error => {

        STATE.lastError =
            error &&
            error.message
                ? error.message
                : String(
                    error
                );

        console.error(
            'UNCAUGHT:',
            STATE.lastError
        );
    }
);


/* =========================================================
   START
========================================================= */

server.listen(
    PORT,
    '0.0.0.0',
    async () => {

        console.log(
            '================================================='
        );

        console.log(
            '🚀 SONNY AI TRADER V5.2'
        );

        console.log(
            '📡 Bitget USDT Futures'
        );

        console.log(
            '🛰️ Radar: 500 Coin'
        );

        console.log(
            '🎯 Candidate: 150'
        );

        console.log(
            '🔬 Deep: 40'
        );

        console.log(
            '📊 4H + 2H → 15M Breakout → Retest → 5M'
        );

        console.log(
            '💰 Minimum Volume: $' +
            CFG.MIN_VOLUME_USDT
        );

        console.log(
            '🎯 Minimum R:R: 1:' +
            CFG.MIN_RR
        );

        console.log(
            '⏱️ Scan: 60 sec'
        );

        console.log(
            '🤖 Auto Trade: KAPALI'
        );

        console.log(
            '================================================='
        );


        try {

            await loadMarkets();

            STATE.marketRefresh =
                Date.now();

            console.log(
                'MARKETS | Gerçek USDT perpetual=' +
                STATE.markets.length
            );

        }
        catch (
            error
        ) {

            STATE.lastError =
                error.message;

            console.error(
                'MARKET ERROR:',
                error.message
            );
        }


        runScan();


        setInterval(
            function(){

                runScan()
                    .catch(
                        function(
                            error
                        ){

                            console.error(
                                'SCAN LOOP:',
                                error.message
                            );

                        }
                    );

            },
            CFG.SCAN_MS
        );


        setInterval(
            function(){

                updateLive()
                    .catch(
                        function(
                            error
                        ){

                            console.error(
                                'LIVE LOOP:',
                                error.message
                            );

                        }
                    );

            },
            CFG.LIVE_MS
        );

    }
);
