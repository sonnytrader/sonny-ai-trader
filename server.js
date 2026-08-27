'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = Number(process.env.PORT || 10000);

app.use(express.json({ limit: '1mb' }));

/* =========================================================
   SONNY AI TRADER FINAL
   500 RADAR -> 150 ADAY -> 40 DERİN
   4H + 2H -> 15M BREAKOUT -> RETEST -> 5M BONUS

   HTML SERVER.JS İÇİNDE
   AUTO TRADE KAPALI
========================================================= */

const CFG = {
    RADAR: 500,
    CANDIDATES: 150,
    DEEP: 40,
    MAX_SIGNALS: 15,

    MIN_VOLUME_USDT: Number(
        process.env.MIN_VOLUME_USDT || 750000
    ),

    SCAN_MS: 60000,
    LIVE_MS: 10000,

    CONCURRENCY: 6,

    H1_LIMIT: 300,
    M15_LIMIT: 200,
    M5_LIMIT: 120,

    CHART_LIMIT: 160,

    LEVEL_LOOKBACK: 24,
    BREAKOUT_LOOKBACK: 12,

    BREAKOUT_VOLUME_RATIO: 1.10,

    RETEST_WINDOW: 8,
    RETEST_TOLERANCE: 0.0045,

    PENDING_TTL: 90 * 60 * 1000,
    SIGNAL_TTL: 45 * 60 * 1000,

    MIN_SCORE: 64,

    MIN_RR: 1.50,
    TP2_RR: 2.25,
    TP3_RR: 3.25,

    ATR_STOP: 1.00,

    REQUIRE_5M: false,

    AUTO_TRADE: false
};


/* =========================================================
   BITGET
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

    universe: [],

    candidates: [],

    deep: [],

    signals: new Map(),

    pending: new Map(),

    selected: 'BTC/USDT:USDT',

    timeframe: '15m',

    scanning: false,

    lastScan: 0,

    lastError: '',

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

function num(
    value,
    fallback = 0
) {
    const x = Number(value);

    return Number.isFinite(x)
        ? x
        : fallback;
}


function avg(
    values
) {
    if (!values.length) {
        return 0;
    }

    return values.reduce(
        (
            sum,
            value
        ) => sum + value,
        0
    ) / values.length;
}


function closed(
    candles
) {
    if (!Array.isArray(candles)) {
        return [];
    }

    if (candles.length <= 1) {
        return candles;
    }

    return candles.slice(
        0,
        -1
    );
}


function cleanSymbol(
    symbol
) {

    let s =
        String(
            symbol || ''
        )
        .toUpperCase()
        .replace(
            '/USDT:USDT',
            ''
        )
        .replace(
            '/USDT',
            ''
        )
        .replace(
            ':USDT',
            ''
        );

    if (
        s.endsWith('USDT')
    ) {

        s =
            s.slice(
                0,
                -4
            );
    }

    return s + 'USDT';
}


/* =========================================================
   KRİTİK: MARKET LOOKUP
   ========================================================= */

function findMarket(
    symbol
) {

    const wanted =
        cleanSymbol(
            symbol
        );


    if (
        !STATE.markets ||
        !STATE.markets.length
    ) {

        return null;
    }


    return (

        STATE.markets.find(
            market =>
                cleanSymbol(
                    market.symbol
                ) === wanted
        )

        ||

        null
    );
}


/* =========================================================
   PRICE FORMAT
========================================================= */

function fmt(
    value
) {

    const x =
        Number(value);

    if (
        !Number.isFinite(x)
    ) {

        return '-';
    }


    if (
        x >= 1000
    ) {

        return x.toFixed(2);
    }


    if (
        x >= 100
    ) {

        return x.toFixed(3);
    }


    if (
        x >= 1
    ) {

        return x.toFixed(5);
    }


    if (
        x >= 0.01
    ) {

        return x.toFixed(7);
    }


    if (
        x >= 0.0001
    ) {

        return x.toFixed(8);
    }


    return x.toFixed(10);
}


/* =========================================================
   MAP LIMIT
========================================================= */

async function mapLimit(
    items,
    limit,
    worker
) {

    const results =
        new Array(
            items.length
        );


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

                results[index] =
                    await worker(
                        items[index],
                        index
                    );

            }
            catch (error) {

                STATE.stats.errors += 1;

                console.error(
                    'ANALİZ ERROR |',
                    items[index]?.symbol ||
                    'UNKNOWN',
                    '|',
                    error.message
                );

                results[index] =
                    null;
            }
        }
    }


    const workers =
        Math.min(
            limit,
            items.length
        );


    await Promise.all(
        Array.from(
            {
                length:
                    workers
            },
            runner
        )
    );


    return results.filter(
        Boolean
    );
}


/* =========================================================
   INDICATORS
========================================================= */

function ema(
    candles,
    period
) {

    const c =
        closed(
            candles
        );


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
                    candle =>
                        num(
                            candle[4]
                        )
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
            (
                1 -
                k
            );
    }


    return value;
}


