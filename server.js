'use strict';

/*
===============================================================
 SONNY AI TRADER V7
 BITGET USDT FUTURES SCALP ENGINE

 500 COIN RADAR
      ↓
 150 CANDIDATE
      ↓
 40 DEEP WATCH
      ↓
 4H TREND
      ↓
 2H DESTEK / DİRENÇ
      ↓
 15M BREAKOUT
      ↓
 15M RETEST
      ↓
 5M SCALP CONFIRMATION
      ↓
 SIGNAL

 FRONTEND:
 server.js İÇİNDE GÖMÜLÜ

 AUTO TRADE:
 KAPALI
===============================================================
*/

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');

const app = express();

app.use(express.json({
    limit: '1mb'
}));

const server = http.createServer(app);

const wss = new WebSocket.Server({
    server: server
});

const PORT = Number(
    process.env.PORT || 10000
);


/* =========================================================
   BITGET
========================================================= */

const exchange = new ccxt.bitget({

    apiKey:
        process.env.BITGET_API_KEY || '',

    secret:
        process.env.BITGET_SECRET || '',

    password:
        process.env.BITGET_PASSPHRASE || '',

    enableRateLimit:
        true,

    timeout:
        20000,

    options: {
        defaultType:
            'swap'
    }

});


/* =========================================================
   CONFIG
========================================================= */

const CFG = {

    /* RADAR */

    MAX_COINS:
        500,

    CANDIDATE_LIMIT:
        150,

    DEEP_LIMIT:
        40,

    MAX_SIGNALS:
        12,


    /* MARKET */

    MIN_VOLUME_USD:
        750000,

    MIN_RANGE_24H:
        0.8,


    /* SCAN */

    SCAN_MS:
        60000,

    LIVE_MS:
        10000,

    REQUEST_CONCURRENCY:
        5,


    /* CANDLES */

    H4_LIMIT:
        80,

    H2_LIMIT:
        100,

    M15_LIMIT:
        140,

    M5_LIMIT:
        80,

    CHART_LIMIT:
        180,


    /* LEVEL */

    LEVEL_LOOKBACK:
        30,

    LEVEL_TOLERANCE:
        0.006,


    /* BREAKOUT */

    BREAKOUT_VOLUME:
        1.10,

    BREAKOUT_BODY_ATR:
        0.25,


    /* RETEST */

    RETEST_MINUTES:
        90,

    RETEST_TOLERANCE:
        0.005,


    /* 5M */

    FIVE_MIN_VOLUME:
        0.95,


    /* SCORE */

    MIN_SCORE:
        62,


    /* RISK */

    MIN_RR:
        1.15,

    ATR_STOP:
        0.65,

    MAX_ENTRY_DISTANCE:
        0.012,


    /* STATE */

    SIGNAL_TTL:
        45 * 60 * 1000,

    PENDING_TTL:
        100 * 60 * 1000,

    LEVEL_COOLDOWN:
        4 * 60 * 60 * 1000,


    /* AUTO TRADE */

    AUTO_TRADE:
        false

};


/* =========================================================
   STATE
========================================================= */

const STATE = {

    scanning:
        false,

    lastScan:
        0,

    lastError:
        null,


    marketRows:
        [],

    candidates:
        [],

    deepWatch:
        [],


    signals:
        new Map(),

    pending:
        new Map(),

    cooldowns:
        new Map(),


    stats: {

        universe:
            0,

        candidates:
            0,

        deepWatch:
            0,

        analyzed:
            0,

        pending:
            0,

        signals:
            0,

        seconds:
            0

    },


    market: {

        label:
            'VERİ BEKLENİYOR',

        direction:
            'NEUTRAL',

        breadth:
            50,

        average:
            0,

        green:
            0,

        red:
            0

    },


    selectedSymbol:
        'BTCUSDT',

    selectedTimeframe:
        '15m'

};


/* =========================================================
   CACHE
========================================================= */

const candleCache =
    new Map();

let tickerCache = {

    time:
        0,

    data:
        new Map()

};

let marketsReady =
    false;


/* =========================================================
   HELPERS
========================================================= */

function sleep(ms) {

    return new Promise(
        function(resolve) {

            setTimeout(
                resolve,
                ms
            );

        }
    );

}


