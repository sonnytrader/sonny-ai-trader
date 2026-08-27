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
   SONNY AI TRADER FINAL
   500 RADAR
   150 CANDIDATE
   40 DEEP
   4H + 2H
   15M BREAKOUT
   RETEST
   5M BONUS
========================================================= */

const CFG = {
    RADAR: 500,
    CANDIDATES: 150,
    DEEP: 40,

    MAX_SIGNALS: 15,

    MIN_VOLUME_USDT: 750000,

    SCAN_MS: 60000,
    LIVE_MS: 10000,

    CONCURRENCY: 5,

    H1_LIMIT: 260,
    M15_LIMIT: 180,
    M5_LIMIT: 120,

    CHART_LIMIT: 180,

    LEVEL_LOOKBACK: 24,

    BREAKOUT_VOLUME_RATIO: 1.10,
    BREAKOUT_BODY_RATIO: 0.18,
    BREAKOUT_BODY_ATR: 0.20,

    RETEST_TOLERANCE: 0.006,
    RETEST_WINDOW_MINUTES: 90,

    RETEST_REJECTION_RATIO: 0.25,
    INVALIDATION_PCT: 0.0035,

    MIN_SCORE: 64,

    MIN_RR: 1.20,
    TP2_RR: 2.00,
    TP3_RR: 3.00,

    ATR_STOP_MULTIPLIER: 0.80,

    REQUIRE_5M: false,

    SIGNAL_TTL: 45 * 60 * 1000,
    PENDING_TTL: 90 * 60 * 1000,
    COOLDOWN: 4 * 60 * 60 * 1000,

    AUTO_TRADE: false
};


/* =========================================================
   EXCHANGE
========================================================= */

const exchange = new ccxt.bitget({
    enableRateLimit: true,
    timeout: 25000,
    options: {
        defaultType: 'swap'
    }
});


/* =========================================================
   STATE
========================================================= */

const STATE = {
    markets: [],
    marketMap: new Map(),

    universe: [],
    candidates: [],
    deep: [],

    pending: new Map(),
    signals: new Map(),
    cooldowns: new Map(),

    selected: 'BTC/USDT:USDT',
    timeframe: '15m',

    scanning: false,
    ready: false,

    lastScan: 0,
    lastError: null,
    lastAnalyzed: 0,

    market: {
        label: 'YATAY / KARIŞIK',
        direction: 'FLAT',
        breadth: 50,
        green: 0,
        red: 0,
        average: 0,
        btc: 'NEUTRAL',
        eth: 'NEUTRAL'
    },

    chart: {
        symbol: 'BTC/USDT:USDT',
        timeframe: '15m',
        candles: [],
        signal: null
    }
};


/* =========================================================
   HELPERS
========================================================= */

function num(value, fallback = 0) {
    const x = Number(value);
    return Number.isFinite(x) ? x : fallback;
}


function avg(values) {
    if (!values.length) return 0;

    return values.reduce(
        (sum, value) => sum + value,
        0
    ) / values.length;
}


function closed(candles) {
    if (!Array.isArray(candles)) {
        return [];
    }

    if (candles.length <= 1) {
        return candles;
    }

    return candles.slice(0, -1);
}


function cleanSymbol(symbol) {

    let s =
        String(symbol || '')
            .toUpperCase()
            .replace('/USDT:USDT', '')
            .replace('/USDT', '')
            .replace(':USDT', '');

    if (!s.endsWith('USDT')) {
        s += 'USDT';
    }

    return s;
}


function fmt(value) {

    const x = Number(value);

    if (!Number.isFinite(x)) {
        return '-';
    }

    if (x >= 1000) {
        return x.toFixed(2);
    }

    if (x >= 100) {
        return x.toFixed(3);
    }

    if (x >= 1) {
        return x.toFixed(5);
    }

    if (x >= 0.01) {
        return x.toFixed(7);
    }

    if (x >= 0.0001) {
        return x.toFixed(8);
    }

    return x.toFixed(10);
}


/* =========================================================
   TEK MARKET LOOKUP
========================================================= */

function findMarket(symbol) {

    const target =
        cleanSymbol(symbol);

    return (
        STATE.markets.find(
            market =>
                cleanSymbol(
                    market.symbol || market
                ) === target
        ) || null
    );

}


/* =========================================================
   CONCURRENCY
========================================================= */

async function mapLimit(
    items,
    limit,
    worker
) {

    const result =
        new Array(items.length);

    let cursor = 0;


    async function runner() {

        while (true) {

            const index =
                cursor++;


            if (
                index >=
                items.length
            ) {

                return;
            }


            try {

                result[index] =
                    await worker(
                        items[index]
                    );

            }
            catch (
                error
            ) {

                console.error(
                    'ANALİZ ERROR |',
                    items[index]?.symbol ||
                    'UNKNOWN',
                    '|',
                    error.message
                );

                result[index] =
                    null;

                STATE.stats =
                    STATE.stats ||
                    {};

                STATE.stats.errors =
                    (STATE.stats.errors || 0) + 1;

            }

        }

    }


    await Promise.all(
        Array.from(
            {
                length:
                    Math.min(
                        limit,
                        items.length
                    )
            },
            runner
        )
    );


    return result.filter(Boolean);

}


/* =========================================================
   CANDLE CACHE
========================================================= */

const candleCache = new Map();


async function getCandles(
    symbol,
    timeframe,
    limit
) {

    const key =
        [
            cleanSymbol(symbol),
            timeframe,
            limit
        ].join('|');


    const cached =
        candleCache.get(
            key
        );


    if (
        cached &&
        Date.now() -
        cached.time <
        10000
    ) {

        return cached.data;

    }


    let market =
        findMarket(
            symbol
        );


    if (
        !market
    ) {

        return [];
    }


    const data =
        await exchange.fetchOHLCV(
            market.symbol,
            timeframe,
            undefined,
            limit
        );


    const candles =
        (
            data || []
        )
        .map(
            row => [
                num(row[0]),
                num(row[1]),
                num(row[2]),
                num(row[3]),
                num(row[4]),
                num(row[5])
            ]
        )
        .sort(
            (
                a,
                b
            ) =>
                a[0] -
                b[0]
        );


    candleCache.set(
        key,
        {
            time:
                Date.now(),
            data:
                candles
        }
    );


    return candles;

}


/* =========================================================
   MARKETS
========================================================= */

async function loadMarkets() {

    const all =
        await exchange.loadMarkets(
            true
        );


    const result =
        [];


    for (
        const market
        of Object.values(all)
    ) {

        if (
            !market
        ) {
            continue;
        }


        if (
            market.active ===
            false
        ) {
            continue;
        }


        if (
            market.swap !==
            true
        ) {
            continue;
        }


        if (
            market.linear !==
            true
        ) {
            continue;
        }


        if (
            market.quote !==
            'USDT'
        ) {
            continue;
        }


        if (
            market.settle !==
            'USDT'
        ) {
            continue;
        }


        result.push(
            market
        );

    }


    STATE.markets =
        result;


    STATE.marketMap =
        new Map(
            result.map(
                market => [
                    cleanSymbol(
                        market.symbol
                    ),
                    market
                ]
            )
        );


    console.log(
        'MARKETS | Gerçek USDT perpetual=' +
        STATE.markets.length
    );

}


/* =========================================================
   TICKERS
========================================================= */

