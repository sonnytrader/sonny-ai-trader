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
   SONNY AI TRADER V5.3
   500 RADAR
   150 ADAY
   40 DERİN
   4H + 2H
      ->
   15M BREAKOUT
      ->
   15M RETEST
      ->
   5M BONUS TEYİT

   AUTO TRADE: KAPALI

   NOT:
   Grafik SERVER.JS içinde.
   Harici index.html gerektirmez.
========================================================= */

const CFG = {
    MAX_RADAR: 500,
    CANDIDATES: 150,
    DEEP: 40,

    MAX_SIGNALS: 15,

    MIN_VOLUME_USDT:
        Number(
            process.env.MIN_VOLUME_USDT || 750000
        ),

    SCAN_MS: 60000,

    LIVE_MS: 10000,

    MARKET_REFRESH_MS:
        15 * 60 * 1000,

    CONCURRENCY: 5,

    H1_LIMIT: 260,

    M15_LIMIT: 180,

    M5_LIMIT: 120,

    CHART_LIMIT: 150,

    BREAKOUT_LOOKBACK: 12,

    BREAKOUT_VOLUME_RATIO: 1.15,

    RETEST_WINDOW: 8,

    RETEST_TOLERANCE: 0.005,

    MIN_SCORE: 66,

    MIN_RR: 1.50,

    TP2_RR: 2.25,

    TP3_RR: 3.25,

    ATR_STOP: 1.15,

    SIGNAL_TTL:
        45 * 60 * 1000,

    PENDING_TTL:
        90 * 60 * 1000,

    COOLDOWN:
        4 * 60 * 60 * 1000,

    /* 5M ZORUNLU DEĞİL */
    REQUIRE_5M: false,

    AUTO_TRADE: false
};


/* =========================================================
   EXCHANGE
========================================================= */