function rsi(
    candles,
    period = 14
) {

    const c =
        closed(
            candles
        );


    if (
        c.length <
        period + 1
    ) {

        return 50;
    }


    let gains = 0;
    let losses = 0;


    for (
        let i =
            c.length -
            period;

        i <
            c.length;

        i++
    ) {

        const diff =
            num(
                c[i][4]
            ) -
            num(
                c[i - 1][4]
            );


        if (
            diff >= 0
        ) {

            gains +=
                diff;

        }
        else {

            losses +=
                -diff;
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
        (
            100 /
            (
                1 +
                rs
            )
        )
    );
}


function atr(
    candles,
    period = 14
) {

    const c =
        closed(
            candles
        );


    if (
        c.length <
        period + 1
    ) {

        return 0;
    }


    const tr = [];


    for (
        let i = 1;
        i < c.length;
        i++
    ) {

        const high =
            num(
                c[i][2]
            );


        const low =
            num(
                c[i][3]
            );


        const previousClose =
            num(
                c[i - 1][4]
            );


        tr.push(
            Math.max(

                high -
                low,

                Math.abs(
                    high -
                    previousClose
                ),

                Math.abs(
                    low -
                    previousClose
                )

            )
        );
    }


    return avg(
        tr.slice(
            -period
        )
    );
}


function trend(
    candles
) {

    const c =
        closed(
            candles
        );


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


function structure(
    candles
) {

    const c =
        closed(
            candles
        ).slice(
            -20
        );


    if (
        c.length <
        8
    ) {

        return 'NEUTRAL';
    }


    const middle =
        Math.floor(
            c.length /
            2
        );


    const first =
        c.slice(
            0,
            middle
        );


    const second =
        c.slice(
            middle
        );


    const firstHigh =
        Math.max(
            ...first.map(
                x =>
                    num(
                        x[2]
                    )
            )
        );


    const firstLow =
        Math.min(
            ...first.map(
                x =>
                    num(
                        x[3]
                    )
            )
        );


    const secondHigh =
        Math.max(
            ...second.map(
                x =>
                    num(
                        x[2]
                    )
            )
        );


    const secondLow =
        Math.min(
            ...second.map(
                x =>
                    num(
                        x[3]
                    )
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
    candles,
    lookback =
        CFG.LEVEL_LOOKBACK
) {

    const c =
        closed(
            candles
        );


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

        resistance:
            Math.max(
                ...base.map(
                    x =>
                        num(
                            x[2]
                        )
                )
            ),

        support:
            Math.min(
                ...base.map(
                    x =>
                        num(
                            x[3]
                        )
                )
            )
    };
}


/* =========================================================
   MARKETS
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
                market.swap === true &&
                market.linear === true &&
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


        if (
            !(price > 0) ||
            !(volume > 0)
        ) {

            continue;
        }


        const high =
            num(
                ticker.high
            );


        const low =
            num(
                ticker.low
            );


        const range =
            low > 0

                ?

                (
                    (
                        high -
                        low
                    ) /
                    low
                ) *
                100

                :

                0;


        rows.push({

            symbol:
                market.symbol,

            coin:
                cleanSymbol(
                    market.symbol
                ),

            price,

            volume,

            change,

            range
        });
    }


    rows.sort(
        (
            a,
            b
        ) => {

            const activityA =
                a.volume *
                (
                    1 +
                    Math.min(
                        Math.abs(
                            a.change
                        ),
                        30
                    ) /
                    100
                );


            const activityB =
                b.volume *
                (
                    1 +
                    Math.min(
                        Math.abs(
                            b.change
                        ),
                        30
                    ) /
                    100
                );


            return (
                activityB -
                activityA
            );
        }
    );


    return rows.slice(
        0,
        CFG.RADAR
    );
}


/* =========================================================
   MARKET SENTIMENT
========================================================= */

async function updateMarket(
    rows
) {

    const valid =
        rows.filter(
            row =>
                Number.isFinite(
                    row.change
                )
        );


    const green =
        valid.filter(
            row =>
                row.change > 0
        ).length;


    const red =
        valid.filter(
            row =>
                row.change < 0
        ).length;


    const average =
        valid.length
            ? avg(
                valid.map(
                    row =>
                        row.change
                )
            )
            : 0;


    const breadth =
        valid.length
            ? (
                green /
                valid.length
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

            const candles =
                await getCandles(
                    btcMarket.symbol,
                    '1h',
                    100
                );


            btc =
                trend(
                    candles
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

            const candles =
                await getCandles(
                    ethMarket.symbol,
                    '1h',
                    100
                );


            eth =
                trend(
                    candles
                );
        }

    }
    catch (_) {}


    let direction =
        'FLAT';


    let label =
        'YATAY / KARIŞIK';


    if (
        breadth >= 62 &&
        average >= 0.35
    ) {

        direction =
            'LONG';

        label =
            'YÜKSELİŞ';

    }
    else if (
        breadth <= 38 &&
        average <= -0.35
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
                average.toFixed(2)
            ),

        btc,

        eth
    };
}


/* =========================================================
   RAW CANDLES
========================================================= */

async function getCandles(
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
   BREAKOUT
========================================================= */

function detectBreakout(
    candles,
    direction,
    level
) {

    const c =
        closed(
            candles
        );


    if (
        c.length <
        CFG.BREAKOUT_LOOKBACK + 3
    ) {

        return null;
    }


    const start =
        Math.max(
            CFG.BREAKOUT_LOOKBACK,
            c.length - 6
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
                    i - 20
                ),
                i
            );


        const averageVolume =
            avg(
                history
                    .map(
                        x =>
                            num(
                                x[5]
                            )
                    )
                    .filter(
                        x =>
                            x > 0
                    )
            );


        const volume =
            num(
                current[5]
            );


        const volumeRatio =
            averageVolume > 0
                ? volume /
                  averageVolume
                : 1;


        const range =
            Math.max(
                num(
                    current[2]
                ) -
                num(
                    current[3]
                ),
                1e-12
            );


        const body =
            Math.abs(
                num(
                    current[4]
                ) -
                num(
                    current[1]
                )
            );


        const bodyRatio =
            body /
            range;


        if (
            volumeRatio <
                CFG.BREAKOUT_VOLUME_RATIO ||
            bodyRatio <
                0.18
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

                volumeRatio
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

                volumeRatio
            };
        }
    }


    return null;
}


/* =========================================================
   RETEST
========================================================= */

