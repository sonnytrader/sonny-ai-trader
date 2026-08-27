'use strict';

/*
================================================================
 SONNY AI TRADER FINAL v5.1
 BITGET FUTURES BREAKOUT ENGINE

 MİMARİ:

 500 COIN RADAR
       ↓
 150 CANDIDATE
       ↓
 40 DEEP WATCH
       ↓
 4H TREND / LEVEL
       ↓
 2H CONFIRMATION
       ↓
 15M BREAKOUT
       ↓
 15M RETEST
       ↓
 5M ENTRY BONUS
       ↓
 SIGNAL
       ↓
 GRAFİK:
 GİRİŞ / STOP / TP1 / TP2 / TP3

 FRONTEND:
 server.js içinde gömülü HTML

 AUTO TRADE:
 KAPALI
================================================================
*/

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');

const app = express();

app.use(express.json());

const server = http.createServer(app);

const wss = new WebSocket.Server({
    server
});

const PORT =
    Number(
        process.env.PORT || 10000
    );


/* =========================================================
   EXCHANGE
========================================================= */

const exchange =
    new ccxt.bitget({

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

    /* -------------------------------------------------------
       RADAR
    ------------------------------------------------------- */

    MAX_COINS:
        500,

    CANDIDATE_LIMIT:
        150,

    DEEP_LIMIT:
        40,

    MAX_SIGNALS:
        15,

    MAX_PREPARING:
        15,


    /* -------------------------------------------------------
       MARKET
    ------------------------------------------------------- */

    MIN_VOLUME_USD:
        750000,

    MIN_24H_RANGE:
        1.0,


    /* -------------------------------------------------------
       TIME
    ------------------------------------------------------- */

    SCAN_MS:
        60_000,

    LIVE_MS:
        10_000,

    MARKET_REFRESH_MS:
        15 * 60_000,


    /* -------------------------------------------------------
       API
    ------------------------------------------------------- */

    REQUEST_CONCURRENCY:
        6,

    REQUEST_DELAY:
        100,


    /* -------------------------------------------------------
       CANDLE
    ------------------------------------------------------- */

    H4_LIMIT:
        100,

    H2_LIMIT:
        100,

    M15_LIMIT:
        150,

    M5_LIMIT:
        100,

    CHART_LIMIT:
        160,


    /* -------------------------------------------------------
       LEVEL
    ------------------------------------------------------- */

    LEVEL_LOOKBACK_4H:
        30,

    LEVEL_LOOKBACK_2H:
        30,

    PIVOT_LOOKBACK:
        3,

    CLUSTER_TOLERANCE:
        0.004,

    LEVEL_TOLERANCE:
        0.012,


    /* -------------------------------------------------------
       BREAKOUT
    ------------------------------------------------------- */

    BREAKOUT_LOOKBACK:
        8,

    MIN_BREAKOUT_VOLUME_RATIO:
        1.15,

    MIN_BREAKOUT_BODY_ATR:
        0.35,

    MIN_BREAKOUT_CLOSE_DISTANCE:
        0.05,


    /* -------------------------------------------------------
       RETEST
    ------------------------------------------------------- */

    RETEST_WINDOW_MINUTES:
        90,

    RETEST_TOLERANCE:
        0.0045,

    BREAKOUT_INVALIDATION:
        0.0015,

    RETEST_MOVE_AWAY:
        0.0015,


    /* -------------------------------------------------------
       5M
       
       ÖNEMLİ:
       5M artık HARD GATE değil.
       Teyit gelirse bonus verir.
       Gelmezse fırsat otomatik silinmez.
    ------------------------------------------------------- */

    FIVE_MIN_VOLUME_RATIO:
        1.05,

    FIVE_MIN_BONUS:
        8,

    REQUIRE_5M:
        false,


    /* -------------------------------------------------------
       RSI
    ------------------------------------------------------- */

    RSI_PERIOD:
        14,

    RSI_LONG_MIN:
        48,

    RSI_LONG_MAX:
        68,

    RSI_SHORT_MIN:
        32,

    RSI_SHORT_MAX:
        52,


    /* -------------------------------------------------------
       SCORE
    ------------------------------------------------------- */

    MIN_SCORE:
        70,


    /* -------------------------------------------------------
       RISK
    ------------------------------------------------------- */

    ENTRY_ZONE_PCT:
        0.0035,

    MAX_ENTRY_DISTANCE:
        0.008,

    MIN_RR:
        1.50,

    ATR_STOP_MULTIPLIER:
        0.90,


    /* -------------------------------------------------------
       SIGNAL
    ------------------------------------------------------- */

    SIGNAL_TTL_MS:
        45 * 60 * 1000,

    LEVEL_COOLDOWN_MS:
        4 * 60 * 60 * 1000,


    /* -------------------------------------------------------
       MISSED
    ------------------------------------------------------- */

    MISSED_BUFFER_PERCENT:
        0.25,

    MISSED_COOLDOWN_MS:
        15 * 60 * 1000,

    MAX_MISSED:
        5,


    /* -------------------------------------------------------
       AUTO TRADE
    ------------------------------------------------------- */

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

    pendingBreakouts:
        new Map(),

    stoppedLevels:
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
            'NÖTR',

        direction:
            'NEUTRAL',

        reason:
            'Piyasa verisi bekleniyor.',

        breadth:
            50,

        average:
            0

    }

};


let marketCache = [];

let cachedResult = null;

let lastScan = null;

let discoveryTime = null;

let scanRunning = false;

let lastError = null;


const candleCache =
    new Map();


let tickerCache = {

    time:
        0,

    data:
        new Map()

};


/* =========================================================
   MISSED STATE
========================================================= */

const missedSignalStore = [];

const missedCooldowns =
    new Map();


/* =========================================================
   LOG
========================================================= */

function log(message) {

    console.log(
        `[${new Date().toISOString()}] ${message}`
    );

}


function sleep(ms) {

    return new Promise(
        resolve =>
            setTimeout(
                resolve,
                ms
            )
    );

}


function round(
    value,
    digits = 6
) {

    if (
        !Number.isFinite(
            Number(value)
        )
    ) {

        return 0;

    }

    return Number(
        Number(value).toFixed(
            digits
        )
    );

}


function n(
    value,
    fallback = 0
) {

    const x =
        Number(value);

    return Number.isFinite(x)
        ? x
        : fallback;

}


function pct(
    value,
    base
) {

    if (
        !Number.isFinite(value) ||
        !Number.isFinite(base) ||
        base === 0
    ) {

        return 0;

    }

    return (
        value /
        base
    ) * 100;

}


function cleanSymbol(symbol) {

    return String(
        symbol || ''
    )

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
        )

        .replace(
            'USDT',
            ''
        )

        .replace(
            /[^A-Z0-9]/gi,
            ''
        )

        .toUpperCase() +
        'USDT';

}


function fmtPrice(value) {

    const x =
        Number(value);

    if (
        !Number.isFinite(x)
    ) {

        return null;

    }

    if (
        x >= 1000
    ) {

        return Number(
            x.toFixed(2)
        );

    }

    if (
        x >= 100
    ) {

        return Number(
            x.toFixed(3)
        );

    }

    if (
        x >= 1
    ) {

        return Number(
            x.toFixed(5)
        );

    }

    if (
        x >= 0.01
    ) {

        return Number(
            x.toFixed(7)
        );

    }

    return Number(
        x.toFixed(10)
    );

}