const exchange =
    new ccxt.bitget({
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

    signals:
        new Map(),

    pending:
        new Map(),

    cooldowns:
        new Map(),

    selected:
        'BTC/USDT:USDT',

    timeframe:
        '15m',

    scanning:
        false,

    lastScan:
        0,

    lastError:
        '',

    marketRefresh:
        0,

    market: {

        label:
            'YATAY / KARIŞIK',

        direction:
            'FLAT',

        breadth:
            50,

        green:
            0,

        red:
            0,

        average:
            0,

        btc:
            'NEUTRAL',

        eth:
            'NEUTRAL',

        reason:
            'Piyasa verisi bekleniyor.'
    },

    chart: {

        symbol:
            'BTC/USDT:USDT',

        timeframe:
            '15m',

        candles:
            [],

        signal:
            null
    },

    stats: {

        universe:
            0,

        candidates:
            0,

        deep:
            0,

        analyzed:
            0,

        pending:
            0,

        signals:
            0,

        errors:
            0
    }
};


/* =========================================================
   HELPERS
========================================================= */

function num(
    value,
    fallback = 0
) {

    const x =
        Number(value);

    return Number.isFinite(x)
        ? x
        : fallback;
}


function clamp(
    value,
    min,
    max
) {

    return Math.max(
        min,
        Math.min(
            max,
            value
        )
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
                ':USDT',
                ''
            )
            .replace(
                '/USDT',
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


function marketSymbol(
    symbol
) {

    const s =
        String(
            symbol || ''
        )
            .toUpperCase();

    if (
        s.includes('/USDT:USDT')
    ) {

        return s;
    }

    if (
        s.includes('/USDT')
    ) {

        return s.replace(
            '/USDT',
            '/USDT:USDT'
        );
    }

    if (
        s.endsWith('USDT')
    ) {

        return (
            s.slice(
                0,
                -4
            ) +
            '/USDT:USDT'
        );
    }

    return (
        s +
        '/USDT:USDT'
    );
}


function digits(
    value
) {

    const x =
        Math.abs(
            num(value)
        );

    if (
        x >= 1000
    ) {

        return 2;
    }

    if (
        x >= 100
    ) {

        return 2;
    }

    if (
        x >= 1
    ) {

        return 4;
    }

    if (
        x >= 0.01
    ) {

        return 6;
    }

    if (
        x >= 0.0001
    ) {

        return 8;
    }

    return 10;
}


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

    return x.toFixed(
        digits(x)
    );
}


function closed(
    candles
) {

    if (
        !Array.isArray(candles)
    ) {

        return [];
    }

    if (
        candles.length < 2
    ) {

        return candles;
    }

    return candles.slice(
        0,
        -1
    );
}


function average(
    values
) {

    if (
        !values.length
    ) {

        return 0;
    }

    return (
        values.reduce(
            (
                sum,
                value
            ) =>
                sum + value,
            0
        ) /
        values.length
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

                result[index] =
                    await worker(
                        items[index],
                        index
                    );

            } catch (
                error
            ) {

                STATE.stats.errors += 1;

                console.error(
                    'ANALIZ ERROR |',
                    items[index] &&
                    items[index].symbol
                        ? items[index].symbol
                        : 'UNKNOWN',
                    '|',
                    error.message
                );

                result[index] =
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
            function() {

                return runner();

            }
        )

    );


    return result.filter(
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
        closed(candles);


    if (
        c.length <
        period
    ) {

        return null;
    }


    let value =
        average(

            c
                .slice(
                    0,
                    period
                )
                .map(
                    function(item) {

                        return num(
                            item[4]
                        );

                    }
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
        closed(candles);


    if (
        c.length <
        period + 1
    ) {

        return 50;
    }


    let gain = 0;
    let loss = 0;


    for (
        let i =
            c.length -
            period;

        i <
            c.length;

        i++
    ) {

        const difference =
            num(
                c[i][4]
            ) -
            num(
                c[i - 1][4]
            );


        if (
            difference >= 0
        ) {

            gain +=
                difference;

        } else {

            loss -=
                difference;
        }
    }


    if (
        loss === 0
    ) {

        return 100;
    }


    const relativeStrength =
        (
            gain /
            period
        ) /
        (
            loss /
            period
        );


    return (
        100 -
        (
            100 /
            (
                1 +
                relativeStrength
            )
        )
    );

}


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


    const ranges =
        [];


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


        ranges.push(

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


    return average(
        ranges.slice(
            -period
        )
    );
}


function volumeRatio(
    candles,
    period = 20
) {

    const c =
        closed(candles);


    if (
        c.length <
        period + 1
    ) {

        return 1;
    }


    const current =
        num(
            c[
                c.length - 1
            ][5]
        );


    const historical =
        c
            .slice(
                -period - 1,
                -1
            )
            .map(
                function(item) {

                    return num(
                        item[5]
                    );

                }
            )
            .filter(
                function(value) {

                    return value > 0;

                }
            );


    if (
        !historical.length
    ) {

        return 1;
    }


    const avg =
        average(
            historical
        );


    return avg > 0
        ? current / avg
        : 1;

}


function trend(
    candles
) {

    const c =
        closed(candles);


    if (
        c.length < 55
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
        last > fast &&
        fast > slow
    ) {

        return 'LONG';
    }


    if (
        last < fast &&
        fast < slow
    ) {

        return 'SHORT';
    }


    return 'NEUTRAL';

}


function structure(
    candles,
    lookback = 20
) {

    const c =
        closed(candles)
            .slice(
                -lookback
            );


    if (
        c.length < 8
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
                function(x) {

                    return num(
                        x[2]
                    );

                }
            )
        );


    const firstLow =
        Math.min(
            ...first.map(
                function(x) {

                    return num(
                        x[3]
                    );

                }
            )
        );


    const secondHigh =
        Math.max(
            ...second.map(
                function(x) {

                    return num(
                        x[2]
                    );

                }
            )
        );


    const secondLow =
        Math.min(
            ...second.map(
                function(x) {

                    return num(
                        x[3]
                    );

                }
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
   AGGREGATE 1H -> 2H / 4H
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
                {

                    time:
                        bucket,

                    open:
                        num(
                            candle[1]
                        ),

                    high:
                        num(
                            candle[2]
                        ),

                    low:
                        num(
                            candle[3]
                        ),

                    close:
                        num(
                            candle[4]
                        ),

                    volume:
                        num(
                            candle[5]
                        )
                }
            );


        } else {

            const current =
                buckets.get(
                    bucket
                );


            current.high =
                Math.max(
                    current.high,
                    num(
                        candle[2]
                    )
                );


            current.low =
                Math.min(
                    current.low,
                    num(
                        candle[3]
                    )
                );


            current.close =
                num(
                    candle[4]
                );


            current.volume +=
                num(
                    candle[5]
                );
        }
    }


    return [

        ...buckets.values()

    ]
        .sort(
            function(
                a,
                b
            ) {

                return a.time -
                    b.time;

            }
        )
        .map(
            function(item) {

                return [

                    item.time,
                    item.open,
                    item.high,
                    item.low,
                    item.close,
                    item.volume

                ];

            }
        );

}


/* =========================================================
   LEVEL
========================================================= */

function getLevels(
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

        resistance:
            Math.max(
                ...base.map(
                    function(x) {

                        return num(
                            x[2]
                        );

                    }
                )
            ),

        support:
            Math.min(
                ...base.map(
                    function(x) {

                        return num(
                            x[3]
                        );

                    }
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
            function(market) {

                return (

                    market &&

                    market.active !==
                        false &&

                    market.swap ===
                        true &&

                    market.linear ===
                        true &&

                    market.quote ===
                        'USDT' &&

                    market.settle ===
                        'USDT'

                );

            }
        );


    return STATE.markets;

}


function findMarket(
    symbol
) {

    const wanted =
        String(
            symbol || ''
        )
        .toUpperCase();


    return STATE.markets.find(
        function(market) {

            return (
                market.symbol ===
                    wanted
            );

        }
    )
    ||
    STATE.markets.find(
        function(market) {

            return (
                cleanSymbol(
                    market.symbol
                ) ===
                cleanSymbol(
                    wanted
                )
            );

        }
    )
    ||
    null;

}


/* =========================================================
   RADAR
========================================================= */

async function fetchRadar() {

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
            !(last > 0) ||
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
                ? (
                    (
                        high -
                        low
                    ) /
                    low
                ) *
                100

                : 0;


        rows.push({

            symbol:
                market.symbol,

            coin:
                cleanSymbol(
                    market.symbol
                ),

            price:
                last,

            volume,

            change,

            range
        });

    }


    rows.sort(
        function(
            a,
            b
        ) {

            const scoreA =
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


            const scoreB =
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


            return scoreB -
                scoreA;

        }
    );


    return rows.slice(
        0,
        CFG.MAX_RADAR
    );

}


/* =========================================================
   MARKET SENTIMENT
========================================================= */

async function calculateMarket() {

    const rows =
        STATE.universe;


    const valid =
        rows.filter(
            function(item) {

                return Number.isFinite(
                    item.change
                );

            }
        );


    const green =
        valid.filter(
            function(item) {

                return (
                    item.change >
                    0
                );

            }
        ).length;


    const red =
        valid.filter(
            function(item) {

                return (
                    item.change <
                    0
                );

            }
        ).length;


    const averageChange =
        valid.length
            ? average(
                valid.map(
                    function(item) {

                        return item.change;

                    }
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

            const btcCandles =
                await exchange.fetchOHLCV(
                    btcMarket.symbol,
                    '1h',
                    undefined,
                    100
                );


            btc =
                trend(
                    btcCandles
                );
        }

    } catch (_) {}


    try {

        const ethMarket =
            findMarket(
                'ETHUSDT'
            );


        if (
            ethMarket
        ) {

            const ethCandles =
                await exchange.fetchOHLCV(
                    ethMarket.symbol,
                    '1h',
                    undefined,
                    100
                );


            eth =
                trend(
                    ethCandles
                );
        }

    } catch (_) {}


    let direction =
        'FLAT';


    let label =
        'YATAY / KARIŞIK';


    /*
    Burada genel piyasa filtresi
    sinyali otomatik öldürmüyor.

    Çünkü altcoin kendi setup'ını
    oluşturabilir.
    */

    if (
        breadth >= 62 &&
        averageChange >= 0.35
    ) {

        direction =
            'LONG';

        label =
            'YÜKSELİŞ';

    }
    else if (
        breadth <= 38 &&
        averageChange <= -0.35
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
                averageChange.toFixed(2)
            ),

        btc,

        eth,

        reason:
            'Breadth %' +
            breadth.toFixed(1) +
            ' • Yeşil ' +
            green +
            ' • Kırmızı ' +
            red +
            ' • Ortalama ' +
            averageChange.toFixed(2) +
            '%'
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
            c.length -
                6
        );


    for (
        let i =
            start;

        i <
            c.length;

        i++
    ) {

        const candle =
            c[i];


        const previous =
            c[i - 1];


        const close =
            num(
                candle[4]
            );


        const previousClose =
            num(
                previous[4]
            );


        const before =
            c.slice(
                Math.max(
                    0,
                    i - 20
                ),
                i
            );


        const averageVolume =
            average(
                before
                    .map(
                        function(x) {

                            return num(
                                x[5]
                            );

                        }
                    )
                    .filter(
                        function(x) {

                            return x > 0;

                        }
                    )
            );


        const volume =
            num(
                candle[5]
            );


        const volumeRatio =
            averageVolume > 0
                ? volume /
                  averageVolume

                : 1;


        const range =
            Math.max(
                num(
                    candle[2]
                ) -
                num(
                    candle[3]
                ),

                1e-12
            );


        const body =
            Math.abs(
                num(
                    candle[4]
                ) -
                num(
                    candle[1]
                )
            );


        const bodyRatio =
            body /
            range;


        if (
            direction ===
            'LONG' &&

            close >
            level &&

            previousClose <=
            level &&

            volumeRatio >=
            CFG.BREAKOUT_VOLUME_RATIO &&

            bodyRatio >=
            0.20
        ) {

            return {

                time:
                    num(
                        candle[0]
                    ),

                level,

                volumeRatio,

                close,

                bodyRatio
            };
        }


        if (
            direction ===
            'SHORT' &&

            close <
            level &&

            previousClose >=
            level &&

            volumeRatio >=
            CFG.BREAKOUT_VOLUME_RATIO &&

            bodyRatio >=
            0.20
        ) {

            return {

                time:
                    num(
                        candle[0]
                    ),

                level,

                volumeRatio,

                close,

                bodyRatio
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
                false
        };
    }


    const c =
        closed(
            candles
        );


    const after =
        c.filter(
            function(candle) {

                return (
                    num(
                        candle[0]
                    ) >
                    breakout.time
                );

            }
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
                false
        };
    }


    const tolerance =
        breakout.level *
        CFG.RETEST_TOLERANCE;


    let touched =
        false;

    let invalid =
        false;

    let recovered =
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
            touches
        ) {

            touched =
                true;

            if (
                direction ===
                'LONG'
            ) {

                if (
                    close <
                    breakout.level *
                    (
                        1 -
                        0.007
                    )
                ) {

                    invalid =
                        true;

                }


                if (
                    close >
                    breakout.level
                ) {

                    recovered =
                        true;

                }

            } else {

                if (
                    close >
                    breakout.level *
                    (
                        1 +
                        0.007
                    )
                ) {

                    invalid =
                        true;

                }


                if (
                    close <
                    breakout.level
                ) {

                    recovered =
                        true;

                }
            }
        }
    }


    if (
        invalid
    ) {

        return {
            ok:
                false,

            invalid:
                true
        };
    }


    return {

        ok:
            touched &&
            recovered,

        invalid:
            false,

        candles:
            after
    };

}