async function fetchUniverse() {

    const tickers =
        await exchange.fetchTickers();


    const rows =
        [];


    for (
        const market
        of STATE.markets
    ) {

        const ticker =
            tickers[
                market.symbol
            ];


        if (
            !ticker
        ) {
            continue;
        }


        const price =
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


        const high =
            num(
                ticker.high
            );


        const low =
            num(
                ticker.low
            );


        if (
            !(price > 0) ||
            !(volume > 0)
        ) {
            continue;
        }


        const range =
            low > 0
                ? (
                    (
                        high -
                        low
                    ) /
                    low
                ) *
                100
                : 0;


        /*
           Ölü coinleri dışarıda bırak.
           Fakat filtreyi çok sıkı tutma.
        */

        if (
            volume <
            CFG.MIN_VOLUME_USDT
        ) {
            continue;
        }


        if (
            range <
                0.5 &&
            Math.abs(change) <
                0.5
        ) {
            continue;
        }


        const activity =
            volume *
            (
                1 +
                Math.min(
                    Math.abs(change),
                    30
                ) /
                100
            );


        rows.push({

            symbol:
                market.symbol,

            price,

            volume,

            change,

            range,

            activity

        });

    }


    rows.sort(
        (
            a,
            b
        ) =>
            b.activity -
            a.activity
    );


    return rows.slice(
        0,
        CFG.RADAR
    );

}


/* =========================================================
   MARKET DIRECTION
========================================================= */

async function updateMarket() {

    const rows =
        STATE.universe;


    const green =
        rows.filter(
            x =>
                x.change >
                0
        ).length;


    const red =
        rows.filter(
            x =>
                x.change <
                0
        ).length;


    const average =
        avg(
            rows.map(
                x =>
                    x.change
            )
        );


    const breadth =
        rows.length
            ? (
                green /
                rows.length
            ) *
            100
            : 50;


    let btc =
        'NEUTRAL';


    let eth =
        'NEUTRAL';


    try {

        const btcMarket =
            findMarket(
                'BTCUSDT'
            );


        if (
            btcMarket
        ) {

            btc =
                trend(
                    await getCandles(
                        btcMarket.symbol,
                        '1h',
                        100
                    )
                );

        }

    }
    catch (_) {}


    try {

        const ethMarket =
            findMarket(
                'ETHUSDT'
            );


        if (
            ethMarket
        ) {

            eth =
                trend(
                    await getCandles(
                        ethMarket.symbol,
                        '1h',
                        100
                    )
                );

        }

    }
    catch (_) {}


    let label =
        'YATAY / KARIŞIK';


    let direction =
        'FLAT';


    if (
        breadth >= 62 &&
        average >= 0.35
    ) {

        label =
            'YÜKSELİŞ';

        direction =
            'LONG';

    }
    else if (
        breadth <= 38 &&
        average <= -0.35
    ) {

        label =
            'DÜŞÜŞ';

        direction =
            'SHORT';

    }


    STATE.market = {

        label,

        direction,

        breadth:
            Number(
                breadth.toFixed(
                    1
                )
            ),

        green,

        red,

        average:
            Number(
                average.toFixed(
                    2
                )
            ),

        btc,

        eth

    };

}


/* =========================================================
   EMA
========================================================= */

function ema(
    candles,
    period
) {

    const c =
        closed(candles);


    if (
        c.length <
        period
    ) {
        return null;
    }


    let value =
        avg(
            c
                .slice(
                    0,
                    period
                )
                .map(
                    x =>
                        num(x[4])
                )
        );


    const k =
        2 /
        (
            period +
            1
        );


    for (
        let i = period;
        i < c.length;
        i++
    ) {

        value =
            num(
                c[i][4]
            ) *
            k +
            value *
            (1 - k);

    }


    return value;

}


/* =========================================================
   RSI
========================================================= */

function rsi(
    candles,
    period = 14
) {

    const c =
        closed(candles);


    if (
        c.length <
        period + 1
    ) {
        return 50;
    }


    let gains =
        0;

    let losses =
        0;


    for (
        let i =
            c.length -
            period;

        i <
            c.length;

        i++
    ) {

        const diff =
            num(c[i][4]) -
            num(c[i - 1][4]);


        if (
            diff > 0
        ) {

            gains += diff;

        }
        else {

            losses +=
                Math.abs(
                    diff
                );

        }

    }


    if (
        losses === 0
    ) {
        return 100;
    }


    const rs =
        (
            gains /
            period
        ) /
        (
            losses /
            period
        );


    return (
        100 -
        100 /
        (1 + rs)
    );

}


/* =========================================================
   ATR
========================================================= */

function atr(
    candles,
    period = 14
) {

    const c =
        closed(candles);


    if (
        c.length <
        period + 1
    ) {
        return 0;
    }


    const values =
        [];


    for (
        let i = 1;
        i < c.length;
        i++
    ) {

        const high =
            num(c[i][2]);

        const low =
            num(c[i][3]);

        const prev =
            num(c[i - 1][4]);


        values.push(

            Math.max(

                high -
                low,

                Math.abs(
                    high -
                    prev
                ),

                Math.abs(
                    low -
                    prev
                )

            )

        );

    }


    return avg(
        values.slice(
            -period
        )
    );

}


/* =========================================================
   TREND
========================================================= */

function trend(
    candles
) {

    const c =
        closed(candles);


    if (
        c.length <
        55
    ) {
        return 'NEUTRAL';
    }


    const fast =
        ema(
            candles,
            21
        );


    const slow =
        ema(
            candles,
            50
        );


    const last =
        num(
            c[
                c.length - 1
            ][4]
        );


    if (
        fast === null ||
        slow === null
    ) {
        return 'NEUTRAL';
    }


    if (
        last >
        fast &&
        fast >
        slow
    ) {

        return 'LONG';
    }


    if (
        last <
        fast &&
        fast <
        slow
    ) {

        return 'SHORT';
    }


    return 'NEUTRAL';

}


/* =========================================================
   STRUCTURE
========================================================= */

function structure15m(
    candles
) {

    const c =
        closed(candles)
            .slice(
                -20
            );


    if (
        c.length <
        8
    ) {
        return 'NEUTRAL';
    }


    const mid =
        Math.floor(
            c.length /
            2
        );


    const first =
        c.slice(
            0,
            mid
        );


    const second =
        c.slice(
            mid
        );


    const firstHigh =
        Math.max(
            ...first.map(
                x =>
                    num(x[2])
            )
        );


    const firstLow =
        Math.min(
            ...first.map(
                x =>
                    num(x[3])
            )
        );


    const secondHigh =
        Math.max(
            ...second.map(
                x =>
                    num(x[2])
            )
        );


    const secondLow =
        Math.min(
            ...second.map(
                x =>
                    num(x[3])
            )
        );


    if (
        secondHigh >
        firstHigh &&
        secondLow >
        firstLow
    ) {

        return 'LONG';
    }


    if (
        secondHigh <
        firstHigh &&
        secondLow <
        firstLow
    ) {

        return 'SHORT';
    }


    return 'NEUTRAL';

}


/* =========================================================
   LEVELS
========================================================= */

function getLevels(
    candles
) {

    const c =
        closed(candles);


    if (
        c.length <
        30
    ) {
        return null;
    }


    const base =
        c.slice(
            -(
                CFG.LEVEL_LOOKBACK +
                1
            ),
            -1
        );


    return {

        resistance:
            Math.max(
                ...base.map(
                    x =>
                        num(x[2])
                )
            ),

        support:
            Math.min(
                ...base.map(
                    x =>
                        num(x[3])
                )
            )

    };

}


/* =========================================================
   BREAKOUT
========================================================= */