function num(value, fallback) {

    const x =
        Number(value);

    if (
        Number.isFinite(x)
    ) {

        return x;

    }

    return fallback === undefined
        ? 0
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


function cleanSymbol(symbol) {

    let x =
        String(
            symbol || ''
        )
        .toUpperCase();

    x =
        x.replace(
            '/USDT:USDT',
            ''
        );

    x =
        x.replace(
            '/USDT',
            ''
        );

    x =
        x.replace(
            ':USDT',
            ''
        );

    x =
        x.replace(
            /[^A-Z0-9]/g,
            ''
        );

    if (
        x.endsWith('USDT')
    ) {

        x =
            x.slice(
                0,
                -4
            );

    }

    return x + 'USDT';

}


function fmtPrice(value) {

    const x =
        Number(value);

    if (
        !Number.isFinite(x)
    ) {

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

    return x.toFixed(10);

}


function percentDistance(
    a,
    b
) {

    if (!b) {

        return 999;

    }

    return (
        Math.abs(a - b) /
        Math.abs(b)
    ) * 100;

}


function closedCandles(
    candles
) {

    if (
        !Array.isArray(candles) ||
        candles.length < 3
    ) {

        return [];

    }

    return candles.slice(
        0,
        -1
    );

}


/* =========================================================
   INDICATORS
========================================================= */

function ema(
    values,
    period
) {

    if (
        !values.length
    ) {

        return 0;

    }

    const k =
        2 / (
            period + 1
        );

    let result =
        values[0];

    for (
        let i = 1;
        i < values.length;
        i++
    ) {

        result =
            values[i] * k +
            result * (1 - k);

    }

    return result;

}


function atr(
    candles,
    period
) {

    period =
        period || 14;

    if (
        candles.length <
        period + 2
    ) {

        return 0;

    }

    const tr = [];

    for (
        let i = 1;
        i < candles.length;
        i++
    ) {

        const high =
            num(candles[i][2]);

        const low =
            num(candles[i][3]);

        const previousClose =
            num(
                candles[i - 1][4]
            );

        tr.push(
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
            )
        );

    }

    const slice =
        tr.slice(
            -period
        );

    return (
        slice.reduce(
            function(sum, value) {
                return sum + value;
            },
            0
        ) /
        slice.length
    );

}


function rsi(
    candles,
    period
) {

    period =
        period || 14;

    if (
        candles.length <
        period + 1
    ) {

        return 50;

    }

    const closes =
        candles.map(
            function(c) {
                return num(c[4]);
            }
        );

    let gains =
        0;

    let losses =
        0;

    for (
        let i =
            closes.length - period;
        i <
            closes.length;
        i++
    ) {

        const diff =
            closes[i] -
            closes[i - 1];

        if (
            diff >= 0
        ) {

            gains += diff;

        }
        else {

            losses -= diff;

        }

    }

    if (
        losses === 0
    ) {

        return 100;

    }

    const averageGain =
        gains / period;

    const averageLoss =
        losses / period;

    const rs =
        averageGain /
        averageLoss;

    return (
        100 -
        (
            100 /
            (1 + rs)
        )
    );

}


function averageVolume(
    candles,
    period
) {

    period =
        period || 20;

    const values =
        candles
            .slice(-period)
            .map(
                function(c) {
                    return num(c[5]);
                }
            );

    if (
        !values.length
    ) {

        return 0;

    }

    return (
        values.reduce(
            function(a, b) {
                return a + b;
            },
            0
        ) /
        values.length
    );

}


function volumeRatio(
    candles
) {

    if (
        candles.length < 22
    ) {

        return 1;

    }

    const last =
        num(
            candles[
                candles.length - 1
            ][5]
        );

    const base =
        averageVolume(
            candles.slice(
                0,
                -1
            ),
            20
        );

    if (!base) {

        return 1;

    }

    return last / base;

}


function bodyAtrRatio(
    candles
) {

    if (
        candles.length < 16
    ) {

        return 0;

    }

    const current =
        candles[
            candles.length - 1
        ];

    const a =
        atr(
            candles,
            14
        );

    if (!a) {

        return 0;

    }

    return (
        Math.abs(
            num(current[4]) -
            num(current[1])
        ) / a
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

    let cursor =
        0;

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
            catch (error) {

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
            runner
        )
    );

    return result;

}


/* =========================================================
   MARKET SYMBOL
========================================================= */

function symbolForMarket(
    symbol
) {

    const wanted =
        cleanSymbol(
            symbol
        );

    if (
        !exchange.markets
    ) {

        return null;

    }

    return Object.keys(
        exchange.markets
    ).find(
        function(key) {

            return (
                cleanSymbol(key) ===
                wanted
            );

        }
    ) || null;

}


/* =========================================================
   CANDLES
========================================================= */

async function getCandles(
    symbol,
    timeframe,
    limit
) {

    const key =
        symbol +
        '|' +
        timeframe +
        '|' +
        limit;

    const cached =
        candleCache.get(
            key
        );

    let ttl =
        30000;

    if (
        timeframe === '5m'
    ) {

        ttl = 5000;

    }

    if (
        timeframe === '15m'
    ) {

        ttl = 12000;

    }

    if (
        cached &&
        Date.now() -
        cached.time <
        ttl
    ) {

        return cached.data;

    }

    try {

        const data =
            await exchange.fetchOHLCV(
                symbol,
                timeframe,
                undefined,
                limit
            );

        const cleaned =
            (
                data || []
            )
            .filter(
                function(c) {

                    return (
                        Array.isArray(c) &&
                        c.length >= 6
                    );

                }
            )
            .sort(
                function(a, b) {

                    return (
                        Number(a[0]) -
                        Number(b[0])
                    );

                }
            );

        candleCache.set(
            key,
            {
                time:
                    Date.now(),

                data:
                    cleaned

            }
        );

        return cleaned;

    }
    catch (error) {

        if (
            cached
        ) {

            return cached.data;

        }

        return [];

    }

}


/* =========================================================
   TICKERS
========================================================= */

async function getTickers(
    force
) {

    if (
        !force &&
        tickerCache.data.size &&
        Date.now() -
        tickerCache.time <
        8000
    ) {

        return tickerCache.data;

    }

    try {

        const all =
            await exchange.fetchTickers();

        const map =
            new Map();

        for (
            const ticker
            of Object.values(
                all || {}
            )
        ) {

            if (
                !ticker ||
                !ticker.symbol
            ) {

                continue;

            }

            const market =
                exchange.markets[
                    ticker.symbol
                ];

            if (
                !market ||
                market.swap !== true ||
                market.quote !== 'USDT' ||
                market.settle !== 'USDT' ||
                market.active === false
            ) {

                continue;

            }

            const base =
                String(
                    market.base || ''
                )
                .toUpperCase();

            if (
                !base ||
                base === 'USDT'
            ) {

                continue;

            }

            const last =
                num(
                    ticker.last
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
                !last ||
                volume <= 0
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
                    ) * 100
                    : 0;

            map.set(
                ticker.symbol,
                {

                    symbol:
                        ticker.symbol,

                    last:
                        last,

                    volume:
                        volume,

                    change:
                        change,

                    high:
                        high,

                    low:
                        low,

                    bid:
                        num(
                            ticker.bid
                        ),

                    ask:
                        num(
                            ticker.ask
                        ),

                    range:
                        range

                }
            );

        }

        tickerCache = {

            time:
                Date.now(),

            data:
                map

        };

        return map;

    }
    catch (error) {

        STATE.lastError =
            error.message;

        return tickerCache.data;

    }

}


/* =========================================================
   500 COIN RADAR
========================================================= */

async function discoverUniverse() {

    const tickers =
        await getTickers();

    const rows =
        [];

    for (
        const ticker
        of tickers.values()
    ) {

        if (
            ticker.volume <
            CFG.MIN_VOLUME_USD
        ) {

            continue;

        }

        if (
            ticker.range <
            CFG.MIN_RANGE_24H
        ) {

            continue;

        }

        const volumeScore =
            clamp(
                Math.log10(
                    (
                        ticker.volume /
                        CFG.MIN_VOLUME_USD
                    ) + 1
                ) / 4,
                0,
                1
            );

        const rangeScore =
            clamp(
                ticker.range /
                8,
                0,
                1
            );

        const momentumScore =
            clamp(
                Math.abs(
                    ticker.change
                ) /
                6,
                0,
                1
            );

        const score =
            volumeScore * 45 +
            rangeScore * 30 +
            momentumScore * 25;

        rows.push({

            symbol:
                ticker.symbol,

            coin:
                cleanSymbol(
                    ticker.symbol
                ),

            last:
                ticker.last,

            volume:
                ticker.volume,

            change:
                ticker.change,

            high:
                ticker.high,

            low:
                ticker.low,

            range:
                ticker.range,

            radarScore:
                score

        });

    }

    rows.sort(
        function(a, b) {

            return (
                b.radarScore -
                a.radarScore
            );

        }
    );

    STATE.marketRows =
        rows.slice(
            0,
            CFG.MAX_COINS
        );

    STATE.stats.universe =
        STATE.marketRows.length;

    return STATE.marketRows;

}


/* =========================================================
   500 → 150
========================================================= */

function buildCandidates(
    rows
) {

    STATE.candidates =
        rows
            .slice()
            .sort(
                function(a, b) {

                    return (
                        b.radarScore -
                        a.radarScore
                    );

                }
            )
            .slice(
                0,
                CFG.CANDIDATE_LIMIT
            );

    STATE.stats.candidates =
        STATE.candidates.length;

}


/* =========================================================
   MARKET BREADTH
========================================================= */

function calculateMarket() {

    const rows =
        STATE.marketRows;

    if (
        !rows.length
    ) {

        return;

    }

    const green =
        rows.filter(
            function(x) {

                return x.change > 0;

            }
        ).length;

    const red =
        rows.filter(
            function(x) {

                return x.change < 0;

            }
        ).length;

    const average =
        rows.reduce(
            function(sum, x) {

                return (
                    sum +
                    x.change
                );

            },
            0
        ) /
        rows.length;

    const breadth =
        green /
        (
            green +
            red ||
            1
        ) *
        100;

    let label =
        'YATAY / KARIŞIK';

    let direction =
        'NEUTRAL';

    /*
       Piyasa etiketi sadece breadth
       VE ortalama aynı yöndeyse değişir.
    */

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

        label:
            label,

        direction:
            direction,

        breadth:
            Number(
                breadth.toFixed(1)
            ),

        average:
            Number(
                average.toFixed(2)
            ),

        green:
            green,

        red:
            red

    };

}


/* =========================================================
   LEVEL DETECTION
========================================================= */

function localLevels(
    candles
) {

    const data =
        closedCandles(
            candles
        )
        .slice(
            -CFG.LEVEL_LOOKBACK
        );

    if (
        data.length < 10
    ) {

        return [];

    }

    const levels =
        [];

    for (
        let i = 2;
        i < data.length - 2;
        i++
    ) {

        const high =
            num(
                data[i][2]
            );

        const low =
            num(
                data[i][3]
            );

        let resistance =
            true;

        let support =
            true;

        for (
            let j = 1;
            j <= 2;
            j++
        ) {

            if (
                high <=
                num(
                    data[i - j][2]
                ) ||
                high <=
                num(
                    data[i + j][2]
                )
            ) {

                resistance =
                    false;

            }

            if (
                low >=
                num(
                    data[i - j][3]
                ) ||
                low >=
                num(
                    data[i + j][3]
                )
            ) {

                support =
                    false;

            }

        }

        if (
            resistance
        ) {

            levels.push({

                price:
                    high,

                type:
                    'RESISTANCE',

                hits:
                    1

            });

        }

        if (
            support
        ) {

            levels.push({

                price:
                    low,

                type:
                    'SUPPORT',

                hits:
                    1

            });

        }

    }

    levels.sort(
        function(a, b) {

            return (
                a.price -
                b.price
            );

        }
    );

    const result =
        [];

    for (
        const level
        of levels
    ) {

        const previous =
            result[
                result.length - 1
            ];

        if (
            previous &&
            percentDistance(
                level.price,
                previous.price
            ) <=
            CFG.LEVEL_TOLERANCE * 100
        ) {

            previous.price =
                (
                    previous.price +
                    level.price
                ) / 2;

            previous.hits++;

        }
        else {

            result.push({
                ...level
            });

        }

    }

    return result;

}


/* =========================================================
   4H TREND
========================================================= */

function getTrend(
    candles
) {

    const data =
        closedCandles(
            candles
        );

    if (
        data.length < 55
    ) {

        return 'NEUTRAL';

    }

    const closes =
        data.map(
            function(c) {

                return num(c[4]);

            }
        );

    const ema21 =
        ema(
            closes,
            21
        );

    const ema50 =
        ema(
            closes,
            50
        );

    const price =
        closes[
            closes.length - 1
        ];

    if (
        ema21 > ema50 &&
        price >= ema21
    ) {

        return 'LONG';

    }

    if (
        ema21 < ema50 &&
        price <= ema21
    ) {

        return 'SHORT';

    }

    return 'NEUTRAL';

}


/* =========================================================
   NEAREST LEVEL
========================================================= */

function nearestLevel(
    candles,
    h2,
    side
) {

    const data =
        closedCandles(
            candles
        );

    if (
        !data.length
    ) {

        return null;

    }

    const price =
        num(
            data[
                data.length - 1
            ][4]
        );

    const levels =
        localLevels(
            h2
        )
        .filter(
            function(level) {

                if (
                    side === 'LONG'
                ) {

                    return (
                        level.price <
                        price
                    );

                }

                return (
                    level.price >
                    price
                );

            }
        );

    if (
        !levels.length
    ) {

        return null;

    }

    levels.sort(
        function(a, b) {

            return (
                Math.abs(
                    a.price -
                    price
                ) -
                Math.abs(
                    b.price -
                    price
                )
            );

        }
    );

    return levels[0];

}


