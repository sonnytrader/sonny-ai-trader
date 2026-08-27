'use strict';

/*
===============================================================
 SONNY AI TRADER FINAL v5.1
 BITGET FUTURES BREAKOUT ENGINE

 MİMARİ:

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
 5M ENTRY CONFIRMATION
       ↓
 SIGNAL

 FRONTEND:
 server.js içinde gömülü HTML

 AUTO TRADE:
 KAPALI
===============================================================
*/

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');

const app = express();

app.use(express.json());

const server =
    http.createServer(app);

const wss =
    new WebSocket.Server({
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
            defaultType: 'swap'
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

    /* -------------------------------------------------------
       MARKET
    ------------------------------------------------------- */

    MIN_VOLUME_USD:
        1_000_000,

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
        120,

    M5_LIMIT:
        80,

    CHART_LIMIT:
        160,

    /* -------------------------------------------------------
       LEVEL
    ------------------------------------------------------- */

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
    ------------------------------------------------------- */

    FIVE_MIN_VOLUME_RATIO:
        1.05,

    FIVE_MIN_BONUS:
        8,

    REQUIRE_5M:
        true,

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

    rotationIndex:
        0,

    marketsLoadedAt:
        0,

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

/* =========================================================
   HELPERS
========================================================= */

function sleep(ms) {

    return new Promise(
        resolve =>
            setTimeout(
                resolve,
                ms
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

    if (x >= 1000)
        return Number(
            x.toFixed(2)
        );

    if (x >= 100)
        return Number(
            x.toFixed(3)
        );

    if (x >= 1)
        return Number(
            x.toFixed(5)
        );

    if (x >= 0.01)
        return Number(
            x.toFixed(7)
        );

    return Number(
        x.toFixed(10)
    );

}

function percentDistance(
    a,
    b
) {

    if (!b)
        return 999;

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

    /*
       Son mum henüz açık olabilir.
       Analizlerde sadece kapanmış mumlar.
    */

    return candles.slice(
        0,
        -1
    );

}

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
            catch (_) {

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
        ) ||
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
        return 5_000;
    }

    if (
        timeframe === '15m'
    ) {
        return 15_000;
    }

    return 30_000;

}

async function getCandles(
    symbol,
    timeframe,
    limit
) {

    const key =
        `${symbol}|${timeframe}|${limit}`;

    const cached =
        candleCache.get(key);

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

    }
    catch (error) {

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
        8_000
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
                        n(ticker.high),

                    low:
                        n(ticker.low),

                    bid:
                        n(ticker.bid),

                    ask:
                        n(ticker.ask)
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

            last:
                ticker.last,

            quoteVolume:
                ticker.volume,

            percentage:
                ticker.change,

            range

        });

    }

    rows.sort(
        (a, b) =>
            b.quoteVolume -
            a.quoteVolume
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

    const candidates =
        [...rows]
            .map(
                row => {

                    let score =
                        0;

                    const volumeScore =
                        Math.min(
                            35,
                            Math.log10(
                                Math.max(
                                    row.quoteVolume,
                                    1
                                )
                            ) * 4
                        );

                    const rangeScore =
                        Math.min(
                            25,
                            row.range * 5
                        );

                    const momentumScore =
                        Math.min(
                            25,
                            Math.abs(
                                row.percentage
                            ) * 5
                        );

                    const activity =
                        Math.min(
                            15,
                            Math.abs(
                                row.percentage
                            ) >= 2
                                ? 15
                                : 7
                        );

                    score =
                        volumeScore +
                        rangeScore +
                        momentumScore +
                        activity;

                    return {

                        ...row,

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
            )
            .slice(
                0,
                CFG.CANDIDATE_LIMIT
            );

    STATE.candidates =
        candidates;

    STATE.stats.candidates =
        candidates.length;

    return candidates;

}

/* =========================================================
   EMA
========================================================= */

function ema(
    candles,
    period
) {

    const c =
        closedCandles(
            candles
        );

    if (
        c.length <
        period
    ) {
        return null;
    }

    const k =
        2 /
        (
            period +
            1
        );

    let value =
        c.slice(
            0,
            period
        )
        .reduce(
            (
                sum,
                item
            ) =>
                sum +
                n(item[4]),
            0
        ) /
        period;

    for (
        let i = period;
        i < c.length;
        i++
    ) {

        value =
            n(c[i][4]) * k +
            value *
            (
                1 - k
            );

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
        closedCandles(
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

    const start =
        c.length -
        period;

    for (
        let i = start;
        i < c.length;
        i++
    ) {

        const diff =
            n(c[i][4]) -
            n(c[i - 1][4]);

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
        (
            100 /
            (
                1 + rs
            )
        )
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
        closedCandles(
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
            n(c[i][2]);

        const low =
            n(c[i][3]);

        const previousClose =
            n(c[i - 1][4]);

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

    const recent =
        tr.slice(
            -period
        );

    return (
        recent.reduce(
            (
                sum,
                value
            ) =>
                sum + value,
            0
        ) /
        recent.length
    );

}

/* =========================================================
   4H TREND
========================================================= */

function trend4H(
    candles
) {

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

    if (
        !fast ||
        !slow
    ) {

        return {

            direction:
                'NEUTRAL',

            diff:
                0
        };

    }

    const diff =
        (
            fast -
            slow
        ) /
        slow *
        100;

    if (
        diff >
        0.15
    ) {

        return {

            direction:
                'LONG',

            diff
        };

    }

    if (
        diff <
        -0.15
    ) {

        return {

            direction:
                'SHORT',

            diff
        };

    }

    return {

        direction:
            'NEUTRAL',

        diff
    };

}

/* =========================================================
   PIVOTS
========================================================= */

function pivots(
    candles,
    lookback =
        CFG.PIVOT_LOOKBACK
) {

    const c =
        closedCandles(
            candles
        );

    const result = [];

    for (
        let i =
            lookback;
        i <
            c.length -
            lookback;
        i++
    ) {

        const high =
            n(c[i][2]);

        const low =
            n(c[i][3]);

        let isHigh =
            true;

        let isLow =
            true;

        for (
            let j = 1;
            j <= lookback;
            j++
        ) {

            if (
                high <=
                n(c[i - j][2]) ||
                high <=
                n(c[i + j][2])
            ) {

                isHigh =
                    false;

            }

            if (
                low >=
                n(c[i - j][3]) ||
                low >=
                n(c[i + j][3])
            ) {

                isLow =
                    false;

            }

        }

        if (
            isHigh
        ) {

            result.push({

                price:
                    high,

                type:
                    'resistance',

                time:
                    c[i][0]

            });

        }

        if (
            isLow
        ) {

            result.push({

                price:
                    low,

                type:
                    'support',

                time:
                    c[i][0]

            });

        }

    }

    return result;

}

/* =========================================================
   CLUSTER
========================================================= */

function clusterLevels(
    levels
) {

    const sorted =
        [...levels]
            .sort(
                (
                    a,
                    b
                ) =>
                    a.price -
                    b.price
            );

    const groups = [];

    for (
        const level
        of sorted
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

        if (
            existing
        ) {

            existing.items.push(
                level
            );

            existing.price =
                existing.items
                    .reduce(
                        (
                            sum,
                            item
                        ) =>
                            sum +
                            item.price,
                        0
                    ) /
                    existing.items.length;

        }
        else {

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

            lastTouch:
                Math.max(
                    ...group.items.map(
                        item =>
                            n(item.time)
                    )
                )

        })
    );

}

/* =========================================================
   GET LEVELS
========================================================= */

function getLevels(
    candles
) {

    return clusterLevels(
        pivots(
            candles
        )
    );

}

/* =========================================================
   BREAKOUT QUALITY
========================================================= */

function breakoutQuality(
    candle,
    m15
) {

    const currentATR =
        atr(
            m15,
            14
        ) ||
        n(candle[4]) *
        0.003;

    const body =
        Math.abs(
            n(candle[4]) -
            n(candle[1])
        );

    const range =
        Math.max(
            n(candle[2]) -
            n(candle[3]),
            n(candle[4]) *
            0.000001
        );

    return {

        atr:
            currentATR,

        bodyAtr:
            body /
            currentATR,

        bodyRatio:
            body /
            range

    };

}

/* =========================================================
   VOLUME RATIO — BREAKOUT MUMU
========================================================= */

function volumeRatioAt(
    candles,
    index
) {

    const c =
        closedCandles(
            candles
        );

    if (
        index < 20 ||
        index >= c.length
    ) {

        return 1;

    }

    const current =
        n(c[index][5]);

    const previous =
        c.slice(
            index - 20,
            index
        );

    const average =
        previous.reduce(
            (
                sum,
                item
            ) =>
                sum +
                n(item[5]),
            0
        ) /
        previous.length;

    return average > 0
        ? current /
          average
        : 1;

}

/* =========================================================
   DETECT RECENT BREAKOUT
========================================================= */

function detectBreakouts(
    m15,
    levels
) {

    const c =
        closedCandles(
            m15
        );

    if (
        c.length < 30
    ) {
        return [];
    }

    const found = [];

    const start =
        Math.max(
            1,
            c.length -
            CFG.BREAKOUT_LOOKBACK
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

        const currentClose =
            n(current[4]);

        const previousClose =
            n(previous[4]);

        const qualityLong =
            breakoutQuality(
                current,
                m15
            );

        const volumeRatio =
            volumeRatioAt(
                m15,
                i
            );

        /* ---------------------------------------------------
           RESISTANCE BREAK
        --------------------------------------------------- */

        for (
            const level
            of levels.filter(
                x =>
                    x.type ===
                    'resistance'
            )
        ) {

            const crossed =
                previousClose <=
                    level.price &&
                currentClose >
                    level.price;

            const closeDistance =
                percentDistance(
                    currentClose,
                    level.price
                );

            if (
                crossed &&
                volumeRatio >=
                    CFG.MIN_BREAKOUT_VOLUME_RATIO &&
                qualityLong.bodyAtr >=
                    CFG.MIN_BREAKOUT_BODY_ATR &&
                closeDistance >=
                    CFG.MIN_BREAKOUT_CLOSE_DISTANCE
            ) {

                found.push({

                    direction:
                        'LONG',

                    level,

                    breakoutCandle:
                        current,

                    breakoutTime:
                        n(current[0]),

                    breakoutVolumeRatio:
                        volumeRatio,

                    breakoutBodyAtr:
                        qualityLong.bodyAtr,

                    breakoutBodyRatio:
                        qualityLong.bodyRatio,

                    closeDistancePct:
                        closeDistance

                });

            }

        }

        /* ---------------------------------------------------
           SUPPORT BREAK
        --------------------------------------------------- */

        for (
            const level
            of levels.filter(
                x =>
                    x.type ===
                    'support'
            )
        ) {

            const crossed =
                previousClose >=
                    level.price &&
                currentClose <
                    level.price;

            const closeDistance =
                percentDistance(
                    currentClose,
                    level.price
                );

            if (
                crossed &&
                volumeRatio >=
                    CFG.MIN_BREAKOUT_VOLUME_RATIO &&
                qualityLong.bodyAtr >=
                    CFG.MIN_BREAKOUT_BODY_ATR &&
                closeDistance >=
                    CFG.MIN_BREAKOUT_CLOSE_DISTANCE
            ) {

                found.push({

                    direction:
                        'SHORT',

                    level,

                    breakoutCandle:
                        current,

                    breakoutTime:
                        n(current[0]),

                    breakoutVolumeRatio:
                        volumeRatio,

                    breakoutBodyAtr:
                        qualityLong.bodyAtr,

                    breakoutBodyRatio:
                        qualityLong.bodyRatio,

                    closeDistancePct:
                        closeDistance

                });

            }

        }

    }

    return found;

}

/* =========================================================
   PENDING KEY
========================================================= */

function pendingKey(
    symbol,
    breakout
) {

    return (
        `${symbol}|` +
        `${breakout.direction}|` +
        `${fmtPrice(
            breakout.level.price
        )}|` +
        `${breakout.breakoutTime}`
    );

}

/* =========================================================
   SAVE BREAKOUT
========================================================= */

function saveBreakouts(
    symbol,
    breakouts
) {

    const now =
        Date.now();

    for (
        const breakout
        of breakouts
    ) {

        const key =
            pendingKey(
                symbol,
                breakout
            );

        if (
            STATE.pendingBreakouts.has(
                key
            )
        ) {
            continue;
        }

        STATE.pendingBreakouts.set(
            key,
            {

                ...breakout,

                key,

                symbol,

                createdAt:
                    now,

                status:
                    'WAITING_RETEST'

            }
        );

        console.log(
            `⚡ BREAKOUT | ` +
            `${cleanSymbol(symbol)} | ` +
            `${breakout.direction} | ` +
            `Level ${fmtPrice(
                breakout.level.price
            )} | ` +
            `Vol ${breakout.breakoutVolumeRatio.toFixed(2)}x`
        );

    }

}

/* =========================================================
   RETEST
========================================================= */

function detectRetest(
    m15,
    pending
) {

    const c =
        closedCandles(
            m15
        );

    const index =
        c.findIndex(
            candle =>
                n(candle[0]) ===
                pending.breakoutTime
        );

    if (
        index < 0
    ) {

        return {

            status:
                'WAITING_RETEST'

        };

    }

    const maxCandles =
        Math.ceil(
            CFG.RETEST_WINDOW_MINUTES /
            15
        );

    const end =
        Math.min(
            c.length,
            index +
            1 +
            maxCandles
        );

    let movedAway =
        false;

    const level =
        pending.level.price;

    for (
        let i =
            index + 1;
        i < end;
        i++
    ) {

        const candle =
            c[i];

        const high =
            n(candle[2]);

        const low =
            n(candle[3]);

        const close =
            n(candle[4]);

        /* ---------------------------------------------------
           LONG
        --------------------------------------------------- */

        if (
            pending.direction ===
            'LONG'
        ) {

            if (
                close <
                level *
                (
                    1 -
                    CFG.BREAKOUT_INVALIDATION
                )
            ) {

                return {

                    status:
                        'INVALIDATED',

                    reason:
                        'Kırılan direnç tekrar aşağı geçildi.'

                };

            }

            if (
                close >
                level *
                (
                    1 +
                    CFG.RETEST_MOVE_AWAY
                )
            ) {

                movedAway =
                    true;

            }

            const touched =
                low <=
                level *
                (
                    1 +
                    CFG.RETEST_TOLERANCE
                );

            const held =
                close >=
                level *
                (
                    1 -
                    CFG.RETEST_TOLERANCE
                );

            if (
                movedAway &&
                touched &&
                held
            ) {

                return {

                    status:
                        'RETESTED',

                    candle,

                    candleIndex:
                        i

                };

            }

        }

        /* ---------------------------------------------------
           SHORT
        --------------------------------------------------- */

        else {

            if (
                close >
                level *
                (
                    1 +
                    CFG.BREAKOUT_INVALIDATION
                )
            ) {

                return {

                    status:
                        'INVALIDATED',

                    reason:
                        'Kırılan destek tekrar yukarı geçildi.'

                };

            }

            if (
                close <
                level *
                (
                    1 -
                    CFG.RETEST_MOVE_AWAY
                )
            ) {

                movedAway =
                    true;

            }

            const touched =
                high >=
                level *
                (
                    1 -
                    CFG.RETEST_TOLERANCE
                );

            const held =
                close <=
                level *
                (
                    1 +
                    CFG.RETEST_TOLERANCE
                );

            if (
                movedAway &&
                touched &&
                held
            ) {

                return {

                    status:
                        'RETESTED',

                    candle,

                    candleIndex:
                        i

                };

            }

        }

    }

    if (
        c.length -
        1 >=
        index +
        maxCandles
    ) {

        return {

            status:
                'EXPIRED'

        };

    }

    return {

        status:
            'WAITING_RETEST'

    };

}

/* =========================================================
   5M CONFIRMATION
========================================================= */

function confirm5M(
    candles,
    retest,
    direction,
    level
) {

    const c =
        closedCandles(
            candles
        );

    if (
        c.length < 8 ||
        !retest?.candle
    ) {

        return {

            confirmed:
                false

        };

    }

    const after =
        c.filter(
            candle =>
                n(candle[0]) >
                n(
                    retest.candle[0]
                )
        );

    if (
        after.length < 2
    ) {

        return {

            confirmed:
                false

        };

    }

    /*
       Tek son muma bakmıyoruz.
       Retest sonrasındaki tüm yakın
       5M geçmişi tarıyoruz.
    */

    const recent =
        after.slice(-12);

    for (
        let i = 1;
        i < recent.length;
        i++
    ) {

        const previous =
            recent[i - 1];

        const current =
            recent[i];

        const open =
            n(current[1]);

        const close =
            n(current[4]);

        const high =
            n(current[2]);

        const low =
            n(current[3]);

        const prevHigh =
            n(previous[2]);

        const prevLow =
            n(previous[3]);

        const volumeRatio =
            volumeRatioAt(
                candles,
                c.indexOf(
                    current
                )
            );

        if (
            direction ===
            'LONG'
        ) {

            const bullish =
                close >
                open;

            const higherLow =
                low >=
                prevLow;

            const continuation =
                close >
                prevHigh;

            const aboveLevel =
                close >
                level;

            if (
                bullish &&
                higherLow &&
                continuation &&
                aboveLevel &&
                volumeRatio >=
                    CFG.FIVE_MIN_VOLUME_RATIO
            ) {

                return {

                    confirmed:
                        true,

                    candle:
                        current,

                    volumeRatio

                };

            }

        }

        else {

            const bearish =
                close <
                open;

            const lowerHigh =
                high <=
                prevHigh;

            const continuation =
                close <
                prevLow;

            const belowLevel =
                close <
                level;

            if (
                bearish &&
                lowerHigh &&
                continuation &&
                belowLevel &&
                volumeRatio >=
                    CFG.FIVE_MIN_VOLUME_RATIO
            ) {

                return {

                    confirmed:
                        true,

                    candle:
                        current,

                    volumeRatio

                };

            }

        }

    }

    return {

        confirmed:
            false

    };

}

/* =========================================================
   SCORE
========================================================= */

function calculateScore(
    data
) {

    let score =
        25;

    const reasons =
        [];

    /* 4H */

    if (
        data.trend.direction ===
        data.direction
    ) {

        score +=
            20;

        reasons.push(
            '4H trend uyumlu'
        );

    }

    else if (
        data.trend.direction ===
        'NEUTRAL'
    ) {

        score +=
            8;

        reasons.push(
            '4H trend nötr'
        );

    }

    else {

        score -=
            10;

        reasons.push(
            '4H trend ters'
        );

    }

    /* 4H + 2H */

    if (
        data.confluence
    ) {

        score +=
            20;

        reasons.push(
            '4H + 2H aynı bölge'
        );

    }

    else {

        score +=
            8;

        reasons.push(
            `${data.levelTf} seviye`
        );

    }

    /* TOUCH */

    if (
        data.touches >= 4
    ) {

        score +=
            10;

        reasons.push(
            `${data.touches} temas`
        );

    }

    else if (
        data.touches >= 2
    ) {

        score +=
            6;

        reasons.push(
            `${data.touches} temas`
        );

    }

    /* BREAKOUT VOLUME */

    if (
        data.breakoutVolume >= 2
    ) {

        score +=
            15;

        reasons.push(
            `Breakout hacmi ${data.breakoutVolume.toFixed(2)}x`
        );

    }

    else if (
        data.breakoutVolume >=
        CFG.MIN_BREAKOUT_VOLUME_RATIO
    ) {

        score +=
            8;

        reasons.push(
            `Breakout hacmi ${data.breakoutVolume.toFixed(2)}x`
        );

    }

    /* BODY */

    if (
        data.breakoutBodyAtr >=
        0.70
    ) {

        score +=
            10;

        reasons.push(
            'Güçlü breakout gövdesi'
        );

    }

    else {

        score +=
            4;

    }

    /* 15M */

    if (
        data.structure ===
        data.direction
    ) {

        score +=
            15;

        reasons.push(
            '15M yapı uyumlu'
        );

    }

    else if (
        data.structure ===
        'NEUTRAL'
    ) {

        score +=
            4;

        reasons.push(
            '15M nötr'
        );

    }

    else {

        score -=
            10;

        reasons.push(
            '15M ters'
        );

    }

    /* RSI */

    if (
        data.direction ===
        'LONG'
    ) {

        if (
            data.rsi >= 45 &&
            data.rsi <= 70
        ) {

            score +=
                5;

            reasons.push(
                'RSI uygun'
            );

        }

        if (
            data.rsi > 82
        ) {

            score -=
                5;

            reasons.push(
                'RSI aşırı yüksek'
            );

        }

    }

    else {

        if (
            data.rsi >= 30 &&
            data.rsi <= 55
        ) {

            score +=
                5;

            reasons.push(
                'RSI uygun'
            );

        }

        if (
            data.rsi < 18
        ) {

            score -=
                5;

            reasons.push(
                'RSI aşırı düşük'
            );

        }

    }

    /* 5M */

    if (
        data.confirm5M
    ) {

        score +=
            CFG.FIVE_MIN_BONUS;

        reasons.push(
            '5M giriş teyidi'
        );

    }

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

    return {

        score,

        reasons

    };

}

/* =========================================================
   15M STRUCTURE
========================================================= */

function structure15M(
    candles
) {

    const c =
        closedCandles(
            candles
        );

    if (
        c.length < 24
    ) {

        return 'NEUTRAL';

    }

    const recent =
        c.slice(-12);

    const previous =
        c.slice(-24, -12);

    const recentHigh =
        Math.max(
            ...recent.map(
                x =>
                    n(x[2])
            )
        );

    const previousHigh =
        Math.max(
            ...previous.map(
                x =>
                    n(x[2])
            )
        );

    const recentLow =
        Math.min(
            ...recent.map(
                x =>
                    n(x[3])
            )
        );

    const previousLow =
        Math.min(
            ...previous.map(
                x =>
                    n(x[3])
            )
        );

    const last =
        recent[
            recent.length - 1
        ];

    const first =
        recent[0];

    if (
        recentHigh >
            previousHigh &&
        recentLow >
            previousLow &&
        n(last[4]) >
            n(first[4])
    ) {

        return 'LONG';

    }

    if (
        recentHigh <
            previousHigh &&
        recentLow <
            previousLow &&
        n(last[4]) <
            n(first[4])
    ) {

        return 'SHORT';

    }

    return 'NEUTRAL';

}

/* =========================================================
   TRADE PLAN
========================================================= */

function buildTradePlan(
    direction,
    level,
    m15,
    oppositeLevels
) {

    const current =
        n(
            m15[
                m15.length - 1
            ][4]
        );

    const currentATR =
        atr(
            m15,
            14
        ) ||
        current *
        0.006;

    const zone =
        Math.max(
            currentATR *
            0.18,
            level.price *
            0.0008
        );

    const risk =
        Math.max(
            currentATR *
            CFG.ATR_STOP_MULTIPLIER,
            current *
            0.002
        );

    let entryLow;
    let entryHigh;
    let stop;

    if (
        direction ===
        'LONG'
    ) {

        entryLow =
            level.price -
            zone;

        entryHigh =
            level.price +
            zone;

        stop =
            level.price -
            risk;

    }

    else {

        entryLow =
            level.price -
            zone;

        entryHigh =
            level.price +
            zone;

        stop =
            level.price +
            risk;

    }

    const entry =
        (
            entryLow +
            entryHigh
        ) / 2;

    const realRisk =
        Math.abs(
            entry -
            stop
        );

    const targets = [];

    const ideal =
        [1.5, 2.25, 3.0];

    const validOpposite =
        oppositeLevels
            .filter(
                x =>
                    direction ===
                    'LONG'
                        ? x.price >
                          entry
                        : x.price <
                          entry
            )
            .sort(
                (
                    a,
                    b
                ) =>
                    Math.abs(
                        a.price -
                        entry
                    ) -
                    Math.abs(
                        b.price -
                        entry
                    )
            );

    for (
        const multiplier
        of ideal
    ) {

        let target =
            direction ===
            'LONG'
                ? entry +
                  realRisk *
                  multiplier
                : entry -
                  realRisk *
                  multiplier;

        const nearby =
            validOpposite.find(
                level2 => {

                    const rr =
                        Math.abs(
                            level2.price -
                            entry
                        ) /
                        realRisk;

                    return (
                        rr >=
                        1.5 &&
                        rr <=
                        multiplier +
                        0.8
                    );

                }
            );

        if (
            nearby
        ) {

            target =
                nearby.price;

        }

        targets.push(
            target
        );

    }

    const tp1 =
        targets[0];

    const tp2 =
        targets[1];

    const tp3 =
        targets[2];

    const rr =
        Math.abs(
            tp1 -
            entry
        ) /
        realRisk;

    if (
        rr <
        CFG.MIN_RR
    ) {

        return null;

    }

    if (
        direction ===
        'LONG' &&
        !(
            tp1 <
            tp2 &&
            tp2 <
            tp3
        )
    ) {

        return null;

    }

    if (
        direction ===
        'SHORT' &&
        !(
            tp1 >
            tp2 &&
            tp2 >
            tp3
        )
    ) {

        return null;

    }

    return {

        entryLow:
            fmtPrice(
                entryLow
            ),

        entryHigh:
            fmtPrice(
                entryHigh
            ),

        entry:
            fmtPrice(
                entry
            ),

        stop:
            fmtPrice(
                stop
            ),

        tp1:
            fmtPrice(
                tp1
            ),

        tp2:
            fmtPrice(
                tp2
            ),

        tp3:
            fmtPrice(
                tp3
            ),

        riskReward:
            `1:${rr.toFixed(2)}`,

        rr:

            Number(
                rr.toFixed(2)
            )

    };

}

/* =========================================================
   DEEP ANALYSIS
========================================================= */

async function analyzeDeep(
    coin
) {

    const symbol =
        coin.symbol;

    try {

        const [
            h4,
            h2,
            m15,
            m5
        ] =
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
                ),

                getCandles(
                    symbol,
                    '5m',
                    CFG.M5_LIMIT
                )

            ]);

        if (
            h4.length < 55 ||
            h2.length < 55 ||
            m15.length < 35 ||
            m5.length < 12
        ) {

            return {

                analyzed:
                    false,

                signals:
                    []

            };

        }

        STATE.stats.analyzed++;

        const price =
            n(
                coin.last
            );

        const levels4 =
            getLevels(
                h4
            );

        const levels2 =
            getLevels(
                h2
            );

        const allLevels =
            [

                ...levels4.map(
                    level => ({
                        ...level,
                        tf:
                            '4H'
                    })
                ),

                ...levels2.map(
                    level => ({
                        ...level,
                        tf:
                            '2H'
                    })
                )

            ];

        const nearby =
            allLevels
                .map(
                    level => ({

                        ...level,

                        distance:
                            percentDistance(
                                price,
                                level.price
                            )

                    })
                )
                .filter(
                    level =>
                        level.distance <=
                        CFG.LEVEL_TOLERANCE *
                        100
                )
                .sort(
                    (
                        a,
                        b
                    ) =>
                        a.distance -
                        b.distance
                );

        if (
            !nearby.length
        ) {

            return {

                analyzed:
                    true,

                signals:
                    []

            };

        }

        /*
           En yakın level.
        */

        const chosen =
            nearby[0];

        /*
           Aynı bölge 4H + 2H
        */

        const sameZone =
            allLevels.filter(
                level =>
                    level.type ===
                        chosen.type &&
                    percentDistance(
                        level.price,
                        chosen.price
                    ) <=
                        CFG.CLUSTER_TOLERANCE *
                        100
            );

        const has4 =
            sameZone.some(
                x =>
                    x.tf ===
                    '4H'
            );

        const has2 =
            sameZone.some(
                x =>
                    x.tf ===
                    '2H'
            );

        const confluence =
            has4 &&
            has2;

        /*
           SUPPORT → LONG
           RESISTANCE → SHORT

           Çünkü burada henüz breakout
           oluşmamışsa bu sadece takip seviyesi.
        */

        const side =
            chosen.type ===
            'resistance'
                ? 'LONG'
                : 'SHORT';

        /*
           Yeni breakout'ları state'e yaz.
        */

        const recentBreakouts =
            detectBreakouts(
                m15,
                allLevels
            );

        saveBreakouts(
            symbol,
            recentBreakouts
        );

        /*
           Bu coin'in pending breakoutları.
        */

        const pendings =
            [...STATE.pendingBreakouts.values()]
                .filter(
                    pending =>
                        pending.symbol ===
                        symbol
                );

        const output =
            [];

        for (
            const pending
            of pendings
        ) {

            const result =
                await analyzePending(
                    coin,
                    pending,
                    h4,
                    h2,
                    m15,
                    m5
                );

            if (
                result
            ) {

                output.push(
                    result
                );

            }

        }

        /*
           Eğer pending yoksa sadece
           watchlist bilgisi döndür.
        */

        return {

            analyzed:
                true,

            signals:
                output,

            watch: {

                symbol,

                score:
                    coin.radarScore,

                price,

                level:
                    fmtPrice(
                        chosen.price
                    ),

                levelType:
                    chosen.type,

                levelTf:
                    chosen.tf,

                confluence,

                has4,

                has2,

                side

            }

        };

    }
    catch (error) {

        console.log(
            `ANALİZ HATASI ${cleanSymbol(symbol)}:`,
            error.message
        );

        return {

            analyzed:
                false,

            signals:
                []

        };

    }

}

/* =========================================================
   ANALYZE PENDING
========================================================= */

async function analyzePending(
    coin,
    pending,
    h4,
    h2,
    m15,
    m5
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

        pending.status =
            'EXPIRED';

        return null;

    }

    const retest =
        detectRetest(
            m15,
            pending
        );

    if (
        retest.status ===
        'INVALIDATED' ||
        retest.status ===
        'EXPIRED'
    ) {

        pending.status =
            retest.status;

        return null;

    }

    if (
        retest.status !==
        'RETESTED'
    ) {

        pending.status =
            'WAITING_RETEST';

        return null;

    }

    pending.status =
        'RETESTED';

    pending.retestTime =
        n(
            retest.candle[0]
        );

    /*
       4H trend
    */

    const trend =
        trend4H(
            h4
        );

    /*
       Sert ters trendi reddet.
    */

    if (
        trend.direction !==
            'NEUTRAL' &&
        trend.direction !==
            pending.direction
    ) {

        pending.status =
            'REJECTED_TREND';

        return null;

    }

    /*
       5M
    */

    const confirm =
        confirm5M(
            m5,
            retest,
            pending.direction,
            pending.level.price
        );

    if (
        CFG.REQUIRE_5M &&
        !confirm.confirmed
    ) {

        pending.status =
            'WAITING_5M_CONFIRM';

        return null;

    }

    /*
       Güncel fiyat
    */

    const current =
        n(
            coin.last
        );

    if (
        !current
    ) {

        return null;

    }

    /*
       Entry fazla kaçmış mı?
    */

    if (
        percentDistance(
            current,
            pending.level.price
        ) >
        CFG.MAX_ENTRY_DISTANCE *
        100
    ) {

        pending.status =
            'MISSED_ENTRY';

        return null;

    }

    /*
       15M structure
    */

    const structure =
        structure15M(
            m15
        );

    /*
       RSI
    */

    const currentRSI =
        rsi(
            m15
        );

    /*
       Opposite levels
    */

    const levels4 =
        getLevels(
            h4
        );

    const levels2 =
        getLevels(
            h2
        );

    const oppositeLevels =
        pending.direction ===
            'LONG'

            ? [
                ...levels4.filter(
                    x =>
                        x.type ===
                        'resistance'
                ),

                ...levels2.filter(
                    x =>
                        x.type ===
                        'resistance'
                )
            ]

            : [
                ...levels4.filter(
                    x =>
                        x.type ===
                        'support'
                ),

                ...levels2.filter(
                    x =>
                        x.type ===
                        'support'
                )
            ];

    /*
       Trade plan
    */

    const trade =
        buildTradePlan(
            pending.direction,
            pending.level,
            m15,
            oppositeLevels
        );

    if (
        !trade
    ) {

        pending.status =
            'REJECTED_RR';

        return null;

    }

    /*
       Score
    */

    const sameZone =
        [
            ...levels4,
            ...levels2
        ].filter(
            level =>
                level.type ===
                    pending.level.type &&
                percentDistance(
                    level.price,
                    pending.level.price
                ) <=
                    CFG.CLUSTER_TOLERANCE *
                    100
        );

    const has4 =
        levels4.some(
            level =>
                level.type ===
                    pending.level.type &&
                percentDistance(
                    level.price,
                    pending.level.price
                ) <=
                    CFG.CLUSTER_TOLERANCE *
                    100
        );

    const has2 =
        levels2.some(
            level =>
                level.type ===
                    pending.level.type &&
                percentDistance(
                    level.price,
                    pending.level.price
                ) <=
                    CFG.CLUSTER_TOLERANCE *
                    100
        );

    const scored =
        calculateScore({

            direction:
                pending.direction,

            trend,

            confluence:
                has4 &&
                has2,

            touches:
                pending.level.touches,

            levelTf:
                has4 &&
                has2
                    ? '4H + 2H'
                    : has4
                        ? '4H'
                        : '2H',

            breakoutVolume:
                pending.breakoutVolumeRatio,

            breakoutBodyAtr:
                pending.breakoutBodyAtr,

            structure,

            rsi:
                currentRSI,

            confirm5M:
                confirm.confirmed

        });

    if (
        scored.score <
        CFG.MIN_SCORE
    ) {

        pending.status =
            'REJECTED_SCORE';

        return null;

    }

    /*
       Cooldown
    */

    const cooldownKey =
        `${pending.symbol}|` +
        `${fmtPrice(
            pending.level.price
        )}`;

    const cooldown =
        STATE.stoppedLevels.get(
            cooldownKey
        );

    if (
        cooldown &&
        Date.now() -
        cooldown <
        CFG.LEVEL_COOLDOWN_MS
    ) {

        return null;

    }

    /*
       SIGNAL
    */

    const timestamp =
        Date.now();

    const signal = {

        id:
            `${cleanSymbol(
                pending.symbol
            )}_${timestamp}`,

        coin:
            cleanSymbol(
                pending.symbol
            ),

        symbol:
            pending.symbol,

        ccxt_symbol:
            pending.symbol,

        taraf:
            pending.direction,

        direction:
            pending.direction,

        confidence:
            scored.score,

        score:
            scored.score,

        livePrice:
            fmtPrice(
                current
            ),

        level:
            fmtPrice(
                pending.level.price
            ),

        levelType:
            pending.direction ===
            'LONG'
                ? 'KIRILAN DİRENÇ'
                : 'KIRILAN DESTEK',

        touches:
            pending.level.touches,

        confluence:
            has4 &&
            has2,

        timeframeLevel:
            has4 &&
            has2
                ? '4H + 2H'
                : has4
                    ? '4H'
                    : '2H',

        trendBias:
            trend.direction,

        structure15m:
            structure,

        breakoutTime:
            pending.breakoutTime,

        retestTime:
            pending.retestTime,

        confirmation5mTime:
            confirm.candle
                ? n(
                    confirm.candle[0]
                )
                : 0,

        breakoutVolumeRatio:
            Number(
                pending.breakoutVolumeRatio.toFixed(
                    2
                )
            ),

        breakoutBodyAtr:
            Number(
                pending.breakoutBodyAtr.toFixed(
                    2
                )
            ),

        breakoutBodyRatio:
            Number(
                pending.breakoutBodyRatio.toFixed(
                    2
                )
            ),

        volume24h:
            coin.quoteVolume,

        rsi:
            Number(
                currentRSI.toFixed(
                    1
                )
            ),

        reason:
            scored.reasons.join(
                ' + '
            ),

        reasons:
            scored.reasons,

        entryLow:
            trade.entryLow,

        entryHigh:
            trade.entryHigh,

        giris:
            trade.entry,

        entry:
            trade.entry,

        stop:
            trade.stop,

        sl:
            trade.stop,

        tp1:
            trade.tp1,

        tp2:
            trade.tp2,

        tp3:
            trade.tp3,

        riskReward:
            trade.riskReward,

        rr:
            trade.rr,

        signalAt:
            timestamp,

        timestamp,

        ageSeconds:
            0,

        signalAge:
            0,

        status:
            'GİRİŞ BEKLENİYOR',

        entryReady:
            false,

        signalSource:
            '4H + 2H BREAKOUT + 15M RETEST + 5M ENTRY',

        signalQuality:
            scored.score,

        cooldownKey,

        tradingView:
            `https://www.tradingview.com/symbols/${cleanSymbol(
                pending.symbol
            )}/?exchange=BITGET`

    };

    pending.status =
        'SIGNAL_CREATED';

    STATE.pendingBreakouts.delete(
        pending.key
    );

    return signal;

}

/* =========================================================
   DEEP WATCH
========================================================= */

async function buildDeepWatch() {

    const results =
        await mapLimit(
            STATE.candidates,
            CFG.REQUEST_CONCURRENCY,
            async coin => {

                try {

                    const [
                        h4,
                        h2
                    ] =
                        await Promise.all([

                            getCandles(
                                coin.symbol,
                                '4h',
                                CFG.H4_LIMIT
                            ),

                            getCandles(
                                coin.symbol,
                                '2h',
                                CFG.H2_LIMIT
                            )

                        ]);

                    if (
                        h4.length < 55 ||
                        h2.length < 55
                    ) {

                        return null;

                    }

                    const price =
                        n(
                            coin.last
                        );

                    const levels4 =
                        getLevels(
                            h4
                        );

                    const levels2 =
                        getLevels(
                            h2
                        );

                    const levels =
                        [
                            ...levels4,
                            ...levels2
                        ];

                    const nearby =
                        levels
                            .map(
                                level => ({

                                    ...level,

                                    distance:
                                        percentDistance(
                                            price,
                                            level.price
                                        )

                                })
                            )
                            .filter(
                                level =>
                                    level.distance <=
                                    CFG.LEVEL_TOLERANCE *
                                    100
                            )
                            .sort(
                                (
                                    a,
                                    b
                                ) =>
                                    a.distance -
                                    b.distance
                            );

                    let score =
                        coin.radarScore;

                    if (
                        nearby.length
                    ) {

                        score +=
                            12;

                    }

                    const confluence =
                        nearby.length >=
                        2;

                    if (
                        confluence
                    ) {

                        score +=
                            8;

                    }

                    return {

                        ...coin,

                        deepScore:
                            Math.min(
                                100,
                                Math.round(
                                    score
                                )
                            ),

                        price,

                        nearby,

                        h4Trend:
                            trend4H(
                                h4
                            ).direction

                    };

                }
                catch (_) {

                    return null;

                }

            }
        );

    STATE.deepWatch =
        results
            .filter(Boolean)
            .sort(
                (
                    a,
                    b
                ) =>
                    b.deepScore -
                    a.deepScore
            )
            .slice(
                0,
                CFG.DEEP_LIMIT
            );

    STATE.stats.deepWatch =
        STATE.deepWatch.length;

}

/* =========================================================
   MARKET SENTIMENT
========================================================= */

function calculateMarket() {

    const rows =
        STATE.marketRows;

    if (
        !rows.length
    ) {

        return;

    }

    let green =
        0;

    let red =
        0;

    let totalMove =
        0;

    for (
        const row
        of rows
    ) {

        const change =
            n(
                row.percentage
            );

        totalMove +=
            change;

        if (
            change >
            0.20
        ) {

            green++;

        }

        else if (
            change <
            -0.20
        ) {

            red++;

        }

    }

    const counted =
        green +
        red;

    const breadth =
        counted
            ? (
                green /
                counted
            ) *
            100
            : 50;

    const average =
        rows.length
            ? totalMove /
              rows.length
            : 0;

    let direction =
        'NEUTRAL';

    let label =
        'NÖTR';

    if (
        breadth >=
            62 &&
        average >=
            0.35
    ) {

        direction =
            'LONG';

        label =
            'YÜKSELİŞ';

    }

    else if (
        breadth <=
            38 &&
        average <=
            -0.35
    ) {

        direction =
            'SHORT';

        label =
            'DÜŞÜŞ';

    }

    else if (
        breadth >=
            55
    ) {

        label =
            'POZİTİF KARARSIZ';

    }

    else if (
        breadth <=
            45
    ) {

        label =
            'NEGATİF KARARSIZ';

    }

    STATE.market = {

        label,

        direction,

        breadth:
            Number(
                breadth.toFixed(
                    0
                )
            ),

        average:
            Number(
                average.toFixed(
                    2
                )
            ),

        reason:
            `Yeşil ${green} • ` +
            `Kırmızı ${red} • ` +
            `Ortalama ${average.toFixed(
                2
            )}%`

    };

}

/* =========================================================
   ROTATION
========================================================= */

function getRotationBatch() {

    const list =
        STATE.deepWatch;

    if (
        !list.length
    ) {

        return [];

    }

    const size =
        Math.min(
            CFG.DEEP_LIMIT,
            list.length
        );

    const start =
        STATE.rotationIndex %
        list.length;

    const result = [];

    for (
        let i = 0;
        i < size;
        i++
    ) {

        result.push(
            list[
                (
                    start +
                    i
                ) %
                list.length
            ]
        );

    }

    STATE.rotationIndex =
        (
            start +
            size
        ) %
        list.length;

    return result;

}

/* =========================================================
   LIVE SIGNAL
========================================================= */

function updateSignal(
    signal,
    currentPrice
) {

    const isLong =
        signal.direction ===
        'LONG';

    const entryLow =
        n(
            signal.entryLow
        );

    const entryHigh =
        n(
            signal.entryHigh
        );

    const stop =
        n(
            signal.stop
        );

    const tp3 =
        n(
            signal.tp3
        );

    signal.livePrice =
        fmtPrice(
            currentPrice
        );

    signal.ageSeconds =
        Math.floor(
            (
                Date.now() -
                signal.signalAt
            ) /
            1000
        );

    signal.signalAge =
        signal.ageSeconds;

    if (
        isLong
    ) {

        if (
            currentPrice <=
            stop
        ) {

            signal.status =
                'STOP';

        }

        else if (
            currentPrice >=
            tp3
        ) {

            signal.status =
                'TP3';

        }

        else if (
            currentPrice >=
                entryLow &&
            currentPrice <=
                entryHigh
        ) {

            signal.status =
                'GİRİŞ ALANI';

            signal.entryReady =
                true;

        }

        else if (
            currentPrice >
            entryHigh *
            1.003
        ) {

            signal.status =
                'KAÇTI';

        }

        else {

            signal.status =
                'GİRİŞ BEKLENİYOR';

        }

    }

    else {

        if (
            currentPrice >=
            stop
        ) {

            signal.status =
                'STOP';

        }

        else if (
            currentPrice <=
            tp3
        ) {

            signal.status =
                'TP3';

        }

        else if (
            currentPrice >=
                entryLow &&
            currentPrice <=
                entryHigh
        ) {

            signal.status =
                'GİRİŞ ALANI';

            signal.entryReady =
                true;

        }

        else if (
            currentPrice <
            entryLow *
            0.997
        ) {

            signal.status =
                'KAÇTI';

        }

        else {

            signal.status =
                'GİRİŞ BEKLENİYOR';

        }

    }

}

/* =========================================================
   LIVE UPDATE
========================================================= */

async function updateLiveSignals() {

    if (
        STATE.signals.size === 0
    ) {

        return;

    }

    const tickers =
        await getTickers(
            true
        );

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
            tickers.get(
                signal.ccxt_symbol
            );

        if (
            ticker?.last
        ) {

            updateSignal(
                signal,
                ticker.last
            );

        }

        if (
            signal.status ===
            'STOP'
        ) {

            STATE.stoppedLevels.set(
                signal.cooldownKey,
                now
            );

        }

        const expired =
            now -
            signal.signalAt >
            CFG.SIGNAL_TTL_MS;

        const terminal =
            [
                'STOP',
                'TP3',
                'KAÇTI'
            ].includes(
                signal.status
            );

        if (
            expired ||
            terminal
        ) {

            STATE.signals.delete(
                id
            );

        }

    }

    STATE.stats.signals =
        STATE.signals.size;

}