function detectBreakout(
    candles,
    direction,
    level
) {

    const c =
        closed(candles);


    if (
        c.length <
        20
    ) {
        return null;
    }


    const start =
        Math.max(
            1,
            c.length -
            6
        );


    for (
        let i = start;
        i < c.length;
        i++
    ) {

        const current =
            c[i];

        const previous =
            c[i - 1];


        const history =
            c.slice(
                Math.max(
                    0,
                    i -
                    20
                ),
                i
            );


        const averageVolume =
            avg(
                history.map(
                    x =>
                        num(x[5])
                )
            );


        const volumeRatio =
            averageVolume >
            0

                ?

                num(
                    current[5]
                ) /
                averageVolume

                :

                1;


        const range =
            Math.max(
                num(current[2]) -
                num(current[3]),
                1e-12
            );


        const body =
            Math.abs(
                num(current[4]) -
                num(current[1])
            );


        const bodyRatio =
            body /
            range;


        const currentATR =
            atr(
                candles
            )
            ||
            num(
                current[4]
            ) *
            0.005;


        const bodyATR =
            body /
            currentATR;


        if (
            volumeRatio <
            CFG.BREAKOUT_VOLUME_RATIO
        ) {
            continue;
        }


        if (
            bodyRatio <
            CFG.BREAKOUT_BODY_RATIO
        ) {
            continue;
        }


        if (
            bodyATR <
            CFG.BREAKOUT_BODY_ATR
        ) {
            continue;
        }


        if (
            direction ===
            'LONG' &&

            num(
                previous[4]
            ) <=
            level &&

            num(
                current[4]
            ) >
            level
        ) {

            return {

                time:
                    num(
                        current[0]
                    ),

                level,

                volumeRatio,

                bodyRatio,

                bodyATR

            };

        }


        if (
            direction ===
            'SHORT' &&

            num(
                previous[4]
            ) >=
            level &&

            num(
                current[4]
            ) <
            level
        ) {

            return {

                time:
                    num(
                        current[0]
                    ),

                level,

                volumeRatio,

                bodyRatio,

                bodyATR

            };

        }

    }


    return null;

}


/* =========================================================
   PENDING
========================================================= */

function createPending(
    symbol,
    direction,
    tf,
    breakout
) {

    const key =
        [
            cleanSymbol(symbol),
            direction,
            tf,
            fmt(
                breakout.level
            )
        ].join('|');


    const old =
        STATE.pending.get(
            key
        );


    if (
        old
    ) {

        old.updatedAt =
            Date.now();

        return;

    }


    const cooldown =
        STATE.cooldowns.get(
            key
        );


    if (
        cooldown &&
        Date.now() -
        cooldown <
        CFG.COOLDOWN
    ) {

        return;

    }


    STATE.pending.set(
        key,
        {

            key,

            symbol:
                cleanSymbol(
                    symbol
                ),

            direction,

            timeframeLevel:
                tf,

            level:
                breakout.level,

            breakoutTime:
                breakout.time,

            breakoutVolumeRatio:
                breakout.volumeRatio,

            breakoutBodyRatio:
                breakout.bodyRatio,

            breakoutBodyATR:
                breakout.bodyATR,

            status:
                'WAITING_RETEST',

            createdAt:
                Date.now(),

            updatedAt:
                Date.now()

        }
    );


    console.log(

        'BREAKOUT |',

        cleanSymbol(
            symbol
        ),

        '|',

        direction,

        '|',

        fmt(
            breakout.level
        ),

        '| VOL',

        breakout.volumeRatio.toFixed(
            2
        ) + 'x'

    );

}


/* =========================================================
   RETEST
========================================================= */

function evaluateRetest(
    candles,
    pending
) {

    const age =
        Date.now() -
        pending.breakoutTime;


    if (
        age >
        CFG.RETEST_WINDOW_MINUTES *
        60 *
        1000
    ) {

        return {

            ok:
                false,

            status:
                'EXPIRED',

            quality:
                0

        };

    }


    const c =
        closed(candles);


    const maxBars =
        Math.ceil(
            CFG.RETEST_WINDOW_MINUTES /
            15
        );


    const after =
        c
            .filter(
                x =>
                    num(x[0]) >
                    pending.breakoutTime
            )
            .slice(
                0,
                maxBars
            );


    if (
        !after.length
    ) {

        return {

            ok:
                false,

            status:
                'WAITING_RETEST',

            quality:
                0

        };

    }


    const level =
        pending.level;


    const tolerance =
        level *
        CFG.RETEST_TOLERANCE;


    let touched =
        false;


    let rejection =
        false;


    let recovery =
        false;


    let invalid =
        false;


    let confirmationCandle =
        null;


    for (
        const candle
        of after
    ) {

        const open =
            num(candle[1]);

        const high =
            num(candle[2]);

        const low =
            num(candle[3]);

        const close =
            num(candle[4]);


        const touches =
            high >=
                level -
                tolerance &&

            low <=
                level +
                tolerance;


        if (
            !touches
        ) {
            continue;
        }


        touched =
            true;


        confirmationCandle =
            candle;


        const range =
            Math.max(
                high -
                low,
                1e-12
            );


        if (
            pending.direction ===
            'LONG'
        ) {

            if (
                close <
                level *
                (
                    1 -
                    CFG.INVALIDATION_PCT
                )
            ) {

                invalid =
                    true;

            }


            const lowerWick =
                Math.min(
                    open,
                    close
                ) -
                low;


            if (
                lowerWick /
                range >=
                CFG.RETEST_REJECTION_RATIO
            ) {

                rejection =
                    true;

            }


            if (
                close >=
                level
            ) {

                recovery =
                    true;

            }

        }
        else {

            if (
                close >
                level *
                (
                    1 +
                    CFG.INVALIDATION_PCT
                )
            ) {

                invalid =
                    true;

            }


            const upperWick =
                high -
                Math.max(
                    open,
                    close
                );


            if (
                upperWick /
                range >=
                CFG.RETEST_REJECTION_RATIO
            ) {

                rejection =
                    true;

            }


            if (
                close <=
                level
            ) {

                recovery =
                    true;

            }

        }

    }


    if (
        invalid
    ) {

        return {

            ok:
                false,

            status:
                'INVALIDATED',

            quality:
                0

        };

    }


    if (
        touched &&
        (
            rejection ||
            recovery
        )
    ) {

        let quality =
            50;


        if (
            rejection
        ) {

            quality +=
                20;

        }


        if (
            recovery
        ) {

            quality +=
                20;

        }


        return {

            ok:
                true,

            status:
                'RETEST_CONFIRMED',

            quality:

                Math.min(
                    100,
                    quality
                ),

            candle:
                confirmationCandle

        };

    }


    return {

        ok:
            false,

        status:
            'WAITING_RETEST',

        quality:
            0

    };

}


/* =========================================================
   TRADE PLAN
========================================================= */