/* =========================================================
   BREAKOUT
========================================================= */

function detectBreakout(
    candles,
    level,
    side
) {

    const data =
        closedCandles(
            candles
        );

    if (
        data.length < 25 ||
        !level
    ) {

        return null;

    }

    const current =
        data[
            data.length - 1
        ];

    const previous =
        data[
            data.length - 2
        ];

    const currentClose =
        num(
            current[4]
        );

    const previousClose =
        num(
            previous[4]
        );

    let crossed =
        false;

    if (
        side === 'LONG'
    ) {

        crossed =
            previousClose <=
            level.price &&
            currentClose >
            level.price;

    }
    else {

        crossed =
            previousClose >=
            level.price &&
            currentClose <
            level.price;

    }

    if (
        !crossed
    ) {

        return null;

    }

    const vr =
        volumeRatio(
            data
        );

    const br =
        bodyAtrRatio(
            data
        );

    if (
        vr <
        CFG.BREAKOUT_VOLUME
    ) {

        return null;

    }

    if (
        br <
        CFG.BREAKOUT_BODY_ATR
    ) {

        return null;

    }

    return {

        time:
            current[0],

        level:
            level.price,

        side:
            side,

        volumeRatio:
            vr,

        bodyRatio:
            br,

        breakoutClose:
            currentClose

    };

}


/* =========================================================
   RETEST
========================================================= */

function detectRetest(
    candles,
    pending
) {

    const data =
        closedCandles(
            candles
        );

    const afterBreakout =
        data.filter(
            function(c) {

                return (
                    c[0] >
                    pending.breakoutTime
                );

            }
        );

    if (
        !afterBreakout.length
    ) {

        return null;

    }

    if (
        Date.now() -
        pending.breakoutTime >
        CFG.RETEST_MINUTES *
        60 *
        1000
    ) {

        return null;

    }

    let touched =
        false;

    let movedAway =
        false;

    let confirmation =
        null;

    for (
        const candle
        of afterBreakout
    ) {

        const high =
            num(candle[2]);

        const low =
            num(candle[3]);

        const close =
            num(candle[4]);

        if (
            pending.side ===
            'LONG'
        ) {

            if (
                low <=
                pending.level *
                (
                    1 +
                    CFG.RETEST_TOLERANCE
                ) &&
                high >=
                pending.level *
                (
                    1 -
                    CFG.RETEST_TOLERANCE
                )
            ) {

                touched =
                    true;

            }

            if (
                touched &&
                close >
                pending.level *
                1.0005
            ) {

                movedAway =
                    true;

            }

        }
        else {

            if (
                high >=
                pending.level *
                (
                    1 -
                    CFG.RETEST_TOLERANCE
                ) &&
                low <=
                pending.level *
                (
                    1 +
                    CFG.RETEST_TOLERANCE
                )
            ) {

                touched =
                    true;

            }

            if (
                touched &&
                close <
                pending.level *
                0.9995
            ) {

                movedAway =
                    true;

            }

        }

        confirmation =
            candle;

    }

    if (
        touched &&
        movedAway
    ) {

        return confirmation;

    }

    return null;

}


/* =========================================================
   5M CONFIRMATION
========================================================= */

function confirm5M(
    candles,
    side
) {

    const data =
        closedCandles(
            candles
        );

    if (
        data.length < 25
    ) {

        return {

            ok:
                false,

            score:
                0,

            rsi:
                50

        };

    }

    const closes =
        data.map(
            function(c) {

                return num(c[4]);

            }
        );

    const price =
        closes[
            closes.length - 1
        ];

    const ema9 =
        ema(
            closes,
            9
        );

    const ema20 =
        ema(
            closes,
            20
        );

    const currentRsi =
        rsi(
            data,
            14
        );

    const vr =
        volumeRatio(
            data
        );

    let score =
        0;

    let ok =
        false;

    if (
        side === 'LONG'
    ) {

        if (
            price >= ema9
        ) {

            score += 20;

        }

        if (
            ema9 >= ema20
        ) {

            score += 20;

        }

        if (
            currentRsi >= 45 &&
            currentRsi <= 80
        ) {

            score += 20;

        }

        if (
            vr >=
            CFG.FIVE_MIN_VOLUME
        ) {

            score += 15;

        }

        ok =
            price >= ema9 &&
            ema9 >= ema20 &&
            currentRsi >= 45 &&
            currentRsi <= 80;

    }
    else {

        if (
            price <= ema9
        ) {

            score += 20;

        }

        if (
            ema9 <= ema20
        ) {

            score += 20;

        }

        if (
            currentRsi >= 20 &&
            currentRsi <= 55
        ) {

            score += 20;

        }

        if (
            vr >=
            CFG.FIVE_MIN_VOLUME
        ) {

            score += 15;

        }

        ok =
            price <= ema9 &&
            ema9 <= ema20 &&
            currentRsi >= 20 &&
            currentRsi <= 55;

    }

    return {

        ok:
            ok,

        score:
            clamp(
                score,
                0,
                75
            ),

        rsi:
            Number(
                currentRsi.toFixed(1)
            )

    };

}


/* =========================================================
   PLAN
========================================================= */

function makePlan(
    side,
    level,
    m15
) {

    const data =
        closedCandles(
            m15
        );

    if (
        data.length < 20
    ) {

        return null;

    }

    const price =
        num(
            data[
                data.length - 1
            ][4]
        );

    const volatility =
        atr(
            data,
            14
        );

    const recent =
        data.slice(
            -8
        );

    const swingLow =
        Math.min.apply(
            null,
            recent.map(
                function(c) {
                    return num(c[3]);
                }
            )
        );

    const swingHigh =
        Math.max.apply(
            null,
            recent.map(
                function(c) {
                    return num(c[2]);
                }
            )
        );

    let entry =
        price;

    let stop =
        0;

    if (
        side === 'LONG'
    ) {

        stop =
            Math.min(
                swingLow,
                entry -
                (
                    volatility ||
                    entry * 0.004
                ) *
                CFG.ATR_STOP
            );

    }
    else {

        stop =
            Math.max(
                swingHigh,
                entry +
                (
                    volatility ||
                    entry * 0.004
                ) *
                CFG.ATR_STOP
            );

    }

    if (
        !Number.isFinite(entry) ||
        !Number.isFinite(stop) ||
        entry === stop
    ) {

        return null;

    }

    const risk =
        Math.abs(
            entry -
            stop
        );

    if (
        risk <= 0
    ) {

        return null;

    }

    /*
       Scalp hedefleri.
       TP1 = yaklaşık 1.25R
       TP2 = yaklaşık 1.90R
       TP3 = yaklaşık 2.60R
    */

    let tp1;

    let tp2;

    let tp3;

    if (
        side === 'LONG'
    ) {

        tp1 =
            entry +
            risk * 1.25;

        tp2 =
            entry +
            risk * 1.90;

        tp3 =
            entry +
            risk * 2.60;

    }
    else {

        tp1 =
            entry -
            risk * 1.25;

        tp2 =
            entry -
            risk * 1.90;

        tp3 =
            entry -
            risk * 2.60;

    }

    /*
       Kırılan seviyeyi ilk hedefe
       gereksiz şekilde ters yönde
       sıkıştırmıyoruz.

       Böylece TP1 < TP2 < TP3
       sıralaması her zaman korunur.
    */

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

    /*
       Aşırı geniş stopu ele.
    */

    if (
        risk /
        entry >
        0.025
    ) {

        return null;

    }

    return {

        entry:
            entry,

        stop:
            stop,

        tp1:
            tp1,

        tp2:
            tp2,

        tp3:
            tp3,

        rr:
            rr

    };

}


/* =========================================================
   SCORE
========================================================= */

function scoreSetup(
    side,
    trend,
    breakoutData,
    retest,
    five,
    market
) {

    let score =
        42;

    /*
       4H trend
    */

    if (
        trend === side
    ) {

        score += 18;

    }
    else if (
        trend === 'NEUTRAL'
    ) {

        score += 8;

    }

    /*
       Breakout volume
    */

    if (
        breakoutData.volumeRatio >=
        2
    ) {

        score += 12;

    }
    else if (
        breakoutData.volumeRatio >=
        1.5
    ) {

        score += 9;

    }
    else if (
        breakoutData.volumeRatio >=
        1.15
    ) {

        score += 5;

    }

    /*
       Retest
    */

    if (
        retest
    ) {

        score += 10;

    }

    /*
       5M
    */

    if (
        five.ok
    ) {

        score += 12;

    }
    else {

        score +=
            Math.round(
                five.score /
                15
            );

    }

    /*
       Market direction
    */

    if (
        (
            side === 'LONG' &&
            market.direction ===
                'LONG'
        ) ||
        (
            side === 'SHORT' &&
            market.direction ===
                'SHORT'
        )
    ) {

        score += 5;

    }

    return clamp(
        Math.round(score),
        0,
        100
    );

}