function detectRetest(
    candles,
    breakout,
    direction
) {

    if (
        !breakout
    ) {

        return {
            ok:
                false,

            status:
                'WAITING_RETEST'
        };
    }


    const c =
        closed(
            candles
        );


    const after =
        c
            .filter(
                candle =>
                    num(
                        candle[0]
                    ) >
                    breakout.time
            )
            .slice(
                0,
                CFG.RETEST_WINDOW
            );


    if (
        !after.length
    ) {

        return {

            ok:
                false,

            status:
                'WAITING_RETEST'
        };
    }


    const tolerance =
        breakout.level *
        CFG.RETEST_TOLERANCE;


    let touched =
        false;


    let recovered =
        false;


    let invalid =
        false;


    for (
        const candle
        of after
    ) {

        const high =
            num(
                candle[2]
            );


        const low =
            num(
                candle[3]
            );


        const close =
            num(
                candle[4]
            );


        const touches =
            high >=
                breakout.level -
                tolerance &&

            low <=
                breakout.level +
                tolerance;


        if (
            !touches
        ) {

            continue;
        }


        touched =
            true;


        if (
            direction ===
            'LONG'
        ) {

            if (
                close <
                breakout.level *
                0.992
            ) {

                invalid =
                    true;
            }


            if (
                close >=
                breakout.level
            ) {

                recovered =
                    true;
            }

        }
        else {

            if (
                close >
                breakout.level *
                1.008
            ) {

                invalid =
                    true;
            }


            if (
                close <=
                breakout.level
            ) {

                recovered =
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
                'INVALIDATED'
        };
    }


    if (
        touched &&
        recovered
    ) {

        return {

            ok:
                true,

            status:
                'RETESTED',

            candle:
                after[
                    after.length - 1
                ]
        };
    }


    return {

        ok:
            false,

        status:
            'WAITING_RETEST'
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
        closed(
            candles
        );


    if (
        c.length <
        20
    ) {

        return null;
    }


    const price =
        num(
            c[
                c.length - 1
            ][4]
        );


    const volatility =
        atr(
            candles,
            14
        )
        ||
        price *
        0.005;


    const recent =
        c.slice(
            -6
        );


    const swingLow =
        Math.min(
            ...recent.map(
                x =>
                    num(
                        x[3]
                    )
            )
        );


    const swingHigh =
        Math.max(
            ...recent.map(
                x =>
                    num(
                        x[2]
                    )
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
                price,
                level
            );


        stop =
            Math.min(
                swingLow,
                level -
                volatility *
                CFG.ATR_STOP
            );


        if (
            stop >=
            entry
        ) {

            stop =
                entry -
                volatility *
                CFG.ATR_STOP;
        }

    }
    else {

        entry =
            Math.min(
                price,
                level
            );


        stop =
            Math.max(
                swingHigh,
                level +
                volatility *
                CFG.ATR_STOP
            );


        if (
            stop <=
            entry
        ) {

            stop =
                entry +
                volatility *
                CFG.ATR_STOP;
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
                entry,
                level
            ),

        entryHigh:
            Math.max(
                entry,
                level
            ),

        stop,

        tp1,

        tp2,

        tp3,

        rr,

        rsi:
            rsi(
                candles
            )
    };
}


/* =========================================================
   5M
========================================================= */

function confirm5M(
    candles,
    direction
) {

    const c =
        closed(
            candles
        );


    if (
        c.length < 3
    ) {

        return false;
    }


    const last =
        c[
            c.length - 1
        ];


    const previous =
        c[
            c.length - 2
        ];


    if (
        direction ===
        'LONG'
    ) {

        return (
            num(
                last[4]
            ) >
            num(
                last[1]
            )
            &&
            num(
                last[4]
            ) >=
            num(
                previous[4]
            )
        );
    }


    return (

        num(
            last[4]
        ) <
        num(
            last[1]
        )
        &&
        num(
            last[4]
        ) <=
        num(
            previous[4]
        )

    );
}


/* =========================================================
   ANALYZE COIN
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
        h1.length < 70 ||
        m15.length < 35 ||
        m5.length < 15
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
        h2.length < 45 ||
        h4.length < 45
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


    const m15Structure =
        structure(
            m15
        );


    const m5Trend =
        trend(
            m5
        );


    const h4Levels =
        getLevels(
            h4
        );


    const h2Levels =
        getLevels(
            h2
        );


    if (
        !h4Levels ||
        !h2Levels
    ) {

        return null;
    }


    const possibleLevels = [

        {
            tf:
                '4H',

            type:
                'resistance',

            price:
                h4Levels.resistance
        },

        {
            tf:
                '4H',

            type:
                'support',

            price:
                h4Levels.support
        },

        {
            tf:
                '2H',

            type:
                'resistance',

            price:
                h2Levels.resistance
        },

        {
            tf:
                '2H',

            type:
                'support',

            price:
                h2Levels.support
        }

    ];


    const found = [];


    for (
        const direction
        of [
            'LONG',
            'SHORT'
        ]
    ) {

        const wantedType =
            direction ===
            'LONG'
                ? 'resistance'
                : 'support';


        const levels =
            possibleLevels.filter(
                level =>
                    level.type ===
                    wantedType
            );


        for (
            const level
            of levels
        ) {

            const breakout =
                detectBreakout(
                    m15,
                    direction,
                    level.price
                );


            if (
                !breakout
            ) {

                continue;
            }


            const key =
                [
                    symbol,
                    direction,
                    level.tf,
                    fmt(
                        level.price
                    )
                ].join('|');


            const retest =
                detectRetest(
                    m15,
                    breakout,
                    direction
                );


            if (
                !retest.ok
            ) {

                if (
                    retest.status ===
                    'WAITING_RETEST'
                ) {

                    STATE.pending.set(
                        key,
                        {

                            key,

                            symbol,

                            direction,

                            level:
                                level.price,

                            tf:
                                level.tf,

                            breakoutTime:
                                breakout.time,

                            breakoutVolumeRatio:
                                breakout.volumeRatio,

                            status:
                                retest.status,

                            updatedAt:
                                Date.now(),

                            createdAt:
                                Date.now()

                        }
                    );
                }


                continue;
            }


            /*
            Trend çatışması varsa
            sadece ikisi birden ters ise ele.
            */

            if (
                h4Trend !==
                    'NEUTRAL' &&

                h2Trend !==
                    'NEUTRAL' &&

                h4Trend !==
                    direction &&

                h2Trend !==
                    direction
            ) {

                continue;
            }


            /*
            Piyasa filtresi katı değil.
            Altcoin setup kaçırmıyoruz.
            */

            if (
                STATE.market.direction !==
                    'FLAT' &&

                STATE.market.direction !==
                    direction &&

                h4Trend !==
                    direction &&

                h2Trend !==
                    direction
            ) {

                continue;
            }


            const five =
                confirm5M(
                    m5,
                    direction
                );


            if (
                CFG.REQUIRE_5M &&
                !five
            ) {

                continue;
            }


            const currentRsi =
                rsi(
                    m15
                );


            let score =
                43;


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
                    12;

                reasons.push(
                    '2H uyumlu'
                );
            }


            if (
                m15Structure ===
                direction
            ) {

                score +=
                    8;

                reasons.push(
                    '15M uyumlu'
                );
            }


            if (
                five
            ) {

                score +=
                    8;

                reasons.push(
                    '5M teyit'
                );
            }


            if (
                breakout.volumeRatio >=
                1.5
            ) {

                score +=
                    8;

                reasons.push(
                    'hacim güçlü'
                );
            }


            if (
                breakout.volumeRatio >=
                2
            ) {

                score +=
                    5;

                reasons.push(
                    'hacim çok güçlü'
                );
            }


            if (
                STATE.market.direction ===
                direction
            ) {

                score +=
                    6;

                reasons.push(
                    'piyasa uyumlu'
                );
            }


            if (
                direction ===
                    'LONG' &&
                currentRsi >=
                    47 &&
                currentRsi <=
                    75
            ) {

                score +=
                    5;

                reasons.push(
                    'RSI uygun'
                );
            }


            if (
                direction ===
                    'SHORT' &&
                currentRsi >=
                    25 &&
                currentRsi <=
                    53
            ) {

                score +=
                    5;

                reasons.push(
                    'RSI uygun'
                );
            }


            score =
                Math.min(
                    100,
                    score
                );


            if (
                score <
                CFG.MIN_SCORE
            ) {

                continue;
            }


            const trade =
                createTradePlan(
                    direction,
                    level,
                    m15
                );


            if (
                !trade
            ) {

                continue;
            }


            found.push({

                id:
                    symbol +
                    '|' +
                    direction,

                symbol,

                marketSymbol:
                    symbol,

                coin:
                    cleanSymbol(
                        symbol
                    ),

                direction,

                score,

                confidence:
                    score,

                price:
                    row.price,

                currentPrice:
                    row.price,

                entry:
                    trade.entry,

                entryLow:
                    trade.entryLow,

                entryHigh:
                    trade.entryHigh,

                stop:
                    trade.stop,

                stopLoss:
                    trade.stop,

                tp1:
                    trade.tp1,

                tp2:
                    trade.tp2,

                tp3:
                    trade.tp3,

                rr:
                    Number(
                        trade.rr.toFixed(
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
                        breakout.volumeRatio.toFixed(
                            2
                        )
                    ),

                breakoutLevel:
                    level.price,

                timeframeLevel:
                    level.tf,

                h4Trend,

                h2Trend,

                m15Trend:
                    m15Structure,

                m5Trend,

                status:
                    'GİRİŞ BEKLENİYOR',

                entryReady:
                    false,

                reason:
                    reasons.join(
                        ' + '
                    ),

                reasons,

                breakoutTime:
                    breakout.time,

                retestTime:
                    retest.candle
                        ? num(
                            retest.candle[0]
                        )
                        : 0,

                signalAt:
                    Date.now(),

                cooldownKey:
                    key

            });
        }
    }


    if (
        !found.length
    ) {

        return null;
    }


    found.sort(
        (
            a,
            b
        ) =>
            b.score -
            a.score
    );


    return {
        signal:
            found[0]
    };
}