function createTradePlan(
    direction,
    level,
    candles
) {

    const c =
        closed(candles);


    if (
        c.length <
        20
    ) {
        return null;
    }


    const current =
        num(
            c[
                c.length -
                1
            ][4]
        );


    const volatility =
        atr(
            candles,
            14
        )
        ||
        current *
        0.005;


    const recent =
        c.slice(
            -6
        );


    const swingLow =
        Math.min(
            ...recent.map(
                x =>
                    num(x[3])
            )
        );


    const swingHigh =
        Math.max(
            ...recent.map(
                x =>
                    num(x[2])
            )
        );


    let entry;
    let stop;


    if (
        direction ===
        'LONG'
    ) {

        entry =
            Math.max(
                current,
                level
            );


        stop =
            Math.min(

                swingLow,

                level -
                volatility *
                CFG.ATR_STOP_MULTIPLIER

            );


        if (
            stop >=
            entry
        ) {

            stop =
                entry -
                volatility *
                CFG.ATR_STOP_MULTIPLIER;

        }

    }
    else {

        entry =
            Math.min(
                current,
                level
            );


        stop =
            Math.max(

                swingHigh,

                level +
                volatility *
                CFG.ATR_STOP_MULTIPLIER

            );


        if (
            stop <=
            entry
        ) {

            stop =
                entry +
                volatility *
                CFG.ATR_STOP_MULTIPLIER;

        }

    }


    const risk =
        Math.abs(
            entry -
            stop
        );


    if (
        !(risk > 0)
    ) {
        return null;
    }


    let tp1;
    let tp2;
    let tp3;


    if (
        direction ===
        'LONG'
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

    }
    else {

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


    const rr =
        Math.abs(
            tp1 -
            entry
        ) /
        risk;


    if (
        rr <
        CFG.MIN_RR
    ) {
        return null;
    }


    return {

        entry,

        entryLow:
            Math.min(
                level,
                entry
            ),

        entryHigh:
            Math.max(
                level,
                entry
            ),

        stop,

        tp1,

        tp2,

        tp3,

        rr

    };

}


/* =========================================================
   SCORE
========================================================= */

function calculateScore(
    direction,
    h4Trend,
    h2Trend,
    m15Trend,
    m5Trend,
    volumeRatio,
    retestQuality,
    rsiValue
) {

    let score =
        38;


    const reasons =
        [];


    if (
        h4Trend ===
        direction
    ) {

        score +=
            16;

        reasons.push(
            '4H uyumlu'
        );

    }


    if (
        h2Trend ===
        direction
    ) {

        score +=
            14;

        reasons.push(
            '2H uyumlu'
        );

    }


    if (
        m15Trend ===
        direction
    ) {

        score +=
            8;

        reasons.push(
            '15M yapı uyumlu'
        );

    }


    if (
        m5Trend ===
        direction
    ) {

        score +=
            5;

        reasons.push(
            '5M bonus'
        );

    }


    if (
        volumeRatio >=
        1.5
    ) {

        score +=
            8;

        reasons.push(
            'hacim güçlü'
        );

    }


    if (
        volumeRatio >=
        2
    ) {

        score +=
            5;

        reasons.push(
            'hacim çok güçlü'
        );

    }


    if (
        retestQuality >=
        70
    ) {

        score +=
            8;

        reasons.push(
            'kaliteli retest'
        );

    }
    else if (
        retestQuality >=
        60
    ) {

        score +=
            5;

        reasons.push(
            'retest teyidi'
        );

    }


    if (
        (
            direction ===
            'LONG'
            &&
            rsiValue >=
            45
            &&
            rsiValue <=
            75
        )
        ||
        (
            direction ===
            'SHORT'
            &&
            rsiValue >=
            25
            &&
            rsiValue <=
            55
        )
    ) {

        score +=
            5;

        reasons.push(
            'RSI uygun'
        );

    }


    return {

        score:
            Math.min(
                100,
                Math.round(
                    score
                )
            ),

        reasons

    };

}


/* =========================================================
   ANALYZE
========================================================= */

async function analyzeCoin(
    row
) {

    const symbol =
        row.symbol;


    const [
        h1,
        m15,
        m5
    ] =
        await Promise.all([

            getCandles(
                symbol,
                '1h',
                CFG.H1_LIMIT
            ),

            getCandles(
                symbol,
                '15m',
                CFG.M15_LIMIT
            ),

            getCandles(
                symbol,
                '5m',
                CFG.M5_LIMIT
            )

        ]);


    if (
        h1.length <
        70
        ||
        m15.length <
        35
        ||
        m5.length <
        15
    ) {

        return null;

    }


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


    if (
        h2.length <
        45
        ||
        h4.length <
        45
    ) {

        return null;

    }


    const h4Trend =
        trend(
            h4
        );


    const h2Trend =
        trend(
            h2
        );


    const m15Trend =
        structure15m(
            m15
        );


    const m5Trend =
        trend(
            m5
        );


    const l4 =
        getLevels(
            h4
        );


    const l2 =
        getLevels(
            h2
        );


    if (
        !l4 ||
        !l2
    ) {

        return null;

    }


    const levels = [

        {
            tf:
                '4H',

            direction:
                'LONG',

            price:
                l4.resistance
        },

        {
            tf:
                '4H',

            direction:
                'SHORT',

            price:
                l4.support
        },

        {
            tf:
                '2H',

            direction:
                'LONG',

            price:
                l2.resistance
        },

        {
            tf:
                '2H',

            direction:
                'SHORT',

            price:
                l2.support
        }

    ];


    /*
       Yeni breakout
    */

    for (
        const item
        of levels
    ) {

        const breakout =
            detectBreakout(
                m15,
                item.direction,
                item.price
            );


        if (
            breakout
        ) {

            createPending(
                symbol,
                item.direction,
                item.tf,
                breakout
            );

        }

    }


    /*
       Pending setup kontrolü
    */

    const pendings =
        [
            ...STATE.pending.values()
        ]
        .filter(
            pending =>
                pending.symbol ===
                cleanSymbol(
                    symbol
                )
        );


    const currentRsi =
        rsi(
            m15
        );


    for (
        const pending
        of pendings
    ) {

        const retest =
            evaluateRetest(
                m15,
                pending
            );


        pending.status =
            retest.status;


        pending.updatedAt =
            Date.now();


        if (
            retest.status ===
            'EXPIRED'
        ) {

            STATE.pending.delete(
                pending.key
            );

            continue;
        }


        if (
            retest.status ===
            'INVALIDATED'
        ) {

            STATE.pending.delete(
                pending.key
            );


            STATE.cooldowns.set(
                pending.key,
                Date.now()
            );


            continue;
        }


        if (
            !retest.ok
        ) {

            continue;
        }


        /*
           İki üst timeframe tamamen tersse
           kaliteyi korumak için alma.
        */

        if (
            h4Trend !==
                'NEUTRAL'
            &&
            h2Trend !==
                'NEUTRAL'
            &&
            h4Trend !==
                pending.direction
            &&
            h2Trend !==
                pending.direction
        ) {

            pending.status =
                'REJECTED_TREND';

            continue;

        }


        const fiveMinute =
            confirm5m(
                m5,
                pending.direction
            );


        if (
            CFG.REQUIRE_5M
            &&
            !fiveMinute
        ) {

            pending.status =
                'WAITING_5M';

            continue;

        }


        const scored =
            calculateScore(
                pending.direction,
                h4Trend,
                h2Trend,
                m15Trend,
                m5Trend,
                pending.breakoutVolumeRatio,
                retest.quality,
                currentRsi
            );


        if (
            scored.score <
            CFG.MIN_SCORE
        ) {

            pending.status =
                'REJECTED_SCORE';

            continue;

        }


        const plan =
            createTradePlan(
                pending.direction,
                pending.level,
                m15
            );


        if (
            !plan
        ) {

            pending.status =
                'REJECTED_RR';

            continue;

        }


        const duplicate =
            [
                ...STATE.signals.values()
            ]
            .some(
                signal =>
                    signal.symbol ===
                        pending.symbol
                    &&
                    signal.direction ===
                        pending.direction
            );


        if (
            duplicate
        ) {

            continue;

        }


        const now =
            Date.now();


        STATE.pending.delete(
            pending.key
        );


        return {

            signal: {

                id:
                    [
                        pending.symbol,
                        pending.direction,
                        now
                    ].join('|'),

                symbol:
                    pending.symbol,

                marketSymbol:
                    pending.symbol,

                direction:
                    pending.direction,

                score:
                    scored.score,

                confidence:
                    scored.score,

                currentPrice:
                    row.price,

                entry:
                    plan.entry,

                entryLow:
                    plan.entryLow,

                entryHigh:
                    plan.entryHigh,

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
                    Number(
                        plan.rr.toFixed(
                            2
                        )
                    ),

                rsi:
                    Number(
                        currentRsi.toFixed(
                            1
                        )
                    ),

                volumeRatio:
                    Number(
                        pending.breakoutVolumeRatio.toFixed(
                            2
                        )
                    ),

                breakoutLevel:
                    pending.level,

                timeframeLevel:
                    pending.timeframeLevel,

                h4Trend,

                h2Trend,

                m15Trend,

                m5Trend,

                retestQuality:
                    retest.quality,

                fiveMinuteConfirmed:
                    fiveMinute,

                status:
                    'GİRİŞ BEKLENİYOR',

                entryReady:
                    false,

                reason:
                    scored.reasons.join(
                        ' + '
                    ),

                reasons:
                    scored.reasons,

                breakoutTime:
                    pending.breakoutTime,

                retestTime:
                    retest.candle
                        ? retest.candle[0]
                        : 0,

                signalAt:
                    now,

                cooldownKey:
                    pending.key
            }

        };

    }


    return null;

}


/* =========================================================
   5M
========================================================= */

function confirm5m(
    candles,
    direction
) {

    const c =
        closed(candles);


    if (
        c.length <
        3
    ) {

        return false;

    }


    const last =
        c[
            c.length -
            1
        ];


    const previous =
        c[
            c.length -
            2
        ];


    if (
        direction ===
        'LONG'
    ) {

        return (
            last[4] >
            last[1]
            &&
            last[4] >=
            previous[4]
        );

    }


    return (
        last[4] <
        last[1]
        &&
        last[4] <=
        previous[4]
    );

}


/* =========================================================
   AGGREGATE
========================================================= */

function aggregateCandles(
    candles,
    hours
) {

    const map =
        new Map();


    const bucketMs =
        hours *
        60 *
        60 *
        1000;


    for (
        const candle
        of candles
    ) {

        const bucket =
            Math.floor(
                num(candle[0]) /
                bucketMs
            ) *
            bucketMs;


        if (
            !map.has(
                bucket
            )
        ) {

            map.set(
                bucket,
                [
                    bucket,
                    num(candle[1]),
                    num(candle[2]),
                    num(candle[3]),
                    num(candle[4]),
                    num(candle[5])
                ]
            );

        }
        else {

            const item =
                map.get(
                    bucket
                );


            item[2] =
                Math.max(
                    item[2],
                    num(candle[2])
                );


            item[3] =
                Math.min(
                    item[3],
                    num(candle[3])
                );


            item[4] =
                num(
                    candle[4]
                );


            item[5] +=
                num(
                    candle[5]
                );

        }

    }


    return [
        ...map.values()
    ]
    .sort(
        (
            a,
            b
        ) =>
            a[0] -
            b[0]
    );

}


/* =========================================================
   CLEANUP
========================================================= */

function cleanup() {

    const now =
        Date.now();


    for (
        const [
            id,
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
                id
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


    for (
        const [
            key,
            time
        ]
        of STATE.cooldowns
    ) {

        if (
            now -
            time >
            CFG.COOLDOWN
        ) {

            STATE.cooldowns.delete(
                key
            );

        }

    }

}


/* =========================================================
   LIVE
========================================================= */

async function updateLiveSignals() {

    if (
        !STATE.signals.size
    ) {

        return;

    }


    const tickers =
        await exchange.fetchTickers();


    const now =
        Date.now();


    for (
        const [
            id,
            signal
        ]
        of STATE.signals
    ) {

        const ticker =
            tickers[
                signal.marketSymbol
            ];


        if (
            !ticker
        ) {

            continue;

        }


        const current =
            num(
                ticker.last ||
                ticker.close
            );


        if (
            !(current > 0)
        ) {

            continue;

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

                STATE.signals.delete(
                    id
                );

                STATE.cooldowns.set(
                    signal.cooldownKey,
                    now
                );

                continue;

            }


            if (
                current >=
                signal.tp3
            ) {

                STATE.signals.delete(
                    id
                );

                continue;

            }


            if (
                current >=
                signal.tp2
            ) {

                signal.status =
                    'TP2';

            }
            else if (
                current >=
                signal.tp1
            ) {

                signal.status =
                    'TP1';

            }
            else if (
                current >=
                signal.entryLow
                &&
                current <=
                signal.entryHigh
            ) {

                signal.status =
                    'GİRİŞ ALANI';

                signal.entryReady =
                    true;

            }

        }
        else {

            if (
                current >=
                signal.stop
            ) {

                STATE.signals.delete(
                    id
                );

                STATE.cooldowns.set(
                    signal.cooldownKey,
                    now
                );

                continue;

            }


            if (
                current <=
                signal.tp3
            ) {

                STATE.signals.delete(
                    id
                );

                continue;

            }


            if (
                current <=
                signal.tp2
            ) {

                signal.status =
                    'TP2';

            }
            else if (
                current <=
                signal.tp1
            ) {

                signal.status =
                    'TP1';

            }
            else if (
                current >=
                signal.entryLow
                &&
                current <=
                signal.entryHigh
            ) {

                signal.status =
                    'GİRİŞ ALANI';

                signal.entryReady =
                    true;

            }

        }


        signal.ageSeconds =
            Math.floor(
                (
                    now -
                    signal.signalAt
                ) /
                1000
            );

    }


    cleanup();

}


/* =========================================================
   CHART
========================================================= */

async function refreshChart() {

    const market =
        findMarket(
            STATE.selected
        )
        ||
        findMarket(
            'BTCUSDT'
        );


    if (
        !market
    ) {

        return;

    }


    if (
        STATE.selected !==
        market.symbol
    ) {

        STATE.selected =
            market.symbol;

    }


    let candles;


    if (
        STATE.timeframe ===
        '2h'
    ) {

        const h1 =
            await getCandles(
                market.symbol,
                '1h',
                CFG.CHART_LIMIT *
                2
            );


        candles =
            aggregateCandles(
                h1,
                2
            );

    }
    else if (
        STATE.timeframe ===
        '4h'
    ) {

        const h1 =
            await getCandles(
                market.symbol,
                '1h',
                CFG.CHART_LIMIT *
                4
            );


        candles =
            aggregateCandles(
                h1,
                4
            );

    }
    else {

        candles =
            await getCandles(
                market.symbol,
                STATE.timeframe,
                CFG.CHART_LIMIT
            );

    }


    const signal =
        [
            ...STATE.signals.values()
        ]
        .find(
            item =>
                item.marketSymbol ===
                market.symbol
        )
        ||
        null;


    STATE.chart = {

        symbol:
            market.symbol,

        timeframe:
            STATE.timeframe,

        candles:
            candles || [],

        signal

    };

}


/* =========================================================
   RUN SCAN
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
        null;


    STATE.stats.errors =
        0;


    const started =
        Date.now();


    try {

        if (
            !STATE.markets.length
        ) {

            await loadMarkets();

        }


        STATE.universe =
            await fetchUniverse();


        STATE.stats.universe =
            STATE.universe.length;


        /*
           500 -> 150
        */

        STATE.candidates =
            STATE.universe
                .slice(
                    0,
                    CFG.CANDIDATES
                );


        STATE.stats.candidates =
            STATE.candidates.length;


        /*
           150 -> 40
        */

        STATE.deep =
            STATE.candidates
                .slice(
                    0,
                    CFG.DEEP
                );


        STATE.stats.deep =
            STATE.deep.length;


        /*
           Market
        */

        await updateMarket();


        /*
           Deep analysis
        */

        const results =
            await mapLimit(
                STATE.deep,
                CFG.CONCURRENCY,
                analyzeCoin
            );


        STATE.stats.analyzed =
            results.length;


        /*
           En iyi sinyaller
        */

        const found =
            results
                .map(
                    x =>
                        x.signal
                )
                .filter(
                    Boolean
                )
                .sort(
                    (
                        a,
                        b
                    ) =>
                        b.score -
                        a.score
                );


        for (
            const signal
            of found
        ) {

            if (
                STATE.signals.size >=
                CFG.MAX_SIGNALS
            ) {

                break;

            }


            const duplicate =
                [
                    ...STATE.signals.values()
                ]
                .some(
                    existing =>
                        existing.symbol ===
                        signal.symbol
                        &&
                        existing.direction ===
                        signal.direction
                );


            if (
                duplicate
            ) {

                continue;

            }


            STATE.signals.set(
                signal.id,
                signal
            );


            STATE.selected =
                signal.marketSymbol;


            console.log(

                'SIGNAL |',
                signal.symbol,
                '|',
                signal.direction,
                '| SCORE',
                signal.score,
                '| RR 1:' +
                signal.rr,
                '| ENTRY',
                fmt(
                    signal.entry
                ),
                '| STOP',
                fmt(
                    signal.stop
                ),
                '| TP1',
                fmt(
                    signal.tp1
                ),
                '| TP2',
                fmt(
                    signal.tp2
                ),
                '| TP3',
                fmt(
                    signal.tp3
                )

            );

        }


        cleanup();


        STATE.lastScan =
            Date.now();


        STATE.stats.pending =
            STATE.pending.size;


        STATE.stats.signals =
            STATE.signals.size;


        await refreshChart();


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

    }
    catch (
        error
    ) {

        STATE.lastError =
            error.message;


        console.error(
            'RADAR ERROR:',
            error.message
        );

    }
    finally {

        STATE.scanning =
            false;


        STATE.ready =
            true;


        broadcast();

    }

}