/* =========================================================
   CLEANUP
========================================================= */

function cleanup() {

    const now =
        Date.now();

    const pendingMaxAge =
        CFG.RETEST_WINDOW_MINUTES *
        60 *
        1000;

    for (
        const [
            key,
            pending
        ]
        of STATE.pendingBreakouts
    ) {

        if (
            now -
            pending.breakoutTime >
            pendingMaxAge
        ) {

            STATE.pendingBreakouts.delete(
                key
            );

        }

    }

    for (
        const [
            key,
            timestamp
        ]
        of STATE.stoppedLevels
    ) {

        if (
            now -
            timestamp >
            CFG.LEVEL_COOLDOWN_MS
        ) {

            STATE.stoppedLevels.delete(
                key
            );

        }

    }

    STATE.stats.pending =
        STATE.pendingBreakouts.size;

    STATE.stats.signals =
        STATE.signals.size;

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

    STATE.lastError =
        null;

    const started =
        Date.now();

    try {

        console.log('');
        console.log(
            '================================================='
        );

        console.log(
            '🔎 SONNY AI TRADER V5.1 TARAMA'
        );

        console.log(
            '================================================='
        );

        /*
           500
        */

        const universe =
            await discoverUniverse();

        /*
           500 → 150
        */

        buildCandidates(
            universe
        );

        /*
           Market
        */

        calculateMarket();

        /*
           150 → 40
        */

        await buildDeepWatch();

        /*
           40 derin analiz
        */

        const batch =
            getRotationBatch();

        const results =
            await mapLimit(
                batch,
                CFG.REQUEST_CONCURRENCY,
                analyzeDeep
            );

        /*
           Watchlist
        */

        const watches =
            results
                .filter(Boolean)
                .map(
                    x =>
                        x.watch
                )
                .filter(Boolean);

        STATE.deepWatch =
            STATE.deepWatch
                .map(
                    item => {

                        const update =
                            watches.find(
                                watch =>
                                    watch.symbol ===
                                    cleanSymbol(
                                        item.symbol
                                    )
                            );

                        if (
                            !update
                        ) {

                            return item;

                        }

                        return {

                            ...item,

                            liveScore:
                                update.score,

                            nearbyLevel:
                                update.level,

                            nearbyLevelType:
                                update.levelType

                        };

                    }
                );

        /*
           Sinyaller
        */

        const found =
            results
                .flatMap(
                    result =>
                        result?.signals ||
                        []
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

            const duplicate =
                [...STATE.signals.values()]
                    .some(
                        existing =>
                            existing.symbol ===
                                signal.symbol &&
                            existing.direction ===
                                signal.direction
                    );

            if (
                duplicate
            ) {

                continue;

            }

            if (
                STATE.signals.size >=
                CFG.MAX_SIGNALS
            ) {

                break;

            }

            STATE.signals.set(
                signal.id,
                signal
            );

        }

        await updateLiveSignals();

        cleanup();

        STATE.lastScan =
            Date.now();

        STATE.stats.seconds =
            Number(
                (
                    (
                        Date.now() -
                        started
                    ) /
                    1000
                ).toFixed(
                    1
                )
            );

        STATE.stats.analyzed =
            STATE.stats.analyzed;

        console.log(
            `✅ RADAR | ` +
            `500→${universe.length} | ` +
            `150→${STATE.candidates.length} | ` +
            `40→${STATE.deepWatch.length} | ` +
            `Analiz=${STATE.stats.analyzed} | ` +
            `Pending=${STATE.pendingBreakouts.size} | ` +
            `Signal=${STATE.signals.size} | ` +
            `${STATE.stats.seconds}s`
        );

        broadcast();

    }
    catch (error) {

        STATE.lastError =
            error.message;

        console.error(
            '❌ RADAR ERROR:',
            error.message
        );

        broadcast();

    }
    finally {

        STATE.scanning =
            false;

    }

}