function percentDistance(
    a,
    b
) {

    if (!b) {

        return 999;

    }

    return (
        Math.abs(
            a - b
        ) /
        b
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
   MAP LIMIT
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

            } catch (_) {

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

    return (

        Object.keys(
            exchange.markets
        )

            .find(
                key =>
                    cleanSymbol(key) ===
                    wanted
            )

        ||

        null

    );

}


/* =========================================================
   CANDLE CACHE
========================================================= */

function candleTTL(
    timeframe
) {

    if (
        timeframe === '1m' ||
        timeframe === '5m'
    ) {

        return 5000;

    }

    if (
        timeframe === '15m'
    ) {

        return 15000;

    }

    return 30000;

}


async function getCandles(
    symbol,
    timeframe,
    limit
) {

    const key =
        `${symbol}|${timeframe}|${limit}`;


    const cached =
        candleCache.get(
            key
        );


    if (
        cached &&
        Date.now() -
        cached.time <
        candleTTL(
            timeframe
        )
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


        if (
            !Array.isArray(data)
        ) {

            return [];

        }


        const cleaned =
            data

                .filter(
                    c =>
                        Array.isArray(c) &&
                        c.length >= 6
                )

                .sort(
                    (a, b) =>
                        Number(a[0]) -
                        Number(b[0])
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

    } catch (error) {

        if (
            process.env.DEBUG ===
            'true'
        ) {

            console.log(
                `CANDLE ${symbol} ${timeframe}:`,
                error.message
            );

        }

        return [];

    }

}


/* =========================================================
   TICKERS
========================================================= */

async function getTickers(
    force = false
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

        const tickers =
            await exchange.fetchTickers();


        const map =
            new Map();


        for (
            const ticker
            of Object.values(
                tickers || {}
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
                market.settle !== 'USDT'
            ) {

                continue;

            }


            const last =
                n(
                    ticker.last
                );


            const volume =
                n(
                    ticker.quoteVolume
                );


            const change =
                n(
                    ticker.percentage
                );


            if (
                !last ||
                !volume
            ) {

                continue;

            }


            map.set(
                ticker.symbol,
                {

                    symbol:
                        ticker.symbol,

                    last,

                    volume,

                    change,

                    high:
                        n(
                            ticker.high
                        ),

                    low:
                        n(
                            ticker.low
                        ),

                    bid:
                        n(
                            ticker.bid
                        ),

                    ask:
                        n(
                            ticker.ask
                        )

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

    } catch (error) {

        lastError =
            error.message;

        STATE.lastError =
            error.message;

        console.error(
            'Ticker hatası:',
            error.message
        );

        return tickerCache.data;

    }

}


/* =========================================================
   500 COIN DISCOVERY
========================================================= */

async function discoverUniverse() {

    const tickers =
        await getTickers();


    const rows = [];


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


        const range =
            ticker.low > 0

                ? (

                    (
                        ticker.high -
                        ticker.low
                    ) /
                    ticker.low

                ) * 100

                : 0;


        if (
            range <
            CFG.MIN_24H_RANGE
        ) {

            continue;

        }


        rows.push({

            symbol:
                ticker.symbol,

            coin:
                cleanSymbol(
                    ticker.symbol
                ),

            price:
                ticker.last,

            volume24h:
                ticker.volume,

            change24h:
                ticker.change,

            high24h:
                ticker.high,

            low24h:
                ticker.low,

            range

        });

    }


    rows.sort(
        (a, b) =>
            b.volume24h -
            a.volume24h
    );


    STATE.marketRows =
        rows.slice(
            0,
            CFG.MAX_COINS
        );


    STATE.stats.universe =
        STATE.marketRows.length;


    discoveryTime =
        new Date().toISOString();


    log(
        `MARKETS | Gerçek USDT perpetual=${STATE.marketRows.length}`
    );


    return STATE.marketRows;

}


/* =========================================================
   500 → 150
========================================================= */

function rankCandidates(
    rows
) {

    return [...rows]

        .map(
            row => {

                const volumeScore =
                    Math.min(
                        40,
                        Math.log10(
                            Math.max(
                                row.volume24h,
                                1
                            )
                        ) * 4
                    );


                const range =
                    row.low24h > 0

                        ? (

                            (
                                row.high24h -
                                row.low24h
                            ) /
                            row.low24h

                        ) * 100

                        : 0;


                const rangeScore =
                    Math.min(
                        25,
                        range * 5
                    );


                const momentumScore =
                    Math.min(
                        25,
                        Math.abs(
                            row.change24h
                        ) * 5
                    );


                const activityScore =
                    Math.abs(
                        row.change24h
                    ) >= 2

                        ? 10

                        : 5;


                const score =
                    volumeScore +
                    rangeScore +
                    momentumScore +
                    activityScore;


                return {

                    ...row,

                    range24h:
                        range,

                    radarScore:
                        Math.round(
                            Math.min(
                                100,
                                score
                            )
                        )

                };

            }
        )

        .sort(
            (a, b) =>
                b.radarScore -
                a.radarScore
        );

}


/* =========================================================
   4H / 2H LEVEL
========================================================= */

function getLevels(
    candles,
    lookback
) {

    if (
        candles.length <
        lookback + 5
    ) {

        return null;

    }


    const closed =
        closedCandles(
            candles
        );


    const current =
        closed[
            closed.length - 1
        ];


    const history =
        closed.slice(
            -lookback - 1,
            -1
        );


    if (
        history.length <
        lookback
    ) {

        return null;

    }


    const resistance =
        Math.max(
            ...history.map(
                c =>
                    c.high
            )
        );


    const support =
        Math.min(
            ...history.map(
                c =>
                    c.low
            )
        );


    return {

        current,

        resistance,

        support,

        previousClose:
            history[
                history.length - 1
            ].close

    };

}


/* =========================================================
   BREAKOUT
========================================================= */

function detectBreakout(
    candles,
    lookback,
    recentBars = 6
) {

    const levels =
        getLevels(
            candles,
            lookback
        );


    if (!levels) {

        return null;

    }


    const closed =
        closedCandles(
            candles
        );


    if (
        closed.length <
        lookback + 3
    ) {

        return null;

    }


    const resistance =
        levels.resistance;


    const support =
        levels.support;


    let longBreakout =
        false;


    let shortBreakout =
        false;


    let breakoutIndex =
        -1;


    let breakoutDirection =
        null;


    const startIndex =
        Math.max(
            1,
            closed.length -
            recentBars
        );


    for (
        let i =
            startIndex;

        i <
            closed.length;

        i++
    ) {

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

            longBreakout =
                true;

            breakoutIndex =
                i;

            breakoutDirection =
                'LONG';

        }


        if (
            current.close <
                support &&

            previous.close >=
                support
        ) {

            shortBreakout =
                true;

            breakoutIndex =
                i;

            breakoutDirection =
                'SHORT';

        }

    }


    let breakoutCandle =
        null;


    if (
        breakoutIndex >= 0
    ) {

        breakoutCandle =
            closed[
                breakoutIndex
            ];

    }


    return {

        resistance,

        support,

        current:
            closed[
                closed.length - 1
            ],

        previous:
            closed[
                closed.length - 2
            ],

        longBreakout,

        shortBreakout,

        breakoutIndex,

        breakoutDirection,

        breakoutCandle

    };

}


/* =========================================================
   VOLUME RATIO
========================================================= */

function volumeRatio(
    candles,
    index
) {

    if (
        !Array.isArray(candles) ||
        candles.length < 20
    ) {

        return 0;

    }


    const end =
        Number.isInteger(index)
            ? index
            : candles.length - 1;


    const start =
        Math.max(
            0,
            end - 20
        );


    const sample =
        candles.slice(
            start,
            end
        );


    if (!sample.length) {

        return 0;

    }


    const avg =
        sample.reduce(
            (sum, c) =>
                sum +
                n(c.volume),
            0
        ) /
        sample.length;


    if (!avg) {

        return 0;

    }


    return (
        n(
            candles[end]?.volume
        ) /
        avg
    );

}


/* =========================================================
   RSI
========================================================= */

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


    let gains = 0;

    let losses = 0;


    for (
        let i = 1;
        i <= period;
        i++
    ) {

        const change =
            values[i] -
            values[i - 1];


        if (
            change >= 0
        ) {

            gains +=
                change;

        } else {

            losses +=
                -change;

        }

    }


    let avgGain =
        gains /
        period;


    let avgLoss =
        losses /
        period;


    for (
        let i =
            period + 1;

        i <
            values.length;

        i++
    ) {

        const change =
            values[i] -
            values[i - 1];


        const gain =
            change > 0
                ? change
                : 0;


        const loss =
            change < 0
                ? -change
                : 0;


        avgGain =
            (
                avgGain *
                    (period - 1) +
                gain
            ) /
            period;


        avgLoss =
            (
                avgLoss *
                    (period - 1) +
                loss
            ) /
            period;

    }


    if (
        avgLoss === 0
    ) {

        return 100;

    }


    const rs =
        avgGain /
        avgLoss;


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

    if (
        candles.length <
        period + 2
    ) {

        return null;

    }


    const trs = [];


    for (
        let i = 1;
        i < candles.length;
        i++
    ) {

        const c =
            candles[i];


        const p =
            candles[i - 1];


        const tr =
            Math.max(

                c.high -
                    c.low,

                Math.abs(
                    c.high -
                    p.close
                ),

                Math.abs(
                    c.low -
                    p.close
                )

            );


        trs.push(
            tr
        );

    }


    if (
        trs.length <
        period
    ) {

        return null;

    }


    let value =
        trs
            .slice(
                0,
                period
            )
            .reduce(
                (a, b) =>
                    a + b,
                0
            ) /
        period;


    for (
        let i =
            period;

        i <
            trs.length;

        i++
    ) {

        value =
            (
                value *
                    (period - 1) +
                trs[i]
            ) /
            period;

    }


    return value;

}


/* =========================================================
   5M CONFIRMATION
========================================================= */

async function getFiveMinuteConfirmation(
    symbol,
    direction
) {

    try {

        const data =
            await getCandles(
                symbol,
                '5m',
                CFG.M5_LIMIT
            );


        const closed =
            closedCandles(
                data
            );


        if (
            closed.length <
            25
        ) {

            return {

                confirmed:
                    false,

                bonus:
                    0,

                volumeRatio:
                    0,

                reason:
                    '5M veri yetersiz.'

            };

        }


        const last =
            closed[
                closed.length - 1
            ];


        const previous =
            closed[
                closed.length - 2
            ];


        const vr =
            volumeRatio(
                closed
            );


        const bullish =
            last.close >
                last.open &&

            last.close >=
                previous.close;


        const bearish =
            last.close <
                last.open &&

            last.close <=
                previous.close;


        const confirmed =
            direction === 'LONG'

                ? (
                    bullish &&
                    vr >=
                        CFG.FIVE_MIN_VOLUME_RATIO
                  )

                : (
                    bearish &&
                    vr >=
                        CFG.FIVE_MIN_VOLUME_RATIO
                  );


        return {

            confirmed,

            bonus:
                confirmed
                    ? CFG.FIVE_MIN_BONUS
                    : 0,

            volumeRatio:
                round(
                    vr,
                    2
                ),

            reason:
                confirmed

                    ? '5M yön + hacim teyidi.'

                    : '5M bonus teyidi yok; ana strateji devam ediyor.'

        };

    } catch (_) {

        return {

            confirmed:
                false,

            bonus:
                0,

            volumeRatio:
                0,

            reason:
                '5M teyidi alınamadı; sinyal kilitlenmedi.'

        };

    }

}


/* =========================================================
   RETEST
========================================================= */

function checkRetest(
    price,
    level,
    direction
) {

    if (
        !price ||
        !level
    ) {

        return false;

    }


    const distance =
        percentDistance(
            price,
            level
        );


    if (
        distance >
        CFG.MAX_ENTRY_DISTANCE * 100
    ) {

        return false;

    }


    if (
        direction ===
        'LONG'
    ) {

        return (
            price >=
                level *
                (
                    1 -
                    CFG.RETEST_TOLERANCE
                ) &&

            price <=
                level *
                (
                    1 +
                    CFG.MAX_ENTRY_DISTANCE
                )
        );

    }


    return (

        price <=
            level *
            (
                1 +
                CFG.RETEST_TOLERANCE
            ) &&

        price >=
            level *
            (
                1 -
                CFG.MAX_ENTRY_DISTANCE
            )

    );

}


/* =========================================================
   SCORE
========================================================= */

function calculateScore({

    breakout4H,

    breakout2H,

    retest,

    rsiOK,

    rsi,

    direction,

    fiveBonus = 0,

    volumeRatio = 0

}) {

    let score = 0;


    if (
        breakout4H
    ) {

        score += 35;

    }


    if (
        breakout2H
    ) {

        score += 30;

    }


    if (
        retest
    ) {

        score += 20;

    }


    if (
        rsiOK
    ) {

        score += 10;

    }


    if (
        direction ===
        'LONG' &&

        rsi >= 52 &&
        rsi <= 63
    ) {

        score += 5;

    }


    if (
        direction ===
        'SHORT' &&

        rsi >= 37 &&
        rsi <= 48
    ) {

        score += 5;

    }


    score +=
        fiveBonus;


    if (
        volumeRatio >=
        2
    ) {

        score += 3;

    }


    return Math.min(
        100,
        Math.round(
            score
        )
    );

}


/* =========================================================
   TRADE PLAN
========================================================= */

function createTradePlan({

    market,

    direction,

    level,

    rsi,

    score,

    reason,

    fiveMin = null,

    atrValue = null

}) {

    const price =
        market.price;


    const rawEntryLow =
        direction ===
        'LONG'

            ? level *
                (
                    1 -
                    CFG.ENTRY_ZONE_PCT
                )

            : level *
                (
                    1 -
                    CFG.ENTRY_ZONE_PCT
                );


    const rawEntryHigh =
        direction ===
        'LONG'

            ? level *
                (
                    1 +
                    CFG.ENTRY_ZONE_PCT
                )

            : level *
                (
                    1 +
                    CFG.ENTRY_ZONE_PCT
                );


    const entryLow =
        Math.min(
            rawEntryLow,
            rawEntryHigh
        );


    const entryHigh =
        Math.max(
            rawEntryLow,
            rawEntryHigh
        );


    /*
    Stop için ATR varsa ATR kullan.
    Yoksa seviyenin arkasında %1.8.
    */

    const fallbackStopDistance =
        level *
        0.018;


    const atrDistance =
        atrValue &&
        Number.isFinite(
            atrValue
        )

            ? atrValue *
                CFG.ATR_STOP_MULTIPLIER

            : fallbackStopDistance;


    let stop;


    if (
        direction ===
        'LONG'
    ) {

        stop =
            level -
            atrDistance;

    } else {

        stop =
            level +
            atrDistance;

    }


    /*
    Stop'un çok yakın kalmasını engelle.
    */

    if (
        direction ===
        'LONG'
    ) {

        stop =
            Math.min(
                stop,
                level *
                    0.985
            );

    } else {

        stop =
            Math.max(
                stop,
                level *
                    1.015
            );

    }


    const risk =
        Math.abs(
            level -
            stop
        );


    let tp1 =
        direction ===
        'LONG'

            ? level +
                risk * 1.5

            : level -
                risk * 1.5;


    let tp2 =
        direction ===
        'LONG'

            ? level +
                risk * 2

            : level -
                risk * 2;


    let tp3 =
        direction ===
        'LONG'

            ? level +
                risk * 3

            : level -
                risk * 3;


    /*
    TP'ler mutlaka yön sırasını korusun.
    */

    if (
        direction ===
        'LONG'
    ) {

        tp1 =
            Math.max(
                tp1,
                level
            );

        tp2 =
            Math.max(
                tp2,
                tp1
            );

        tp3 =
            Math.max(
                tp3,
                tp2
            );

    } else {

        tp1 =
            Math.min(
                tp1,
                level
            );

        tp2 =
            Math.min(
                tp2,
                tp1
            );

        tp3 =
            Math.min(
                tp3,
                tp2
            );

    }


    const actualRisk =
        Math.abs(
            level -
            stop
        );


    const actualReward =
        Math.abs(
            tp1 -
            level
        );


    const rr =
        actualRisk > 0

            ? actualReward /
                actualRisk

            : 0;


    /*
    R:R yetersizse sinyal üretme.
    */

    if (
        rr <
        CFG.MIN_RR
    ) {

        return null;

    }


    return {

        symbol:
            market.symbol,

        direction,

        strategy:
            '4H / 2H BREAKOUT + 15M RETEST + 5M BONUS',

        status:
            'ACTIVE',

        score,

        price:
            round(
                price,
                8
            ),

        entryLow:
            round(
                entryLow,
                8
            ),

        entryHigh:
            round(
                entryHigh,
                8
            ),

        stop:
            round(
                stop,
                8
            ),

        tp1:
            round(
                tp1,
                8
            ),

        tp2:
            round(
                tp2,
                8
            ),

        tp3:
            round(
                tp3,
                8
            ),

        rr:
            round(
                rr,
                2
            ),

        rsi:
            round(
                rsi,
                1
            ),

        fiveMinConfirmed:
            Boolean(
                fiveMin?.confirmed
            ),

        fiveMinVolumeRatio:
            round(
                fiveMin?.volumeRatio || 0,
                2
            ),

        change24h:
            round(
                market.change24h,
                2
            ),

        volume24h:
            round(
                market.volume24h /
                1000000,
                2
            ),

        level:
            round(
                level,
                8
            ),

        reason

    };

}


/* =========================================================
   PREPARING
========================================================= */

function buildPreparing({

    market,

    fourHour,

    twoHour,

    fifteen

}) {

    if (
        !fourHour ||
        !twoHour ||
        !fifteen
    ) {

        return null;

    }


    const closed15 =
        closedCandles(
            fifteen
        );


    const closes15 =
        closed15.map(
            c =>
                c.close
        );


    const currentRSI =
        rsi(
            closes15,
            CFG.RSI_PERIOD
        );


    if (
        currentRSI === null
    ) {

        return null;

    }


    const price =
        market.price;


    const longDistance =
        percentDistance(
            price,
            fourHour.resistance
        );


    const shortDistance =
        percentDistance(
            price,
            fourHour.support
        );


    /*
    LONG hazırlık.
    */

    if (

        price <
            fourHour.resistance &&

        longDistance <=
            1.5 &&

        currentRSI >= 45 &&
        currentRSI <= 70

    ) {

        return {

            symbol:
                market.symbol,

            direction:
                'LONG',

            price:
                round(
                    price,
                    8
                ),

            trigger:
                round(
                    fourHour.resistance,
                    8
                ),

            distance:
                round(
                    longDistance,
                    3
                ),

            rsi:
                round(
                    currentRSI,
                    1
                ),

            level:
                round(
                    fourHour.resistance,
                    8
                )

        };

    }


    /*
    SHORT hazırlık.
    */

    if (

        price >
            fourHour.support &&

        shortDistance <=
            1.5 &&

        currentRSI >= 30 &&
        currentRSI <= 55

    ) {

        return {

            symbol:
                market.symbol,

            direction:
                'SHORT',

            price:
                round(
                    price,
                    8
                ),

            trigger:
                round(
                    fourHour.support,
                    8
                ),

            distance:
                round(
                    shortDistance,
                    3
                ),

            rsi:
                round(
                    currentRSI,
                    1
                ),

            level:
                round(
                    fourHour.support,
                    8
                )

        };

    }


    return null;

}


/* =========================================================
   SIGNAL KEY
========================================================= */

function signalKey(
    signal
) {

    return (
        signal.symbol +
        '|' +
        signal.direction
    );

}


/* =========================================================
   UPDATE SIGNAL LIFECYCLE
========================================================= */

function updateSignalLifecycle(
    signal,
    livePrice
) {

    const next = {

        ...signal,

        price:
            round(
                livePrice,
                8
            )

    };


    const direction =
        signal.direction;


    const entryLow =
        Number(
            signal.entryLow
        );


    const entryHigh =
        Number(
            signal.entryHigh
        );


    const stop =
        Number(
            signal.stop
        );


    const tp1 =
        Number(
            signal.tp1
        );


    const buffer =
        CFG.MISSED_BUFFER_PERCENT /
        100;


    /*
    LONG
    */

    if (
        direction ===
        'LONG'
    ) {

        if (
            livePrice <=
            stop
        ) {

            return {

                ...next,

                status:
                    'INVALID',

                lifecycleReason:
                    'Fiyat STOP seviyesine ulaştı.'

            };

        }


        if (
            livePrice >=
            tp1
        ) {

            return {

                ...next,

                status:
                    'MISSED',

                lifecycleReason:
                    'Fiyat TP1 seviyesine ulaştı; giriş fırsatı kaçtı.'

            };

        }


        if (
            livePrice >
            entryHigh *
            (
                1 +
                buffer
            )
        ) {

            return {

                ...next,

                status:
                    'MISSED',

                lifecycleReason:
                    'Fiyat giriş bölgesinden yukarı uzaklaştı.'

            };

        }


        return next;

    }


    /*
    SHORT
    */

    if (
        livePrice >=
        stop
    ) {

        return {

            ...next,

            status:
                'INVALID',

            lifecycleReason:
                'Fiyat STOP seviyesine ulaştı.'

        };

    }


    if (
        livePrice <=
        tp1
    ) {

        return {

            ...next,

            status:
                'MISSED',

            lifecycleReason:
                'Fiyat TP1 seviyesine ulaştı; giriş fırsatı kaçtı.'

        };

    }


    if (
        livePrice <
        entryLow *
        (
            1 -
            buffer
        )
    ) {

        return {

            ...next,

            status:
                'MISSED',

            lifecycleReason:
                'Fiyat giriş bölgesinden aşağı uzaklaştı.'

        };

    }


    return next;

}


/* =========================================================
   MOVE TO HISTORY
========================================================= */

function moveSignalToHistory(
    key,
    signal,
    reason
) {

    const item = {

        ...signal,

        status:
            'MISSED',

        missedReason:
            reason,

        missedAt:
            new Date().toISOString()

    };


    missedSignalStore.unshift(
        item
    );


    while (
        missedSignalStore.length >
        CFG.MAX_MISSED
    ) {

        missedSignalStore.pop();

    }


    missedCooldowns.set(
        key,
        Date.now() +
        CFG.MISSED_COOLDOWN_MS
    );


    STATE.signals.delete(
        key
    );

}


/* =========================================================
   SYNC ACTIVE SIGNALS
========================================================= */

function syncActiveSignals(
    newlyDetectedSignals,
    priceMap = new Map()
) {

    /*
    Yeni sinyalleri aktif havuza ekle.
    */

    for (
        const signal
        of newlyDetectedSignals
    ) {

        const key =
            signalKey(
                signal
            );


        const cooldownUntil =
            missedCooldowns.get(
                key
            ) ||
            0;


        if (
            cooldownUntil >
            Date.now()
        ) {

            continue;

        }


        if (
            cooldownUntil &&
            cooldownUntil <=
            Date.now()
        ) {

            missedCooldowns.delete(
                key
            );

        }


        const previous =
            STATE.signals.get(
                key
            );


        STATE.signals.set(
            key,
            {

                ...(previous || {}),

                ...signal,

                status:
                    'ACTIVE',

                createdAt:
                    previous?.createdAt ||
                    new Date().toISOString()

            }
        );

    }


    /*
    Canlı fiyat kontrolü.
    */

    for (
        const [
            key,
            signal
        ]
        of
        STATE.signals.entries()
    ) {

        const livePrice =
            priceMap.get(
                signal.symbol
            );


        if (
            !Number.isFinite(
                livePrice
            )
        ) {

            continue;

        }


        const updated =
            updateSignalLifecycle(
                signal,
                livePrice
            );


        if (
            updated.status ===
            'MISSED'
        ) {

            moveSignalToHistory(
                key,
                updated,
                updated.lifecycleReason ||
                    'Giriş fırsatı kaçtı.'
            );

            continue;

        }


        if (
            updated.status ===
            'INVALID'
        ) {

            moveSignalToHistory(
                key,
                updated,
                updated.lifecycleReason ||
                    'Sinyal geçersiz oldu.'
            );

            continue;

        }


        STATE.signals.set(
            key,
            updated
        );

    }


    return Array.from(
        STATE.signals.values()
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

}


/* =========================================================
   PRICE MAP
========================================================= */

function getPriceMapFromMarket() {

    const map =
        new Map();


    marketCache.forEach(
        item => {

            if (
                item.symbol &&
                Number.isFinite(
                    item.price
                )
            ) {

                map.set(
                    item.symbol,
                    item.price
                );

            }

        }
    );


    return map;

}


/* =========================================================
   MISSED
========================================================= */

function getMissedSignals() {

    return missedSignalStore
        .slice(
            0,
            CFG.MAX_MISSED
        );

}


/* =========================================================
   COIN ANALYSIS
========================================================= */

async function analyzeCoin(
    market
) {

    try {

        const [

            fourHour,

            twoHour,

            fifteen

        ] = await Promise.all([

            getCandles(
                market.symbol,
                '4h',
                CFG.H4_LIMIT
            ),

            getCandles(
                market.symbol,
                '2h',
                CFG.H2_LIMIT
            ),

            getCandles(
                market.symbol,
                '15m',
                CFG.M15_LIMIT
            )

        ]);


        if (
            fourHour.length < 40 ||
            twoHour.length < 40 ||
            fifteen.length < 50
        ) {

            return null;

        }


        const fourBreak =
            detectBreakout(
                fourHour,
                CFG.LEVEL_LOOKBACK_4H
            );


        const twoBreak =
            detectBreakout(
                twoHour,
                CFG.LEVEL_LOOKBACK_2H
            );


        const closed15 =
            closedCandles(
                fifteen
            );


        const closes15 =
            closed15.map(
                c =>
                    c.close
            );


        const currentRSI =
            rsi(
                closes15,
                CFG.RSI_PERIOD
            );


        if (
            currentRSI === null
        ) {

            return null;

        }


        const currentPrice =
            market.price;


        /*
        ================================================
        LONG
        ================================================
        */

        if (

            fourBreak &&
            twoBreak &&

            fourBreak.longBreakout &&
            twoBreak.longBreakout

        ) {

            const level =
                fourBreak.resistance;


            const retest =
                checkRetest(
                    currentPrice,
                    level,
                    'LONG'
                );


            const rsiOK =
                currentRSI >=
                    CFG.RSI_LONG_MIN &&

                currentRSI <=
                    CFG.RSI_LONG_MAX;


            const breakoutVR =
                fourBreak.breakoutIndex >= 0

                    ? volumeRatio(
                        closedCandles(
                            fourHour
                        ),
                        fourBreak.breakoutIndex
                    )

                    : 0;


            /*
            Hacim düşükse breakout zayıf kabul edilir.
            */

            if (
                breakoutVR >=
                CFG.MIN_BREAKOUT_VOLUME_RATIO
            ) {

                const fiveMin =
                    retest

                        ? await getFiveMinuteConfirmation(
                            market.symbol,
                            'LONG'
                        )

                        : null;


                if (
                    retest &&
                    rsiOK
                ) {

                    let score =
                        calculateScore({

                            breakout4H:
                                true,

                            breakout2H:
                                true,

                            retest:
                                true,

                            rsiOK:
                                true,

                            rsi:
                                currentRSI,

                            direction:
                                'LONG',

                            fiveBonus:
                                fiveMin?.bonus ||
                                0,

                            volumeRatio:
                                breakoutVR

                        });


                    /*
                    5M hard gate değil.
                    */

                    const signal =
                        createTradePlan({

                            market,

                            direction:
                                'LONG',

                            level,

                            rsi:
                                currentRSI,

                            score,

                            fiveMin,

                            atrValue:
                                atr(
                                    closedCandles(
                                        fifteen
                                    ),
                                    14
                                ),

                            reason:
                                '4H direnç kırılımı + 2H doğrulama + 15M retest + RSI.' +
                                (
                                    fiveMin?.confirmed
                                        ? ' 5M yön/hacim teyidi mevcut.'
                                        : ' 5M teyidi yok; sinyal ana setup üzerinden değerlendirildi.'
                                )

                        });


                    if (
                        signal &&
                        score >=
                        CFG.MIN_SCORE
                    ) {

                        return {

                            type:
                                'SIGNAL',

                            signal

                        };

                    }

                }

            }

        }


        /*
        ================================================
        SHORT
        ================================================
        */

        if (

            fourBreak &&
            twoBreak &&

            fourBreak.shortBreakout &&
            twoBreak.shortBreakout

        ) {

            const level =
                fourBreak.support;


            const retest =
                checkRetest(
                    currentPrice,
                    level,
                    'SHORT'
                );


            const rsiOK =
                currentRSI >=
                    CFG.RSI_SHORT_MIN &&

                currentRSI <=
                    CFG.RSI_SHORT_MAX;


            const breakoutVR =
                fourBreak.breakoutIndex >= 0

                    ? volumeRatio(
                        closedCandles(
                            fourHour
                        ),
                        fourBreak.breakoutIndex
                    )

                    : 0;


            if (
                breakoutVR >=
                CFG.MIN_BREAKOUT_VOLUME_RATIO
            ) {

                const fiveMin =
                    retest

                        ? await getFiveMinuteConfirmation(
                            market.symbol,
                            'SHORT'
                        )

                        : null;


                if (
                    retest &&
                    rsiOK
                ) {

                    const score =
                        calculateScore({

                            breakout4H:
                                true,

                            breakout2H:
                                true,

                            retest:
                                true,

                            rsiOK:
                                true,

                            rsi:
                                currentRSI,

                            direction:
                                'SHORT',

                            fiveBonus:
                                fiveMin?.bonus ||
                                0,

                            volumeRatio:
                                breakoutVR

                        });


                    const signal =
                        createTradePlan({

                            market,

                            direction:
                                'SHORT',

                            level,

                            rsi:
                                currentRSI,

                            score,

                            fiveMin,

                            atrValue:
                                atr(
                                    closedCandles(
                                        fifteen
                                    ),
                                    14
                                ),

                            reason:
                                '4H destek kırılımı + 2H doğrulama + 15M retest + RSI.' +
                                (
                                    fiveMin?.confirmed
                                        ? ' 5M yön/hacim teyidi mevcut.'
                                        : ' 5M teyidi yok; sinyal ana setup üzerinden değerlendirildi.'
                                )

                        });


                    if (
                        signal &&
                        score >=
                        CFG.MIN_SCORE
                    ) {

                        return {

                            type:
                                'SIGNAL',

                            signal

                        };

                    }

                }

            }

        }


        /*
        ================================================
        PREPARING
        ================================================
        */

        const preparing =
            buildPreparing({

                market,

                fourHour:
                    getLevels(
                        fourHour,
                        CFG.LEVEL_LOOKBACK_4H
                    ),

                twoHour:
                    getLevels(
                        twoHour,
                        CFG.LEVEL_LOOKBACK_2H
                    ),

                fifteen

            });


        if (
            preparing
        ) {

            return {

                type:
                    'PREPARING',

                preparing

            };

        }


        return null;

    } catch (error) {

        log(
            `Analiz hatası ${market.symbol}: ${error.message}`
        );

        return null;

    }

}


/* =========================================================
   MARKET DIRECTION
========================================================= */

async function calculateMarketDirection() {

    try {

        const btc =
            marketCache.find(
                item =>
                    cleanSymbol(
                        item.symbol
                    ) ===
                    'BTCUSDT'
            );


        const eth =
            marketCache.find(
                item =>
                    cleanSymbol(
                        item.symbol
                    ) ===
                    'ETHUSDT'
            );


        const bullish =
            marketCache.filter(
                item =>
                    item.change24h >
                    1
            ).length;


        const bearish =
            marketCache.filter(
                item =>
                    item.change24h <
                    -1
            ).length;


        const total =
            Math.max(
                1,
                marketCache.length
            );


        const breadth =
            (
                bullish /
                total
            ) * 100;


        STATE.market.breadth =
            round(
                breadth,
                1
            );


        /*
        BTC + ETH öncelikli.
        Ama tek başına BTC yönü
        bütün piyasayı belirlemez.
        */

        const btcChange =
            btc
                ? btc.change24h
                : 0;


        const ethChange =
            eth
                ? eth.change24h
                : 0;


        const average =
            (
                btcChange +
                ethChange
            ) / 2;


        STATE.market.average =
            round(
                average,
                2
            );


        if (
            breadth >= 58 &&
            average > 0
        ) {

            return {

                direction:
                    'LONG',

                label:
                    'PİYASA YUKARI',

                reason:
                    `Breadth %${round(breadth, 1)} · BTC/ETH ortalama ${round(average, 2)}%.`

            };

        }


        if (
            breadth <= 42 &&
            average < 0
        ) {

            return {

                direction:
                    'SHORT',

                label:
                    'PİYASA AŞAĞI',

                reason:
                    `Breadth %${round(breadth, 1)} · BTC/ETH ortalama ${round(average, 2)}%.`

            };

        }


        return {

            direction:
                'NEUTRAL',

            label:
                'PİYASA KARIŞIK',

            reason:
                `Breadth %${round(breadth, 1)} · BTC/ETH ortalama ${round(average, 2)}%. Yön yeterince net değil.`

        };

    } catch (error) {

        return {

            direction:
                'NEUTRAL',

            label:
                'PİYASA KARIŞIK',

            reason:
                'Piyasa yönü hesaplanamadı.'

        };

    }

}


/* =========================================================
   RADAR
========================================================= */

async function runRadar() {

    if (
        scanRunning &&
        cachedResult
    ) {

        return cachedResult;

    }


    if (
        scanRunning
    ) {

        return {

            success:
                false,

            error:
                'Tarama zaten çalışıyor.'

        };

    }


    scanRunning =
        true;


    STATE.scanning =
        true;


    lastError =
        null;


    STATE.lastError =
        null;


    const started =
        Date.now();


    try {

        /*
        =====================================================
        1. 500 COIN
        =====================================================
        */

        const universe =
            await discoverUniverse();


        /*
        =====================================================
        2. 500 → 150
        =====================================================
        */

        const ranked =
            rankCandidates(
                universe
            );


        const candidates =
            ranked.slice(
                0,
                CFG.CANDIDATE_LIMIT
            );


        STATE.candidates =
            candidates;


        STATE.stats.candidates =
            candidates.length;


        /*
        =====================================================
        3. 150 → 40 DEEP
        =====================================================
        */

        const deepWatch =
            candidates.slice(
                0,
                CFG.DEEP_LIMIT
            );


        STATE.deepWatch =
            deepWatch;


        STATE.stats.deepWatch =
            deepWatch.length;


        log(
            `RADAR | Universe=${universe.length} | Candidates=${candidates.length} | Deep=${deepWatch.length}`
        );


        const signals = [];

        const preparing = [];


        /*
        =====================================================
        4. DEEP ANALYSIS
        =====================================================
        */

        for (
            let i = 0;
            i < deepWatch.length;
            i += CFG.REQUEST_CONCURRENCY
        ) {

            const batch =
                deepWatch.slice(
                    i,
                    i +
                    CFG.REQUEST_CONCURRENCY
                );


            const batchResults =
                await Promise.all(

                    batch.map(
                        coin =>
                            analyzeCoin(
                                coin
                            )
                    )

                );


            batchResults.forEach(
                result => {

                    if (!result) {

                        return;

                    }


                    if (
                        result.type ===
                        'SIGNAL'
                    ) {

                        signals.push(
                            result.signal
                        );

                    }


                    if (
                        result.type ===
                        'PREPARING'
                    ) {

                        preparing.push(
                            result.preparing
                        );

                    }

                }
            );


            await sleep(
                CFG.REQUEST_DELAY
            );

        }


        /*
        =====================================================
        5. SIGNAL SYNC
        =====================================================
        */

        signals.sort(
            (a, b) =>
                b.score -
                a.score
        );


        const priceMap =
            getPriceMapFromMarket();


        const finalSignals =
            syncActiveSignals(
                signals,
                priceMap
            );


        /*
        =====================================================
        6. PREPARING
        =====================================================
        */

        preparing.sort(
            (a, b) =>
                a.distance -
                b.distance
        );


        const finalPreparing =
            preparing.slice(
                0,
                CFG.MAX_PREPARING
            );


        /*
        =====================================================
        7. MARKET
        =====================================================
        */

        const marketDirection =
            await calculateMarketDirection();


        STATE.market = {

            direction:
                marketDirection.direction,

            label:
                marketDirection.label,

            reason:
                marketDirection.reason,

            breadth:
                STATE.market.breadth,

            average:
                STATE.market.average

        };


        const elapsed =
            (
                Date.now() -
                started
            ) /
            1000;


        STATE.stats.analyzed =
            deepWatch.length;


        STATE.stats.pending =
            finalPreparing.length;


        STATE.stats.signals =
            finalSignals.length;


        STATE.stats.seconds =
            round(
                elapsed,
                1
            );


        /*
        =====================================================
        RESULT
        =====================================================
        */

        cachedResult = {

            success:
                true,

            system:
                'SONNY AI TRADER V5.1',

            timestamp:
                new Date().toISOString(),

            refresh:
                'EVERY 60 SECONDS',

            strategy:
                '500 → 150 → 40 → 4H + 2H → 15M BREAKOUT → RETEST → 5M BONUS',

            market:
                STATE.market,

            stats: {

                market:
                    universe.length,

                candidates:
                    candidates.length,

                deepWatch:
                    deepWatch.length,

                analyzed:
                    deepWatch.length,

                signals:
                    finalSignals.length,

                preparing:
                    finalPreparing.length,

                duration:
                    round(
                        elapsed,
                        1
                    )

            },

            candidates,

            deepWatch,

            signals:
                finalSignals,

            missed:
                getMissedSignals(),

            preparing:
                finalPreparing,

            mode:
                'MANUAL SIGNAL ONLY',

            autoTrade:
                false

        };


        lastScan =
            cachedResult.timestamp;


        STATE.lastScan =
            Date.now();


        log(
            `RADAR tamamlandı | Universe=${universe.length} | Candidates=${candidates.length} | Deep=${deepWatch.length} | Analiz=${deepWatch.length} | Pending=${finalPreparing.length} | SIGNAL=${finalSignals.length}`
        );


        broadcast(
            cachedResult
        );


        return cachedResult;

    } catch (error) {

        lastError =
            error.message;


        STATE.lastError =
            error.message;


        log(
            `RADAR ERROR: ${error.message}`
        );


        return {

            success:
                false,

            error:
                error.message,

            system:
                'SONNY AI TRADER V5.1'

        };

    } finally {

        scanRunning =
            false;

        STATE.scanning =
            false;

    }

}


/* =========================================================
   BROADCAST
========================================================= */

function broadcast(
    data
) {

    const message =
        JSON.stringify({
            type:
                'radar',

            data
        });


    wss.clients.forEach(
        client => {

            if (
                client.readyState ===
                WebSocket.OPEN
            ) {

                client.send(
                    message
                );

            }

        }
    );

}


/* =========================================================
   WEB UI
========================================================= */

const HTML = `

<!DOCTYPE html>

<html lang="tr">

<head>

<meta charset="UTF-8">

<meta
name="viewport"
content="width=device-width, initial-scale=1.0"
>

<title>
Sonny AI Trader V5.1
</title>

<style>

* {
    box-sizing:
        border-box;
}

html,
body {

    margin:
        0;

    padding:
        0;

    background:
        #070b11;

    color:
        #eef3f8;

    font-family:
        Arial,
        Helvetica,
        sans-serif;

}

body {

    min-height:
        100vh;

}

.container {

    width:
        min(
            1450px,
            96%
        );

    margin:
        18px auto 40px;

}

.header {

    display:
        flex;

    justify-content:
        space-between;

    align-items:
        center;

    gap:
        15px;

    margin-bottom:
        14px;

}

.title {

    font-size:
        25px;

    font-weight:
        900;

}

.subtitle {

    color:
        #718198;

    font-size:
        11px;

    margin-top:
        6px;

}

.online {

    background:
        #0d2118;

    border:
        1px solid #174d31;

    color:
        #45e58d;

    border-radius:
        20px;

    padding:
        8px 13px;

    font-size:
        10px;

    font-weight:
        900;

}


/* =========================================================
   MARKET
========================================================= */

.market-box {

    background:
        #101720;

    border:
        1px solid #202d3d;

    border-radius:
        12px;

    padding:
        14px;

    margin-bottom:
        12px;

}

.market-title {

    color:
        #718198;

    font-size:
        9px;

    font-weight:
        900;

    letter-spacing:
        1px;

}

.market-direction {

    font-size:
        24px;

    font-weight:
        900;

    margin-top:
        5px;

}

.market-reason {

    color:
        #8290a3;

    font-size:
        10px;

    margin-top:
        5px;

}

.long {

    color:
        #45e58d;

}

.short {

    color:
        #ff647a;

}

.neutral {

    color:
        #e5c65b;

}


/* =========================================================
   STATS
========================================================= */

.stats {

    display:
        grid;

    grid-template-columns:
        repeat(
            5,
            1fr
        );

    gap:
        8px;

    margin-bottom:
        12px;

}

.stat {

    background:
        #101720;

    border:
        1px solid #202d3d;

    border-radius:
        9px;

    padding:
        10px;

}

.stat-label {

    color:
        #718198;

    font-size:
        8px;

    font-weight:
        800;

}

.stat-value {

    font-size:
        17px;

    font-weight:
        900;

    margin-top:
        5px;

}


/* =========================================================
   CHART
========================================================= */

.chart-panel {

    background:
        #0b1119;

    border:
        1px solid #26354a;

    border-radius:
        12px;

    padding:
        10px;

    margin-bottom:
        12px;

}

.chart-header {

    display:
        flex;

    justify-content:
        space-between;

    align-items:
        center;

    gap:
        10px;

    margin-bottom:
        8px;

}

.chart-title {

    font-size:
        15px;

    font-weight:
        900;

}

.chart-sub {

    color:
        #718198;

    font-size:
        9px;

    margin-top:
        3px;

}

.timeframes {

    display:
        flex;

    gap:
        4px;

    flex-wrap:
        wrap;

}

.tf {

    background:
        #172235;

    border:
        1px solid #26364b;

    color:
        #95a4b8;

    border-radius:
        5px;

    padding:
        5px 8px;

    font-size:
        9px;

    font-weight:
        800;

    cursor:
        pointer;

}

.tf.active {

    background:
        #24517d;

    color:
        white;

    border-color:
        #3a8bea;

}

.chart-wrap {

    position:
        relative;

    width:
        100%;

    height:
        500px;

    background:
        #070c13;

    border-radius:
        8px;

    overflow:
        hidden;

}

#priceChart {

    display:
        block;

    width:
        100%;

    height:
        100%;

}

.chart-plan {

    display:
        grid;

    grid-template-columns:
        repeat(
            6,
            1fr
        );

    gap:
        5px;

    margin-top:
        7px;

}

.chart-level {

    background:
        #101925;

    border-radius:
        6px;

    padding:
        7px;

    font-size:
        8px;

}

.chart-level span {

    color:
        #718198;

    display:
        block;

}

.chart-level b {

    display:
        block;

    margin-top:
        3px;

    font-size:
        10px;

}

.entry-level b {

    color:
        #55d7ff;

}

.stop-level b {

    color:
        #ff647a;

}

.tp-level b {

    color:
        #45e58d;

}


/* =========================================================
   PANEL
========================================================= */

.panel {

    background:
        #101720;

    border:
        1px solid #202d3d;

    border-radius:
        12px;

    padding:
        13px;

    margin-bottom:
        12px;

}

.panel h2 {

    margin:
        0 0 5px;

    font-size:
        15px;

}

.panel-description {

    color:
        #718198;

    font-size:
        9px;

    line-height:
        1.5;

    margin-bottom:
        10px;

}


/* =========================================================
   SIGNAL
========================================================= */

.signal-card {

    background:
        #0b1119;

    border:
        1px solid #26354a;

    border-radius:
        9px;

    padding:
        11px;

    margin-bottom:
        8px;

}

.signal-top {

    display:
        flex;

    justify-content:
        space-between;

    align-items:
        center;

    gap:
        8px;

}

.coin {

    font-size:
        16px;

    font-weight:
        900;

    cursor:
        pointer;

}

.coin:hover {

    text-decoration:
        underline;

}

.score {

    background:
        #172235;

    padding:
        5px 8px;

    border-radius:
        5px;

    font-size:
        9px;

    font-weight:
        900;

}

.strategy {

    color:
        #8190a3;

    font-size:
        9px;

    margin-top:
        5px;

}

.price-line {

    margin-top:
        9px;

    font-size:
        10px;

}

.price {

    font-size:
        17px;

    font-weight:
        900;

}

.plan-grid {

    display:
        grid;

    grid-template-columns:
        repeat(
            6,
            1fr
        );

    gap:
        5px;

    margin-top:
        9px;

}

.plan {

    background:
        #121b27;

    border-radius:
        6px;

    padding:
        7px;

}

.plan-label {

    color:
        #6e7d91;

    font-size:
        8px;

}

.plan-value {

    margin-top:
        3px;

    font-weight:
        900;

    font-size:
        10px;

}

.entry {

    color:
        #55d7ff;

}

.stop {

    color:
        #ff647a;

}

.tp {

    color:
        #45e58d;

}

.reason {

    margin-top:
        8px;

    padding:
        8px;

    background:
        #0e1621;

    border-radius:
        6px;

    color:
        #96a5b8;

    font-size:
        9px;

    line-height:
        1.5;

}

.badge5 {

    display:
        inline-block;

    margin-top:
        7px;

    padding:
        4px 6px;

    border-radius:
        5px;

    font-size:
        8px;

    font-weight:
        900;

    background:
        #172235;

    color:
        #8ea0b6;

}

.badge5.confirmed {

    background:
        #0d2b20;

    color:
        #45e58d;

}


/* =========================================================
   PREPARING
========================================================= */

.prepare-card {

    display:
        flex;

    justify-content:
        space-between;

    align-items:
        center;

    gap:
        10px;

    padding:
        9px 0;

    border-bottom:
        1px solid #202a38;

}

.prepare-card:last-child {

    border-bottom:
        0;

}

.prepare-coin {

    font-size:
        11px;

    font-weight:
        900;

    cursor:
        pointer;

}

.prepare-info {

    color:
        #8190a3;

    font-size:
        9px;

    margin-top:
        3px;

}

.trigger {

    text-align:
        right;

}

.trigger-price {

    color:
        #e4c45a;

    font-size:
        10px;

    font-weight:
        900;

}

.distance {

    color:
        #73839a;

    font-size:
        8px;

    margin-top:
        3px;

}


/* =========================================================
   MISSED
========================================================= */

.missed-card {

    background:
        #17131a;

    border:
        1px solid #3b2b3f;

    border-radius:
        8px;

    padding:
        9px;

    margin-bottom:
        7px;

}

.missed-title {

    color:
        #e8b85d;

    font-size:
        10px;

    font-weight:
        900;

}

.missed-info {

    color:
        #8190a3;

    font-size:
        8px;

    margin-top:
        4px;

}

.missed-reason {

    color:
        #aa98a4;

    font-size:
        8px;

    margin-top:
        4px;

}


/* =========================================================
   BUTTON
========================================================= */

button {

    border:
        0;

    border-radius:
        7px;

    padding:
        8px 11px;

    background:
        #e9edf4;

    color:
        #090e16;

    font-size:
        9px;

    font-weight:
        900;

    cursor:
        pointer;

}

button.secondary {

    background:
        #242f40;

    color:
        white;

}


/* =========================================================
   STATUS
========================================================= */

.status {

    margin-top:
        8px;

    color:
        #718198;

    font-size:
        9px;

}


/* =========================================================
   MOBILE
========================================================= */

@media(
    max-width: 800px
) {

    .container {

        width:
            100%;

        margin:
            0;

        padding:
            8px;

    }


    .header {

        display:
            block;

    }


    .title {

        font-size:
            19px;

    }


    .online {

        display:
            inline-block;

        margin-top:
            7px;

    }


    .stats {

        grid-template-columns:
            repeat(
                2,
                1fr
            );

    }


    .stats .stat:last-child {

        grid-column:
            span 2;

    }


    .chart-header {

        display:
            block;

    }


    .timeframes {

        margin-top:
            8px;

    }


    .chart-wrap {

        height:
            390px;

    }


    .chart-plan {

        grid-template-columns:
            repeat(
                3,
                1fr
            );

    }


    .plan-grid {

        grid-template-columns:
            repeat(
                2,
                1fr
            );

    }


    .signal-card {

        padding:
            9px;

    }


    .signal-top {

        align-items:
            flex-start;

    }

}


/* =========================================================
   VERY SMALL MOBILE
========================================================= */

@media(
    max-width: 430px
) {

    .chart-wrap {

        height:
            330px;

    }


    .chart-plan {

        grid-template-columns:
            repeat(
                2,
                1fr
            );

    }


    .title {

        font-size:
            17px;

    }

}

</style>

</head>


<body>


<div class="container">


<div class="header">

<div>

<div class="title">
⚡ SONNY AI TRADER V5.1
</div>

<div class="subtitle">

500 RADAR → 150 ADAY → 40 DEEP →
4H + 2H → 15M BREAKOUT → RETEST → 5M BONUS

</div>

</div>


<div class="online">
● SİSTEM AKTİF · AUTO TRADE KAPALI
</div>

</div>


<!-- MARKET -->

<div class="market-box">

<div class="market-title">
GENEL PİYASA
</div>

<div
id="marketDirection"
class="market-direction neutral"
>
YÜKLENİYOR...
</div>

<div
id="marketReason"
class="market-reason"
>
Piyasa analiz ediliyor...
</div>

</div>


<!-- STATS -->

<div class="stats">


<div class="stat">

<div class="stat-label">
RADAR
</div>

<div
id="marketCount"
class="stat-value"
>
0
</div>

</div>


<div class="stat">

<div class="stat-label">
ADAY
</div>

<div
id="candidateCount"
class="stat-value"
>
0
</div>

</div>


<div class="stat">

<div class="stat-label">
DERİN ANALİZ
</div>

<div
id="deepCount"
class="stat-value"
>
0
</div>

</div>


<div class="stat">

<div class="stat-label">
AKTİF SİNYAL
</div>

<div
id="signalCount"
class="stat-value"
>
0
</div>

</div>


<div class="stat">

<div class="stat-label">
SON TARAMA
</div>

<div
id="lastScan"
class="stat-value"
>
-
</div>

</div>


</div>


<!-- CHART -->

<div class="chart-panel">


<div class="chart-header">


<div>

<div
id="chartTitle"
class="chart-title"
>
BTCUSDT · 15M
</div>

<div
id="chartSub"
class="chart-sub"
>
Gerçek Bitget mum grafiği
</div>

</div>


<div class="timeframes">


<button
class="tf"
data-tf="5m"
onclick="changeTF('5m')"
>
5M
</button>


<button
class="tf active"
data-tf="15m"
onclick="changeTF('15m')"
>
15M
</button>


<button
class="tf"
data-tf="1h"
onclick="changeTF('1h')"
>
1H
</button>


<button
class="tf"
data-tf="2h"
onclick="changeTF('2h')"
>
2H
</button>


<button
class="tf"
data-tf="4h"
onclick="changeTF('4h')"
>
4H
</button>


</div>


</div>


<div class="chart-wrap">

<canvas
id="priceChart"
>
</canvas>

</div>


<div
id="chartPlan"
class="chart-plan"
>

<div
class="chart-level"
>

<span>
SİNYAL
</span>

<b>
Bekleniyor
</b>

</div>

</div>


</div>


<!-- ACTIVE -->

<div class="panel">


<h2>
🚨 AKTİF SCALP SİNYALLERİ
</h2>


<div class="panel-description">

Sadece 4H/2H kırılımı + 15M retest + RSI
uygunluğu oluştuğunda sinyal gelir.
5M teyidi varsa ekstra skor bonusudur.

</div>


<div id="signals">

<div class="panel-description">
Sistem tarıyor...
</div>

</div>


</div>


<!-- MISSED -->

<div
class="panel"
id="missedPanel"
>


<h2>
⚠️ KAÇAN / GEÇERSİZ
</h2>


<div
class="panel-description"
>

Giriş bölgesinden uzaklaşan veya
TP1/STOP'a ulaşan eski setup'lar.

</div>


<div id="missed">

<div class="panel-description">
Henüz yok.
</div>

</div>


</div>


<!-- PREPARING -->

<div class="panel">


<h2>
🟡 HAZIRLANAN FIRSATLAR
</h2>


<div class="panel-description">

Seviyeye yaklaşan ancak henüz gerçek
kırılım + retest tamamlanmamış coinler.

</div>


<div id="preparing">

<div class="panel-description">
Şu anda hazırlanan setup yok.
</div>

</div>


</div>


<!-- CONTROL -->

<div class="panel">


<button
onclick="manualScan()"
>
↻ ŞİMDİ TARA
</button>


<button
class="secondary"
onclick="showStrategy()"
>
ℹ STRATEJİ
</button>


<div
id="status"
class="status"
>
Sistem başlatılıyor...
</div>


</div>


<!-- STRATEGY -->

<div
id="strategyInfo"
class="panel hidden"
>


<h2>
🧠 SİSTEM NASIL ÇALIŞIYOR?
</h2>


<div
class="panel-description"
>


<b>
1 — 500 COIN RADAR
</b>

<br>

Bitget USDT perpetual piyasasındaki
uygun coinler taranır.

<br><br>


<b>
2 — 150 ADAY
</b>

<br>

Hacim, hareket ve volatiliteye göre
en aktif 150 coin seçilir.

<br><br>


<b>
3 — 40 DEEP WATCH
</b>

<br>

150 coin içinden en güçlü 40 setup
derin teknik analize alınır.

<br><br>


<b>
4 — 4H
</b>

<br>

Ana destek ve direnç seviyeleri belirlenir.
4H kırılımı ana tetikleyicidir.

<br><br>


<b>
5 — 2H
</b>

<br>

Kırılımın aynı yönde 2H tarafından
doğrulanması beklenir.

<br><br>


<b>
6 — 15M BREAKOUT
</b>

<br>

Kırılım kapanmış mum üzerinden kontrol edilir.
Hacim zayıfsa setup elenir.

<br><br>


<b>
7 — 15M RETEST
</b>

<br>

Fiyat kırdığı seviyeye geri döner.
Giriş bölgesi burada oluşur.

<br><br>


<b>
8 — RSI
</b>

<br>

RSI giriş yönüyle uyumlu bölgede olmalıdır.

<br><br>


<b>
9 — 5M
</b>

<br>

5M yön + hacim teyidi gelirse skora bonus eklenir.
Ancak 5M teyidi yok diye iyi bir scalp setup
otomatik olarak silinmez.

<br><br>


<b>
10 — İŞLEM PLANI
</b>

<br>

GİRİŞ → STOP → TP1 → TP2 → TP3
ve gerçek R:R hesaplanır.

</div>


</div>


<div
class="status"
>

SONNY AI TRADER V5.1 · BITGET FUTURES ·
MANUAL SIGNAL ONLY

</div>


</div>


<script>


/* =========================================================
   GLOBAL
========================================================= */

let selectedSymbol =
    'BTCUSDT';

let selectedTF =
    '15m';

let chartPayload =
    null;


/* =========================================================
   FORMAT
========================================================= */

function formatPrice(
    value
) {

    if (
        value === undefined ||
        value === null
    ) {

        return '-';

    }


    const number =
        Number(value);


    if (
        !Number.isFinite(
            number
        )
    ) {

        return '-';

    }


    if (
        number >= 1000
    ) {

        return number.toFixed(2);

    }


    if (
        number >= 100
    ) {

        return number.toFixed(3);

    }


    if (
        number >= 1
    ) {

        return number.toFixed(5);

    }


    if (
        number >= 0.01
    ) {

        return number.toFixed(7);

    }


    return number.toFixed(10);

}


/* =========================================================
   ESCAPE
========================================================= */

function escapeHtml(
    value
) {

    return String(
        value === undefined ||
        value === null
            ? ''
            : value
    )

        .replace(
            /&/g,
            '&amp;'
        )

        .replace(
            /</g,
            '&lt;'
        )

        .replace(
            />/g,
            '&gt;'
        )

        .replace(
            /"/g,
            '&quot;'
        )

        .replace(
            /'/g,
            '&#39;'
        );

}


/* =========================================================
   CHART SYMBOL
========================================================= */

function selectSymbol(
    symbol
) {

    selectedSymbol =
        symbol;

    loadChart();

}


/* =========================================================
   TIMEFRAME
========================================================= */

function changeTF(
    tf
) {

    selectedTF =
        tf;


    document
        .querySelectorAll(
            '.tf'
        )
        .forEach(
            button => {

                button.classList.toggle(
                    'active',
                    button.dataset.tf ===
                    tf
                );

            }
        );


    loadChart();

}


/* =========================================================
   DRAW CHART
========================================================= */

function drawChart() {

    const canvas =
        document.getElementById(
            'priceChart'
        );


    if (
        !canvas ||
        !chartPayload
    ) {

        return;

    }


    const rect =
        canvas.getBoundingClientRect();


    const dpr =
        window.devicePixelRatio ||
        1;


    const width =
        Math.max(
            300,
            rect.width
        );


    const height =
        Math.max(
            250,
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


    ctx.clearRect(
        0,
        0,
        width,
        height
    );


    const candles =
        (
            chartPayload.candles ||
            []
        ).slice(
            -100
        );


    if (
        !candles.length
    ) {

        ctx.fillStyle =
            '#718198';

        ctx.font =
            '12px Arial';

        ctx.fillText(
            'Grafik verisi bekleniyor...',
            15,
            25
        );

        return;

    }


    let min =
        Math.min(
            ...candles.map(
                c =>
                    Number(c[3])
            )
        );


    let max =
        Math.max(
            ...candles.map(
                c =>
                    Number(c[2])
            )
        );


    const signal =
        chartPayload.signal;


    if (signal) {

        [

            signal.entryLow,

            signal.entryHigh,

            signal.stop,

            signal.tp1,

            signal.tp2,

            signal.tp3

        ]

            .filter(
                Number.isFinite
            )

            .forEach(
                value => {

                    min =
                        Math.min(
                            min,
                            Number(value)
                        );

                    max =
                        Math.max(
                            max,
                            Number(value)
                        );

                }
            );

    }


    const padding =
        (
            max -
            min
        ) *
        0.07 ||
        1;


    min -=
        padding;


    max +=
        padding;


    const left =
        58;


    const right =
        18;


    const top =
        15;


    const bottom =
        25;


    const plotWidth =
        width -
        left -
        right;


    const plotHeight =
        height -
        top -
        bottom;


    function X(
        index
    ) {

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


    function Y(
        value
    ) {

        return (

            top +

            (
                max -
                Number(value)
            ) /
            Math.max(
                0.00000001,
                max -
                min
            ) *
            plotHeight

        );

    }


    /*
    GRID
    */

    ctx.strokeStyle =
        '#172230';

    ctx.lineWidth =
        1;


    for (
        let i = 0;
        i < 6;
        i++
    ) {

        const yy =
            top +
            (
                plotHeight /
                5
            ) *
            i;


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


        const value =
            max -
            (
                (
                    max -
                    min
                ) /
                5
            ) *
            i;


        ctx.fillStyle =
            '#65758a';

        ctx.font =
            '9px Arial';


        ctx.fillText(
            formatPrice(
                value
            ),
            3,
            yy + 3
        );

    }


    /*
    CANDLES
    */

    const candleWidth =
        Math.max(
            2,
            (
                plotWidth /
                candles.length
            ) *
            0.62
        );


    candles.forEach(
        (
            raw,
            index
        ) => {

            const open =
                Number(
                    raw[1]
                );


            const high =
                Number(
                    raw[2]
                );


            const low =
                Number(
                    raw[3]
                );


            const close =
                Number(
                    raw[4]
                );


            const xx =
                X(index);


            const yo =
                Y(open);


            const yh =
                Y(high);


            const yl =
                Y(low);


            const yc =
                Y(close);


            const bullish =
                close >=
                open;


            ctx.strokeStyle =
                bullish
                    ? '#45e58d'
                    : '#ff647a';


            ctx.fillStyle =
                ctx.strokeStyle;


            /*
            WICK
            */

            ctx.beginPath();

            ctx.moveTo(
                xx,
                yh
            );

            ctx.lineTo(
                xx,
                yl
            );

            ctx.stroke();


            /*
            BODY
            */

            ctx.fillRect(

                xx -
                candleWidth /
                2,

                Math.min(
                    yo,
                    yc
                ),

                candleWidth,

                Math.max(
                    1,
                    Math.abs(
                        yc -
                        yo
                    )
                )

            );

        }
    );


    /*
    LEVEL LINE
    */

    function drawLevel(
        value,
        label,
        type
    ) {

        if (
            value === undefined ||
            value === null
        ) {

            return;

        }


        const numeric =
            Number(
                value
            );


        if (
            !Number.isFinite(
                numeric
            )
        ) {

            return;

        }


        const yy =
            Y(
                numeric
            );


        if (
            yy <
                top ||
            yy >
                top +
                plotHeight
        ) {

            return;

        }


        let stroke =
            '#55d7ff';


        if (
            type ===
            'stop'
        ) {

            stroke =
                '#ff647a';

        }


        if (
            type ===
            'tp'
        ) {

            stroke =
                '#45e58d';

        }


        ctx.strokeStyle =
            stroke;


        ctx.setLineDash([
            7,
            4
        ]);


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


        ctx.setLineDash([]);


        ctx.fillStyle =
            stroke;


        ctx.font =
            'bold 9px Arial';


        ctx.fillText(
            label +
            ' ' +
            formatPrice(
                numeric
            ),
            left +
            4,
            Math.max(
                10,
                yy -
                4
            )
        );

    }


    if (signal) {

        drawLevel(
            signal.entryLow,
            'GİRİŞ',
            'entry'
        );


        drawLevel(
            signal.entryHigh,
            'GİRİŞ',
            'entry'
        );


        drawLevel(
            signal.stop,
            'STOP',
            'stop'
        );


        drawLevel(
            signal.tp1,
            'TP1',
            'tp'
        );


        drawLevel(
            signal.tp2,
            'TP2',
            'tp'
        );


        drawLevel(
            signal.tp3,
            'TP3',
            'tp'
        );

    }


    /*
    CURRENT PRICE
    */

    const last =
        candles[
            candles.length - 1
        ];


    const lastClose =
        Number(
            last[4]
        );


    const currentY =
        Y(
            lastClose
        );


    ctx.strokeStyle =
        '#55d7ff';


    ctx.setLineDash([
        3,
        3
    ]);


    ctx.beginPath();

    ctx.moveTo(
        left,
        currentY
    );

    ctx.lineTo(
        width -
        right,
        currentY
    );

    ctx.stroke();


    ctx.setLineDash([]);


    ctx.fillStyle =
        '#55d7ff';


    ctx.font =
        'bold 9px Arial';


    ctx.fillText(
        formatPrice(
            lastClose
        ),
        width -
        right -
        55,
        currentY -
        4
    );

}


/* =========================================================
   CHART PLAN
========================================================= */

function renderChartPlan() {

    const box =
        document.getElementById(
            'chartPlan'
        );


    if (!box) {

        return;

    }


    const signal =
        chartPayload?.signal;


    if (!signal) {

        box.innerHTML =

            '<div class="chart-level">' +

            '<span>SİNYAL</span>' +

            '<b>Aktif sinyal yok</b>' +

            '</div>';


        return;

    }


    box.innerHTML =

        '<div class="chart-level entry-level">' +

        '<span>GİRİŞ</span>' +

        '<b>' +

        formatPrice(
            signal.entryLow
        ) +

        ' - ' +

        formatPrice(
            signal.entryHigh
        ) +

        '</b>' +

        '</div>' +


        '<div class="chart-level stop-level">' +

        '<span>STOP</span>' +

        '<b>' +

        formatPrice(
            signal.stop
        ) +

        '</b>' +

        '</div>' +


        '<div class="chart-level tp-level">' +

        '<span>TP1</span>' +

        '<b>' +

        formatPrice(
            signal.tp1
        ) +

        '</b>' +

        '</div>' +


        '<div class="chart-level tp-level">' +

        '<span>TP2</span>' +

        '<b>' +

        formatPrice(
            signal.tp2
        ) +

        '</b>' +

        '</div>' +


        '<div class="chart-level tp-level">' +

        '<span>TP3</span>' +

        '<b>' +

        formatPrice(
            signal.tp3
        ) +

        '</b>' +

        '</div>' +


        '<div class="chart-level">' +

        '<span>R:R / SKOR</span>' +

        '<b>' +

        '1:' +

        signal.rr +

        ' · ' +

        signal.score +

        '</b>' +

        '</div>';

}


/* =========================================================
   LOAD CHART
========================================================= */

async function loadChart() {

    try {

        const response =
            await fetch(

                '/api/chart?symbol=' +

                encodeURIComponent(
                    selectedSymbol
                ) +

                '&tf=' +

                encodeURIComponent(
                    selectedTF
                ) +

                '&_=' +

                Date.now(),

                {
                    cache:
                        'no-store'
                }

            );


        const data =
            await response.json();


        if (
            !data.success
        ) {

            throw new Error(
                data.error ||
                'Grafik alınamadı.'
            );

        }


        chartPayload =
            data;


        document.getElementById(
            'chartTitle'
        ).textContent =

            selectedSymbol +
            ' · ' +
            selectedTF.toUpperCase();


        if (
            data.signal
        ) {

            document.getElementById(
                'chartSub'
            ).textContent =

                data.signal.direction +
                ' · SKOR ' +
                data.signal.score +
                ' · RSI ' +
                data.signal.rsi;

        } else {

            document.getElementById(
                'chartSub'
            ).textContent =

                'Aktif sinyal yok · Gerçek Bitget fiyat grafiği';

        }


        renderChartPlan();

        drawChart();

    } catch (error) {

        document.getElementById(
            'chartSub'
        ).textContent =

            'Grafik hatası: ' +
            error.message;

    }

}


/* =========================================================
   RENDER SIGNALS
========================================================= */

function renderSignals(
    items
) {

    const box =
        document.getElementById(
            'signals'
        );


    if (
        !items ||
        !items.length
    ) {

        box.innerHTML =

            '<div class="panel-description">' +

            'Şu anda teyit edilmiş scalp sinyali yok.' +

            '<br><br>' +

            'Radar 500 coin tarıyor ve uygun setup arıyor.' +

            '</div>';


        return;

    }


    let html =
        '';


    items.forEach(
        item => {

            const directionClass =
                item.direction ===
                'LONG'

                    ? 'long'

                    : 'short';


            const fiveClass =
                item.fiveMinConfirmed
                    ? 'confirmed'
                    : '';


            const fiveText =
                item.fiveMinConfirmed

                    ? (
                        '5M TEYİT +' +
                        item.fiveMinVolumeRatio +
                        'x'
                      )

                    : '5M BONUS YOK';


            html +=

                '<div class="signal-card">' +


                '<div class="signal-top">' +


                '<div' +

                ' class="coin ' +
                directionClass +
                '"' +

                ' onclick="selectSymbol(\\'' +
                escapeHtml(
                    item.symbol
                ) +
                '\\')">' +

                escapeHtml(
                    item.symbol
                ) +

                ' · ' +

                escapeHtml(
                    item.direction
                ) +

                '</div>' +


                '<div class="score">' +

                'SKOR ' +

                escapeHtml(
                    item.score
                ) +

                '</div>' +


                '</div>' +


                '<div class="strategy">' +

                escapeHtml(
                    item.strategy
                ) +

                '</div>' +


                '<div class="price-line">' +

                'Anlık: ' +

                '<span class="price">' +

                formatPrice(
                    item.price
                ) +

                '</span>' +

                '</div>' +


                '<div class="plan-grid">' +


                '<div class="plan">' +

                '<div class="plan-label">' +
                'GİRİŞ' +
                '</div>' +

                '<div class="plan-value entry">' +

                formatPrice(
                    item.entryLow
                ) +

                ' - ' +

                formatPrice(
                    item.entryHigh
                ) +

                '</div>' +

                '</div>' +


                '<div class="plan">' +

                '<div class="plan-label">' +
                'STOP' +
                '</div>' +

                '<div class="plan-value stop">' +

                formatPrice(
                    item.stop
                ) +

                '</div>' +

                '</div>' +


                '<div class="plan">' +

                '<div class="plan-label">' +
                'TP1' +
                '</div>' +

                '<div class="plan-value tp">' +

                formatPrice(
                    item.tp1
                ) +

                '</div>' +

                '</div>' +


                '<div class="plan">' +

                '<div class="plan-label">' +
                'TP2' +
                '</div>' +

                '<div class="plan-value tp">' +

                formatPrice(
                    item.tp2
                ) +

                '</div>' +

                '</div>' +


                '<div class="plan">' +

                '<div class="plan-label">' +
                'TP3' +
                '</div>' +

                '<div class="plan-value tp">' +

                formatPrice(
                    item.tp3
                ) +

                '</div>' +

                '</div>' +


                '<div class="plan">' +

                '<div class="plan-label">' +
                'R:R' +
                '</div>' +

                '<div class="plan-value">' +

                '1:' +

                escapeHtml(
                    item.rr
                ) +

                '</div>' +

                '</div>' +


                '</div>' +


                '<div class="badge5 ' +
                fiveClass +
                '">' +

                fiveText +

                '</div>' +


                '<div class="reason">' +

                '<b>Neden:</b> ' +

                escapeHtml(
                    item.reason
                ) +

                '</div>' +


                '</div>';

        }
    );


    box.innerHTML =
        html;

}


/* =========================================================
   RENDER MISSED
========================================================= */

function renderMissed(
    items
) {

    const box =
        document.getElementById(
            'missed'
        );


    if (
        !items ||
        !items.length
    ) {

        box.innerHTML =

            '<div class="panel-description">' +

            'Henüz kaçan / geçersiz sinyal yok.' +

            '</div>';


        return;

    }


    box.innerHTML =

        items
            .map(
                item =>

                    '<div class="missed-card">' +

                    '<div class="missed-title">' +

                    escapeHtml(
                        item.symbol
                    ) +

                    ' · ' +

                    escapeHtml(
                        item.direction
                    ) +

                    '</div>' +

                    '<div class="missed-info">' +

                    'Giriş: ' +

                    formatPrice(
                        item.entryLow
                    ) +

                    ' - ' +

                    formatPrice(
                        item.entryHigh
                    ) +

                    ' · Son: ' +

                    formatPrice(
                        item.price
                    ) +

                    '</div>' +

                    '<div class="missed-reason">' +

                    escapeHtml(
                        item.missedReason ||
                        item.lifecycleReason ||
                        'Giriş fırsatı kaçtı.'
                    ) +

                    '</div>' +

                    '</div>'

            )

            .join('');

}


/* =========================================================
   RENDER PREPARING
========================================================= */

function renderPreparing(
    items
) {

    const box =
        document.getElementById(
            'preparing'
        );


    if (
        !items ||
        !items.length
    ) {

        box.innerHTML =

            '<div class="panel-description">' +

            'Şu anda hazırlanan güçlü fırsat yok.' +

            '</div>';


        return;

    }


    box.innerHTML =

        items

            .map(
                item => {

                    const directionClass =
                        item.direction ===
                        'LONG'

                            ? 'long'

                            : 'short';


                    return (

                        '<div class="prepare-card">' +


                        '<div>' +


                        '<div' +

                        ' class="prepare-coin ' +
                        directionClass +
                        '"' +

                        ' onclick="selectSymbol(\\'' +
                        escapeHtml(
                            item.symbol
                        ) +
                        '\\')">' +

                        escapeHtml(
                            item.symbol
                        ) +

                        ' · ' +

                        escapeHtml(
                            item.direction
                        ) +

                        '</div>' +


                        '<div class="prepare-info">' +

                        'Anlık: ' +

                        formatPrice(
                            item.price
                        ) +

                        ' · RSI: ' +

                        escapeHtml(
                            item.rsi
                        ) +

                        '</div>' +


                        '</div>' +


                        '<div class="trigger">' +

                        '<div class="trigger-price">' +

                        'Tetik: ' +

                        formatPrice(
                            item.trigger
                        ) +

                        '</div>' +


                        '<div class="distance">' +

                        escapeHtml(
                            item.distance
                        ) +

                        '% uzakta' +

                        '</div>' +


                        '</div>' +


                        '</div>'

                    );

                }
            )

            .join('');

}


/* =========================================================
   DASHBOARD
========================================================= */

function updateDashboard(
    data
) {

    if (!data) {

        return;

    }


    if (
        data.market
    ) {

        const direction =
            document.getElementById(
                'marketDirection'
            );


        direction.textContent =
            data.market.label ||
            'PİYASA KARIŞIK';


        direction.className =
            'market-direction ' +

            (
                data.market.direction ===
                'LONG'

                    ? 'long'

                    :

                data.market.direction ===
                'SHORT'

                    ? 'short'

                    : 'neutral'
            );


        document.getElementById(
            'marketReason'
        ).textContent =

            (
                data.market.reason ||
                ''
            ) +

            (
                data.market.breadth !==
                undefined

                    ? ' · Breadth %' +
                      data.market.breadth

                    : ''
            );

    }


    if (
        data.stats
    ) {

        document.getElementById(
            'marketCount'
        ).textContent =

            data.stats.market ||
            0;


        document.getElementById(
            'candidateCount'
        ).textContent =

            data.stats.candidates ||
            0;


        document.getElementById(
            'deepCount'
        ).textContent =

            data.stats.deepWatch ||
            0;


        document.getElementById(
            'signalCount'
        ).textContent =

            data.stats.signals ||
            0;

    }


    if (
        data.timestamp
    ) {

        document.getElementById(
            'lastScan'
        ).textContent =

            new Date(
                data.timestamp
            ).toLocaleTimeString(
                'tr-TR'
            );

    }


    renderSignals(
        data.signals
    );


    renderMissed(
        data.missed
    );


    renderPreparing(
        data.preparing
    );


    /*
    İlk sinyal varsa grafik ona geçsin.
    */

    if (
        data.signals &&
        data.signals.length
    ) {

        if (
            selectedSymbol ===
            'BTCUSDT'
        ) {

            selectedSymbol =
                data.signals[0].symbol;

        }

    }


    loadChart();

}


/* =========================================================
   LOAD RESULT
========================================================= */

async function loadResult() {

    try {

        const response =
            await fetch(

                '/api/result?_=' +
                Date.now(),

                {
                    cache:
                        'no-store'
                }

            );


        if (
            !response.ok
        ) {

            throw new Error(
                'HTTP ' +
                response.status
            );

        }


        const payload =
            await response.json();


        const data =
            payload.result ||
            (
                payload.success &&
                payload.stats
                    ? payload
                    : null
            );


        if (
            data
        ) {

            updateDashboard(
                data
            );


            document.getElementById(
                'status'
            ).textContent =

                payload.scanning

                    ? 'Sistem taramayı sürdürüyor...'

                    : 'Sistem aktif · Her 60 saniyede yeni radar.';

        } else {

            document.getElementById(
                'status'
            ).textContent =

                payload.message ||
                'İlk radar taraması bekleniyor...';

        }

    } catch (error) {

        document.getElementById(
            'status'
        ).textContent =

            'Sunucu bağlantı hatası: ' +
            error.message;

    }

}


/* =========================================================
   MANUAL SCAN
========================================================= */

async function manualScan() {

    document.getElementById(
        'status'
    ).textContent =

        'Radar manuel olarak taranıyor...';


    try {

        await fetch(
            '/api/scan?_=' +
            Date.now(),
            {
                cache:
                    'no-store'
            }
        );


        await loadResult();

    } catch (error) {

        document.getElementById(
            'status'
        ).textContent =

            'Tarama hatası: ' +
            error.message;

    }

}


/* =========================================================
   STRATEGY
========================================================= */

function showStrategy() {

    document
        .getElementById(
            'strategyInfo'
        )
        .classList.toggle(
            'hidden'
        );

}


/* =========================================================
   RESIZE
========================================================= */

window.addEventListener(
    'resize',
    drawChart
);


/* =========================================================
   START
========================================================= */

loadResult();


setInterval(
    loadResult,
    10000
);

</script>

</body>

</html>

`;


/* =========================================================
   API RESULT
========================================================= */

app.get(
    '/',
    (req, res) => {

        res.setHeader(
            'Content-Type',
            'text/html; charset=utf-8'
        );

        res.setHeader(
            'Cache-Control',
            'no-store, no-cache, must-revalidate, proxy-revalidate'
        );

        res.setHeader(
            'Pragma',
            'no-cache'
        );

        res.setHeader(
            'Expires',
            '0'
        );

        res.send(
            HTML
        );

    }
);


/* =========================================================
   HEALTH
========================================================= */

app.get(
    '/health',
    (req, res) => {

        res.json({

            success:
                true,

            status:
                'healthy',

            system:
                'SONNY AI TRADER V5.1',

            strategy:
                '500 → 150 → 40 → 4H + 2H → 15M → RETEST → 5M BONUS',

            uptime:
                process.uptime()

        });

    }
);


/* =========================================================
   STATUS
========================================================= */

app.get(
    '/api/status',
    (req, res) => {

        res.json({

            success:
                true,

            system:
                'SONNY AI TRADER V5.1',

            status:
                scanRunning
                    ? 'SCANNING'
                    : 'ONLINE',

            strategy:
                '500 → 150 → 40 → 4H + 2H → 15M BREAKOUT → RETEST → 5M BONUS',

            refresh:
                '60 SECONDS',

            lastScan,

            discoveryTime,

            market:
                marketCache.length,

            candidates:
                STATE.stats.candidates,

            deep:
                STATE.stats.deepWatch,

            signals:
                STATE.stats.signals,

            error:
                lastError

        });

    }
);


/* =========================================================
   SCAN
========================================================= */

app.get(
    '/api/scan',
    async (req, res) => {

        const result =
            await runRadar();


        res.json(
            result
        );

    }
);


/* =========================================================
   RESULT
========================================================= */

app.get(
    '/api/result',
    async (req, res) => {

        res.setHeader(
            'Cache-Control',
            'no-store, no-cache, must-revalidate, proxy-revalidate'
        );

        res.setHeader(
            'Pragma',
            'no-cache'
        );

        res.setHeader(
            'Expires',
            '0'
        );


        try {

            if (
                !cachedResult &&
                !scanRunning
            ) {

                runRadar()
                    .catch(
                        error =>
                            log(
                                `İlk radar hatası: ${error.message}`
                            )
                    );

            }


            if (
                !cachedResult
            ) {

                return res.json({

                    success:
                        true,

                    scanning:
                        true,

                    result:
                        null,

                    message:
                        'İlk tarama devam ediyor...'

                });

            }


            /*
            Canlı fiyat güncellemesi.
            */

            try {

                const tickers =
                    await getTickers(
                        true
                    );


                const priceMap =
                    new Map();


                for (
                    const [
                        symbol,
                        ticker
                    ]
                    of
                    tickers.entries()
                ) {

                    if (
                        Number.isFinite(
                            ticker.last
                        )
                    ) {

                        priceMap.set(
                            symbol,
                            ticker.last
                        );

                    }

                }


                /*
                Aktif sinyallerin fiyatını güncelle.
                */

                for (
                    const [
                        key,
                        signal
                    ]
                    of
                    STATE.signals.entries()
                ) {

                    const livePrice =
                        priceMap.get(
                            signal.symbol
                        );


                    if (
                        Number.isFinite(
                            livePrice
                        )
                    ) {

                        const updated =
                            updateSignalLifecycle(
                                signal,
                                livePrice
                            );


                        if (
                            updated.status ===
                            'MISSED'
                        ) {

                            moveSignalToHistory(
                                key,
                                updated,
                                updated.lifecycleReason
                            );

                        } else if (
                            updated.status ===
                            'INVALID'
                        ) {

                            moveSignalToHistory(
                                key,
                                updated,
                                updated.lifecycleReason
                            );

                        } else {

                            STATE.signals.set(
                                key,
                                updated
                            );

                        }

                    }

                }


                /*
                Sonuçtaki coin fiyatlarını güncelle.
                */

                cachedResult.signals =
                    Array.from(
                        STATE.signals.values()
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


                cachedResult.missed =
                    getMissedSignals();


                cachedResult.stats.signals =
                    cachedResult.signals.length;


                /*
                Radar fiyatları.
                */

                cachedResult.candidates =
                    cachedResult.candidates.map(
                        item => {

                            const price =
                                priceMap.get(
                                    item.symbol
                                );


                            return Number.isFinite(
                                price
                            )

                                ? {
                                    ...item,
                                    price:
                                        round(
                                            price,
                                            8
                                        )
                                }

                                : item;

                        }
                    );


            } catch (priceError) {

                log(
                    `Live fiyat yenileme hatası: ${priceError.message}`
                );

            }


            res.json({

                success:
                    true,

                scanning:
                    scanRunning,

                result:
                    cachedResult

            });

        } catch (error) {

            lastError =
                error.message;


            res.status(
                500
            ).json({

                success:
                    false,

                scanning:
                    scanRunning,

                result:
                    cachedResult,

                error:
                    error.message

            });

        }

    }
);


/* =========================================================
   CHART API
========================================================= */

app.get(
    '/api/chart',
    async (req, res) => {

        try {

            const rawSymbol =
                String(
                    req.query.symbol ||
                    'BTCUSDT'
                )
                    .toUpperCase();


            const symbol =
                symbolForMarket(
                    rawSymbol
                );


            if (
                !symbol
            ) {

                return res
                    .status(
                        404
                    )
                    .json({

                        success:
                            false,

                        error:
                            'Coin bulunamadı: ' +
                            rawSymbol

                    });

            }


            const allowed =
                new Set([

                    '5m',

                    '15m',

                    '1h',

                    '2h',

                    '4h'

                ]);


            const timeframe =
                allowed.has(
                    String(
                        req.query.tf ||
                        '15m'
                    )
                )

                    ? String(
                        req.query.tf ||
                        '15m'
                    )

                    : '15m';


            const candles =
                await getCandles(
                    symbol,
                    timeframe,
                    CFG.CHART_LIMIT
                );


            const cleaned =
                candles.map(
                    row => ({

                        time:
                            Number(
                                row[0]
                            ),

                        open:
                            Number(
                                row[1]
                            ),

                        high:
                            Number(
                                row[2]
                            ),

                        low:
                            Number(
                                row[3]
                            ),

                        close:
                            Number(
                                row[4]
                            ),

                        volume:
                            Number(
                                row[5] ||
                                0
                            )

                    })
                );


            const signal =
                Array.from(
                    STATE.signals.values()
                )

                    .filter(
                        item =>
                            item.symbol ===
                            symbol
                    )

                    .sort(
                        (a, b) =>
                            b.score -
                            a.score
                    )[0]

                    ||

                (
                    cachedResult?.signals ||
                    []
                ).find(
                    item =>
                        item.symbol ===
                        symbol
                )

                    ||

                null;


            res.json({

                success:
                    true,

                symbol,

                timeframe,

                candles:
                    cleaned,

                signal:
                    signal

                        ? {

                            symbol:
                                signal.symbol,

                            direction:
                                signal.direction,

                            score:
                                signal.score,

                            price:
                                signal.price,

                            entryLow:
                                signal.entryLow,

                            entryHigh:
                                signal.entryHigh,

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

                            fiveMinConfirmed:
                                signal.fiveMinConfirmed,

                            fiveMinVolumeRatio:
                                signal.fiveMinVolumeRatio

                        }

                        : null

            });

        } catch (error) {

            res
                .status(
                    500
                )
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
   WEBSOCKET
========================================================= */

wss.on(
    'connection',
    socket => {

        try {

            socket.send(

                JSON.stringify({

                    type:
                        'connected',

                    data:
                        cachedResult

                })

            );

        } catch (_) {}

    }
);


/* =========================================================
   404
========================================================= */

app.use(
    (req, res) => {

        res
            .status(
                404
            )
            .json({

                success:
                    false,

                error:
                    'Endpoint not found'

            });

    }
);


/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
    (
        error,
        req,
        res,
        next
    ) => {

        console.error(
            'SERVER ERROR:',
            error
        );


        if (
            res.headersSent
        ) {

            return next(
                error
            );

        }


        res
            .status(
                500
            )
            .json({

                success:
                    false,

                error:
                    error.message ||
                    'Internal server error'

            });

    }
);


/* =========================================================
   SERVER START
========================================================= */

server.listen(
    PORT,
    '0.0.0.0',
    () => {

        console.log(
            '=============================================='
        );

        console.log(
            '🚀 SONNY AI TRADER V5.1'
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
            '📊 4H + 2H → 15M Breakout → Retest → 5M Bonus'
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


        /*
        İlk tarama.
        */

        setTimeout(
            () => {

                runRadar()
                    .catch(
                        error =>
                            log(
                                `İlk tarama hatası: ${error.message}`
                            )
                    );

            },
            2500
        );


        /*
        Ana radar.
        */

        setInterval(
            () => {

                runRadar()
                    .catch(
                        error =>
                            log(
                                `Radar döngüsü hatası: ${error.message}`
                            )
                    );

            },
            CFG.SCAN_MS
        );


        /*
        WebSocket canlı sonuç.
        */

        setInterval(
            () => {

                if (
                    cachedResult
                ) {

                    broadcast(
                        cachedResult
                    );

                }

            },
            CFG.LIVE_MS
        );

    }
);