/* =========================================================
   PUBLIC
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
            signal.marketSymbol
    };

}


function statusData() {

    return {

        success:
            true,

        engine:
            'SONNY AI TRADER FINAL',

        ready:
            STATE.ready,

        scanning:
            STATE.scanning,

        autoTrade:
            CFG.AUTO_TRADE,

        lastScan:
            STATE.lastScan,

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
                STATE.stats.errors || 0

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

                    marketSymbol:
                        item.symbol,

                    direction:
                        item.direction,

                    level:
                        fmt(
                            item.level
                        ),

                    timeframeLevel:
                        item.timeframeLevel,

                    volumeRatio:
                        Number(
                            item
                                .breakoutVolumeRatio
                                .toFixed(
                                    2
                                )
                        ),

                    status:
                        item.status

                })
            ),

        chart: {

            symbol:
                STATE.chart.symbol,

            timeframe:
                STATE.chart.timeframe,

            candles:
                STATE.chart.candles,

            signal:
                STATE.chart.signal
                    ? publicSignal(
                        STATE.chart.signal
                    )
                    : null

        }

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

            }
            catch (_) {}

        }

    }

}


wss.on(
    'connection',
    ws => {

        try {

            ws.send(
                JSON.stringify({

                    type:
                        'snapshot',

                    data:
                        statusData()

                })
            );

        }
        catch (_) {}

    }
);


/* =========================================================
   API
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
                'Sonny AI Trader FINAL',

            ready:
                STATE.ready,

            scanning:
                STATE.scanning,

            markets:
                STATE.markets.length,

            stats:
                statusData().stats,

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
                    'Tarama devam ediyor.'

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
   CHART API
========================================================= */