/* =========================================================
   AGGREGATION
========================================================= */

function aggregateCandles(
    candles,
    hours
) {

    if (
        !Array.isArray(
            candles
        )
    ) {

        return [];
    }


    const bucketMs =
        hours *
        60 *
        60 *
        1000;


    const buckets =
        new Map();


    for (
        const candle
        of candles
    ) {

        const timestamp =
            num(
                candle[0]
            );


        if (
            !timestamp
        ) {

            continue;
        }


        const bucket =
            Math.floor(
                timestamp /
                bucketMs
            ) *
            bucketMs;


        if (
            !buckets.has(
                bucket
            )
        ) {

            buckets.set(
                bucket,
                [

                    bucket,

                    num(
                        candle[1]
                    ),

                    num(
                        candle[2]
                    ),

                    num(
                        candle[3]
                    ),

                    num(
                        candle[4]
                    ),

                    num(
                        candle[5]
                    )

                ]
            );

        }
        else {

            const current =
                buckets.get(
                    bucket
                );


            current[2] =
                Math.max(
                    current[2],
                    num(
                        candle[2]
                    )
                );


            current[3] =
                Math.min(
                    current[3],
                    num(
                        candle[3]
                    )
                );


            current[4] =
                num(
                    candle[4]
                );


            current[5] +=
                num(
                    candle[5]
                );
        }
    }


    return [
        ...buckets.values()
    ].sort(
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


    STATE.stats.pending =
        STATE.pending.size;


    STATE.stats.signals =
        STATE.signals.size;

}


/* =========================================================
   CHART REFRESH
========================================================= */

async function refreshChart() {

    const market =
        findMarket(
            STATE.selected
        );


    if (
        !market
    ) {

        console.error(
            'CHART: selected market bulunamadı:',
            STATE.selected
        );

        return;
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
                item.symbol ===
                market.symbol
        ) ||
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
   LIVE SIGNALS
========================================================= */

async function updateLiveSignals() {

    if (
        !STATE.signals.size
    ) {

        return;
    }


    try {

        const tickers =
            await exchange.fetchTickers();


        for (
            const [
                id,
                signal
            ]
            of STATE.signals
        ) {

            const ticker =
                tickers[
                    signal.symbol
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

                    signal.status =
                        'STOP';


                    STATE.signals.delete(
                        id
                    );

                }
                else if (
                    current >=
                    signal.tp3
                ) {

                    signal.status =
                        'TP3';

                }
                else if (
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
                        signal.entryLow &&
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

                    signal.status =
                        'STOP';


                    STATE.signals.delete(
                        id
                    );

                }
                else if (
                    current <=
                    signal.tp3
                ) {

                    signal.status =
                        'TP3';

                }
                else if (
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
                        signal.entryLow &&
                    current <=
                        signal.entryHigh
                ) {

                    signal.status =
                        'GİRİŞ ALANI';

                    signal.entryReady =
                        true;

                }
            }
        }


        cleanup();


        if (
            STATE.selected
        ) {

            await refreshChart();

        }

    }
    catch (error) {

        STATE.lastError =
            error.message;


        console.error(
            'LIVE ERROR:',
            error.message
        );
    }

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
        '';


    STATE.stats.analyzed =
        0;


    STATE.stats.errors =
        0;


    const started =
        Date.now();


    try {

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

        STATE.universe =
            await fetchRadar();


        STATE.stats.universe =
            STATE.universe.length;


        /*
           GENEL PİYASA
        */

        await updateMarket(
            STATE.universe
        );


        /*
           500 -> 150
        */

        STATE.candidates =
            STATE.universe
                .filter(
                    coin =>
                        coin.volume >=
                        CFG.MIN_VOLUME_USDT
                )
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
            STATE.candidates.slice(
                0,
                CFG.DEEP
            );


        STATE.stats.deep =
            STATE.deep.length;


        /*
           DEEP
        */

        const results =
            await mapLimit(
                STATE.deep,
                CFG.CONCURRENCY,
                async coin => {

                    const result =
                        await analyzeCoin(
                            coin
                        );


                    STATE.stats.analyzed +=
                        1;


                    return result;
                }
            );


        /*
           SİNYALLER
        */

        for (
            const result
            of results
        ) {

            if (
                !result ||
                !result.signal
            ) {

                continue;
            }


            const signal =
                result.signal;


            if (
                STATE.signals.has(
                    signal.id
                )
            ) {

                continue;
            }


            STATE.signals.set(
                signal.id,
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


        /*
           Her tarama sonrası
           seçili coin grafiğini güncelle.
        */

        if (
            STATE.selected
        ) {

            await refreshChart();

        }


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
            )
            .toFixed(1) +

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
            'SONNY AI TRADER FINAL v5.3',

        autoTrade:
            CFG.AUTO_TRADE,

        scanning:
            STATE.scanning,

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
                        fmt(
                            item.level
                        ),

                    tf:
                        item.tf,

                    breakoutVolume:
                        Number(
                            item
                                .breakoutVolumeRatio
                                .toFixed(
                                    2
                                )
                        ),

                    status:
                        item.status,

                    breakoutTime:
                        item.breakoutTime
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
    '/health',
    (
        req,
        res
    ) => {

        res.json({

            ok:
                true,

            service:
                'Sonny AI Trader FINAL v5.3',

            stats:
                statusData().stats,

            signals:
                statusData().signals.length,

            pending:
                statusData().pending.length,

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


/* =========================================================
   MANUAL SCAN
========================================================= */

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
   CHART API
========================================================= */

app.get(
    '/api/chart',
    async (
        req,
        res
    ) => {

        try {

            const market =
                findMarket(
                    req.query.symbol ||
                    STATE.selected
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


            const requested =
                String(
                    req.query.timeframe ||
                    '15m'
                );


            const allowed = [

                '5m',
                '15m',
                '1h',
                '2h',
                '4h'

            ];


            STATE.selected =
                market.symbol;


            STATE.timeframe =
                allowed.includes(
                    requested
                )
                    ? requested
                    : '15m';


            await refreshChart();


            res.json({

                success:
                    true,

                symbol:
                    STATE.chart.symbol,

                timeframe:
                    STATE.chart.timeframe,

                candles:
                    STATE.chart.candles.map(
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
                    ),

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
SONNY AI TRADER FINAL
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
font-family:Arial,Helvetica,sans-serif;
}

body{
overflow:hidden;
}

.app{
height:100vh;
display:grid;
grid-template-columns:245px minmax(0,1fr) 285px;
}

.side{
background:#0b0f16;
border-right:1px solid #202936;
padding:12px;
overflow:auto;
}

.brand{
font-size:18px;
font-weight:900;
}

.brand small{
display:block;
font-size:9px;
font-weight:500;
color:#718096;
margin-top:4px;
}

.scan{
width:100%;
margin-top:10px;
padding:10px;
border:0;
border-radius:7px;
background:#172742;
color:#fff;
font-weight:800;
cursor:pointer;
}

.stats{
display:grid;
grid-template-columns:repeat(3,1fr);
gap:5px;
margin-top:10px;
}

.stat{
background:#0f151e;
border:1px solid #202c3b;
border-radius:6px;
padding:7px;
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
background:#0f151e;
border:1px solid #202c3b;
border-left:3px solid #13e0a2;
border-radius:8px;
padding:10px;
cursor:pointer;
}

.card.short{
border-left-color:#ff4d6d;
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
font-size:13px;
font-weight:900;
}

.badge{
font-size:9px;
font-weight:900;
padding:3px 6px;
border-radius:4px;
}

.badge.long{
background:#073c2e;
color:#13e0a2;
}

.badge.short{
background:#451322;
color:#ff4d6d;
}

.cp{
font-size:18px;
font-weight:900;
margin-top:7px;
}

.meta{
font-size:9px;
color:#718096;
margin-top:5px;
}

.main{
min-width:0;
display:flex;
flex-direction:column;
}

.head{
height:65px;
display:flex;
justify-content:space-between;
align-items:center;
gap:10px;
padding:0 14px;
border-bottom:1px solid #202936;
}

.title{
font-size:19px;
font-weight:900;
}

.sub{
font-size:9px;
color:#718096;
margin-top:4px;
}

.pill{
color:#13e0a2;
background:#073323;
border:1px solid #0b684a;
padding:7px 10px;
border-radius:18px;
font-size:9px;
white-space:nowrap;
}

.chartwrap{
position:relative;
flex:1;
min-height:0;
}

.toolbar{
position:absolute;
z-index:10;
top:10px;
left:12px;
right:12px;
display:flex;
justify-content:space-between;
align-items:center;
pointer-events:none;
}

.chartname{
font-size:12px;
font-weight:900;
}

.tf{
display:flex;
gap:4px;
pointer-events:auto;
}

.tf button{
background:#111b29;
color:#8995a6;
border:1px solid #26384f;
border-radius:5px;
padding:5px 8px;
font-size:9px;
cursor:pointer;
}

.tf button.active{
color:#fff;
background:#172a47;
border-color:#428cff;
}

canvas{
display:block;
width:100%;
height:100%;
}

.right{
background:#0b0f16;
border-left:1px solid #202936;
padding:10px;
overflow:auto;
}

.box{
background:#0f151e;
border:1px solid #202c3b;
border-radius:8px;
padding:11px;
margin-bottom:9px;
}

.box-title{
font-size:9px;
font-weight:900;
color:#8292a6;
}

.market{
font-size:19px;
font-weight:900;
color:#f4c84a;
margin-top:6px;
}

.market.up{
color:#13e0a2;
}

.market.down{
color:#ff4d6d;
}

.info{
font-size:9px;
line-height:1.6;
color:#718096;
margin-top:6px;
}

.active-name{
font-size:15px;
font-weight:900;
margin-top:6px;
}

.active-name.long{
color:#13e0a2;
}

.active-name.short{
color:#ff4d6d;
}

.grid2{
display:grid;
grid-template-columns:1fr 1fr;
gap:5px;
margin-top:8px;
}

.level{
background:#0a1017;
border:1px solid #182534;
border-radius:5px;
padding:7px;
}

.level span{
display:block;
font-size:8px;
color:#718096;
}

.level b{
font-size:11px;
}

.green{
color:#13e0a2;
}

.red{
color:#ff4d6d;
}

.blue{
color:#4da3ff;
}

.pendingItem{
background:#09111b;
border-left:2px solid #f4c84a;
padding:7px;
border-radius:4px;
margin-top:5px;
font-size:9px;
}

.empty{
font-size:10px;
color:#718096;
padding:10px;
}

@media(max-width:950px){

.app{
grid-template-columns:
210px
minmax(0,1fr);
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
border-right:0;
border-bottom:1px solid #202936;
max-height:215px;
}

.cards{
flex-direction:row;
overflow-x:auto;
}

.card{
min-width:165px;
}

.main{
height:
calc(
100vh -
215px
);
min-height:420px;
}

.head{
height:48px;
padding:0 8px;
}

.title{
font-size:15px;
}

.pill{
font-size:8px;
padding:6px;
}

.chartwrap{
height:
calc(
100vh -
263px
);
min-height:350px;
}

.tf button{
padding:5px 6px;
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
FINAL v5.3 • BITGET FUTURES
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
<b id="cand">0</b>
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
Teyit edilmiş sinyal yok.
</div>

</div>

</aside>


<main class="main">


<header class="head">

<div>

<div class="title">

<span id="sym">
BTCUSDT
</span>

•

<span id="tft">
15M
</span>

</div>


<div
id="scanText"
class="sub"
>
Sistem hazırlanıyor...
</div>

</div>


<div class="pill">

● AUTO TRADE KAPALI

</div>

</header>


<div class="chartwrap">


<div class="toolbar">

<div
id="chartName"
class="chartname"
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
></canvas>


</div>

</main>


<aside class="right">


<div class="box">

<div class="box-title">
GENEL PİYASA
</div>


<div
id="market"
class="market"
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

<div class="box-title">
AKTİF SCALP SİNYALİ
</div>


<div
id="active"
>

<div class="empty">
Henüz teyit edilmiş
sinyal yok.
</div>

</div>

</div>


<div class="box">

<div class="box-title">
BEKLEYEN KIRILIM / RETEST
</div>


<div
id="pending"
>

<div class="empty">
Bekleyen setup yok.
</div>

</div>

</div>

</aside>


</div>


<script>

(function(){

'use strict';


let selected =
'BTC/USDT:USDT';


let timeframe =
'15m';


let candles = [];


let currentSignal =
null;


/* =====================================================
   HELPERS
===================================================== */

function el(
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

            }[
                c
            ];

        }
    );

}


function price(
    value
){

    const x =
        Number(
            value
        );


    if (
        !Number.isFinite(x)
    ){

        return '-';

    }


    if (
        x >= 1000
    ){

        return x.toFixed(2);

    }


    if (
        x >= 100
    ){

        return x.toFixed(3);

    }


    if (
        x >= 1
    ){

        return x.toFixed(5);

    }


    if (
        x >= 0.01
    ){

        return x.toFixed(7);

    }


    if (
        x >= 0.0001
    ){

        return x.toFixed(8);

    }


    return x.toFixed(10);

}


/* =====================================================
   STATUS
===================================================== */

function render(
    data
){

    const stats =
        data.stats ||
        {};


    el(
        'radar'
    ).textContent =
        stats.universe ||
        0;


    el(
        'cand'
    ).textContent =
        stats.candidates ||
        0;


    el(
        'deep'
    ).textContent =
        stats.deep ||
        0;


    el(
        'scanText'
    ).textContent =

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


    const market =
        data.market ||
        {};


    el(
        'market'
    ).textContent =
        market.label ||
        'YATAY / KARIŞIK';


    el(
        'market'
    ).className =
        'market ' +

        (
            market.direction ===
            'LONG'

                ? 'up'

                : market.direction ===
                  'SHORT'

                    ? 'down'

                    : ''
        );


    el(
        'marketInfo'
    ).innerHTML =

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


    const signals =
        data.signals ||
        [];


    const cards =
        el(
            'cards'
        );


    cards.innerHTML =
        '';


    if (
        !signals.length
    ){

        cards.innerHTML =
            '<div class="empty">'+
            'Teyit edilmiş sinyal yok.'+
            '</div>';

    }
    else {

        signals.forEach(
            function(
                signal
            ){

                const card =
                    document.createElement(
                        'div'
                    );


                card.className =
                    'card ' +

                    (
                        signal.direction ===
                        'SHORT'

                            ? 'short'

                            : ''
                    ) +

                    (
                        signal.marketSymbol ===
                        selected

                            ? ' active'

                            : ''
                    );


                card.innerHTML =

                    '<div class="top">'+

                        '<div class="coin">'+
                            esc(
                                signal.symbol
                            )+
                        '</div>'+

                        '<div class="badge '+
                            (
                                signal.direction ===
                                'LONG'
                                    ? 'long'
                                    : 'short'
                            )+
                        '">'+
                            esc(
                                signal.direction
                            )+
                        '</div>'+

                    '</div>'+

                    '<div class="cp">'+
                        price(
                            signal.currentPrice ||
                            signal.entry
                        )+
                    '</div>'+

                    '<div class="meta">'+
                        '● GİRİŞ ALANI • '+
                        'GÜÇ '+
                        esc(
                            signal.score
                        )+
                        '/100'+
                    '</div>';


                card.onclick =
                    function(){

                        selected =
                            signal.marketSymbol;

                        currentSignal =
                            signal;

                        showActive(
                            signal
                        );

                        loadChart();

                    };


                cards.appendChild(
                    card
                );

            }
        );

    }


    let selectedSignal =
        signals.find(
            function(
                signal
            ){

                return (
                    signal.marketSymbol ===
                    selected
                );

            }
        );


    if (
        !selectedSignal &&
        signals.length
    ){

        selectedSignal =
            signals[0];

        selected =
            selectedSignal.marketSymbol;
    }


    currentSignal =
        selectedSignal ||
        null;


    showActive(
        currentSignal
    );


    renderPending(
        data.pending ||
        []
    );


    if (
        data.chart
    ){

        candles =
            normalizeCandles(
                data.chart.candles ||
                []
            );


        if (
            data.chart.symbol
        ){

            selected =
                data.chart.symbol;
        }


        if (
            data.chart.timeframe
        ){

            timeframe =
                data.chart.timeframe;
        }


        if (
            data.chart.signal
        ){

            currentSignal =
                data.chart.signal;
        }


        updateHeader();

        drawChart();

    }

}


/* =====================================================
   ACTIVE
===================================================== */

function showActive(
    signal
){

    if (
        !signal
    ){

        el(
            'active'
        ).innerHTML =

            '<div class="empty">'+
            'Henüz teyit edilmiş '+
            'sinyal yok.'+
            '</div>';

        return;

    }


    const cls =
        signal.direction ===
        'LONG'
            ? 'long'
            : 'short';


    el(
        'active'
    ).innerHTML =

        '<div class="active-name '+
        cls+
        '">'+

            esc(
                signal.symbol
            )+

            ' • '+

            esc(
                signal.direction
            )+

        '</div>'+

        '<div class="grid2">'+


            detail(
                'GİRİŞ',
                price(
                    signal.entryLow
                )+
                ' — '+
                price(
                    signal.entryHigh
                ),
                'green'
            )+


            detail(
                'STOP',
                price(
                    signal.stop
                ),
                'red'
            )+


            detail(
                'TP1',
                price(
                    signal.tp1
                ),
                'blue'
            )+


            detail(
                'TP2',
                price(
                    signal.tp2
                ),
                'blue'
            )+


            detail(
                'TP3',
                price(
                    signal.tp3
                ),
                'blue'
            )+


            detail(
                'R:R',
                '1:'+
                esc(
                    signal.rr
                ),
                ''
            )+


        '</div>'+

        '<div class="info">'+

            esc(
                signal.status ||
                'GİRİŞ BEKLENİYOR'
            )+

            ' • SKOR '+
            esc(
                signal.score
            )+
            '/100'+

            '<br>RSI '+
            esc(
                signal.rsi
            )+

            ' • VOL '+
            esc(
                signal.volumeRatio
            )+
            'x'+

            '<br>'+

            esc(
                signal.reason ||
                ''
            )+

        '</div>';

}


function detail(
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
                esc(
                    value
                )+
            '</b>'+

        '</div>'

    );

}


/* =====================================================
   PENDING
===================================================== */

function renderPending(
    items
){

    const target =
        el(
            'pending'
        );


    if (
        !items.length
    ){

        target.innerHTML =
            '<div class="empty">'+
            'Bekleyen setup yok.'+
            '</div>';

        return;

    }


    target.innerHTML =
        items.map(
            function(
                item
            ){

                return (

                    '<div class="pendingItem">'+

                        '<b>'+
                            esc(
                                item.symbol
                            )+
                            ' '+
                            esc(
                                item.direction
                            )+
                        '</b>'+

                        '<br>'+
                        'Seviye '+
                        esc(
                            item.level
                        )+

                        ' • '+
                        esc(
                            item.status
                        )+

                    '</div>'

                );

            }
        ).join('');

}


/* =====================================================
   NORMALIZE
===================================================== */

function normalizeCandles(
    items
){

    return (
        items ||
        []
    )

    .map(
        function(
            item
        ){

            if (
                Array.isArray(
                    item
                )
            ){

                return {

                    time:
                        Number(
                            item[0]
                        ),

                    open:
                        Number(
                            item[1]
                        ),

                    high:
                        Number(
                            item[2]
                        ),

                    low:
                        Number(
                            item[3]
                        ),

                    close:
                        Number(
                            item[4]
                        ),

                    volume:
                        Number(
                            item[5] ||
                            0
                        )

                };

            }


            return {

                time:
                    Number(
                        item.time
                    ),

                open:
                    Number(
                        item.open
                    ),

                high:
                    Number(
                        item.high
                    ),

                low:
                    Number(
                        item.low
                    ),

                close:
                    Number(
                        item.close
                    ),

                volume:
                    Number(
                        item.volume ||
                        0
                    )

            };

        }
    )

    .filter(
        function(
            item
        ){

            return (

                Number.isFinite(
                    item.time
                ) &&

                Number.isFinite(
                    item.open
                ) &&

                Number.isFinite(
                    item.high
                ) &&

                Number.isFinite(
                    item.low
                ) &&

                Number.isFinite(
                    item.close
                )

            );

        }
    )

    .sort(
        function(
            a,
            b
        ){

            return (
                a.time -
                b.time
            );

        }
    );

}


/* =====================================================
   HEADER
===================================================== */

function updateHeader(){

    const symbol =
        String(
            selected ||
            'BTCUSDT'
        )
        .replace(
            '/USDT:USDT',
            'USDT'
        );


    const tf =
        String(
            timeframe ||
            '15m'
        ).toUpperCase();


    el(
        'sym'
    ).textContent =
        symbol;


    el(
        'tft'
    ).textContent =
        tf;


    el(
        'chartName'
    ).textContent =
        symbol +
        ' • ' +
        tf;

}


/* =====================================================
   LOAD CHART
===================================================== */

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


        if (
            !data.success
        ){

            console.error(
                data.error
            );

            return;

        }


        candles =
            normalizeCandles(
                data.candles ||
                []
            );


        if (
            data.signal
        ){

            currentSignal =
                data.signal;

            showActive(
                currentSignal
            );

        }


        selected =
            data.ccxtSymbol ||
            data.symbol ||
            selected;


        timeframe =
            data.timeframe ||
            timeframe;


        updateHeader();

        drawChart();

    }
    catch(
        error
    ){

        console.error(
            'GRAFİK ERROR:',
            error
        );

    }

}


/* =====================================================
   CANVAS CHART
===================================================== */

function drawChart(){

    const canvas =
        el(
            'chart'
        );


    if (
        !canvas
    ){

        return;

    }


    const rect =
        canvas.getBoundingClientRect();


    const dpr =
        window.devicePixelRatio ||
        1;


    const width =
        Math.max(
            320,
            rect.width
        );


    const height =
        Math.max(
            320,
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


    if (
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
            candle
        ){

            values.push(
                candle.high,
                candle.low
            );

        }
    );


    const signal =
        currentSignal;


    if (
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


    let min =
        Math.min(
            ...values
        );


    let max =
        Math.max(
            ...values
        );


    const range =
        max -
        min;


    const padding =
        range *
        0.07 ||
        1;


    min -=
        padding;


    max +=
        padding;


    const left =
        55;


    const right =
        78;


    const top =
        28;


    const bottom =
        25;


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
        let i = 0;
        i <= 5;
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


        const pv =
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
            price(
                pv
            ),
            5,
            gy + 3
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


    const body =
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
            candle,
            index
        ){

            const xx =
                x(
                    index
                );


            const open =
                Number(
                    candle.open
                );


            const high =
                Number(
                    candle.high
                );


            const low =
                Number(
                    candle.low
                );


            const close =
                Number(
                    candle.close
                );


            const up =
                close >=
                open;


            const color =
                up
                    ? '#13e0a2'
                    : '#ff4d6d';


            ctx.strokeStyle =
                color;


            ctx.fillStyle =
                color;


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


            const openY =
                y(
                    open
                );


            const closeY =
                y(
                    close
                );


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
                        openY -
                        closeY
                    )
                )

            );

        }
    );


    /* ENTRY ZONE */

    if (
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
            'rgba(19,224,162,.11)';


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

        line(
            signal.stop,
            '#ff4d6d',
            'STOP'
        );


        line(
            signal.entry,
            '#13e0a2',
            'GİRİŞ'
        );


        line(
            signal.tp1,
            '#4da3ff',
            'TP1'
        );


        line(
            signal.tp2,
            '#4da3ff',
            'TP2'
        );


        line(
            signal.tp3,
            '#4da3ff',
            'TP3'
        );

    }


    function line(
        value,
        color,
        label
    ){

        const number =
            Number(
                value
            );


        if(
            !Number.isFinite(
                number
            )
        ){

            return;

        }


        const yy =
            y(
                number
            );


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

            label +
            ' ' +
            price(
                number
            ),

            width -
            right +
            5,

            yy +
            3
        );

    }

}


/* =====================================================
   TIMEFRAMES
===================================================== */

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

                        item.classList
                            .remove(
                                'active'
                            );

                    }
                );


                button.classList
                    .add(
                        'active'
                    );


                timeframe =
                    button.dataset.tf;


                loadChart();

            };

    }
);