/* =========================================================
   PUBLIC SIGNAL
========================================================= */

function publicSignal(
    signal
) {

    const {
        cooldownKey,
        ...publicData
    } =
        signal;

    return {

        ...publicData,

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

/* =========================================================
   PUBLIC STATUS
========================================================= */

function getStatus() {

    return {

        success:
            true,

        engine:
            'Sonny AI Trader FINAL v5.1',

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

            scanned:
                STATE.stats.universe,

            candidates:
                STATE.stats.candidates,

            deepWatch:
                STATE.stats.deepWatch,

            analyzed:
                STATE.stats.analyzed,

            pendingBreakouts:
                STATE.pendingBreakouts.size,

            signals:
                STATE.signals.size

        },

        market:
            STATE.market,

        signals:
            [...STATE.signals.values()]
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
            [...STATE.pendingBreakouts.values()]
                .map(
                    pending => ({

                        symbol:
                            cleanSymbol(
                                pending.symbol
                            ),

                        direction:
                            pending.direction,

                        level:
                            fmtPrice(
                                pending.level.price
                            ),

                        breakoutTime:
                            pending.breakoutTime,

                        breakoutVolume:
                            pending.breakoutVolumeRatio,

                        status:
                            pending.status

                    })
                ),

        watchlist:
            STATE.deepWatch.map(
                coin => ({

                    symbol:
                        cleanSymbol(
                            coin.symbol
                        ),

                    score:
                        coin.deepScore,

                    radarScore:
                        coin.radarScore,

                    price:
                        coin.price,

                    change24h:
                        coin.percentage,

                    volume24h:
                        coin.quoteVolume,

                    level:
                        coin.nearbyLevel ||
                        null,

                    levelType:
                        coin.nearbyLevelType ||
                        null,

                    trend:
                        coin.h4Trend ||
                        'NEUTRAL'

                })
            )

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
                getStatus()

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

        ws.send(
            JSON.stringify({

                type:
                    'snapshot',

                data:
                    getStatus()

            })
        );

    }
);

/* =========================================================
   API STATUS
========================================================= */

app.get(
    '/api/status',
    (req, res) => {

        res.json(
            getStatus()
        );

    }
);

/* =========================================================
   API SIGNALS
========================================================= */

app.get(
    '/api/signals',
    (req, res) => {

        const status =
            getStatus();

        res.json({

            success:
                true,

            signals:
                status.signals,

            stats:
                status.stats,

            market:
                status.market

        });

    }
);

/* =========================================================
   API RADAR
========================================================= */

app.get(
    '/api/scalp-radar',
    (req, res) => {

        const status =
            getStatus();

        res.json({

            success:
                true,

            universe:
                status.stats.universe,

            candidates:
                status.stats.candidates,

            deepWatch:
                status.stats.deepWatch,

            analyzed:
                status.stats.analyzed,

            pending:
                status.pending,

            signals:
                status.signals,

            watchlist:
                status.watchlist,

            market:
                status.market

        });

    }
);

/* =========================================================
   API SCAN
========================================================= */

app.get(
    '/api/scan',
    (req, res) => {

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
   API HEALTH
========================================================= */

app.get(
    '/health',
    (req, res) => {

        res.json({

            ok:
                true,

            service:
                'Sonny AI Trader FINAL v5.1',

            uptime:
                process.uptime(),

            scanning:
                STATE.scanning,

            lastScan:
                STATE.lastScan,

            universe:
                STATE.stats.universe,

            candidates:
                STATE.stats.candidates,

            deepWatch:
                STATE.stats.deepWatch,

            pendingBreakouts:
                STATE.pendingBreakouts.size,

            signals:
                STATE.signals.size,

            error:
                STATE.lastError

        });

    }
);

/* =========================================================
   API CHART
========================================================= */

app.get(
    '/api/chart',
    async (req, res) => {

        try {

            const symbol =
                symbolForMarket(
                    req.query.symbol
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

            const timeframe =
                allowed.includes(
                    String(
                        req.query.timeframe ||
                        '15m'
                    )
                )
                    ? String(
                        req.query.timeframe
                    )
                    : '15m';

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

            const ticker =
                await exchange.fetchTicker(
                    symbol
                );

            const signal =
                [...STATE.signals.values()]
                    .filter(
                        item =>
                            item.ccxt_symbol ===
                            symbol
                    )
                    .sort(
                        (
                            a,
                            b
                        ) =>
                            b.timestamp -
                            a.timestamp
                    )[0] ||
                    null;

            res.json({

                success:
                    true,

                symbol:
                    cleanSymbol(
                        symbol
                    ),

                timeframe,

                price:
                    n(
                        ticker?.last ||
                        candles[
                            candles.length - 1
                        ][4]
                    ),

                candles:
                    candles.map(
                        candle => ({

                            time:
                                n(
                                    candle[0]
                                ),

                            open:
                                n(
                                    candle[1]
                                ),

                            high:
                                n(
                                    candle[2]
                                ),

                            low:
                                n(
                                    candle[3]
                                ),

                            close:
                                n(
                                    candle[4]
                                ),

                            volume:
                                n(
                                    candle[5]
                                )

                        })
                    ),

                signal:
                    signal
                        ? publicSignal(
                            signal
                        )
                        : null

            });

        }
        catch (error) {

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
   EMBEDDED FRONTEND
========================================================= */

const HTML =
String.raw`

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

button{

    font-family:
        inherit;

}

.app{

    width:100%;

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

    color:#d5dce5;

}

.kpi{

    display:grid;

    grid-template-columns:
        1fr 1fr;

    gap:7px;

    margin-top:10px;

}

.kpi div{

    background:#0a1017;

    padding:8px;

    border-radius:7px;

}

.kpi span{

    display:block;

    color:#6e7b8e;

    font-size:9px;

}

.kpi b{

    display:block;

    margin-top:3px;

    font-size:14px;

}

.signalTitle{

    font-size:14px;

    font-weight:900;

}

.sideSignal{

    margin-top:7px;

    font-size:11px;

    font-weight:900;

}

.detailGrid{

    display:grid;

    grid-template-columns:
        1fr 1fr;

    gap:6px;

    margin-top:12px;

}

.detail{

    background:#0a1017;

    padding:8px;

    border-radius:7px;

}

.detail span{

    display:block;

    color:#69778a;

    font-size:9px;

}

.detail b{

    display:block;

    margin-top:3px;

    font-size:12px;

}

.green{

    color:#2be19b;

}

.red{

    color:#ff5d6d;

}

.blue{

    color:#55a6ff;

}

.pending{

    border-left:
        3px solid #e2a83d;

}

.empty{

    color:#69778a;

    font-size:11px;

    line-height:1.5;

}

.status{

    display:flex;

    align-items:center;

    gap:7px;

    font-size:10px;

}

.dot{

    width:7px;

    height:7px;

    border-radius:50%;

    background:#ff5d6d;

}

.dot.online{

    background:#2be19b;

}

.scan{

    width:100%;

    border:0;

    background:#17233b;

    color:#fff;

    padding:9px;

    border-radius:8px;

    cursor:pointer;

    margin-top:8px;

}

.scan:hover{

    background:#213455;

}

.footer{

    margin-top:10px;

    color:#59677a;

    font-size:9px;

    line-height:1.5;

}

@media(
    max-width:900px
){

    .app{

        grid-template-columns:
            1fr;

    }

    .side{

        display:none;

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

    <aside class="side">

        <div class="brand">

            SONNY AI TRADER

            <small>
                FINAL v5.1 • BITGET FUTURES
            </small>

        </div>

        <div
            id="cards"
            class="cards"
        >

            <div class="empty">
                Sinyaller bekleniyor...
            </div>

        </div>

    </aside>

    <main class="main">

        <header class="head">

            <div>

                <div class="title">
                    Sonny AI Trader FINAL
                </div>

                <div class="sub">
                    500 → 150 → 40 |
                    4H + 2H →
                    15M Breakout →
                    Retest →
                    5M Entry
                </div>

            </div>

            <div class="stats">

                <span>
                    RADAR:
                    <b id="radar">0</b>
                </span>

                <span>
                    ADAY:
                    <b id="candidate">0</b>
                </span>

                <span>
                    WATCH:
                    <b id="watch">0</b>
                </span>

                <span>
                    PENDING:
                    <b id="pending">0</b>
                </span>

                <span>
                    SİNYAL:
                    <b id="signalCount">0</b>
                </span>

            </div>

        </header>

        <section class="work">

            <div class="chartwrap">

                <div class="toolbar">

                    <div
                        id="chartName"
                        class="chartname"
                    >
                        Grafik
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
                            data-tf="2h"
                        >
                            2H
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

            <aside class="right">

                <div class="box">

                    <div class="label">
                        SİSTEM
                    </div>

                    <div
                        class="status"
                        style="margin-top:8px"
                    >

                        <span
                            id="dot"
                            class="dot"
                        ></span>

                        <span
                            id="connection"
                        >
                            BAĞLANIYOR
                        </span>

                    </div>

                    <button
                        id="scanButton"
                        class="scan"
                    >
                        TARAMAYI YENİLE
                    </button>

                </div>

                <div class="box">

                    <div class="label">
                        GENEL PİYASA
                    </div>

                    <div
                        id="market"
                        class="market flat"
                    >
                        NÖTR
                    </div>

                    <div
                        id="marketReason"
                        class="empty"
                        style="margin-top:6px"
                    >
                        Veri bekleniyor...
                    </div>

                    <div class="kpi">

                        <div>

                            <span>
                                BREADTH
                            </span>

                            <b
                                id="breadth"
                            >
                                50%
                            </b>

                        </div>

                        <div>

                            <span>
                                ORT. HAREKET
                            </span>

                            <b
                                id="avg"
                            >
                                0%
                            </b>

                        </div>

                    </div>

                </div>

                <div
                    id="detailBox"
                    class="box"
                >

                    <div class="label">
                        SEÇİLİ SİNYAL
                    </div>

                    <div
                        id="detail"
                        style="margin-top:8px"
                    >

                        <div class="empty">
                            Sinyal seçilmedi.
                        </div>

                    </div>

                </div>

                <div class="box">

                    <div class="label">
                        PENDING BREAKOUT
                    </div>

                    <div
                        id="pendingList"
                        style="margin-top:8px"
                    >

                        <div class="empty">
                            Bekleyen breakout yok.
                        </div>

                    </div>

                </div>

                <div class="footer">

                    Auto Trade:
                    <b>KAPALI</b>
                    <br>

                    Sadece sinyal üretir.
                    Otomatik emir göndermez.

                </div>

            </aside>

        </section>

    </main>

</div>

<script>

let state = {

    signals: [],

    pending: [],

    watchlist: [],

    selected: null,

    timeframe: '15m'

};

let ws = null;

let reconnectTimer = null;


/* =========================================================
   ELEMENT
========================================================= */

function $(id){

    return document.getElementById(
        id
    );

}


/* =========================================================
   CONNECTION
========================================================= */

function setConnection(
    online
){

    $('connection').textContent =
        online
            ? 'CANLI'
            : 'BAĞLANTI YOK';

    $('dot').className =
        online
            ? 'dot online'
            : 'dot';

}


function connect(){

    try{

        const protocol =
            location.protocol ===
            'https:'
                ? 'wss://'
                : 'ws://';

        ws =
            new WebSocket(
                protocol +
                location.host
            );

        ws.onopen =
            function(){

                setConnection(
                    true
                );

            };

        ws.onclose =
            function(){

                setConnection(
                    false
                );

                if(
                    !reconnectTimer
                ){

                    reconnectTimer =
                        setTimeout(
                            function(){

                                reconnectTimer =
                                    null;

                                connect();

                            },
                            3000
                        );

                }

            };

        ws.onerror =
            function(){

                setConnection(
                    false
                );

            };

        ws.onmessage =
            function(event){

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
                catch(error){

                    console.error(
                        error
                    );

                }

            };

    }
    catch(error){

        setConnection(
            false
        );

    }

}


/* =========================================================
   REST FALLBACK
========================================================= */

async function loadStatus(){

    try{

        const response =
            await fetch(
                '/api/status',
                {
                    cache:
                        'no-store'
                }
            );

        const data =
            await response.json();

        render(
            data
        );

    }
    catch(error){

        console.error(
            error
        );

    }

}


/* =========================================================
   RENDER
========================================================= */

function render(
    data
){

    if(
        !data
    ){
        return;
    }

    state.signals =
        data.signals ||
        [];

    state.pending =
        data.pending ||
        [];

    state.watchlist =
        data.watchlist ||
        [];

    if(
        !state.selected &&
        state.signals.length
    ){

        state.selected =
            state.signals[0];

    }

    const stats =
        data.stats ||
        {};

    const market =
        data.market ||
        {};

    $('radar').textContent =
        stats.universe ||
        0;

    $('candidate').textContent =
        stats.candidates ||
        0;

    $('watch').textContent =
        stats.deepWatch ||
        0;

    $('pending').textContent =
        stats.pendingBreakouts ||
        state.pending.length;

    $('signalCount').textContent =
        stats.signals ||
        state.signals.length;

    $('market').textContent =
        market.label ||
        'NÖTR';

    $('marketReason').textContent =
        market.reason ||
        'Veri bekleniyor...';

    $('breadth').textContent =
        `${market.breadth || 50}%`;

    $('avg').textContent =
        `${market.average || 0}%`;

    const marketText =
        String(
            market.direction ||
            ''
        ).toUpperCase();

    $('market').className =
        'market ' +
        (
            marketText === 'LONG'
                ? 'up'
                : marketText === 'SHORT'
                    ? 'down'
                    : 'flat'
        );

    renderCards();

    renderDetail();

    renderPending();

}


/* =========================================================
   CARDS
========================================================= */

function renderCards(){

    const container =
        $('cards');

    if(
        !state.signals.length
    ){

        container.innerHTML =
            `
            <div class="empty">
                Aktif sinyal yok.
                <br><br>
                Radar çalışıyor...
            </div>
            `;

        return;

    }

    container.innerHTML =
        '';

    state.signals.forEach(
        function(signal){

            const card =
                document.createElement(
                    'div'
                );

            const active =
                state.selected &&
                state.selected.id ===
                signal.id;

            card.className =
                'card' +
                (
                    active
                        ? ' active'
                        : ''
                );

            const side =
                signal.direction ===
                'LONG'
                    ? 'LONG'
                    : 'SHORT';

            card.innerHTML =
                `

                <div class="top">

                    <div class="coin">
                        ${signal.coin}
                    </div>

                    <div
                        class="badge ${
                            side === 'LONG'
                                ? 'long'
                                : 'short'
                        }"
                    >
                        ${side}
                    </div>

                </div>

                <div class="price">
                    ${
                        signal.livePrice ??
                        '-'
                    }
                </div>

                <div class="meta">
                    SKOR ${
                        signal.score ??
                        '-'
                    }
                    •
                    R:R ${
                        signal.riskReward ||
                        (
                            signal.rr
                                ? `1:${signal.rr}`
                                : '-'
                        )
                    }
                </div>

                <div class="meta">
                    ${
                        signal.status ||
                        'GİRİŞ BEKLENİYOR'
                    }
                </div>

                ${
                    signal.entryReady
                        ? `
                        <div class="ready">
                            ● GİRİŞ ALANI
                        </div>
                        `
                        : ''
                }

                `;

            card.onclick =
                function(){

                    state.selected =
                        signal;

                    renderCards();

                    renderDetail();

                    loadChart();

                };

            container.appendChild(
                card
            );

        }
    );

}


/* =========================================================
   DETAIL
========================================================= */

function renderDetail(){

    const signal =
        state.selected;

    if(
        !signal
    ){

        $('detail').innerHTML =
            `
            <div class="empty">
                Sinyal seçilmedi.
            </div>
            `;

        return;

    }

    $('chartName').textContent =
        signal.coin;

    $('detail').innerHTML =
        `

        <div class="signalTitle">
            ${signal.coin}
        </div>

        <div
            class="sideSignal ${
                signal.direction ===
                'LONG'
                    ? 'green'
                    : 'red'
            }"
        >
            ${signal.direction}
            •
            ${signal.score}/100
        </div>

        <div class="detailGrid">

            <div class="detail">

                <span>
                    GİRİŞ
                </span>

                <b>
                    ${
                        signal.entry ||
                        '-'
                    }
                </b>

            </div>

            <div class="detail">

                <span>
                    STOP
                </span>

                <b class="red">
                    ${
                        signal.stop ||
                        signal.sl ||
                        '-'
                    }
                </b>

            </div>

            <div class="detail">

                <span>
                    TP1
                </span>

                <b class="green">
                    ${
                        signal.tp1 ||
                        '-'
                    }
                </b>

            </div>

            <div class="detail">

                <span>
                    TP2
                </span>

                <b class="green">
                    ${
                        signal.tp2 ||
                        '-'
                    }
                </b>

            </div>

            <div class="detail">

                <span>
                    TP3
                </span>

                <b class="green">
                    ${
                        signal.tp3 ||
                        '-'
                    }
                </b>

            </div>

            <div class="detail">

                <span>
                    R:R
                </span>

                <b class="blue">
                    ${
                        signal.riskReward ||
                        (
                            signal.rr
                                ? `1:${signal.rr}`
                                : '-'
                        )
                    }
                </b>

            </div>

        </div>

        <div
            class="empty"
            style="margin-top:10px"
        >

            ${
                signal.reason ||
                ''
            }

        </div>

        `;

}


/* =========================================================
   PENDING
========================================================= */

function renderPending(){

    const container =
        $('pendingList');

    if(
        !state.pending.length
    ){

        container.innerHTML =
            `
            <div class="empty">
                Bekleyen breakout yok.
            </div>
            `;

        return;

    }

    container.innerHTML =
        '';

    state.pending
        .slice(
            0,
            10
        )
        .forEach(
            function(item){

                const el =
                    document.createElement(
                        'div'
                    );

                el.className =
                    'box pending';

                el.style.margin =
                    '0 0 7px 0';

                el.innerHTML =
                    `

                    <div class="signalTitle">
                        ${
                            item.symbol
                        }
                    </div>

                    <div class="meta">

                        ${
                            item.direction
                        }

                        •

                        LEVEL ${
                            item.level
                        }

                    </div>

                    <div class="meta">

                        VOL ${
                            Number(
                                item.breakoutVolume ||
                                1
                            ).toFixed(
                                2
                            )
                        }x

                        •

                        ${
                            item.status
                        }

                    </div>

                    `;

                container.appendChild(
                    el
                );

            }
        );

}


/* =========================================================
   CHART
========================================================= */

async function loadChart(){

    const signal =
        state.selected;

    if(
        !signal
    ){
        return;
    }

    try{

        const response =
            await fetch(
                `/api/chart?symbol=${
                    encodeURIComponent(
                        signal.symbol ||
                        signal.coin
                    )
                }&timeframe=${
                    state.timeframe
                }`,
                {
                    cache:
                        'no-store'
                }
            );

        const data =
            await response.json();

        if(
            data.success
        ){

            drawChart(
                data.candles ||
                [],
                data.signal ||
                signal
            );

        }

    }
    catch(error){

        console.error(
            'Grafik:',
            error
        );

    }

}


/* =========================================================
   DRAW CHART
========================================================= */

function drawChart(
    candles,
    signal
){

    const canvas =
        $('chart');

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
            200,
            rect.height
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

    ctx.scale(
        dpr,
        dpr
    );

    ctx.clearRect(
        0,
        0,
        width,
        height
    );

    if(
        !candles.length
    ){
        return;
    }

    const values =
        candles.flatMap(
            candle => [

                Number(
                    candle.high
                ),

                Number(
                    candle.low
                )

            ]
        );

    [
        signal.entry,
        signal.stop ||
            signal.sl,
        signal.tp1,
        signal.tp2,
        signal.tp3
    ]
    .map(Number)
    .filter(
        Number.isFinite
    )
    .forEach(
        value =>
            values.push(
                value
            )
    );

    let min =
        Math.min(
            ...values
        );

    let max =
        Math.max(
            ...values
        );

    const padding =
        (
            max -
            min
        ) *
        0.08 ||
        1;

    min -=
        padding;

    max +=
        padding;

    function y(
        value
    ){

        return (
            height -
            (
                (
                    value -
                    min
                ) /
                (
                    max -
                    min
                )
            ) *
            height
        );

    }

    const step =
        width /
        Math.max(
            candles.length -
            1,
            1
        );

    /* PRICE */

    ctx.beginPath();

    candles.forEach(
        function(
            candle,
            index
        ){

            const close =
                Number(
                    candle.close
                );

            const x =
                index *
                step;

            const yy =
                y(
                    close
                );

            if(
                index === 0
            ){

                ctx.moveTo(
                    x,
                    yy
                );

            }
            else{

                ctx.lineTo(
                    x,
                    yy
                );

            }

        }
    );

    ctx.strokeStyle =
        '#7d899a';

    ctx.lineWidth =
        1.4;

    ctx.stroke();


    /* LEVEL */

    function level(
        value,
        label,
        stroke
    ){

        const price =
            Number(
                value
            );

        if(
            !Number.isFinite(
                price
            )
        ){
            return;
        }

        const yy =
            y(
                price
            );

        ctx.beginPath();

        ctx.setLineDash(
            [
                5,
                5
            ]
        );

        ctx.moveTo(
            0,
            yy
        );

        ctx.lineTo(
            width,
            yy
        );

        ctx.strokeStyle =
            stroke;

        ctx.lineWidth =
            1;

        ctx.stroke();

        ctx.setLineDash(
            []
        );

        ctx.font =
            '10px Arial';

        ctx.fillStyle =
            stroke;

        ctx.fillText(
            label +
            ' ' +
            price,
            7,
            Math.max(
                12,
                yy - 4
            )
        );

    }

    level(
        signal.entry,
        'ENTRY',
        '#55a6ff'
    );

    level(
        signal.stop ||
            signal.sl,
        'SL',
        '#ff5d6d'
    );

    level(
        signal.tp1,
        'TP1',
        '#2be19b'
    );

    level(
        signal.tp2,
        'TP2',
        '#2be19b'
    );

    level(
        signal.tp3,
        'TP3',
        '#2be19b'
    );

}


/* =========================================================
   TIMEFRAME
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
                            b =>
                                b.classList
                                    .remove(
                                        'active'
                                    )
                        );

                    button.classList.add(
                        'active'
                    );

                    state.timeframe =
                        button.dataset.tf;

                    loadChart();

                };

        }
    );


/* =========================================================
   MANUAL SCAN
========================================================= */

$('scanButton')
    .onclick =
        async function(){

            try{

                await fetch(
                    '/api/scan'
                );

            }
            catch(_){}

        };


/* =========================================================
   REFRESH
========================================================= */

setInterval(
    loadStatus,
    5000
);

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

window.addEventListener(
    'resize',
    function(){

        if(
            state.selected
        ){

            loadChart();

        }

    }
);


/* =========================================================
   START
========================================================= */

connect();

loadStatus();

</script>

</body>

</html>

`;

/* =========================================================
   ROOT
========================================================= */

app.get(
    '/',
    (req, res) => {

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
   SERVER
========================================================= */

server.listen(
    PORT,
    '0.0.0.0',
    async () => {

        console.log('');
        console.log(
            '================================================='
        );

        console.log(
            '🚀 SONNY AI TRADER FINAL v5.1'
        );

        console.log(
            '📡 Bitget USDT Futures'
        );

        console.log(
            '🛰️ 500 Coin Radar'
        );

        console.log(
            '🎯 150 Candidate'
        );

        console.log(
            '👁️ 40 Deep Watch'
        );

        console.log(
            '📊 4H Trend'
        );

        console.log(
            '📐 4H + 2H Support / Resistance'
        );

        console.log(
            '⚡ 15M Breakout'
        );

        console.log(
            '🔄 15M Retest'
        );

        console.log(
            '🔥 5M Entry Confirmation'
        );

        console.log(
            `🎯 Minimum Score: ${CFG.MIN_SCORE}`
        );

        console.log(
            `💰 Minimum Volume: $${CFG.MIN_VOLUME_USD.toLocaleString()}`
        );

        console.log(
            `⏱️ Scan: ${CFG.SCAN_MS / 1000}s`
        );

        console.log(
            `🌐 Port: ${PORT}`
        );

        console.log(
            '🤖 Auto Trade: KAPALI'
        );

        console.log(
            '================================================='
        );

        try{

            await exchange.loadMarkets(
                true
            );

            STATE.marketsLoadedAt =
                Date.now();

            await runScan();

        }
        catch(error){

            STATE.lastError =
                error.message;

            console.error(
                'İlk tarama hatası:',
                error.message
            );

        }

        setInterval(
            function(){

                runScan()
                    .catch(
                        error => {

                            STATE.lastError =
                                error.message;

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

                updateLiveSignals()
                    .then(
                        broadcast
                    )
                    .catch(
                        error =>
                            console.error(
                                'LIVE:',
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
);

/* =========================================================
   PROCESS SAFETY
========================================================= */

process.on(
    'unhandledRejection',
    error => {

        console.error(
            'UNHANDLED:',
            error
        );

        STATE.lastError =
            error?.message ||
            String(error);

    }
);

process.on(
    'uncaughtException',
    error => {

        console.error(
            'UNCAUGHT:',
            error
        );

        STATE.lastError =
            error?.message ||
            String(error);

    }
);