app.get(
    '/api/chart',
    async (
        req,
        res
    ) => {

        try {

            const requested =
                req.query.symbol ||
                STATE.selected ||
                'BTCUSDT';


            const market =
                findMarket(
                    requested
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


            STATE.selected =
                market.symbol;


            const allowed = [

                '5m',
                '15m',
                '1h',
                '2h',
                '4h'

            ];


            const requestedTF =
                String(
                    req.query.timeframe ||
                    '15m'
                ).toLowerCase();


            STATE.timeframe =
                allowed.includes(
                    requestedTF
                )
                    ? requestedTF
                    : '15m';


            await refreshChart();


            res.json({

                success:
                    true,

                symbol:
                    cleanSymbol(
                        STATE.chart.symbol
                    ),

                ccxtSymbol:
                    STATE.chart.symbol,

                timeframe:
                    STATE.chart.timeframe,

                candles:
                    STATE.chart.candles,

                signal:
                    STATE.chart.signal
                        ? publicSignal(
                            STATE.chart.signal
                        )
                        : null

            });

        }
        catch (
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
SONNY AI TRADER
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
color:#edf2f7;
font-family:Arial,Helvetica,sans-serif;
}

body{
overflow:hidden;
}

.app{
height:100vh;
display:grid;
grid-template-columns:220px minmax(0,1fr) 280px;
}

.side,
.right{
background:#0b1017;
padding:10px;
overflow:auto;
}

.side{
border-right:1px solid #202b38;
}

.right{
border-left:1px solid #202b38;
}

.brand{
font-size:18px;
font-weight:900;
}

.brand small{
display:block;
font-size:8px;
color:#718096;
margin-top:4px;
}

.scan{
width:100%;
margin-top:9px;
padding:9px;
border:0;
border-radius:7px;
background:#172840;
color:#fff;
font-weight:900;
cursor:pointer;
}

.stats{
display:grid;
grid-template-columns:repeat(3,1fr);
gap:5px;
margin-top:9px;
}

.stat{
background:#101721;
border:1px solid #263345;
border-radius:6px;
padding:6px;
text-align:center;
}

.stat b{
display:block;
font-size:14px;
}

.stat span{
font-size:8px;
color:#718096;
}

.cards{
display:flex;
flex-direction:column;
gap:7px;
margin-top:10px;
}

.card{
background:#101721;
border:1px solid #263345;
border-left:3px solid #13dba0;
border-radius:8px;
padding:9px;
cursor:pointer;
}

.card.short{
border-left-color:#ff5570;
}

.card.active{
border-color:#4776ff;
}

.top{
display:flex;
justify-content:space-between;
align-items:center;
}

.coin{
font-size:12px;
font-weight:900;
}

.badge{
font-size:8px;
font-weight:900;
padding:3px 6px;
border-radius:4px;
}

.badge.long{
color:#13dba0;
background:#073c2e;
}

.badge.short{
color:#ff5570;
background:#451322;
}

.cardPrice{
font-size:18px;
font-weight:900;
margin-top:6px;
}

.meta{
font-size:8px;
color:#718096;
margin-top:4px;
}

.empty{
font-size:10px;
color:#718096;
padding:9px;
}

.main{
min-width:0;
display:flex;
flex-direction:column;
}

.header{
height:60px;
display:flex;
justify-content:space-between;
align-items:center;
padding:0 12px;
border-bottom:1px solid #202b38;
}

.title{
font-size:18px;
font-weight:900;
}

.pill{
font-size:8px;
color:#13dba0;
background:#073323;
border:1px solid #0b684a;
padding:7px 9px;
border-radius:18px;
}

.chartArea{
position:relative;
flex:1;
min-height:0;
}

.toolbar{
position:absolute;
z-index:10;
top:9px;
left:10px;
right:10px;
display:flex;
justify-content:space-between;
align-items:center;
pointer-events:none;
}

.chartName{
font-size:11px;
font-weight:900;
}

.tf{
display:flex;
gap:4px;
pointer-events:auto;
}

.tf button{
background:#111a26;
color:#8491a4;
border:1px solid #29384c;
border-radius:5px;
padding:5px 7px;
font-size:8px;
cursor:pointer;
}

.tf button.active{
background:#182c4a;
color:#fff;
border-color:#428cff;
}

canvas{
width:100%;
height:100%;
display:block;
}

.box{
background:#101721;
border:1px solid #263345;
border-radius:8px;
padding:10px;
margin-bottom:8px;
}

.boxTitle{
font-size:8px;
font-weight:900;
color:#8190a3;
}

.regime{
font-size:18px;
font-weight:900;
margin-top:5px;
color:#f4c84a;
}

.regime.long{
color:#13dba0;
}

.regime.short{
color:#ff5570;
}

.activeName{
font-size:14px;
font-weight:900;
margin-top:6px;
}

.activeName.long{
color:#13dba0;
}

.activeName.short{
color:#ff5570;
}

.plan{
display:grid;
grid-template-columns:1fr 1fr;
gap:5px;
margin-top:8px;
}

.level{
background:#09111a;
border-radius:5px;
padding:7px;
}

.level span{
display:block;
font-size:8px;
color:#718096;
}

.level b{
font-size:10px;
}

.green{
color:#13dba0;
}

.red{
color:#ff5570;
}

.blue{
color:#55a7ff;
}

.pendingItem{
background:#09111a;
border-left:2px solid #f4c84a;
border-radius:4px;
padding:7px;
margin-top:5px;
font-size:8px;
}

.info{
font-size:9px;
line-height:1.55;
color:#718096;
margin-top:5px;
}

@media(max-width:900px){

.app{
grid-template-columns:200px minmax(0,1fr);
}

.right{
display:none;
}

}

@media(max-width:650px){

body{
overflow:auto;
}

.app{
display:block;
height:auto;
min-height:100vh;
}

.side{
height:205px;
border-right:0;
border-bottom:1px solid #202b38;
}

.cards{
flex-direction:row;
overflow-x:auto;
}

.card{
min-width:165px;
}

.main{
height:calc(100vh - 205px);
min-height:420px;
}

.header{
height:48px;
padding:0 8px;
}

.title{
font-size:14px;
}

.pill{
font-size:7px;
padding:6px;
}

.chartArea{
height:calc(100vh - 253px);
min-height:350px;
}

}

</style>

</head>


<body>

<div class="app">


<aside class="side">

<div class="brand">

⚡ SONNY AI TRADER

<small>
4H + 2H • 15M BREAKOUT • RETEST • 5M BONUS
</small>

</div>


<button
id="scan"
class="scan"
>
RADARI YENİLE
</button>


<div class="stats">

<div class="stat">
<b id="radar">0</b>
<span>RADAR</span>
</div>

<div class="stat">
<b id="candidate">0</b>
<span>ADAY</span>
</div>

<div class="stat">
<b id="deep">0</b>
<span>DERİN</span>
</div>

</div>


<div
id="cards"
class="cards"
>

<div class="empty">
Sinyal bekleniyor...
</div>

</div>

</aside>


<main class="main">

<header class="header">

<div>

<div class="title">

<span id="symbol">
BTCUSDT
</span>

•

<span id="timeframe">
15M
</span>

</div>

<div
id="scanInfo"
class="info"
>
Sistem hazırlanıyor...
</div>

</div>


<div class="pill">
● AUTO TRADE KAPALI
</div>

</header>


<div class="chartArea">


<div class="toolbar">

<div
id="chartName"
class="chartName"
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


<canvas
id="chart"
>
</canvas>


</div>

</main>


<aside class="right">


<div class="box">

<div class="boxTitle">
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
class="info"
>
Analiz ediliyor...
</div>

</div>


<div class="box">

<div class="boxTitle">
AKTİF SCALP SİNYALİ
</div>

<div
id="active"
>

<div class="empty">
Henüz sinyal yok.
</div>

</div>

</div>


<div class="box">

<div class="boxTitle">
BEKLEYEN BREAKOUT / RETEST
</div>

<div
id="pending"
>

<div class="empty">
Setup yok.
</div>

</div>

</div>

</aside>


</div>


<script>

(function(){

'use strict';


let selected =
'BTCUSDT';


let timeframe =
'15m';


let candles =
[];


let signal =
null;


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

const n =
Number(value);


if(
!Number.isFinite(
n
)
){

return '-';

}


if(
n >= 1000
){

return n.toFixed(2);

}


if(
n >= 100
){

return n.toFixed(3);

}


if(
n >= 1
){

return n.toFixed(5);

}


if(
n >= 0.01
){

return n.toFixed(7);

}


return n.toFixed(9);

}


function normalize(
items
){

return (
items || []
)
.map(
function(
x
){

if(
Array.isArray(x)
){

return {

time:+x[0],
open:+x[1],
high:+x[2],
low:+x[3],
close:+x[4],
volume:+(
x[5] || 0
)

};

}


return {

time:+x.time,
open:+x.open,
high:+x.high,
low:+x.low,
close:+x.close,
volume:+(
x.volume || 0
)

};

}
)
.filter(
function(
x
){

return (

Number.isFinite(
x.time
)
&&
Number.isFinite(
x.open
)
&&
Number.isFinite(
x.high
)
&&
Number.isFinite(
x.low
)
&&
Number.isFinite(
x.close
)

);

}
)
.sort(
function(
a,
b
){

return a.time-b.time;

}
);

}


function updateHeader(){

const sym =
String(
selected
)
.replace(
'/USDT:USDT',
'USDT'
)
.replace(
'/USDT',
'USDT'
);


$('symbol')
.textContent =
sym;


$('timeframe')
.textContent =
timeframe.toUpperCase();


$('chartName')
.textContent =
sym +
' • ' +
timeframe.toUpperCase();

}


function level(
label,
value,
cls
){

return (

'<div class="level">'+
'<span>'+
label+
'</span>'+
'<b class="'+
cls+
'">'+
esc(value)+
'</b>'+
'</div>'

);

}


function showActive(
s
){

if(
!s
){

$('active').innerHTML =
'<div class="empty">Henüz sinyal yok.</div>';

return;

}


const cls =
s.direction ===
'LONG'
?
'long'
:
'short';


$('active').innerHTML =

'<div class="activeName '+
cls+
'">'+
esc(s.symbol)+
' • '+
esc(s.direction)+
'</div>'+

'<div class="plan">'+

level(
'GİRİŞ',
price(s.entryLow)+
' — '+
price(s.entryHigh),
'green'
)+

level(
'STOP',
price(s.stop),
'red'
)+

level(
'TP1',
price(s.tp1),
'blue'
)+

level(
'TP2',
price(s.tp2),
'blue'
)+

level(
'TP3',
price(s.tp3),
'blue'
)+

level(
'R:R',
'1:'+esc(s.rr),
''
)+

'</div>'+

'<div class="info">'+

esc(
s.status ||
'GİRİŞ BEKLENİYOR'
)+

' • SKOR '+
esc(
s.score
)+
'/100'+

'<br>RSI '+
esc(
s.rsi
)+

' • VOL '+
esc(
s.volumeRatio
)+
'x'+

'<br>'+
esc(
s.reason ||
''
)+

'</div>';

}


function render(
data
){

const st =
data.stats ||
{};


$('radar')
.textContent =
st.universe ||
0;


$('candidate')
.textContent =
st.candidates ||
0;


$('deep')
.textContent =
st.deep ||
0;


$('scanInfo')
.textContent =

data.lastScan
?
'Son tarama: '+
new Date(
data.lastScan
).toLocaleTimeString(
'tr-TR'
)
:
'Tarama bekleniyor...';


const market =
data.market ||
{};


$('regime')
.textContent =
market.label ||
'YATAY / KARIŞIK';


$('regime')
.className =
'regime '+
(
market.direction ===
'LONG'
?
'long'
:
market.direction ===
'SHORT'
?
'short'
:
''
);


$('marketInfo')
.innerHTML =

'Breadth %'+
esc(
market.breadth
)+

' • Yeşil '+
esc(
market.green
)+
' • Kırmızı '+
esc(
market.red
)+

'<br>Ortalama '+
esc(
market.average
)+
'%'+

'<br>BTC 1H '+
esc(
market.btc
)+
' • ETH 1H '+
esc(
market.eth
);


const signals =
data.signals ||
[];


const cards =
$('cards');


cards.innerHTML =
'';


if(
!signals.length
){

cards.innerHTML =
'<div class="empty">Teyit edilmiş sinyal yok.</div>';

}
else{

signals.forEach(
function(
s
){

const card =
document.createElement(
'div'
);


card.className =
'card '+
(
s.direction ===
'SHORT'
?
'short '
:
''
)+
(
s.marketSymbol ===
selected
?
'active'
:
''
);


card.innerHTML =

'<div class="top">'+

'<div class="coin">'+
esc(
s.symbol
)+
'</div>'+

'<div class="badge '+
(
s.direction ===
'LONG'
?
'long'
:
'short'
)+
'">'+
esc(
s.direction
)+
'</div>'+

'</div>'+

'<div class="cardPrice">'+
price(
s.currentPrice ||
s.entry
)+
'</div>'+

'<div class="meta">'+
'● GİRİŞ ALANI • SKOR '+
esc(
s.score
)+
'/100'+
'</div>';


card.onclick =
function(){

selected =
s.marketSymbol;

signal =
s;

showActive(
s
);

loadChart();

};


cards.appendChild(
card
);

}
);

}


if(
signals.length
){

const active =
signals.find(
function(
s
){

return (
s.marketSymbol ===
selected
);

}
)
||
signals[0];


selected =
active.marketSymbol;

signal =
active;

showActive(
active
);

}


const pending =
data.pending ||
[];


$('pending').innerHTML =

pending.length

?

pending.map(
function(
p
){

return (

'<div class="pendingItem">'+

'<b>'+
esc(
p.symbol
)+
' '+
esc(
p.direction
)+
'</b>'+

'<br>Seviye '+
esc(
p.level
)+

' • '+
esc(
p.status
)+

'</div>'

);

}
).join('')

:

'<div class="empty">Setup yok.</div>';


if(
data.chart
){

candles =
normalize(
data.chart.candles
);


selected =
data.chart.symbol ||
selected;


timeframe =
data.chart.timeframe ||
timeframe;


signal =
data.chart.signal ||
signal ||
null;


updateHeader();

drawChart();

}

}


async function loadChart(){

try{

const response =
await fetch(

'/api/chart?symbol='+
encodeURIComponent(
selected
)+
'&timeframe='+
encodeURIComponent(
timeframe
),

{
cache:
'no-store'
}

);


const data =
await response.json();


if(
!data.success
){

return;

}


candles =
normalize(
data.candles
);


selected =
data.symbol ||
selected;


timeframe =
data.timeframe ||
timeframe;


if(
data.signal
){

signal =
data.signal;

showActive(
signal
);

}


updateHeader();

drawChart();

}
catch(
error
){

console.error(
'GRAFİK:',
error.message
);

}

}


function drawChart(){

const canvas =
$('chart');


const rect =
canvas.getBoundingClientRect();


const dpr =
window.devicePixelRatio ||
1;


const width =
Math.max(
320,
Math.floor(
rect.width
)
);


const height =
Math.max(
320,
Math.floor(
rect.height
)
);


canvas.width =
width *
dpr;


canvas.height =
height *
dpr;


const ctx =
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


ctx.fillStyle =
'#070b11';


ctx.fillRect(
0,
0,
width,
height
);


if(
!candles.length
){

ctx.fillStyle =
'#718096';

ctx.font =
'12px Arial';

ctx.fillText(
'Grafik verisi bekleniyor...',
15,
45
);

return;

}


const visible =
candles.slice(
-140
);


const values =
[];


visible.forEach(
function(
c
){

values.push(
c.high,
c.low
);

});


if(
signal
){

[
signal.entryLow,
signal.entryHigh,
signal.entry,
signal.stop,
signal.tp1,
signal.tp2,
signal.tp3
]
.forEach(
function(
v
){

if(
Number.isFinite(
Number(v)
)
){

values.push(
Number(v)
);

}

}
);

}


let min =
Math.min(
...values
);


let max =
Math.max(
...values
);


let range =
max -
min;


if(
range <=
0
){

range =
1;

}


const pad =
range *
0.07;


min -=
pad;


max +=
pad;


const left =
55;


const right =
82;


const top =
28;


const bottom =
24;


const plotWidth =
Math.max(
1,
width -
left -
right
);


const plotHeight =
Math.max(
1,
height -
top -
bottom
);


function y(
v
){

return (

top +

(
max -
Number(v)
) /
(
max -
min
) *
plotHeight

);

}


function x(
i
){

return (

left +

(
i /
Math.max(
1,
visible.length -
1
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


for(
let i=0;
i<=5;
i++
){

const gy =
top +
plotHeight *
i /
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


const value =
max -
(
max -
min
) *
i /
5;


ctx.fillStyle =
'#607083';

ctx.font =
'9px Arial';

ctx.fillText(
price(value),
5,
gy+3
);

}


/* CANDLES */

const step =
plotWidth /
Math.max(
1,
visible.length -
1
);


const bodyWidth =
Math.max(
2,
Math.min(
10,
step *
0.65
)
);


visible.forEach(
function(
c,
i
){

const xx =
x(i);


const up =
c.close >=
c.open;


const color =
up
?
'#13dba0'
:
'#ff5570';


ctx.strokeStyle =
color;


ctx.fillStyle =
color;


ctx.beginPath();

ctx.moveTo(
xx,
y(c.high)
);

ctx.lineTo(
xx,
y(c.low)
);

ctx.stroke();


const openY =
y(c.open);


const closeY =
y(c.close);


ctx.fillRect(

xx -
bodyWidth/2,

Math.min(
openY,
closeY
),

bodyWidth,

Math.max(
1,
Math.abs(
openY -
closeY
)
)

);

});


/* ENTRY ZONE */

if(
signal &&
Number.isFinite(
Number(
signal.entryLow
)
) &&
Number.isFinite(
Number(
signal.entryHigh
)
)
){

const a =
y(
signal.entryLow
);


const b =
y(
signal.entryHigh
);


ctx.fillStyle =
'rgba(19,219,160,.11)';


ctx.fillRect(

left,

Math.min(
a,
b
),

plotWidth,

Math.abs(
a -
b
)

);

}


/* LEVELS */

if(
signal
){

drawLevel(
signal.stop,
'#ff5570',
'STOP'
);


drawLevel(
signal.entry,
'#13dba0',
'GİRİŞ'
);


drawLevel(
signal.tp1,
'#55a7ff',
'TP1'
);


drawLevel(
signal.tp2,
'#55a7ff',
'TP2'
);


drawLevel(
signal.tp3,
'#55a7ff',
'TP3'
);

}


function drawLevel(
value,
color,
label
){

const n =
Number(value);


if(
!Number.isFinite(
n
)
){

return;

}


const yy =
y(n);


ctx.strokeStyle =
color;


ctx.setLineDash(
[
6,
5
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


ctx.fillStyle =
color;


ctx.font =
'bold 9px Arial';


ctx.fillText(

label+
' '+
price(n),

width -
right +
5,

yy +
3

);

}

}


document
.querySelectorAll(
'[data-tf]'
)
.forEach(
function(
button
){

button.onclick =
function(){

document
.querySelectorAll(
'[data-tf]'
)
.forEach(
function(
item
){

item.classList.remove(
'active'
);

}
);


button.classList.add(
'active'
);


timeframe =
button.dataset.tf;


loadChart();

};

}
);


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


function connect(){

const protocol =
location.protocol ===
'https:'
?
'wss://'
:
'ws://';


const socket =
new WebSocket(
protocol +
location.host
);


socket.onmessage =
function(
event
){

try{

const message =
JSON.parse(
event.data
);


if(
message.type ===
'snapshot'
){

render(
message.data
);

}

}
catch(
error
){

console.error(
'WS:',
error
);

}

};


socket.onclose =
function(){

setTimeout(
connect,
2500
);

};

}


connect();


fetch(
'/api/status',
{
cache:
'no-store'
}
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
function(
error
){

console.error(
'STATUS:',
error
);

});


setInterval(
function(){

loadChart();

},
15000
);


window.addEventListener(
'resize',
function(){

drawChart();

}
);


updateHeader();

drawChart();

})();

</script>

</body>

</html>`;


/* =========================================================
   START
========================================================= */

server.listen(
    PORT,
    '0.0.0.0',
    () => {

        console.log('');
        console.log(
            '================================================='
        );

        console.log(
            '🚀 SONNY AI TRADER FINAL'
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
            '📊 4H + 2H → 15M Breakout → Retest → 5M BONUS'
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
            '🌐 Port: ' +
            PORT
        );

        console.log(
            '================================================='
        );


        initialize();

    }
);


/* =========================================================
   INITIALIZE
========================================================= */

async function initialize() {

    try {

        await loadMarkets();


        STATE.ready =
            true;


        await runScan();

    }
    catch (
        error
    ) {

        STATE.lastError =
            error.message;


        console.error(
            'INITIALIZE ERROR:',
            error.message
        );

    }


    setInterval(
        function(){

            runScan()
                .catch(
                    error =>
                        console.error(
                            'SCAN LOOP:',
                            error.message
                        )
                );

        },
        CFG.SCAN_MS
    );


    setInterval(
        function(){

            updateLiveSignals()
                .then(
                    refreshChart
                )
                .then(
                    broadcast
                )
                .catch(
                    error =>
                        console.error(
                            'LIVE LOOP:',
                            error.message
                        )
                );

        },
        CFG.LIVE_MS
    );


    setInterval(
        function(){

            cleanup();

            broadcast();

        },
        5000
    );

}