/* =====================================================
   SCAN
===================================================== */

el(
    'scan'
)
.onclick =
function(){

    fetch(
        '/api/scan'
    )
    .catch(
        function(){}
    );

};


/* =====================================================
   WEBSOCKET
===================================================== */

function connect(){

    const protocol =
        location.protocol ===
        'https:'
            ? 'wss://'
            : 'ws://';


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
                    'WS ERROR:',
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


/* INITIAL */

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

    }
);


/* REFRESH */

setInterval(
    function(){

        if(
            selected
        ){

            loadChart();

        }

    },
    15000
);


window.addEventListener(
    'resize',
    function(){

        drawChart();

    }
);

})();

</script>


</body>

</html>
`;


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
            error?.message ||
            String(
                error
            );

        console.error(
            'UNHANDLED:',
            error
        );
    }
);


process.on(
    'uncaughtException',
    error => {

        STATE.lastError =
            error?.message ||
            String(
                error
            );

        console.error(
            'UNCAUGHT:',
            error
        );
    }
);


/* =========================================================
   START
========================================================= */

(async function(){

    console.log(
        '================================================='
    );

    console.log(
        '🚀 SONNY AI TRADER FINAL v5.3'
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
        '🌐 Port: ' +
        PORT
    );

    console.log(
        '================================================='
    );


    try{

        await loadMarkets();


        console.log(
            'MARKETS | Gerçek USDT perpetual=' +
            STATE.markets.length
        );


    }
    catch(
        error
    ){

        STATE.lastError =
            error.message;


        console.error(
            'MARKET ERROR:',
            error.message
        );

    }


    server.listen(
        PORT,
        '0.0.0.0',
        function(){

            console.log(
                '🌐 Server listening on ' +
                PORT
            );

        }
    );


    await runScan();


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

})();