/* =========================================================
   COOLDOWN
========================================================= */

function cooldownKey(
    symbol,
    level,
    side
) {

    return (
        cleanSymbol(
            symbol
        ) +
        '|' +
        side +
        '|' +
        Math.round(
            Number(level) *
            1000000
        )
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
            pending
        ]
        of STATE.pending
    ) {

        if (
            now -
            pending.created >
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
            timestamp
        ]
        of STATE.cooldowns
    ) {

        if (
            now -
            timestamp >
            CFG.LEVEL_COOLDOWN
        ) {

            STATE.cooldowns.delete(
                key
            );

        }

    }

    for (
        const [
            key,
            signal
        ]
        of STATE.signals
    ) {

        if (
            now -
            signal.timestamp >
            CFG.SIGNAL_TTL
        ) {

            STATE.signals.delete(
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
   DEEP ANALYSIS
========================================================= */

async function analyzeCoin(
    item
) {

    const symbol =
        item.symbol;

    const result =
        await Promise.all([

            getCandles(
                symbol,
                '4h',
                CFG.H4_LIMIT
            ),

            getCandles(
                symbol,
                '2h',
                CFG.H2_LIMIT
            ),

            getCandles(
                symbol,
                '15m',
                CFG.M15_LIMIT
            )

        ]);

    const h4 =
        result[0];

    const h2 =
        result[1];

    const m15 =
        result[2];

    if (
        h4.length < 60 ||
        h2.length < 30 ||
        m15.length < 30
    ) {

        return null;

    }

    const trend =
        getTrend(
            h4
        );

    const data15 =
        closedCandles(
            m15
        );

    const currentPrice =
        num(
            data15[
                data15.length - 1
            ][4]
        );

    /*
       Önce yeni breakoutları bul.
    */

    for (
        const side
        of [
            'LONG',
            'SHORT'
        ]
    ) {

        /*
           Güçlü 4H trend varken
           tamamen ters işlem üretme.
        */

        if (
            trend !== 'NEUTRAL' &&
            trend !== side
        ) {

            continue;

        }

        const level =
            nearestLevel(
                m15,
                h2,
                side
            );

        if (
            !level
        ) {

            continue;

        }

        const breakout =
            detectBreakout(
                m15,
                level,
                side
            );

        if (
            !breakout
        ) {

            continue;

        }

        const key =
            cooldownKey(
                symbol,
                level.price,
                side
            );

        if (
            STATE.cooldowns.has(
                key
            )
        ) {

            continue;

        }

        const pendingKey =
            cleanSymbol(symbol) +
            '|' +
            side +
            '|' +
            Math.round(
                level.price *
                1000000
            );

        STATE.pending.set(
            pendingKey,
            {

                symbol:
                    symbol,

                side:
                    side,

                level:
                    level.price,

                levelType:
                    level.type,

                breakoutTime:
                    breakout.time,

                created:
                    Date.now(),

                volumeRatio:
                    breakout.volumeRatio

            }
        );

        console.log(
            'BREAKOUT | ' +
            cleanSymbol(symbol) +
            ' | ' +
            side +
            ' | ' +
            fmtPrice(level.price) +
            ' | VOL ' +
            breakout.volumeRatio.toFixed(2) +
            'x'
        );

    }


    const found =
        [];


    /*
       Sonraki aşama:
       pending breakout -> retest
    */

    for (
        const [
            key,
            pending
        ]
        of STATE.pending
    ) {

        if (
            pending.symbol !==
            symbol
        ) {

            continue;

        }

        const retest =
            detectRetest(
                m15,
                pending
            );

        if (
            !retest
        ) {

            continue;

        }


        /*
           5M sadece retest oluştuğunda çekiliyor.
           Böylece 500 coin için gereksiz
           5M API yükü oluşmuyor.
        */

        const m5 =
            await getCandles(
                symbol,
                '5m',
                CFG.M5_LIMIT
            );

        const five =
            confirm5M(
                m5,
                pending.side
            );


        const breakoutData = {

            volumeRatio:
                pending.volumeRatio

        };


        const score =
            scoreSetup(
                pending.side,
                trend,
                breakoutData,
                retest,
                five,
                STATE.market
            );


        /*
           5M'de küçük zayıflık varsa
           coin tamamen kaçmasın.

           Fakat skor yine yeterli olmak zorunda.
        */

        if (
            score <
            CFG.MIN_SCORE
        ) {

            continue;

        }


        const plan =
            makePlan(
                pending.side,
                pending.level,
                m15
            );

        if (
            !plan
        ) {

            continue;

        }


        /*
           Fiyat giriş bölgesinden çok
           uzaklaştıysa kovalamıyoruz.
        */

        if (
            percentDistance(
                plan.entry,
                currentPrice
            ) >
            CFG.MAX_ENTRY_DISTANCE *
            100
        ) {

            continue;

        }


        const m5Closed =
            closedCandles(
                m5
            );

        const currentRsi =
            rsi(
                m5Closed,
                14
            );


        const signal = {

            symbol:
                cleanSymbol(
                    symbol
                ),

            ccxt_symbol:
                symbol,

            side:
                pending.side,

            type:
                pending.side,

            status:
                'GİRİŞ BEKLENİYOR',


            score:
                score,


            entry:
                plan.entry,

            stop:
                plan.stop,

            tp1:
                plan.tp1,

            tp2:
                plan.tp2,

            tp3:
                plan.tp3,

            rr:
                plan.rr,


            entryZone: [

                plan.entry *
                (
                    pending.side ===
                    'LONG'
                        ? 0.9985
                        : 1.0015
                ),

                plan.entry *
                (
                    pending.side ===
                    'LONG'
                        ? 1.0015
                        : 0.9985
                )

            ],


            rsi:
                Number(
                    currentRsi.toFixed(1)
                ),


            volumeRatio:
                pending.volumeRatio,


            timeframeLevel:
                pending.levelType,


            level:
                pending.level,


            timestamp:
                Date.now(),


            signalAt:
                Date.now(),


            reason:
                '4H trend + 2H seviye + 15M breakout/retest + 5M scalp teyidi'

        };


        found.push(
            signal
        );


        STATE.pending.delete(
            key
        );


        console.log(
            'SIGNAL | ' +
            signal.symbol +
            ' | ' +
            signal.side +
            ' | SCORE ' +
            signal.score +
            ' | 1:' +
            signal.rr.toFixed(2)
        );

    }


    return {

        symbol:
            symbol,

        signals:
            found

    };

}


/* =========================================================
   ADD SIGNALS
========================================================= */

function addSignals(
    signals
) {

    for (
        const signal
        of signals
    ) {

        const id =
            signal.symbol +
            '|' +
            signal.side;

        STATE.signals.set(
            id,
            signal
        );

        if (
            !STATE.selectedSymbol
        ) {

            STATE.selectedSymbol =
                signal.symbol;

        }

    }


    /*
       En fazla 12 aktif sinyal.
    */

    if (
        STATE.signals.size >
        CFG.MAX_SIGNALS
    ) {

        const sorted =
            Array.from(
                STATE.signals.entries()
            )
            .sort(
                function(a, b) {

                    return (
                        b[1].timestamp -
                        a[1].timestamp
                    );

                }
            );

        const remove =
            sorted.slice(
                CFG.MAX_SIGNALS
            );

        for (
            const [
                id
            ]
            of remove
        ) {

            STATE.signals.delete(
                id
            );

        }

    }

}


/* =========================================================
   FULL RADAR
========================================================= */

async function runScan() {

    if (
        STATE.scanning
    ) {

        return;

    }

    STATE.scanning =
        true;

    const started =
        Date.now();

    STATE.lastError =
        null;

    try {

        console.log('');

        console.log(
            '=============================================='
        );

        console.log(
            'SONNY AI TRADER V7 SCALP RADAR'
        );

        console.log(
            '500 -> 150 -> 40 -> 4H/2H -> 15M -> RETEST -> 5M'
        );

        console.log(
            '=============================================='
        );


        /*
           500
        */

        const universe =
            await discoverUniverse();


        /*
           500 -> 150
        */

        buildCandidates(
            universe
        );


        /*
           Market
        */

        calculateMarket();


        /*
           150 -> 40
        */

        const deep =
            STATE.candidates.slice(
                0,
                CFG.DEEP_LIMIT
            );

        STATE.deepWatch =
            deep;

        STATE.stats.deepWatch =
            deep.length;


        /*
           40 coin deep analysis
        */

        const results =
            await mapLimit(
                deep,
                CFG.REQUEST_CONCURRENCY,
                analyzeCoin
            );


        const valid =
            results.filter(
                Boolean
            );


        STATE.stats.analyzed =
            valid.length;


        const allSignals =
            valid.flatMap(
                function(result) {

                    return (
                        result.signals ||
                        []
                    );

                }
            );


        addSignals(
            allSignals
        );


        cleanup();


        STATE.lastScan =
            Date.now();


        STATE.stats.seconds =
            Math.round(
                (
                    Date.now() -
                    started
                ) / 100
            ) / 10;


        console.log(
            'RADAR tamamlandı | ' +
            'Universe=' +
            STATE.stats.universe +
            ' | Candidates=' +
            STATE.stats.candidates +
            ' | Deep=' +
            STATE.stats.deepWatch +
            ' | Analiz=' +
            STATE.stats.analyzed +
            ' | Pending=' +
            STATE.pending.size +
            ' | SIGNAL=' +
            STATE.signals.size
        );

    }
    catch (error) {

        STATE.lastError =
            error.message;

        console.error(
            'SCAN ERROR:',
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
   LIVE SIGNAL UPDATE
========================================================= */

function updateSignal(
    signal,
    price
) {

    signal.current =
        price;

    if (
        signal.side ===
        'LONG'
    ) {

        if (
            price <=
            signal.stop
        ) {

            signal.status =
                'STOP';

        }
        else if (
            price >=
            signal.tp3
        ) {

            signal.status =
                'TP3';

        }
        else if (
            price >=
            signal.tp2
        ) {

            signal.status =
                'TP2';

        }
        else if (
            price >=
            signal.tp1
        ) {

            signal.status =
                'TP1';

        }

    }
    else {

        if (
            price >=
            signal.stop
        ) {

            signal.status =
                'STOP';

        }
        else if (
            price <=
            signal.tp3
        ) {

            signal.status =
                'TP3';

        }
        else if (
            price <=
            signal.tp2
        ) {

            signal.status =
                'TP2';

        }
        else if (
            price <=
            signal.tp1
        ) {

            signal.status =
                'TP1';

        }

    }

}


/* =========================================================
   LIVE LOOP
========================================================= */

async function liveUpdate() {

    try {

        const tickers =
            await getTickers(
                true
            );


        for (
            const [
                id,
                signal
            ]
            of STATE.signals
        ) {

            const ticker =
                tickers.get(
                    signal.ccxt_symbol
                );

            if (
                ticker
            ) {

                updateSignal(
                    signal,
                    ticker.last
                );

            }


            /*
               Terminal state.
            */

            if (
                signal.status ===
                    'STOP' ||
                signal.status ===
                    'TP3'
            ) {

                if (
                    signal.status ===
                    'STOP'
                ) {

                    STATE.cooldowns.set(
                        cooldownKey(
                            signal.ccxt_symbol,
                            signal.level ||
                                signal.entry,
                            signal.side
                        ),
                        Date.now()
                    );

                }

                STATE.signals.delete(
                    id
                );

            }

        }


        cleanup();

        broadcast();

    }
    catch (error) {

        STATE.lastError =
            error.message;

    }

}


/* =========================================================
   STATUS
========================================================= */

function getStatus() {

    return {

        success:
            true,

        stats:
            {
                ...STATE.stats
            },

        market:
            STATE.market,

        signals:
            Array.from(
                STATE.signals.values()
            )
            .sort(
                function(a, b) {

                    return (
                        b.score -
                        a.score
                    );

                }
            ),

        pending:
            Array.from(
                STATE.pending.values()
            )
            .map(
                function(item) {

                    return {

                        symbol:
                            cleanSymbol(
                                item.symbol
                            ),

                        side:
                            item.side,

                        level:
                            item.level,

                        volumeRatio:
                            item.volumeRatio,

                        levelType:
                            item.levelType,

                        status:
                            'RETEST BEKLENİYOR',

                        created:
                            item.created

                    };

                }
            ),

        watchlist:
            STATE.candidates.map(
                function(item) {

                    return {

                        symbol:
                            item.coin,

                        last:
                            item.last,

                        change:
                            item.change,

                        volume:
                            item.volume,

                        score:
                            Math.round(
                                item.radarScore
                            )

                    };

                }
            ),

        selectedSymbol:
            STATE.selectedSymbol,

        selectedTimeframe:
            STATE.selectedTimeframe,

        error:
            STATE.lastError

    };

}


/* =========================================================
   WEBSOCKET
========================================================= */

function broadcast() {

    const message =
        JSON.stringify(
            getStatus()
        );

    for (
        const client
        of wss.clients
    ) {

        if (
            client.readyState ===
            WebSocket.OPEN
        ) {

            client.send(
                message
            );

        }

    }

}


/* =========================================================
   API STATUS
========================================================= */

app.get(
    '/api/status',
    function(req, res) {

        res.json(
            getStatus()
        );

    }
);


app.get(
    '/api/scalp-radar',
    function(req, res) {

        res.json(
            getStatus()
        );

    }
);


/* =========================================================
   API SCAN
========================================================= */

app.get(
    '/api/scan',
    function(req, res) {

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
   HEALTH
========================================================= */

app.get(
    '/health',
    function(req, res) {

        res.json({

            ok:
                true,

            service:
                'Sonny AI Trader V7',

            uptime:
                process.uptime(),

            scanning:
                STATE.scanning,

            stats:
                STATE.stats,

            pending:
                STATE.pending.size,

            signals:
                STATE.signals.size,

            error:
                STATE.lastError

        });

    }
);


/* =========================================================
   CHART API
========================================================= */

app.get(
    '/api/chart',
    async function(req, res) {

        try {

            const requestedSymbol =
                req.query.symbol ||
                STATE.selectedSymbol ||
                'BTCUSDT';

            const symbol =
                symbolForMarket(
                    requestedSymbol
                );

            if (
                !symbol
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


            const allowed =
                [
                    '5m',
                    '15m',
                    '1h',
                    '2h',
                    '4h'
                ];


            const requestedTf =
                String(
                    req.query.timeframe ||
                    '15m'
                );


            const timeframe =
                allowed.includes(
                    requestedTf
                )
                    ? requestedTf
                    : '15m';


            STATE.selectedSymbol =
                cleanSymbol(
                    symbol
                );

            STATE.selectedTimeframe =
                timeframe;


            const candles =
                await getCandles(
                    symbol,
                    timeframe,
                    CFG.CHART_LIMIT
                );


            if (
                !candles.length
            ) {

                return res
                    .status(404)
                    .json({

                        success:
                            false,

                        error:
                            'Grafik verisi yok.'

                    });

            }


            const tickers =
                await getTickers();


            const ticker =
                tickers.get(
                    symbol
                );


            const signal =
                Array.from(
                    STATE.signals.values()
                )
                .filter(
                    function(item) {

                        return (
                            item.ccxt_symbol ===
                            symbol
                        );

                    }
                )
                .sort(
                    function(a, b) {

                        return (
                            b.timestamp -
                            a.timestamp
                        );

                    }
                )[0] ||
                null;


            const pending =
                Array.from(
                    STATE.pending.values()
                )
                .filter(
                    function(item) {

                        return (
                            item.symbol ===
                            symbol
                        );

                    }
                )[0] ||
                null;


            res.json({

                success:
                    true,

                symbol:
                    cleanSymbol(
                        symbol
                    ),

                timeframe:
                    timeframe,

                price:
                    ticker
                        ? ticker.last
                        : candles[
                            candles.length - 1
                        ][4],

                candles:
                    candles.map(
                        function(c) {

                            return {

                                time:
                                    c[0],

                                open:
                                    c[1],

                                high:
                                    c[2],

                                low:
                                    c[3],

                                close:
                                    c[4],

                                volume:
                                    c[5]

                            };

                        }
                    ),

                signal:
                    signal
                        ? {

                            side:
                                signal.side,

                            score:
                                signal.score,

                            status:
                                signal.status,

                            entry:
                                signal.entry,

                            entryZone:
                                signal.entryZone,

                            stop:
                                signal.stop,

                            tp1:
                                signal.tp1,

                            tp2:
                                signal.tp2,

                            tp3:
                                signal.tp3,

                            rr:
                                signal.rr,

                            rsi:
                                signal.rsi,

                            volumeRatio:
                                signal.volumeRatio

                        }
                        : null,

                pending:
                    pending
                        ? {

                            side:
                                pending.side,

                            level:
                                pending.level,

                            levelType:
                                pending.levelType,

                            volumeRatio:
                                pending.volumeRatio,

                            status:
                                'RETEST BEKLENİYOR'

                        }
                        : null

            });

        }
        catch (error) {

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
   EMBEDDED FRONTEND
========================================================= */

const HTML = String.raw`
<!DOCTYPE html>

<html lang="tr">

<head>

<meta charset="UTF-8">

<meta
    name="viewport"
    content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"
>

<title>SONNY AI TRADER</title>

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

    background:#070b11;

    color:#e8eef7;

    font-family:
        Arial,
        Helvetica,
        sans-serif;

}

button{

    font-family:inherit;

}

.app{

    display:grid;

    grid-template-columns:
        245px
        minmax(0,1fr)
        300px;

    height:100vh;

}

.left,
.right{

    background:#0b1018;

    border:1px solid #182131;

    overflow:auto;

}

.left{

    padding:12px;

}

.right{

    padding:12px;

}

.brand{

    font-size:17px;

    font-weight:900;

    color:#ffffff;

    margin-bottom:4px;

}

.sub{

    font-size:9px;

    color:#718096;

    margin-bottom:12px;

    line-height:1.4;

}

.stats{

    display:grid;

    grid-template-columns:
        repeat(3,1fr);

    gap:5px;

    margin-bottom:9px;

}

.stat{

    background:#111925;

    border:1px solid #1b2738;

    border-radius:6px;

    padding:7px;

}

.stat b{

    display:block;

    color:#ffffff;

    font-size:12px;

}

.stat span{

    font-size:8px;

    color:#718096;

}

.action{

    width:100%;

    border:0;

    border-radius:6px;

    padding:10px;

    background:#172744;

    color:#ffffff;

    font-size:10px;

    font-weight:900;

    cursor:pointer;

}

.coin{

    background:#101722;

    border:1px solid #1d293a;

    border-left:
        3px solid #3b82f6;

    border-radius:8px;

    padding:9px;

    margin-bottom:7px;

    cursor:pointer;

}

.coin.long{

    border-left-color:
        #00d69f;

}

.coin.short{

    border-left-color:
        #ff4d6d;

}

.coin .top{

    display:flex;

    justify-content:space-between;

    align-items:center;

    gap:5px;

    font-size:11px;

    font-weight:900;

}

.coin .price{

    font-size:15px;

    font-weight:900;

    margin:5px 0;

}

.coin small{

    font-size:8px;

    color:#7c8ba1;

    line-height:1.4;

}

.badge{

    font-size:8px;

    padding:3px 5px;

    border-radius:4px;

    background:#19263a;

    white-space:nowrap;

}

.long .badge{

    color:#00d69f;

}

.short .badge{

    color:#ff4d6d;

}

.main{

    display:flex;

    flex-direction:column;

    min-width:0;

    min-height:0;

}

.bar{

    min-height:67px;

    padding:
        12px 15px;

    border-bottom:
        1px solid #182131;

    display:flex;

    justify-content:space-between;

    align-items:center;

    gap:10px;

}

.title{

    font-size:16px;

    font-weight:900;

}

.title small{

    display:block;

    font-size:8px;

    color:#6f7f95;

    margin-top:5px;

}

.toolbar{

    display:flex;

    gap:5px;

    flex-shrink:0;

}

.btn{

    background:#111a28;

    color:#91a0b5;

    border:
        1px solid #26344a;

    border-radius:5px;

    padding:
        6px 9px;

    font-size:9px;

    cursor:pointer;

}

.btn.active{

    color:#ffffff;

    border-color:#3b82f6;

    background:#14243c;

}

.chartWrap{

    position:relative;

    flex:1;

    min-height:0;

    overflow:hidden;

}

.chart{

    width:100%;

    height:100%;

    display:block;

}

.chartLegend{

    position:absolute;

    left:12px;

    top:10px;

    background:
        rgba(7,13,22,.94);

    border:
        1px solid #243248;

    border-radius:5px;

    padding:7px 9px;

    font-size:9px;

    line-height:1.5;

    pointer-events:none;

}

.panel{

    background:#101722;

    border:
        1px solid #1d2939;

    border-radius:9px;

    padding:11px;

    margin-bottom:10px;

}

.panel h3{

    margin:
        0 0 9px;

    font-size:10px;

    color:#7f90a8;

    text-transform:uppercase;

}

.marketLabel{

    font-size:18px;

    font-weight:900;

}

.green{

    color:#00d69f;

}

.red{

    color:#ff4d6d;

}

.yellow{

    color:#f7c948;

}

.kv{

    display:grid;

    grid-template-columns:
        1fr 1fr;

    gap:6px;

}

.kv div{

    background:#0b111a;

    border-radius:5px;

    padding:7px;

}

.kv label{

    display:block;

    color:#718096;

    font-size:8px;

    margin-bottom:3px;

}

.kv b{

    font-size:11px;

}

.signalTitle{

    font-size:14px;

    font-weight:900;

    margin-bottom:7px;

}

.pending{

    font-size:9px;

    padding:8px;

    border-left:
        2px solid #f7c948;

    background:#0c131d;

    margin-bottom:5px;

    line-height:1.5;

}

.empty{

    font-size:9px;

    color:#66758a;

    padding:8px 0;

    line-height:1.5;

}

.foot{

    font-size:8px;

    color:#607086;

    line-height:1.5;

}

@media(max-width:1100px){

    .app{

        grid-template-columns:
            210px
            minmax(0,1fr)
            260px;

    }

    .title{

        font-size:13px;

    }

}

@media(max-width:850px){

    .app{

        grid-template-columns:
            185px
            minmax(0,1fr);

    }

    .right{

        display:none;

    }

    .bar{

        min-height:58px;

        padding:9px;

    }

}

@media(max-width:600px){

    .app{

        display:block;

    }

    .left{

        display:none;

    }

    .right{

        display:none;

    }

    .main{

        width:100vw;

        height:100vh;

    }

    .bar{

        min-height:52px;

        padding:7px;

    }

    .title{

        font-size:12px;

    }

    .title small{

        font-size:7px;

    }

    .toolbar{

        gap:3px;

    }

    .btn{

        padding:
            5px 6px;

        font-size:8px;

    }

    .chartLegend{

        left:5px;

        top:5px;

        font-size:8px;

        max-width:
            calc(100% - 10px);

    }

}

</style>

</head>


<body>


<div class="app">


<!-- =====================================================
     LEFT
===================================================== -->

<aside class="left">

    <div class="brand">
        ⚡ SONNY AI TRADER
    </div>

    <div class="sub">
        V7 • BITGET USDT FUTURES • SCALP ENGINE
    </div>


    <div class="stats">

        <div class="stat">
            <b id="universe">0</b>
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


    <button
        class="action"
        id="scanBtn"
    >
        RADARI YENİLE
    </button>


    <div
        id="coins"
        style="margin-top:10px"
    ></div>

</aside>


<!-- =====================================================
     CENTER
===================================================== -->

<main class="main">


    <div class="bar">


        <div
            class="title"
            id="chartTitle"
        >

            BTCUSDT • 15M

            <small>
                4H TREND → 2H SEVİYE → 15M KIRILIM → RETEST → 5M SCALP
            </small>

        </div>


        <div class="toolbar">

            <button
                class="btn"
                data-tf="5m"
            >
                5M
            </button>

            <button
                class="btn active"
                data-tf="15m"
            >
                15M
            </button>

            <button
                class="btn"
                data-tf="1h"
            >
                1H
            </button>

            <button
                class="btn"
                data-tf="2h"
            >
                2H
            </button>

            <button
                class="btn"
                data-tf="4h"
            >
                4H
            </button>

        </div>

    </div>


    <div class="chartWrap">

        <canvas
            id="chart"
            class="chart"
        ></canvas>


        <div
            id="legend"
            class="chartLegend"
        >
            Grafik verisi bekleniyor...
        </div>

    </div>


</main>


<!-- =====================================================
     RIGHT
===================================================== -->

<aside class="right">


    <div class="panel">

        <h3>
            GENEL PİYASA
        </h3>

        <div
            id="market"
            class="marketLabel yellow"
        >
            VERİ BEKLENİYOR
        </div>

        <div
            id="marketInfo"
            class="foot"
        >
            Breadth -- • Ortalama --
        </div>

    </div>


    <div class="panel">

        <h3>
            AKTİF SCALP SİNYALİ
        </h3>

        <div
            id="signalBox"
            class="empty"
        >
            Henüz teyit edilmiş scalp sinyali yok.
        </div>

    </div>


    <div class="panel">

        <h3>
            BEKLEYEN KIRILIM / RETEST
        </h3>

        <div
            id="pendingBox"
            class="empty"
        >
            Bekleyen setup yok.
        </div>

    </div>


</aside>


</div>


<script>

/* =========================================================
   FRONTEND STATE
========================================================= */

var state = {

    symbol:
        'BTCUSDT',

    tf:
        '15m',

    chart:
        null

};


/* =========================================================
   HELPERS
========================================================= */

function esc(value){

    return String(
        value == null
            ? ''
            : value
    ).replace(
        /[&<>"']/g,
        function(c){

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


function money(value){

    var x =
        Number(value);

    if (
        !isFinite(x)
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

    return x.toFixed(10);

}


async function api(url){

    var response =
        await fetch(
            url,
            {
                cache:
                    'no-store'
            }
        );

    return response.json();

}


/* =========================================================
   LOAD CHART
========================================================= */

async function loadChart(){

    try{

        var data =
            await api(
                '/api/chart?symbol=' +
                encodeURIComponent(
                    state.symbol
                ) +
                '&timeframe=' +
                state.tf
            );


        if (
            data.success
        ){

            state.chart =
                data;


            document
                .getElementById(
                    'chartTitle'
                )
                .childNodes[0]
                .nodeValue =
                    data.symbol +
                    ' • ' +
                    state.tf.toUpperCase();


            drawChart();

        }

    }
    catch(error){

        document
            .getElementById(
                'legend'
            )
            .innerText =
                'Grafik yüklenemedi.';

    }

}


/* =========================================================
   DRAW CHART
========================================================= */

function drawChart(){

    var canvas =
        document.getElementById(
            'chart'
        );

    var box =
        canvas.getBoundingClientRect();

    var ratio =
        window.devicePixelRatio ||
        1;


    var width =
        Math.max(
            300,
            box.width
        );

    var height =
        Math.max(
            250,
            box.height
        );


    canvas.width =
        width * ratio;

    canvas.height =
        height * ratio;


    var ctx =
        canvas.getContext(
            '2d'
        );


    ctx.setTransform(
        ratio,
        0,
        0,
        ratio,
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
        state.chart &&
        state.chart.candles
            ? state.chart.candles
            : [];


    if (
        !candles.length
    ){

        return;

    }


    var padding = {

        left:
            12,

        right:
            72,

        top:
            28,

        bottom:
            28

    };


    var chartWidth =
        width -
        padding.left -
        padding.right;


    var chartHeight =
        height -
        padding.top -
        padding.bottom;


    var high =
        Math.max.apply(
            null,
            candles.map(
                function(c){

                    return Number(
                        c.high
                    );

                }
            )
        );


    var low =
        Math.min.apply(
            null,
            candles.map(
                function(c){

                    return Number(
                        c.low
                    );

                }
            )
        );


    var range =
        high -
        low ||
        1;


    function priceY(price){

        return (
            padding.top +
            (
                (
                    high -
                    price
                ) /
                range
            ) *
            chartHeight
        );

    }


    function candleX(index){

        if (
            candles.length <= 1
        ){

            return padding.left;

        }

        return (
            padding.left +
            (
                index /
                (
                    candles.length - 1
                )
            ) *
            chartWidth
        );

    }


    /* GRID */

    ctx.lineWidth =
        1;

    ctx.strokeStyle =
        '#172131';


    for (
        var g = 0;
        g < 6;
        g++
    ){

        var gy =
            padding.top +
            (
                g *
                chartHeight /
                5
            );


        ctx.beginPath();

        ctx.moveTo(
            padding.left,
            gy
        );

        ctx.lineTo(
            width -
            padding.right,
            gy
        );

        ctx.stroke();


        ctx.fillStyle =
            '#56657a';

        ctx.font =
            '9px Arial';


        var gridPrice =
            high -
            (
                range *
                g /
                5
            );


        ctx.fillText(
            money(
                gridPrice
            ),
            width -
            padding.right +
            6,
            gy + 3
        );

    }


    /* CANDLES */

    var candleWidth =
        Math.max(
            2,
            (
                chartWidth /
                candles.length
            ) * 0.72
        );


    candles.forEach(
        function(candle,index){

            var x =
                candleX(
                    index
                );


            var open =
                Number(
                    candle.open
                );

            var close =
                Number(
                    candle.close
                );

            var candleHigh =
                Number(
                    candle.high
                );

            var candleLow =
                Number(
                    candle.low
                );


            var yOpen =
                priceY(
                    open
                );

            var yClose =
                priceY(
                    close
                );

            var yHigh =
                priceY(
                    candleHigh
                );

            var yLow =
                priceY(
                    candleLow
                );


            var rising =
                close >= open;


            var candleColor =
                rising
                    ? '#00d69f'
                    : '#ff4d6d';


            ctx.strokeStyle =
                candleColor;

            ctx.fillStyle =
                candleColor;


            /* wick */

            ctx.beginPath();

            ctx.moveTo(
                x,
                yHigh
            );

            ctx.lineTo(
                x,
                yLow
            );

            ctx.stroke();


            /* body */

            var bodyTop =
                Math.min(
                    yOpen,
                    yClose
                );

            var bodyHeight =
                Math.max(
                    1,
                    Math.abs(
                        yClose -
                        yOpen
                    )
                );


            ctx.fillRect(
                x -
                candleWidth / 2,
                bodyTop,
                candleWidth,
                bodyHeight
            );

        }
    );


    /* =====================================================
       SIGNAL LEVELS
    ===================================================== */

    var signal =
        state.chart.signal;


    if (
        signal
    ){

        var levels = [

            [
                'GİRİŞ',
                signal.entry,
                '#38bdf8'
            ],

            [
                'STOP',
                signal.stop,
                '#ff4d6d'
            ],

            [
                'TP1',
                signal.tp1,
                '#00d69f'
            ],

            [
                'TP2',
                signal.tp2,
                '#00d69f'
            ],

            [
                'TP3',
                signal.tp3,
                '#00d69f'
            ]

        ];


        levels.forEach(
            function(level){

                var price =
                    Number(
                        level[1]
                    );

                var y =
                    priceY(
                        price
                    );


                ctx.setLineDash(
                    [
                        6,
                        4
                    ]
                );


                ctx.strokeStyle =
                    level[2];


                ctx.beginPath();

                ctx.moveTo(
                    padding.left,
                    y
                );

                ctx.lineTo(
                    width -
                    padding.right,
                    y
                );

                ctx.stroke();


                ctx.setLineDash(
                    []
                );


                ctx.fillStyle =
                    level[2];

                ctx.font =
                    'bold 9px Arial';


                ctx.fillText(
                    level[0] +
                    ' ' +
                    money(
                        price
                    ),
                    width -
                    padding.right +
                    5,
                    y - 3
                );

            }
        );


        document
            .getElementById(
                'legend'
            )
            .innerHTML =

                '<b>' +
                esc(
                    signal.side
                ) +
                ' • SKOR ' +
                esc(
                    signal.score
                ) +
                '</b>' +

                '<br>Giriş: ' +
                money(
                    signal.entry
                ) +

                ' • Stop: ' +
                money(
                    signal.stop
                ) +

                '<br>TP1: ' +
                money(
                    signal.tp1
                ) +

                ' • TP2: ' +
                money(
                    signal.tp2
                ) +

                ' • TP3: ' +
                money(
                    signal.tp3
                ) +

                '<br>R:R 1:' +
                Number(
                    signal.rr
                ).toFixed(2) +

                ' • RSI ' +
                esc(
                    signal.rsi
                );

    }
    else if (
        state.chart.pending
    ){

        document
            .getElementById(
                'legend'
            )
            .innerHTML =

                '<b>' +
                esc(
                    state.chart.pending.side
                ) +
                ' • RETEST BEKLENİYOR' +
                '</b>' +

                '<br>Seviye: ' +
                money(
                    state.chart.pending.level
                ) +

                '<br>Breakout hacmi: ' +
                Number(
                    state.chart.pending.volumeRatio
                ).toFixed(2) +
                'x';

    }
    else{

        document
            .getElementById(
                'legend'
            )
            .innerHTML =

                '<b>' +
                esc(
                    state.symbol
                ) +
                ' • ' +
                state.tf.toUpperCase() +
                '</b>' +

                '<br>Teyitli scalp sinyali yok.';

    }

}


/* =========================================================
   RENDER
========================================================= */

function render(
    data
){

    document
        .getElementById(
            'universe'
        )
        .innerText =
            data.stats.universe;


    document
        .getElementById(
            'cand'
        )
        .innerText =
            data.stats.candidates;


    document
        .getElementById(
            'deep'
        )
        .innerText =
            data.stats.deepWatch;


    /* =====================================================
       LEFT COIN LIST
    ===================================================== */

    var container =
        document.getElementById(
            'coins'
        );


    container.innerHTML =
        '';


    var signals =
        data.signals ||
        [];


    var watchlist =
        data.watchlist ||
        [];


    var signalSymbols =
        signals.map(
            function(s){

                return s.symbol;

            }
        );


    var list =
        signals.concat(
            watchlist.filter(
                function(item){

                    return (
                        signalSymbols.indexOf(
                            item.symbol
                        ) === -1
                    );

                }
            )
            .slice(
                0,
                12
            )
        );


    list
        .slice(
            0,
            15
        )
        .forEach(
            function(item){

                var side =
                    item.side ||
                    '';


                var div =
                    document.createElement(
                        'div'
                    );


                div.className =
                    'coin ' +
                    side.toLowerCase();


                var badge =
                    side
                        ? esc(
                            side
                        ) +
                        ' • ' +
                        esc(
                            item.score
                        )
                        : 'RADAR';


                var mainPrice =
                    side
                        ? money(
                            item.entry
                        )
                        : money(
                            item.last
                        );


                var details =
                    side

                        ? (
                            'GİRİŞ ' +
                            money(
                                item.entry
                            ) +
                            ' • TP1 ' +
                            money(
                                item.tp1
                            ) +
                            ' • STOP ' +
                            money(
                                item.stop
                            )
                        )

                        : (
                            '24H ' +
                            Number(
                                item.change ||
                                0
                            ).toFixed(2) +
                            '% • HACİM ' +
                            Math.round(
                                Number(
                                    item.volume ||
                                    0
                                ) /
                                1000000
                            ) +
                            'M'
                        );


                div.innerHTML =

                    '<div class="top">' +

                        '<span>' +
                            esc(
                                item.symbol
                            ) +
                        '</span>' +

                        '<span class="badge">' +
                            badge +
                        '</span>' +

                    '</div>' +

                    '<div class="price">' +
                        mainPrice +
                    '</div>' +

                    '<small>' +
                        details +
                    '</small>';


                div.onclick =
                    function(){

                        state.symbol =
                            item.symbol;

                        loadChart();

                    };


                container.appendChild(
                    div
                );

            }
        );


    /* =====================================================
       MARKET
    ===================================================== */

    var market =
        document.getElementById(
            'market'
        );


    market.innerText =
        data.market.label;


    market.className =
        'marketLabel ' +
        (
            data.market.direction ===
            'LONG'
                ? 'green'
                : data.market.direction ===
                  'SHORT'
                    ? 'red'
                    : 'yellow'
        );


    document
        .getElementById(
            'marketInfo'
        )
        .innerText =

            'Breadth ' +
            data.market.breadth +
            '% • Yeşil ' +
            data.market.green +
            ' • Kırmızı ' +
            data.market.red +
            ' • Ortalama ' +
            data.market.average +
            '%';


    /* =====================================================
       ACTIVE SIGNAL
    ===================================================== */

    var signalBox =
        document.getElementById(
            'signalBox'
        );


    var activeSignal =
        signals.find(
            function(item){

                return (
                    item.symbol ===
                    state.symbol
                );

            }
        );


    if (
        !activeSignal &&
        signals.length
    ){

        activeSignal =
            signals[0];

    }


    if (
        activeSignal
    ){

        signalBox.innerHTML =

            '<div class="signalTitle">' +

                esc(
                    activeSignal.symbol
                ) +

                ' <span class="' +

                (
                    activeSignal.side ===
                    'LONG'
                        ? 'green'
                        : 'red'
                ) +

                '">' +

                esc(
                    activeSignal.side
                ) +

                '</span>' +

            '</div>' +


            '<div class="kv">' +


                '<div>' +

                    '<label>GİRİŞ</label>' +

                    '<b>' +

                    money(
                        activeSignal.entry
                    ) +

                    '</b>' +

                '</div>' +


                '<div>' +

                    '<label>SKOR</label>' +

                    '<b>' +

                    activeSignal.score +

                    '/100</b>' +

                '</div>' +


                '<div>' +

                    '<label>STOP</label>' +

                    '<b class="red">' +

                    money(
                        activeSignal.stop
                    ) +

                    '</b>' +

                '</div>' +


                '<div>' +

                    '<label>TP1</label>' +

                    '<b class="green">' +

                    money(
                        activeSignal.tp1
                    ) +

                    '</b>' +

                '</div>' +


                '<div>' +

                    '<label>TP2</label>' +

                    '<b class="green">' +

                    money(
                        activeSignal.tp2
                    ) +

                    '</b>' +

                '</div>' +


                '<div>' +

                    '<label>TP3</label>' +

                    '<b class="green">' +

                    money(
                        activeSignal.tp3
                    ) +

                    '</b>' +

                '</div>' +


                '<div>' +

                    '<label>R:R</label>' +

                    '<b>1:' +

                    Number(
                        activeSignal.rr
                    ).toFixed(2) +

                    '</b>' +

                '</div>' +


                '<div>' +

                    '<label>RSI</label>' +

                    '<b>' +

                    activeSignal.rsi +

                    '</b>' +

                '</div>' +


            '</div>' +


            '<div class="foot" style="margin-top:8px">' +

                esc(
                    activeSignal.reason
                ) +

            '</div>';

    }
    else{

        signalBox.innerHTML =

            '<div class="empty">' +

            'Henüz teyit edilmiş scalp sinyali yok.' +

            '</div>';

    }


    /* =====================================================
       PENDING
    ===================================================== */

    var pendingBox =
        document.getElementById(
            'pendingBox'
        );


    var pending =
        data.pending ||
        [];


    if (
        pending.length
    ){

        pendingBox.innerHTML =
            pending
                .slice(
                    0,
                    8
                )
                .map(
                    function(item){

                        return (

                            '<div class="pending">' +

                                '<b>' +

                                esc(
                                    item.symbol
                                ) +

                                ' ' +

                                esc(
                                    item.side
                                ) +

                                '</b>' +

                                '<br>Seviye ' +

                                money(
                                    item.level
                                ) +

                                ' • Hacim ' +

                                Number(
                                    item.volumeRatio
                                ).toFixed(2) +

                                'x' +

                                '<br>' +

                                'RETEST BEKLENİYOR' +

                            '</div>'

                        );

                    }
                )
                .join('');

    }
    else{

        pendingBox.innerHTML =

            '<div class="empty">' +

            'Bekleyen setup yok.' +

            '</div>';

    }

}


/* =========================================================
   REFRESH
========================================================= */

async function refresh(){

    try{

        var data =
            await api(
                '/api/status'
            );


        render(
            data
        );


        if (
            !state.chart
        ){

            await loadChart();

        }

    }
    catch(error){

        /* sessiz */

    }

}


/* =========================================================
   TIMEFRAME BUTTONS
========================================================= */

document
    .querySelectorAll(
        '[data-tf]'
    )
    .forEach(
        function(button){

            button.onclick =
                function(){

                    document
                        .querySelectorAll(
                            '[data-tf]'
                        )
                        .forEach(
                            function(item){

                                item.classList.remove(
                                    'active'
                                );

                            }
                        );


                    button.classList.add(
                        'active'
                    );


                    state.tf =
                        button.getAttribute(
                            'data-tf'
                        );


                    loadChart();

                };

        }
    );


/* =========================================================
   SCAN BUTTON
========================================================= */

document
    .getElementById(
        'scanBtn'
    )
    .onclick =
        function(){

            var button =
                this;


            button.innerText =
                'TARANIYOR...';


            api(
                '/api/scan'
            )
            .finally(
                function(){

                    setTimeout(
                        function(){

                            button.innerText =
                                'RADARI YENİLE';

                        },
                        1500
                    );

                }
            );

        };


/* =========================================================
   RESIZE
========================================================= */

window.addEventListener(
    'resize',
    function(){

        if (
            state.chart
        ){

            drawChart();

        }

    }
);


/* =========================================================
   WEBSOCKET
========================================================= */

var protocol =
    location.protocol ===
    'https:'
        ? 'wss:'
        : 'ws:';


try{

    var ws =
        new WebSocket(
            protocol +
            '//' +
            location.host
        );


    ws.onmessage =
        function(event){

            try{

                var data =
                    JSON.parse(
                        event.data
                    );


                render(
                    data
                );


                if (
                    state.chart
                ){

                    /*
                       Sinyal değiştiğinde
                       grafik seviyelerini
                       de yenile.
                    */

                    loadChart();

                }

            }
            catch(error){

                /* sessiz */

            }

        };

}
catch(error){

    /* HTTP polling devam eder */

}


/* =========================================================
   START FRONTEND
========================================================= */

refresh();


setInterval(
    refresh,
    10000
);


setInterval(
    loadChart,
    15000
);

</script>


</body>

</html>
`;


/* =========================================================
   HOME
========================================================= */

app.get(
    '/',
    function(req, res){

        res
            .status(200)
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
    async function(){

        console.log(
            '=============================================='
        );

        console.log(
            '🚀 SONNY AI TRADER V7'
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
            CFG.MIN_VOLUME_USD
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
            '=============================================='
        );


        try{

            await exchange.loadMarkets();

            marketsReady =
                true;


            const perpetuals =
                Object.values(
                    exchange.markets
                )
                .filter(
                    function(market){

                        return (
                            market.swap === true &&
                            market.quote === 'USDT' &&
                            market.settle === 'USDT'
                        );

                    }
                )
                .length;


            console.log(
                'MARKETS | Gerçek USDT perpetual=' +
                perpetuals
            );


            /*
               İlk tarama hemen başlasın.
            */

            runScan();

        }
        catch(error){

            STATE.lastError =
                error.message;

            console.error(
                'MARKET LOAD ERROR:',
                error.message
            );

        }

    }
);


/* =========================================================
   LOOPS
========================================================= */

setInterval(
    function(){

        if (
            marketsReady
        ){

            runScan();

        }

    },
    CFG.SCAN_MS
);


setInterval(
    function(){

        if (
            marketsReady
        ){

            liveUpdate();

        }

    },
    CFG.LIVE_MS
);


setInterval(
    function(){

        cleanup();

    },
    30000
);


/* =========================================================
   PROCESS ERRORS
========================================================= */

process.on(
    'unhandledRejection',
    function(error){

        STATE.lastError =
            error &&
            error.message
                ? error.message
                : String(
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
    function(error){

        STATE.lastError =
            error &&
            error.message
                ? error.message
                : String(
                    error
                );

        console.error(
            'UNCAUGHT:',
            error
        );

    }
);