/* =========================================================
   TRADE PLAN
========================================================= */

function buildTradePlan(
    symbol,
    direction,
    level,
    candles
) {

    const c =
        closed(
            candles
        );


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
            candles
        )
        ||
        current *
        0.006;


    const recent =
        c.slice(
            -6
        );


    const swingLow =
        Math.min(
            ...recent.map(
                function(x) {

                    return num(
                        x[3]
                    );

                }
            )
        );


    const swingHigh =
        Math.max(
            ...recent.map(
                function(x) {

                    return num(
                        x[2]
                    );

                }
            )
        );


    let entry;

    let stop;


    if (
        direction ===
        'LONG'
    ) {

        entry =
            current >=
                level
                ? current
                : level;


        stop =
            Math.min(
                swingLow,
                level -
                currentAtr *
                CFG.ATR_STOP
            );


        if (
            stop >= entry
        ) {

            stop =
                entry -
                currentAtr *
                CFG.ATR_STOP;
        }

    } else {

        entry =
            current <=
                level
                ? current
                : level;


        stop =
            Math.max(
                swingHigh,
                level +
                currentAtr *
                CFG.ATR_STOP
            );


        if (
            stop <= entry
        ) {

            stop =
                entry +
                currentAtr *
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
    Kesin sıralama.
    */

    if (
        direction ===
        'LONG'
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

        symbol,

        direction,

        entry,

        entryLow:
            direction ===
            'LONG'
                ? level
                : entry,

        entryHigh:
            direction ===
            'LONG'
                ? entry
                : level,

        stop,

        tp1,

        tp2,

        tp3,

        rr,

        risk,

        rsi:
            rsi(
                candles
            )
    };

}


/* =========================================================
   5M BONUS
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
        c.length <
        5
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


    if (
        h1.length < 70 ||
        m15.length < 35 ||
        m5.length < 15
    ) {

        return null;
    }


    /*
    1H'den 2H ve 4H üret.
    */

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
        h2.length < 55 ||
        h4.length < 55
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
        trend(
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


    const results =
        [];


    for (
        const direction
        of [
            'LONG',
            'SHORT'
        ]
    ) {

        const h4Level =
            direction ===
            'LONG'
                ? h4Levels.resistance
                : h4Levels.support;


        const h2Level =
            direction ===
            'LONG'
                ? h2Levels.resistance
                : h2Levels.support;


        let breakout =
            detectBreakout(
                m15,
                direction,
                h4Level
            );


        let source =
            '4H';


        if (
            !breakout
        ) {

            breakout =
                detectBreakout(
                    m15,
                    direction,
                    h2Level
                );

            source =
                '2H';
        }


        if (
            !breakout
        ) {

            continue;
        }


        /*
        H4/H2 yönü açıkça ters ise
        zayıf setup'ı alma.
        */

        if (
            h4Trend !==
                'NEUTRAL' &&
            h4Trend !==
                direction
        ) {

            if (
                h2Trend !==
                direction
            ) {

                continue;
            }
        }


        /*
        Genel piyasa filtresi:
        sadece açıkça ters + ters H4/H2 ise engelle.
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


        /*
        RETEST
        */

        const retest =
            detectRetest(
                m15,
                breakout,
                direction
            );


        if (
            !retest.ok
        ) {

            const pendingKey =
                symbol +
                '|' +
                direction +
                '|' +
                breakout.level;


            STATE.pending.set(
                pendingKey,
                {

                    key:
                        pendingKey,

                    symbol,

                    direction,

                    level:
                        breakout.level,

                    price:
                        row.price,

                    source,

                    volumeRatio:
                        breakout.volumeRatio,

                    status:
                        retest.invalid
                            ? 'INVALIDATED'
                            : 'RETEST BEKLENİYOR',

                    breakoutTime:
                        breakout.time,

                    updatedAt:
                        Date.now(),

                    createdAt:
                        Date.now()
                }
            );


            continue;
        }


        /*
        SCORE
        */

        let score =
            48;


        if (
            h4Trend ===
            direction
        ) {

            score +=
                15;
        }


        if (
            h2Trend ===
            direction
        ) {

            score +=
                14;
        }


        if (
            m15Trend ===
            direction
        ) {

            score +=
                7;
        }


        if (
            m5Trend ===
            direction
        ) {

            score +=
                9;
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


        const m15Rsi =
            rsi(
                m15
            );


        if (
            direction ===
            'LONG' &&
            m15Rsi >=
                48 &&
            m15Rsi <=
                74
        ) {

            score +=
                5;
        }


        if (
            direction ===
            'SHORT' &&
            m15Rsi >=
                26 &&
            m15Rsi <=
                52
        ) {

            score +=
                5;
        }


        /*
        Piyasa aynı yön ise bonus.
        */

        if (
            STATE.market.direction ===
            direction
        ) {

            score +=
                6;
        }


        if (
            score <
            CFG.MIN_SCORE
        ) {

            continue;
        }


        const plan =
            buildTradePlan(
                symbol,
                direction,
                breakout.level,
                m15
            );


        if (
            !plan
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


        if (
            five
        ) {

            score +=
                8;
        }


        score =
            Math.min(
                100,
                score
            );


        const cooldownKey =
            symbol +
            '|' +
            direction +
            '|' +
            breakout.level.toFixed(
                digits(
                    breakout.level
                )
            );


        const lastCooldown =
            STATE.cooldowns.get(
                cooldownKey
            );


        if (
            lastCooldown &&
            Date.now() -
                lastCooldown <
                CFG.COOLDOWN
        ) {

            continue;
        }


        const signal = {

            key:
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

            price:
                row.price,

            currentPrice:
                row.price,

            score:
                Math.round(
                    score
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
                Number(
                    plan.rr.toFixed(
                        2
                    )
                ),

            rsi:
                Number(
                    plan.rsi.toFixed(
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
                breakout.level,

            levelSource:
                source,

            h4Trend,

            h2Trend,

            m15Trend,

            m5Trend,

            status:
                'GİRİŞ ALANI',

            reason:

                source +
                ' SEVİYE • ' +

                '15M BREAKOUT + RETEST • ' +

                '4H ' +
                h4Trend +
                ' • ' +

                '2H ' +
                h2Trend +
                ' • ' +

                '5M ' +
                (
                    five
                        ? 'TEYİT'
                        : 'BONUS YOK'
                ) +
                ' • ' +

                'VOL ' +
                breakout.volumeRatio
                    .toFixed(
                        2
                    ) +
                'x',

            signalAt:
                Date.now(),

            timestamp:
                Date.now(),

            entryReady:
                false
        };


        results.push(
            signal
        );

    }


    if (
        !results.length
    ) {

        return null;
    }


    return results.sort(
        function(
            a,
            b
        ) {

            return b.score -
                a.score;

        }
    )[0];

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


        if (
            pending.status ===
                'INVALIDATED'
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


    STATE.stats.pending =
        STATE.pending.size;


    STATE.stats.signals =
        STATE.signals.size;

}


/* =========================================================
   CHART
========================================================= */

async function refreshChart(
    symbol,
    timeframe,
    signal
) {

    let candles;


    if (
        timeframe ===
        '2h'
    ) {

        const h1 =
            await getRawCandles(
                symbol,
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
        timeframe ===
        '4h'
    ) {

        const h1 =
            await getRawCandles(
                symbol,
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
            await getRawCandles(
                symbol,
                timeframe,
                CFG.CHART_LIMIT
            );
    }


    STATE.chart = {

        symbol,

        timeframe,

        candles:

            Array.isArray(
                candles
            )
                ? candles
                : [],

        signal:
            signal ||
            null
    };

}


/* =========================================================
   LIVE
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
        async function(
            signal
        ) {

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
                    !(current > 0)
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

                        STATE.cooldowns.set(
                            signal.key,
                            Date.now()
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
                    else {

                        signal.status =
                            'GİRİŞ BEKLENİYOR';
                    }

                }
                else {

                    if (
                        current >=
                        signal.stop
                    ) {

                        signal.status =
                            'STOP';

                        STATE.cooldowns.set(
                            signal.key,
                            Date.now()
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
                    else {

                        signal.status =
                            'GİRİŞ BEKLENİYOR';
                    }
                }


            } catch (_) {}


            return signal;

        }
    );


    cleanup();


    /*
    Aktif seçili sinyal varsa
    grafiği canlı güncelle.
    */

    const selectedSignal =
        [
            ...STATE.signals.values()
        ]
        .find(
            function(signal) {

                return (
                    signal.symbol ===
                    STATE.selected
                );

            }
        );


    if (
        selectedSignal
    ) {

        STATE.chart.signal =
            selectedSignal;

    }


    broadcast();

}


/* =========================================================
   STATUS
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
            'SONNY AI TRADER V5.3',

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
                function(
                    a,
                    b
                ) {

                    return b.score -
                        a.score;

                }
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
                function(
                    a,
                    b
                ) {

                    return (
                        b.updatedAt -
                        a.updatedAt
                    );

                }
            )
            .slice(
                0,
                20
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

            } catch (_) {}
        }
    }

}


wss.on(
    'connection',
    function(ws) {

        try {

            ws.send(
                JSON.stringify({

                    type:
                        'snapshot',

                    data:
                        statusData()
                })
            );

        } catch (_) {}

    }
);


/* =========================================================
   API
========================================================= */

app.get(
    '/health',
    function(
        req,
        res
    ) {

        res.json({

            ok:
                true,

            service:
                'Sonny AI Trader V5.3',

            uptime:
                process.uptime(),

            scanning:
                STATE.scanning,

            stats:
                STATE.stats,

            error:
                STATE.lastError
        });
    }
);


app.get(
    '/api/status',
    function(
        req,
        res
    ) {

        res.json(
            statusData()
        );

    }
);


app.get(
    '/api/signals',
    function(
        req,
        res
    ) {

        res.json(
            statusData()
        );

    }
);


app.get(
    '/api/scalp-radar',
    function(
        req,
        res
    ) {

        res.json(
            statusData()
        );

    }
);


app.get(
    '/api/scan',
    function(
        req,
        res
    ) {

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
    async function(
        req,
        res
    ) {

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


            const signal =
                [
                    ...STATE.signals.values()
                ]
                .find(
                    function(item) {

                        return (
                            item.symbol ===
                            market.symbol
                        );

                    }
                )
                ||
                null;


            await refreshChart(
                market.symbol,
                timeframe,
                signal
            );


            STATE.selected =
                market.symbol;


            STATE.timeframe =
                timeframe;


            res.json({

                success:
                    true,

                symbol:
                    market.symbol,

                timeframe,

                price:
                    num(
                        STATE.chart.candles.length
                            ? STATE.chart
                                .candles[
                                    STATE.chart
                                        .candles
                                        .length -
                                    1
                                ][4]
                            : 0
                    ),

                candles:
                    STATE.chart.candles
                        .map(
                            function(
                                candle
                            ) {

                                return {

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
                                };

                            }
                        ),

                signal:
                    STATE.chart.signal
                        ? publicSignal(
                            STATE.chart.signal
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
   EMBEDDED HTML
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
SONNY AI TRADER V5.3
</title>


<style>

*{
box-sizing:border-box;
}

html,
body{
margin:0;
width:100%;
min-height:100%;
background:#070b11;
color:#edf3f8;
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
245px
minmax(0,1fr)
285px;
}

.sidebar{
background:#080d14;
border-right:
1px solid #202936;
padding:12px 10px;
overflow:auto;
}

.brand{
font-size:19px;
font-weight:900;
margin:3px 4px 2px;
}

.subtitle{
font-size:9px;
color:#718096;
margin:0 4px 12px;
}

.scan{
width:100%;
border:0;
background:#172742;
color:#fff;
padding:10px;
border-radius:7px;
font-weight:800;
cursor:pointer;
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
font-size:8px;
color:#718096;
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
border-color:#4774a3;
background:#111d29;
}

.card-top{
display:flex;
justify-content:space-between;
align-items:center;
gap:6px;
}

.coin{
font-size:13px;
font-weight:900;
}

.badge{
font-size:9px;
padding:3px 6px;
border-radius:4px;
font-weight:900;
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
font-size:9px;
color:#718096;
}

.dot{
color:#13e0a2;
}

.empty{
font-size:11px;
color:#718096;
padding:12px;
}

.main{
min-width:0;
padding:10px;
}

.header{
height:58px;
display:flex;
align-items:center;
justify-content:space-between;
gap:10px;
}

.title{
font-size:20px;
font-weight:900;
}

.title small{
display:block;
font-size:9px;
color:#718096;
font-weight:500;
margin-top:4px;
}

.status-pill{
font-size:9px;
color:#13e0a2;
background:#073323;
border:1px solid #0b684a;
padding:7px 10px;
border-radius:18px;
white-space:nowrap;
}

.chart-panel{
background:#080e16;
border:1px solid #202c3b;
border-radius:8px;
overflow:hidden;
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
background:#111b29;
color:#9aa8b8;
border:1px solid #26384f;
border-radius:5px;
padding:6px 8px;
font-size:9px;
cursor:pointer;
}

.tf button.active{
color:#fff;
background:#172a47;
border-color:#428cff;
}

.chart{
height:
calc(100vh - 135px);
min-height:450px;
width:100%;
position:relative;
background:#070b11;
overflow:hidden;
}

.chart-svg{
display:block;
width:100%;
height:100%;
}

.right{
background:#080d14;
border-left:1px solid #202936;
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
font-size:9px;
color:#8391a4;
font-weight:900;
margin-bottom:8px;
text-transform:uppercase;
}

.regime{
font-size:19px;
font-weight:900;
color:#f4c84a;
}

.regime.long{
color:#13e0a2;
}

.regime.short{
color:#ff4d6d;
}

.market-info{
font-size:9px;
line-height:1.65;
color:#718096;
}

.active-name{
font-size:15px;
font-weight:900;
margin-bottom:8px;
}

.active-name.long{
color:#13e0a2;
}

.active-name.short{
color:#ff4d6d;
}

.plan{
display:grid;
grid-template-columns:
1fr
1fr;
gap:5px;
}

.level{
background:#09111b;
border:1px solid #182534;
border-radius:5px;
padding:7px;
}

.level span{
font-size:8px;
color:#718096;
display:block;
}

.level b{
font-size:11px;
display:block;
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
font-size:9px;
line-height:1.5;
color:#8997a8;
margin-top:8px;
}

.pending-item{
font-size:9px;
color:#b9c3d0;
background:#09111b;
border-left:
2px solid #f4c84a;
padding:7px;
border-radius:4px;
margin-bottom:5px;
}

@media(max-width:950px){

.app{
grid-template-columns:
205px
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
border-right:0;
border-bottom:
1px solid #202936;
max-height:220px;
}

.signal-list{
flex-direction:row;
overflow-x:auto;
}

.signal-card{
min-width:165px;
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

.status-pill{
font-size:8px;
padding:6px;
}

.chart{
height:58vh;
min-height:340px;
}

.chart-head{
height:42px;
}

.tf button{
padding:5px 7px;
}

}


@media(max-width:500px){

.chart{
height:54vh;
min-height:320px;
}

.right{
display:block;
padding:7px;
}

}

</style>

</head>


<body>


<div class="app">


<!-- =====================================================
     SOL
====================================================== -->

<aside class="sidebar">

<div class="brand">
⚡ SONNY AI TRADER
</div>

<div class="subtitle">
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


<!-- =====================================================
     CENTER
====================================================== -->

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


<small
id="scanInfo"
>
Sistem hazırlanıyor...
</small>

</div>


<div class="status-pill">

● AUTO TRADE KAPALI

</div>

</div>


<section
class="chart-panel"
>

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


<div
id="chart"
class="chart"
>

<svg
id="chartSvg"
class="chart-svg"
viewBox="0 0 1000 600"
preserveAspectRatio="none"
>
</svg>

</div>

</section>

</main>


<!-- =====================================================
     RIGHT
====================================================== -->

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


if(
!Number.isFinite(x)
){

return '-';

}


if(
x >= 1000
){

return x.toFixed(2);

}


if(
x >= 100
){

return x.toFixed(2);

}


if(
x >= 1
){

return x.toFixed(4);

}


if(
x >= 0.01
){

return x.toFixed(6);

}


if(
x >= 0.0001
){

return x.toFixed(8);

}


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
)
.toLocaleTimeString(
'tr-TR'
)

:

'Tarama bekleniyor...';


/* MARKET */

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


/* SIGNAL */

var signals =
data.signals ||
[];


var list =
$('signals');


list.innerHTML =
'';


if(
!signals.length
){

list.innerHTML =

'<div class="empty">'+
'Teyit edilmiş sinyal yok.'+
'</div>';

}
else{

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
?
'short'
:
''
) +

(
signal.marketSymbol ===
state.selected
?
' active'
:
''
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
?
'long'
:
'short'
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

'<span>'+
'<span class="dot">●</span> '+
'GİRİŞ ALANI'+
'</span>'+

' • GÜÇ ' +

esc(
signal.score
) +

'/100';


card.onclick =
function(){

state.selected =
signal.marketSymbol;

state.signal =
signal;

setActive(
signal
);

loadChart();

};


list.appendChild(
card
);

}
);

}


/* SEÇİLİ SİNYAL */

var selected =
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


if(
selected
){

state.selected =
selected.marketSymbol;

state.signal =
selected;

setActive(
selected
);

}
else{

state.signal =
null;

setActive(
null
);

}


/* PENDING */

renderPending(
data.pending ||
[]
);


/* CHART */

if(
data.chart
){

state.candles =
normalizeCandles(
data.chart.candles ||
[]
);


if(
data.chart.symbol
){

state.selected =
data.chart.symbol;

}


if(
data.chart.timeframe
){

state.timeframe =
data.chart.timeframe;

}


if(
data.chart.signal
){

state.signal =
data.chart.signal;

}


updateHeader();


drawChart();

}


$('system')
.textContent =

data.error

?

'HATA: ' +
data.error

:

data.scanning

?

'Tarama devam ediyor...'

:

'SİSTEM AKTİF';

}


/* =========================================================
   ACTIVE
========================================================= */

function setActive(
signal
){

if(
!signal
){

$('active')
.innerHTML =

'<div class="empty">'+
'Henüz teyit edilmiş sinyal yok.'+
'</div>';

return;

}


var directionClass =
signal.direction ===
'LONG'
?
'long'
:
'short';


$('active')
.innerHTML =

'<div class="active-name '+
directionClass+
'">'+

esc(
signal.symbol
) +

' • ' +

esc(
signal.direction
) +

'</div>' +

'<div class="plan">'+

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
)+

level(
'STOP',
price(
signal.stop
),
'stop'
)+

level(
'TP1',
price(
signal.tp1
),
'tp'
)+

level(
'TP2',
price(
signal.tp2
),
'tp'
)+

level(
'TP3',
price(
signal.tp3
),
'tp'
)+

level(
'R:R',
'1:' +
signal.rr,
''
)+

'</div>' +

'<div class="reason">'+

esc(
signal.status ||
'GİRİŞ ALANI'
)+

' • SKOR ' +

esc(
signal.score
)+

'/100'+

'<br>RSI ' +

esc(
signal.rsi
)+

' • VOL ' +

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


function level(
label,
value,
cls
){

return (

'<div class="level '+
cls+
'">'+

'<span>'+
label+
'</span>'+

'<b>'+
esc(
value
)+
'</b>'+

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


if(
!items.length
){

box.innerHTML =

'<div class="empty">'+
'Bekleyen setup yok.'+
'</div>';

return;

}


box.innerHTML =
items.map(
function(
item
){

return (

'<div class="pending-item">'+

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
price(
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


/* =========================================================
   CANDLE NORMALIZE
========================================================= */

function normalizeCandles(
items
){

return items

.map(
function(
item
){

if(
Array.isArray(item)
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


/* =========================================================
   HEADER
========================================================= */

function updateHeader(){

var symbol =
String(
state.selected ||
'BTCUSDT'
)
.replace(
'/USDT:USDT',
'USDT'
);


var tf =
String(
state.timeframe ||
'15m'
)
.toUpperCase();


$('pageSymbol')
.textContent =
symbol;


$('pageTf')
.textContent =
tf;


$('chartName')
.textContent =
symbol +
' • ' +
tf;

}


/* =========================================================
   LOAD CHART
========================================================= */

async function loadChart(){

if(
!state.selected
){

return;

}


try{

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


if(
!data.success
){

return;

}


state.candles =
normalizeCandles(
data.candles ||
[]
);


state.signal =
data.signal ||
state.signal ||
null;


state.selected =
data.symbol ||
state.selected;


state.timeframe =
data.timeframe ||
state.timeframe;


updateHeader();


drawChart();


}
catch(
error
){

console.error(
'CHART:',
error
);

}

}


/* =========================================================
   SVG CHART
========================================================= */

function drawChart(){

var svg =
$('chartSvg');


if(
!svg
){

return;

}


svg.innerHTML =
'';


var candles =
state.candles ||
[];


if(
!candles.length
){

svg.innerHTML =

'<text x="20" y="35" '+
'fill="#718096" '+
'font-size="13">'+
'Grafik verisi bekleniyor...'+
'</text>';

return;

}


var visible =
candles.slice(
-120
);


var width =
1000;


var height =
600;


var left =
65;


var right =
90;


var top =
35;


var bottom =
30;


var plotWidth =
width -
left -
right;


var plotHeight =
height -
top -
bottom;


var minimum =
Infinity;


var maximum =
-Infinity;


visible.forEach(
function(
candle
){

minimum =
Math.min(
minimum,
Number(
candle.low
)
);

maximum =
Math.max(
maximum,
Number(
candle.high
)
);

});


var signal =
state.signal;


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
value
){

var x =
Number(
value
);


if(
Number.isFinite(x)
){

minimum =
Math.min(
minimum,
x
);

maximum =
Math.max(
maximum,
x
);

}

}
);

}


var range =
maximum -
minimum;


if(
range <= 0
){

range =
1;

}


var padding =
range *
0.06;


minimum -=
padding;


maximum +=
padding;


function y(
value
){

return (

top +

(
maximum -
Number(value)
) /

(
maximum -
minimum
) *

plotHeight

);

}


function x(
index
){

return (

left +

index *
plotWidth /
Math.max(
1,
visible.length -
1
)

);

}


/* ======================================================
   BACKGROUND
====================================================== */

svg.innerHTML +=

'<rect '+
'x="0" y="0" '+
'width="1000" '+
'height="600" '+
'fill="#070b11"/>';


/* ======================================================
   GRID
====================================================== */

for(
var g = 0;
g <= 5;
g++
){

var gy =
top +
plotHeight *
g /
5;


svg.innerHTML +=

'<line '+
'x1="'+left+'" '+
'y1="'+gy+'" '+
'x2="'+
(width -
right)+
'" '+
'y2="'+gy+'" '+
'stroke="#182330" '+
'stroke-width="1"/>';


var gridPrice =
maximum -
(
maximum -
minimum
) *
g /
5;


svg.innerHTML +=

'<text '+
'x="5" '+
'y="'+
(gy + 4)+
'" '+
'fill="#617286" '+
'font-size="10">'+

esc(
price(
gridPrice
)
)+

'</text>';

}


/* ======================================================
   CANDLE
====================================================== */

var step =
plotWidth /
Math.max(
1,
visible.length -
1
);


var body =
Math.max(
3,
Math.min(
10,
step *
0.62
)
);


visible.forEach(
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


var rising =
close >=
open;


var color =
rising
?
'#13e0a2'
:
'#ff4d6d';


/* WICK */

svg.innerHTML +=

'<line '+
'x1="'+xx+'" '+
'y1="'+y(high)+'" '+
'x2="'+xx+'" '+
'y2="'+y(low)+'" '+
'stroke="'+color+'" '+
'stroke-width="1"/>';


/* BODY */

var topBody =
Math.min(
y(open),
y(close)
);


var bodyHeight =
Math.max(
2,
Math.abs(
y(close) -
y(open)
)
);


svg.innerHTML +=

'<rect '+
'x="'+
(xx -
body / 2)+
'" '+
'y="'+
topBody+
'" '+
'width="'+
body+
'" '+
'height="'+
bodyHeight+
'" '+
'fill="'+
color+
'"/>';

}
);


/* ======================================================
   ENTRY ZONE
====================================================== */

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

var entryY1 =
y(
signal.entryLow
);


var entryY2 =
y(
signal.entryHigh
);


svg.innerHTML +=

'<rect '+
'x="'+
left+
'" '+
'y="'+
Math.min(
entryY1,
entryY2
)+
'" '+
'width="'+
plotWidth+
'" '+
'height="'+
Math.abs(
entryY1 -
entryY2
)+
'" '+
'fill="rgba(19,224,162,.10)"/>';

}


/* ======================================================
   LEVELS
====================================================== */

if(
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

}


function drawLevel(
value,
color,
label
){

var levelValue =
Number(
value
);


if(
!Number.isFinite(
levelValue
)
){

return;

}


var yy =
y(
levelValue
);


svg.innerHTML +=

'<line '+
'x1="'+
left+
'" '+
'y1="'+
yy+
'" '+
'x2="'+
(width -
right)+
'" '+
'y2="'+
yy+
'" '+
'stroke="'+
color+
'" '+
'stroke-width="1.3" '+
'stroke-dasharray="7 5"/>';


svg.innerHTML +=

'<text '+
'x="'+
(width -
right +
8)+
'" '+
'y="'+
(yy + 4)+
'" '+
'fill="'+
color+
'" '+
'font-size="10" '+
'font-weight="bold">'+

esc(
label +
' ' +
price(
levelValue
)
)+

'</text>';

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


state.timeframe =
button.getAttribute(
'data-tf'
);


loadChart();

};

}
);


/* =========================================================
   SCAN
========================================================= */

$('scan').onclick =
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

var ws =
null;


function connect(){

try{

var protocol =
location.protocol ===
'https:'
?
'wss://'
:
'ws://';


ws =
new WebSocket(
protocol +
location.host
);


ws.onmessage =
function(
event
){

try{

var message =
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


ws.onclose =
function(){

setTimeout(
connect,
2500
);

};


}
catch(
error
){

console.error(
'WS CONNECT:',
error
);


setTimeout(
connect,
2500
);

}

}


connect();


/* INITIAL STATUS */

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
function(){}
);


/* PERIODIC CHART */

setInterval(
function(){

if(
state.selected
){

loadChart();

}

},
15000
);


/* RESIZE */

window.addEventListener(
'resize',
function(){

drawChart();

}
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
    function(
        req,
        res
    ) {

        res
            .type(
                'html'
            )
            .send(
                HTML
            );

    }
);


/* =========================================================
   BOOT
========================================================= */

async function boot() {

    console.log(
        '================================================='
    );

    console.log(
        '🚀 SONNY AI TRADER V5.3'
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

    } catch (
        error
    ) {

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


    /*
    İlk taramayı başlat.
    */

    setTimeout(
        function(){

            runScan();

        },
        500
    );


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

                        STATE.lastError =
                            error.message;

                    }
                );

        },
        CFG.LIVE_MS
    );

}


/* =========================================================
   START
========================================================= */

boot()
    .catch(
        function(
            error
        ){

            console.error(
                'BOOT ERROR:',
                error
            );

            process.exit(
                1
            );

        }
    );
