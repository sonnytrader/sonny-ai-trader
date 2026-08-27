'use strict';

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
   SONNY AI TRADER
   BREAKOUT ENGINE v4 — FINAL
   =========================================================

   STRATEJİ:

   4H / 2H LEVEL
          ↓
   15M CLOSED BREAKOUT
          ↓
   BREAKOUT STATE
          ↓
   15M RETEST
          ↓
   RETEST HOLD
          ↓
   ENTRY ZONE
          ↓
   5M OPTIONAL CONFIRMATION
          ↓
   SCORE
          ↓
   REAL R:R
          ↓
   LONG / SHORT

   5M ZORUNLU DEĞİLDİR.
   ========================================================= */


const CFG = {

    /* ============================
       RADAR
       ============================ */

    MIN_VOLUME_USD: 2_000_000,

    MIN_24H_MOVE: 1.2,

    MAX_COINS: 160,

    MAX_SIGNALS: 15,

    SCAN_MS: 60_000,


    /* ============================
       LEVEL
       ============================ */

    PIVOT_LOOKBACK: 3,

    CLUSTER_TOLERANCE: 0.004,

    LEVEL_MIN_TOUCHES: 1,


    /* ============================
       BREAKOUT
       ============================ */

    MIN_BREAKOUT_VOLUME_RATIO: 1.10,

    MIN_BREAKOUT_BODY_RATIO: 0.30,

    BREAKOUT_MIN_DISTANCE: 0.0005,


    /* ============================
       RETEST
       ============================ */

    RETEST_WINDOW_MIN: 90,

    RETEST_TOLERANCE: 0.0045,

    RETEST_MAX_BARS: 6,


    /* ============================
       ENTRY
       ============================ */

    MAX_ENTRY_DISTANCE: 0.006,

    ENTRY_ZONE_BELOW:
        0.0030,

    ENTRY_ZONE_ABOVE:
        0.0030,


    /* ============================
       INVALIDATION
       ============================ */

    INVALIDATE_CLOSE_DISTANCE:
        0.0015,


    /* ============================
       TRADE PLAN
       ============================ */

    LEVEL_BUFFER_ATR: 0.35,

    MIN_RR_TP1: 1.50,

    TP2_RR: 2.20,

    TP3_RR: 3.00,


    /* ============================
       SCORE
       ============================ */

    MIN_SCORE: 68,

    FIVE_M_BONUS: 8,

    CONFLUENCE_BONUS: 8,


    /* ============================
       STATE
       ============================ */

    LEVEL_COOLDOWN_MS:
        4 * 60 * 60 * 1000,

    PENDING_TTL_MS:
        90 * 60 * 1000,

    SIGNAL_TTL_MS:
        12 * 60 * 60 * 1000,


    /* ============================
       REQUESTS
       ============================ */

    REQUEST_CONCURRENCY: 6,

    REQUEST_DELAY: 100,

    RETRY_COUNT: 2,

    RETRY_DELAY: 500,


    /* ============================
       CHART
       ============================ */

    MAX_CHART_CANDLES: 180

};


/* =========================================================
   STATE
   ========================================================= */

const STATE = {

    pendingBreakouts: new Map(),

    activeSignals: new Map(),

    cooldowns: new Map()

};


let exchange = null;

let marketRows = [];

let signals = [];

let scanRunning = false;

let lastScan = 0;

let lastError = null;

let marketSentiment = {

    label: 'YATAY / KARIŞIK',

    direction: 'NEUTRAL',

    breadthPct: 50,

    averageMove: 0,

    btcMove: null,

    ethMove: null,

    reason: 'Piyasa verisi bekleniyor.'

};

let stats = {

    universe: 0,

    analyzed: 0,

    pending: 0,

    signals: 0,

    seconds: 0

};


/* =========================================================
   BASIC HELPERS
   ========================================================= */

function sleep(ms) {

    return new Promise(resolve =>
        setTimeout(resolve, ms)
    );

}


function num(value, fallback = 0) {

    const x = Number(value);

    return Number.isFinite(x)
        ? x
        : fallback;

}


function cleanSymbol(symbol) {

    return String(symbol || '')
        .replace('/USDT:USDT', '')
        .replace('/USDT', '')
        .replace(':USDT', '')
        .replace('USDT', '')
        .replace(/[^A-Z0-9]/gi, '')
        .toUpperCase() + 'USDT';

}


function normalizeSymbol(symbol) {

    if (!symbol) {
        return null;
    }

    const wanted =
        cleanSymbol(symbol);

    if (!exchange?.markets) {
        return null;
    }

    return Object.keys(exchange.markets)
        .find(key =>
            cleanSymbol(key) === wanted
        ) || null;

}


function formatPrice(value) {

    const x = Number(value);

    if (!Number.isFinite(x)) {
        return null;
    }

    if (x >= 1000) {
        return Number(x.toFixed(2));
    }

    if (x >= 100) {
        return Number(x.toFixed(3));
    }

    if (x >= 1) {
        return Number(x.toFixed(5));
    }

    if (x >= 0.01) {
        return Number(x.toFixed(6));
    }

    return Number(x.toFixed(10));

}


function directionForLevel(type) {

    return type === 'support'
        ? 'LONG'
        : 'SHORT';

}


/* =========================================================
   SAFE REQUEST
   ========================================================= */

async function safeRequest(fn) {

    let lastErrorLocal = null;

    for (
        let attempt = 0;
        attempt <= CFG.RETRY_COUNT;
        attempt++
    ) {

        try {

            return await fn();

        } catch (error) {

            lastErrorLocal = error;

            if (
                attempt <
                CFG.RETRY_COUNT
            ) {

                await sleep(
                    CFG.RETRY_DELAY *
                    (attempt + 1)
                );

            }

        }

    }

    throw lastErrorLocal;

}


/* =========================================================
   ATR
   ========================================================= */

function calculateATR(
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
            num(candles[i][2]);

        const low =
            num(candles[i][3]);

        const previousClose =
            num(candles[i - 1][4]);

        trs.push(
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

    const values =
        trs.slice(-period);

    const result =
        values.reduce(
            (sum, value) =>
                sum + value,
            0
        ) /
        values.length;

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

function calculateRSI(
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
            num(candles[i][4]) -
            num(candles[i - 1][4]);

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

    return 100 -
        (
            100 /
            (1 + rs)
        );

}


/* =========================================================
   EMA
   ========================================================= */

function calculateEMA(
    candles,
    period
) {

    if (
        !candles ||
        candles.length <
            period
    ) {

        return null;

    }

    const closes =
        candles.map(
            candle =>
                num(candle[4])
        );

    const multiplier =
        2 /
        (period + 1);

    let ema =
        closes
            .slice(0, period)
            .reduce(
                (sum, value) =>
                    sum + value,
                0
            ) /
        period;

    for (
        let i = period;
        i < closes.length;
        i++
    ) {

        ema =
            (
                closes[i] -
                ema
            ) *
            multiplier +
            ema;

    }

    return ema;

}


/* =========================================================
   TREND
   ========================================================= */

function getTrendBias(
    candles
) {

    const ema21 =
        calculateEMA(
            candles,
            21
        );

    const ema50 =
        calculateEMA(
            candles,
            50
        );

    if (
        ema21 === null ||
        ema50 === null
    ) {

        return 'NEUTRAL';

    }

    const difference =
        (
            ema21 -
            ema50
        ) /
        ema50;


    if (
        difference >=
        0.003
    ) {

        return 'LONG';

    }


    if (
        difference <=
        -0.003
    ) {

        return 'SHORT';

    }

    return 'NEUTRAL';

}


/* =========================================================
   PIVOTS
   ========================================================= */

function findPivots(
    candles,
    lookback = 3
) {

    const result = [];

    if (
        !candles ||
        candles.length <
            lookback * 2 + 3
    ) {

        return result;

    }

    for (
        let i = lookback;
        i <
            candles.length -
            lookback;
        i++
    ) {

        const high =
            num(candles[i][2]);

        const low =
            num(candles[i][3]);

        let swingHigh = true;

        let swingLow = true;


        for (
            let j = 1;
            j <= lookback;
            j++
        ) {

            if (
                high <=
                    num(
                        candles[i - j][2]
                    ) ||
                high <=
                    num(
                        candles[i + j][2]
                    )
            ) {

                swingHigh = false;

            }

            if (
                low >=
                    num(
                        candles[i - j][3]
                    ) ||
                low >=
                    num(
                        candles[i + j][3]
                    )
            ) {

                swingLow = false;

            }

        }


        if (swingHigh) {

            result.push({

                price: high,

                type: 'resistance',

                time:
                    num(candles[i][0])

            });

        }


        if (swingLow) {

            result.push({

                price: low,

                type: 'support',

                time:
                    num(candles[i][0])

            });

        }

    }

    return result;

}


/* =========================================================
   CLUSTER LEVELS
   ========================================================= */

function clusterLevels(
    levels,
    timeframe
) {

    const groups = [];

    const sorted =
        [...levels]
            .sort(
                (a, b) =>
                    a.price -
                    b.price
            );


    for (
        const level of sorted
    ) {

        const existing =
            groups.find(group =>

                group.type ===
                    level.type &&

                Math.abs(
                    level.price -
                    group.price
                ) /
                    Math.max(
                        group.price,
                        1e-12
                    ) <=
                    CFG.CLUSTER_TOLERANCE

            );


        if (existing) {

            existing.items.push(
                level
            );

            existing.price =
                existing.items.reduce(
                    (sum, item) =>
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
                    [level],

                timeframe

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

            timeframe:
                group.timeframe,

            time:
                group.items[
                    group.items.length - 1
                ]?.time || 0

        })
    );

}


/* =========================================================
   VOLUME RATIO
   ========================================================= */

function volumeRatioAt(
    candles,
    index,
    period = 20
) {

    if (
        index < period
    ) {

        return 0;

    }

    const current =
        num(
            candles[index][5]
        );

    const average =
        candles
            .slice(
                index - period,
                index
            )
            .reduce(
                (sum, candle) =>
                    sum +
                    num(candle[5]),
                0
            ) /
        period;


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
   CLOSED CANDLE INDEX
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
   BREAKOUT
   ========================================================= */

function detectBreakout(
    previous,
    current,
    level
) {

    const previousClose =
        num(previous[4]);

    const open =
        num(current[1]);

    const close =
        num(current[4]);

    const high =
        num(current[2]);

    const low =
        num(current[3]);


    const body =
        Math.abs(
            close -
            open
        );

    const range =
        Math.max(
            high -
            low,
            1e-12
        );

    const bodyRatio =
        body /
        range;


    if (
        bodyRatio <
        CFG.MIN_BREAKOUT_BODY_RATIO
    ) {

        return null;

    }


    /*
     * RESISTANCE BREAK
     * => LONG
     */

    if (

        previousClose <=
            level.price &&

        close >
            level.price &&

        (
            close -
            level.price
        ) /
            level.price >=
            CFG.BREAKOUT_MIN_DISTANCE

    ) {

        return 'LONG';

    }


    /*
     * SUPPORT BREAK
     * => SHORT
     */

    if (

        previousClose >=
            level.price &&

        close <
            level.price &&

        (
            level.price -
            close
        ) /
            level.price >=
            CFG.BREAKOUT_MIN_DISTANCE

    ) {

        return 'SHORT';

    }


    return null;

}


/* =========================================================
   ENTRY ZONE
   ========================================================= */

function getEntryZone(
    level,
    side
) {

    /*
     * LONG:
     * seviye hafif üstünde.
     *
     * SHORT:
     * seviye hafif altında.
     */

    if (
        side === 'LONG'
    ) {

        return {

            low:
                level *
                (
                    1 +
                    0.0002
                ),

            high:
                level *
                (
                    1 +
                    CFG.ENTRY_ZONE_ABOVE
                )

        };

    }


    return {

        low:
            level *
            (
                1 -
                CFG.ENTRY_ZONE_BELOW
            ),

        high:
            level *
            (
                1 -
                0.0002
            )

    };

}


/* =========================================================
   RETEST
   ========================================================= */

function retestFound(
    candles,
    pending
) {

    const start =
        pending.breakoutIndex +
        1;

    const end =
        Math.min(
            latestClosedIndex(
                candles
            ),
            start +
            CFG.RETEST_MAX_BARS
        );


    if (
        end <
        start
    ) {

        return null;

    }


    for (
        let i = start;
        i <= end;
        i++
    ) {

        const candle =
            candles[i];

        const high =
            num(candle[2]);

        const low =
            num(candle[3]);

        const close =
            num(candle[4]);


        const tolerance =
            pending.level *
            CFG.RETEST_TOLERANCE;


        const touched =

            low <=
                pending.level +
                tolerance &&

            high >=
                pending.level -
                tolerance;


        if (!touched) {

            continue;

        }


        let held = false;


        if (
            pending.side ===
            'LONG'
        ) {

            held =
                close >=
                pending.level *
                (
                    1 -
                    CFG.RETEST_TOLERANCE
                );

        } else {

            held =
                close <=
                pending.level *
                (
                    1 +
                    CFG.RETEST_TOLERANCE
                );

        }


        if (!held) {

            continue;

        }


        /*
         * Retest bulundu.
         */

        return {

            index: i,

            time:
                num(candle[0]),

            close,

            high,

            low

        };

    }


    return null;

}


/* =========================================================
   INVALIDATION
   ========================================================= */

function isInvalidated(
    close,
    level,
    side
) {

    if (
        side === 'LONG'
    ) {

        return (

            close <
            level *
            (
                1 -
                CFG.INVALIDATE_CLOSE_DISTANCE
            )

        );

    }


    return (

        close >
        level *
        (
            1 +
            CFG.INVALIDATE_CLOSE_DISTANCE
        )

    );

}


/* =========================================================
   OPPOSITE LEVEL
   ========================================================= */

function findOppositeLevel(
    levels,
    side,
    price
) {

    const candidates =
        levels.filter(level => {

            if (
                side ===
                'LONG'
            ) {

                return (

                    level.type ===
                        'resistance' &&

                    level.price >
                        price

                );

            }


            return (

                level.type ===
                    'support' &&

                level.price <
                    price

            );

        });


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


/* =========================================================
   TRADE PLAN
   ========================================================= */

function createTradePlan(
    side,
    entry,
    level,
    atrValue,
    oppositeLevel
) {

    const minimumBuffer =
        entry *
        0.0025;


    const atrBuffer =
        (
            atrValue ||
            entry *
            0.006
        ) *
        CFG.LEVEL_BUFFER_ATR;


    const buffer =
        Math.max(
            minimumBuffer,
            atrBuffer
        );


    let stop;


    if (
        side ===
        'LONG'
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
                entry -
                stop
            ),

            entry *
            0.002

        );


    let tp1;
    let tp2;
    let tp3;


    if (
        side ===
        'LONG'
    ) {

        tp1 =
            entry +
            risk *
            CFG.MIN_RR_TP1;

        tp2 =
            entry +
            risk *
            CFG.TP2_RR;

        tp3 =
            entry +
            risk *
            CFG.TP3_RR;


        if (
            oppositeLevel
        ) {

            /*
             * Karşı seviye varsa
             * hedefler onun ötesine taşmaz.
             */

            tp1 =
                Math.min(
                    tp1,
                    oppositeLevel
                );

            tp2 =
                Math.min(
                    tp2,
                    oppositeLevel
                );

            tp3 =
                Math.min(
                    tp3,
                    oppositeLevel
                );

        }

    } else {

        tp1 =
            entry -
            risk *
            CFG.MIN_RR_TP1;

        tp2 =
            entry -
            risk *
            CFG.TP2_RR;

        tp3 =
            entry -
            risk *
            CFG.TP3_RR;


        if (
            oppositeLevel
        ) {

            tp1 =
                Math.max(
                    tp1,
                    oppositeLevel
                );

            tp2 =
                Math.max(
                    tp2,
                    oppositeLevel
                );

            tp3 =
                Math.max(
                    tp3,
                    oppositeLevel
                );

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
        CFG.MIN_RR_TP1
    ) {

        return null;

    }


    if (
        side ===
        'LONG'
    ) {

        if (
            !(
                stop <
                    entry &&

                entry <
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
                    entry &&

                entry >
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
   5M OPTIONAL CONFIRMATION
   ========================================================= */

function check5mConfirmation(
    candles,
    side
) {

    if (
        !candles ||
        candles.length <
            12
    ) {

        return false;

    }


    const i =
        latestClosedIndex(
            candles
        );


    const current =
        candles[i];

    const previous =
        candles[i - 1];


    const close =
        num(current[4]);

    const open =
        num(current[1]);

    const previousClose =
        num(previous[4]);


    if (
        side ===
        'LONG'
    ) {

        return (

            close >
                open &&

            close >
                previousClose

        );

    }


    return (

        close <
            open &&

        close <
            previousClose

    );

}


/* =========================================================
   15M STRUCTURE
   ========================================================= */

function get15mStructure(
    candles
) {

    if (
        !candles ||
        candles.length <
            10
    ) {

        return 'NEUTRAL';

    }


    const c =
        candles.slice(-8);


    const highs =
        c.map(
            x => num(x[2])
        );

    const lows =
        c.map(
            x => num(x[3])
        );

    const closes =
        c.map(
            x => num(x[4])
        );


    const bullish =

        highs[7] >
            highs[4] &&

        lows[7] >
            lows[4] &&

        closes[7] >
            closes[4];


    const bearish =

        highs[7] <
            highs[4] &&

        lows[7] <
            lows[4] &&

        closes[7] <
            closes[4];


    if (bullish) {
        return 'LONG';
    }

    if (bearish) {
        return 'SHORT';
    }

    return 'NEUTRAL';

}


/* =========================================================
   STATE KEY
   ========================================================= */

function levelKey(
    coin,
    levelType,
    level
) {

    return (

        coin +
        '|' +
        levelType +
        '|' +
        Number(level)
            .toFixed(8)

    );

}


/* =========================================================
   STATE CLEANUP
   ========================================================= */

function cleanupState() {

    const now =
        Date.now();


    /*
     * Pending breakout TTL
     */

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
            CFG.PENDING_TTL_MS

        ) {

            STATE.pendingBreakouts
                .delete(key);

        }

    }


    /*
     * Cooldown TTL
     */

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


    /*
     * Active signal TTL
     */

    for (
        const [
            coin,
            signal
        ] of
            STATE.activeSignals
    ) {

        if (

            now -
            signal.signalAt >
            CFG.SIGNAL_TTL_MS

        ) {

            STATE.activeSignals
                .delete(coin);

        }

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

    return safeRequest(
        () =>
            exchange.fetchOHLCV(
                symbol,
                timeframe,
                undefined,
                limit
            )
    );

}


/* =========================================================
   DISCOVER RADAR

   ÖNEMLİ:
   Tüm perpetual ticker'lar alınır.

   Market sentiment bütün evrenden hesaplanır.

   Radar ise ayrıca hacim + hareket
   filtresinden geçirilir.
   ========================================================= */

async function discoverRadar() {

    await safeRequest(
        () =>
            exchange.loadMarkets(
                true
            )
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

                market.settle ===
                    'USDT' &&

                (
                    market.swap ||
                    market.future
                )

        );


    const allRows = [];

    const radarRows = [];


    for (
        let i = 0;
        i < markets.length;
        i += 40
    ) {

        const batch =
            markets.slice(
                i,
                i + 40
            );


        const symbols =
            batch.map(
                market =>
                    market.symbol
            );


        try {

            const tickers =
                await safeRequest(
                    () =>
                        exchange.fetchTickers(
                            symbols
                        )
                );


            for (
                const ticker of
                    Object.values(
                        tickers || {}
                    )
            ) {

                if (
                    !ticker ||
                    !ticker.symbol
                ) {

                    continue;

                }


                const row = {

                    symbol:
                        ticker.symbol,

                    last:
                        num(
                            ticker.last
                        ),

                    quoteVolume:
                        num(
                            ticker.quoteVolume
                        ),

                    percentage:
                        num(
                            ticker.percentage
                        )

                };


                if (
                    row.last <= 0
                ) {

                    continue;

                }


                allRows.push(
                    row
                );


                if (

                    row.quoteVolume >=
                        CFG.MIN_VOLUME_USD &&

                    Math.abs(
                        row.percentage
                    ) >=
                        CFG.MIN_24H_MOVE

                ) {

                    radarRows.push(
                        row
                    );

                }

            }

        } catch (error) {

            console.log(
                'Ticker batch atlandı:',
                error.message
            );

        }


        await sleep(
            CFG.REQUEST_DELAY
        );

    }


    radarRows.sort(
        (a, b) =>
            b.quoteVolume -
            a.quoteVolume
    );


    return {

        allRows,

        radarRows:
            radarRows.slice(
                0,
                CFG.MAX_COINS
            )

    };

}


/* =========================================================
   MARKET SENTIMENT
   ========================================================= */

function calculateMarketSentiment(
    rows
) {

    if (
        !rows.length
    ) {

        return {

            label:
                'VERİ YOK',

            direction:
                'NEUTRAL',

            breadthPct:
                50,

            averageMove:
                0,

            btcMove:
                null,

            ethMove:
                null,

            reason:
                'Piyasa verisi alınamadı.'

        };

    }


    const valid =
        rows.filter(
            row =>
                Number.isFinite(
                    row.percentage
                )
        );


    const green =
        valid.filter(
            row =>
                row.percentage >
                0
        ).length;


    const breadthPct =
        valid.length
            ? (
                green /
                valid.length
            ) *
            100
            : 50;


    const averageMove =
        valid.length
            ? valid.reduce(
                (
                    sum,
                    row
                ) =>
                    sum +
                    row.percentage,
                0
            ) /
            valid.length
            : 0;


    const btc =
        valid.find(
            row =>
                cleanSymbol(
                    row.symbol
                ) ===
                'BTCUSDT'
        );


    const eth =
        valid.find(
            row =>
                cleanSymbol(
                    row.symbol
                ) ===
                'ETHUSDT'
        );


    const btcMove =
        btc
            ? btc.percentage
            : null;


    const ethMove =
        eth
            ? eth.percentage
            : null;


    const majors =
        [btcMove, ethMove]
            .filter(
                value =>
                    value !== null
            );


    const majorAverage =
        majors.length
            ? majors.reduce(
                (
                    sum,
                    value
                ) =>
                    sum +
                    value,
                0
            ) /
            majors.length
            : averageMove;


    /*
     * GÜÇLÜ GENİŞ TABANLI LONG
     */

    if (

        breadthPct >=
            62 &&

        averageMove >=
            0.45 &&

        majorAverage >=
            0.25

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

            averageMove:
                Number(
                    averageMove.toFixed(2)
                ),

            btcMove,

            ethMove,

            reason:

                `%${breadthPct.toFixed(0)} ` +
                'coin pozitif · ' +

                `ortalama ${averageMove.toFixed(2)}% · ` +

                `BTC/ETH ${majorAverage.toFixed(2)}%`

        };

    }


    /*
     * GÜÇLÜ GENİŞ TABANLI SHORT
     */

    if (

        breadthPct <=
            38 &&

        averageMove <=
            -0.45 &&

        majorAverage <=
            -0.25

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

            averageMove:
                Number(
                    averageMove.toFixed(2)
                ),

            btcMove,

            ethMove,

            reason:

                `%${(
                    100 -
                    breadthPct
                ).toFixed(0)} ` +
                'coin negatif · ' +

                `ortalama ${averageMove.toFixed(2)}% · ` +

                `BTC/ETH ${majorAverage.toFixed(2)}%`

        };

    }


    /*
     * MAJÖRLER GÜÇLÜ LONG
     */

    if (

        majorAverage >=
            0.8 &&

        breadthPct >=
            55

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

            averageMove:
                Number(
                    averageMove.toFixed(2)
                ),

            btcMove,

            ethMove,

            reason:

                `BTC/ETH ${majorAverage.toFixed(2)}% · ` +

                `breadth %${breadthPct.toFixed(0)}`

        };

    }


    /*
     * MAJÖRLER GÜÇLÜ SHORT
     */

    if (

        majorAverage <=
            -0.8 &&

        breadthPct <=
            45

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

            averageMove:
                Number(
                    averageMove.toFixed(2)
                ),

            btcMove,

            ethMove,

            reason:

                `BTC/ETH ${majorAverage.toFixed(2)}% · ` +

                `breadth %${breadthPct.toFixed(0)}`

        };

    }


    /*
     * NEUTRAL
     *
     * Burada artık sadece
     * "hacim ağırlığı" nedeniyle
     * yatay denmiyor.
     */

    return {

        label:
            'YATAY / KARIŞIK',

        direction:
            'NEUTRAL',

        breadthPct:
            Number(
                breadthPct.toFixed(1)
            ),

        averageMove:
            Number(
                averageMove.toFixed(2)
            ),

        btcMove,

        ethMove,

        reason:

            `Breadth %${breadthPct.toFixed(0)} · ` +

            `ortalama ${averageMove.toFixed(2)}% · ` +

            `BTC/ETH ${majorAverage.toFixed(2)}%`

    };

}


/* =========================================================
   ANALYZE SYMBOL
   ========================================================= */

async function analyzeSymbol(
    row
) {

    const symbol =
        row.symbol;

    const coin =
        cleanSymbol(
            symbol
        );


    try {

        /*
         * İlk aşamada 5M çekmiyoruz.
         *
         * Bu çok önemli.
         *
         * 160 coin için gereksiz
         * 5M API yükü oluşmuyor.
         */

        const [
            h4,
            h2,
            m15
        ] = await Promise.all([

            fetchOHLCV(
                symbol,
                '4h',
                110
            ),

            fetchOHLCV(
                symbol,
                '2h',
                110
            ),

            fetchOHLCV(
                symbol,
                '15m',
                150
            )

        ]);


        if (

            h4.length < 55 ||
            h2.length < 55 ||
            m15.length < 35

        ) {

            return null;

        }


        const lastIndex =
            latestClosedIndex(
                m15
            );


        const lastC =
            m15[lastIndex];

        const previousC =
            m15[lastIndex - 1];


        const live =
            num(
                row.last
            );


        if (
            live <= 0
        ) {

            return null;

        }


        /*
         * LEVELS
         */

        const levels4 =
            clusterLevels(
                findPivots(
                    h4,
                    CFG.PIVOT_LOOKBACK
                ),
                '4H'
            );


        const levels2 =
            clusterLevels(
                findPivots(
                    h2,
                    CFG.PIVOT_LOOKBACK
                ),
                '2H'
            );


        const levels =
            [
                ...levels4,
                ...levels2
            ];


        if (
            !levels.length
        ) {

            return null;

        }


        /*
         * ACTIVE SIGNAL
         */

        const active =
            STATE.activeSignals
                .get(coin);


        if (active) {

            active.livePrice =
                formatPrice(
                    live
                );


            active.ageSeconds =
                Math.floor(
                    (
                        Date.now() -
                        active.signalAt
                    ) /
                    1000
                );


            const close =
                num(lastC[4]);


            const invalidated =
                isInvalidated(

                    close,

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


            /*
             * Fiyat giriş bölgesinden çıktıysa
             * artık "GİRİŞ AKTİF" demiyoruz.
             */

            const entryStillValid =
                isInsideEntryZone(
                    live,
                    active.entryLowRaw,
                    active.entryHighRaw
                );


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


            if (
                !entryStillValid
            ) {

                active.status =
                    'WAIT';

                active.statusText =
                    'GİRİŞ KAÇTI';

                active.entryAvailable =
                    false;

            } else {

                active.status =
                    'ACTIVE';

                active.statusText =
                    'GİRİŞ AKTİF';

                active.entryAvailable =
                    true;

            }


            return active;

        }


        /*
         * BREAKOUT DETECTION
         */

        for (
            const level of
                levels
        ) {

            const side =
                detectBreakout(
                    previousC,
                    lastC,
                    level
                );


            if (!side) {

                continue;

            }


            const key =
                levelKey(
                    coin,
                    level.type,
                    level.price
                );


            if (
                STATE.cooldowns
                    .has(key)
            ) {

                continue;

            }


            /*
             * Aynı breakout'u
             * her taramada yeniden yazma.
             */

            if (
                STATE.pendingBreakouts
                    .has(key)
            ) {

                continue;

            }


            const volumeRatio =
                volumeRatioAt(
                    m15,
                    lastIndex
                );


            /*
             * Breakout hacmi,
             * breakout mumundan alınır.
             */

            if (
                volumeRatio <
                CFG.MIN_BREAKOUT_VOLUME_RATIO
            ) {

                continue;

            }


            const body =
                Math.abs(
                    num(lastC[4]) -
                    num(lastC[1])
                );


            const range =
                Math.max(
                    num(lastC[2]) -
                    num(lastC[3]),
                    1e-12
                );


            const bodyRatio =
                body /
                range;


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
                            num(lastC[0]),

                        breakoutIndex:
                            lastIndex,

                        createdAt:
                            Date.now(),

                        volumeRatio,

                        bodyRatio,

                        timeframeLevel:
                            level.timeframe,

                        touches:
                            level.touches

                    }

                );

        }


        /*
         * RETEST
         */

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


            const retest =
                retestFound(
                    m15,
                    p
                );


            if (!retest) {

                continue;

            }


            /*
             * Retest'in bulunduğu
             * kapanış seviyesi bozulmuş mu?
             */

            if (
                isInvalidated(
                    retest.close,
                    p.level,
                    p.side
                )
            ) {

                continue;

            }


            pending = {

                ...p,

                retestIndex:
                    retest.index,

                retestAt:
                    retest.time

            };


            break;

        }


        if (!pending) {

            return null;

        }


        /*
         * ENTRY ZONE
         */

        const zone =
            getEntryZone(
                pending.level,
                pending.side
            );


        const distance =
            Math.abs(
                live -
                pending.level
            ) /
            pending.level;


        /*
         * Fiyat artık çok uzaksa
         * bu retest trade değildir.
         */

        if (
            distance >
            CFG.MAX_ENTRY_DISTANCE
        ) {

            return null;

        }


        if (
            !isInsideEntryZone(
                live,
                zone.low,
                zone.high
            )
        ) {

            return null;

        }


        /*
         * 15M STRUCTURE
         */

        const structure =
            get15mStructure(
                m15
            );


        /*
         * 4H TREND
         */

        const trend4H =
            getTrendBias(
                h4
            );


        /*
         * RSI
         */

        const currentRSI =
            calculateRSI(
                m15
            );


        /*
         * ATR
         */

        const currentATR =
            calculateATR(
                m15
            ) ||
            live *
            0.006;


        /*
         * 5M SADECE BURADA ÇEKİLİR.
         *
         * Yani sadece gerçek retest oluşmuş
         * adaylarda.
         */

        let fiveConfirmed =
            false;


        let fiveBonus =
            0;


        try {

            const m5 =
                await fetchOHLCV(
                    symbol,
                    '5m',
                    40
                );


            fiveConfirmed =
                check5mConfirmation(
                    m5,
                    pending.side
                );


            if (
                fiveConfirmed
            ) {

                fiveBonus =
                    CFG.FIVE_M_BONUS;

            }

        } catch (error) {

            /*
             * 5M alınamazsa
             * sinyal iptal edilmiyor.
             */

            fiveConfirmed =
                false;

            fiveBonus =
                0;

        }


        /*
         * SCORE
         */

        let score = 50;


        /*
         * 4H level
         */

        if (
            pending.timeframeLevel ===
            '4H'
        ) {

            score += 8;

        } else {

            score += 5;

        }


        /*
         * Touches
         */

        if (
            pending.touches >= 4
        ) {

            score += 8;

        } else if (
            pending.touches >= 2
        ) {

            score += 5;

        }


        /*
         * 15M structure
         */

        if (
            structure ===
            pending.side
        ) {

            score += 10;

        } else if (
            structure ===
            'NEUTRAL'
        ) {

            score += 3;

        } else {

            score -= 3;

        }


        /*
         * 4H trend
         */

        if (
            trend4H ===
            pending.side
        ) {

            score += 8;

        } else if (
            trend4H ===
            'NEUTRAL'
        ) {

            score += 2;

        } else {

            /*
             * Ters 4H trendi
             * artık otomatik red değil.
             *
             * Çünkü güçlü breakout
             * trend dönüşü olabilir.
             */

            score -= 5;

        }


        /*
         * Breakout volume
         */

        if (
            pending.volumeRatio >=
            1.8
        ) {

            score += 8;

        } else if (
            pending.volumeRatio >=
            1.4
        ) {

            score += 6;

        } else {

            score += 3;

        }


        /*
         * RSI
         */

        if (
            currentRSI !== null
        ) {

            const rsiGood =

                pending.side ===
                'LONG'

                    ? (
                        currentRSI >= 48 &&
                        currentRSI <= 74
                    )

                    : (
                        currentRSI >= 26 &&
                        currentRSI <= 52
                    );


            if (
                rsiGood
            ) {

                score += 4;

            }

        }


        /*
         * 4H + 2H CONFLUENCE
         */

        const sameTypeLevels =
            levels.filter(
                level =>

                    level.type ===
                        pending.levelType &&

                    Math.abs(
                        level.price -
                        pending.level
                    ) /
                        pending.level <=
                        CFG.CLUSTER_TOLERANCE

            );


        const has4H =
            sameTypeLevels.some(
                level =>
                    level.timeframe ===
                    '4H'
            );


        const has2H =
            sameTypeLevels.some(
                level =>
                    level.timeframe ===
                    '2H'
            );


        const confluence =
            has4H &&
            has2H;


        if (
            confluence
        ) {

            score +=
                CFG.CONFLUENCE_BONUS;

        }


        /*
         * 5M BONUS
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


        /*
         * OPPOSITE LEVEL
         */

        const oppositeLevel =
            findOppositeLevel(
                levels,
                pending.side,
                live
            );


        /*
         * TRADE PLAN
         */

        const plan =
            createTradePlan(

                pending.side,

                live,

                pending.level,

                currentATR,

                oppositeLevel

            );


        if (!plan) {

            return null;

        }


        /*
         * SIGNAL
         */

        const now =
            Date.now();


        const cooldownKey =
            levelKey(
                coin,
                pending.levelType,
                pending.level
            );


        const signal = {

            id:
                `${coin}-${now}`,

            coin,

            symbol:
                coin,

            ccxt_symbol:
                symbol,


            direction:
                pending.side,

            taraf:
                pending.side,


            confidence:
                score,


            status:
                'ACTIVE',

            statusText:
                'GİRİŞ AKTİF',

            entryAvailable:
                true,


            livePrice:
                formatPrice(
                    live
                ),


            giris:
                formatPrice(
                    live
                ),


            entryLow:
                formatPrice(
                    zone.low
                ),

            entryHigh:
                formatPrice(
                    zone.high
                ),


            entryLowRaw:
                zone.low,

            entryHighRaw:
                zone.high,


            sl:
                formatPrice(
                    plan.stop
                ),

            stop:
                formatPrice(
                    plan.stop
                ),


            tp1:
                formatPrice(
                    plan.tp1
                ),

            tp2:
                formatPrice(
                    plan.tp2
                ),

            tp3:
                formatPrice(
                    plan.tp3
                ),


            stopRaw:
                plan.stop,

            tp1Raw:
                plan.tp1,

            tp2Raw:
                plan.tp2,

            tp3Raw:
                plan.tp3,


            level:
                formatPrice(
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


            confluence,


            touches:
                pending.touches,


            distance:
                Number(
                    (
                        distance *
                        100
                    ).toFixed(3)
                ),


            volume24h:
                num(
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


            atr:
                Number(
                    currentATR.toFixed(8)
                ),


            trend4H,


            structure15m:
                structure,


            fiveMinuteConfirmed:
                fiveConfirmed,


            rr:
                Number(
                    plan.rr.toFixed(2)
                ),


            signalAt:
                now,

            timestamp:
                now,

            ageSeconds:
                0,


            breakoutAt:
                pending.breakoutAt,

            retestAt:
                pending.retestAt,


            reason:

                (
                    confluence
                        ? '4H + 2H seviye'
                        : pending.timeframeLevel +
                          ' seviye'
                ) +

                ' → 15M breakout' +

                ' → retest' +

                (
                    structure ===
                    pending.side
                        ? ' → 15M yapı teyidi'
                        : ''
                ) +

                (
                    fiveConfirmed
                        ? ' → 5M teyit'
                        : ''
                )

        };


        signal.cooldownKey =
            cooldownKey;


        /*
         * ACTIVE STATE
         */

        STATE.activeSignals.set(
            coin,
            signal
        );


        /*
         * Breakout artık kullanıldı.
         */

        STATE.pendingBreakouts.delete(
            cooldownKey
        );


        return signal;

    } catch (error) {

        /*
         * Bir coin patladı diye
         * bütün radar durmaz.
         */

        return null;

    }

}


/* =========================================================
   ENTRY ZONE TEST
   ========================================================= */

function isInsideEntryZone(
    price,
    low,
    high
) {

    return (

        price >= low &&
        price <= high

    );

}


/* =========================================================
   RUN SCAN
   ========================================================= */

async function runScan() {

    if (
        scanRunning
    ) {

        return;

    }


    scanRunning =
        true;


    const started =
        Date.now();


    try {

        cleanupState();


        console.log(
            'Bitget radar taraması başlıyor...'
        );


        const discovered =
            await discoverRadar();


        marketRows =
            discovered.radarRows;


        /*
         * Gerçek piyasa sentiment'i
         * bütün perpetual evrenden.
         */

        marketSentiment =
            calculateMarketSentiment(
                discovered.allRows
            );


        stats.universe =
            marketRows.length;


        const activeResults = [];


        let analyzed = 0;


        /*
         * Chunked analysis.
         */

        for (
            let i = 0;
            i < marketRows.length;
            i +=
                CFG.REQUEST_CONCURRENCY
        ) {

            const chunk =
                marketRows.slice(
                    i,
                    i +
                    CFG.REQUEST_CONCURRENCY
                );


            const results =
                await Promise.all(
                    chunk.map(
                        analyzeSymbol
                    )
                );


            analyzed +=
                chunk.length;


            for (
                const signal of
                    results
            ) {

                if (signal) {

                    activeResults.push(
                        signal
                    );

                }

            }


            await sleep(
                CFG.REQUEST_DELAY
            );

        }


        /*
         * Active state'teki sinyaller korunur.
         */

        const allActive =
            Array.from(
                STATE.activeSignals
                    .values()
            );


        /*
         * Deduplicate.
         */

        const merged =
            new Map();


        for (
            const signal of
                allActive
        ) {

            merged.set(
                signal.coin,
                signal
            );

        }


        for (
            const signal of
                activeResults
        ) {

            merged.set(
                signal.coin,
                signal
            );

        }


        signals =
            Array.from(
                merged.values()
            )
            .sort(
                (a, b) =>

                    b.confidence -
                    a.confidence ||

                    a.distance -
                    b.distance

            )
            .slice(
                0,
                CFG.MAX_SIGNALS
            );


        stats.analyzed =
            analyzed;

        stats.pending =
            STATE.pendingBreakouts
                .size;

        stats.signals =
            signals.length;

        stats.seconds =
            Number(
                (
                    (
                        Date.now() -
                        started
                    ) /
                    1000
                ).toFixed(1)
            );


        lastScan =
            Date.now();


        lastError =
            null;


        broadcast();


        console.log(

            'RADAR tamamlandı | ' +

            `Universe=${stats.universe} | ` +

            `Analiz=${stats.analyzed} | ` +

            `Pending=${stats.pending} | ` +

            `SIGNAL=${stats.signals} | ` +

            `Piyasa=${marketSentiment.label}`

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
   PUBLIC SNAPSHOT
   ========================================================= */

function getPublicSignals() {

    return signals.map(
        signal => {

            const copy =
                {
                    ...signal
                };


            copy.ageSeconds =
                Math.max(

                    0,

                    Math.floor(

                        (
                            Date.now() -
                            signal.signalAt
                        ) /
                        1000

                    )

                );


            return copy;

        }
    );

}


function getSnapshot() {

    return {

        signals:
            getPublicSignals(),

        stats: {

            ...stats

        },

        market: {

            ...marketSentiment

        },

        scanRunning,

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
                CFG.MIN_RR_TP1,

            fiveMRequired:
                false

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
                'SNAPSHOT',

            data:
                getSnapshot()

        });


    for (
        const client of
            wss.clients
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
   REST — STATUS
   ========================================================= */

app.get(
    '/api/status',
    (req, res) => {

        res.json({

            success:
                true,

            ...getSnapshot()

        });

    }
);


/* =========================================================
   REST — SIGNALS
   ========================================================= */

app.get(
    '/api/signals',
    (req, res) => {

        res.json({

            success:
                true,

            count:
                signals.length,

            data:
                getPublicSignals()

        });

    }
);


/* =========================================================
   REST — CHART
   ========================================================= */

app.get(
    '/api/chart',
    async (
        req,
        res
    ) => {

        try {

            const symbol =
                normalizeSymbol(
                    req.query.symbol
                );


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


            const allowed = [

                '5m',

                '15m',

                '1h',

                '2h',

                '4h'

            ];


            const timeframe =
                allowed.includes(
                    req.query.timeframe
                )

                    ? req.query.timeframe

                    : '15m';


            const candles =
                await fetchOHLCV(

                    symbol,

                    timeframe,

                    CFG.MAX_CHART_CANDLES

                );


            const ticker =
                await safeRequest(
                    () =>
                        exchange.fetchTicker(
                            symbol
                        )
                );


            res.json({

                success:
                    true,

                symbol:
                    cleanSymbol(
                        symbol
                    ),

                timeframe,

                price:
                    num(
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
    (req, res) => {

        res.json({

            ok:
                true,

            exchange:
                'BITGET',

            scanRunning,

            lastScan,

            lastError,

            signals:
                signals.length,

            pending:
                STATE.pendingBreakouts.size

        });

    }
);


/* =========================================================
   WEBSOCKET
   ========================================================= */

wss.on(
    'connection',
    ws => {

        try {

            ws.send(
                JSON.stringify({

                    type:
                        'SNAPSHOT',

                    data:
                        getSnapshot()

                })
            );

        } catch (_) {}

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
    content="width=device-width,initial-scale=1,viewport-fit=cover"
>

<title>
    Sonny AI Trader
</title>

<style>

* {
    box-sizing: border-box;
}

html,
body {
    margin: 0;
    width: 100%;
    height: 100%;
    background: #070a0f;
    color: #eef3f8;
    font-family:
        Arial,
        Helvetica,
        sans-serif;
}

body {
    overflow: hidden;
}

.app {
    width: 100%;
    height: 100dvh;
    display: grid;
    grid-template-columns: 280px minmax(0,1fr);
}


/* =========================================================
   SIDEBAR
========================================================= */

.sidebar {
    background: #0b0f16;
    border-right: 1px solid #202936;
    min-width: 0;
    overflow-y: auto;
    padding: 14px;
}

.logo {
    font-size: 18px;
    font-weight: 900;
}

.logo small {
    display: block;
    margin-top: 5px;
    font-size: 9px;
    color: #718096;
    line-height: 1.5;
}

.signal-list {
    margin-top: 16px;
    display: grid;
    gap: 9px;
}

.signal-card {
    background: #0f151e;
    border: 1px solid #202b39;
    border-radius: 13px;
    padding: 11px;
    cursor: pointer;
    transition: .15s;
}

.signal-card:hover {
    border-color: #385ba8;
}

.signal-card.selected {
    border-color: #4776ff;
    box-shadow:
        0 0 0 1px #1c3f91;
}

.card-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
}

.coin {
    font-size: 13px;
    font-weight: 900;
}

.badge {
    font-size: 9px;
    font-weight: 900;
    border-radius: 5px;
    padding: 4px 6px;
}

.badge.long {
    background: #103627;
    color: #2be19b;
}

.badge.short {
    background: #38141c;
    color: #ff5b6b;
}

.card-price {
    margin-top: 8px;
    font-size: 17px;
    font-weight: 900;
}

.card-meta {
    margin-top: 5px;
    color: #7b8798;
    font-size: 9px;
}

.card-status {
    margin-top: 7px;
    font-size: 9px;
    color: #2be19b;
    font-weight: 800;
}

.card-status.wait {
    color: #e5b84a;
}

.empty {
    text-align: center;
    color: #657184;
    font-size: 10px;
    padding: 30px 8px;
}


/* =========================================================
   MAIN
========================================================= */

.main {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
}

.header {
    height: 70px;
    flex: 0 0 70px;
    border-bottom: 1px solid #202936;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 15px;
    padding: 10px 17px;
}

.header-title {
    font-size: 17px;
    font-weight: 900;
}

.header-sub {
    margin-top: 5px;
    color: #778397;
    font-size: 9px;
}

.header-stats {
    display: flex;
    gap: 17px;
    color: #778397;
    font-size: 9px;
}

.header-stats b {
    color: #eef3f8;
}


/* =========================================================
   CONTENT
========================================================= */

.content {
    min-width: 0;
    min-height: 0;
    flex: 1;
    display: grid;
    grid-template-columns:
        minmax(0,1fr)
        285px;
}


/* =========================================================
   CHART
========================================================= */

.chart-area {
    min-width: 0;
    min-height: 0;
    position: relative;
}

.chart-toolbar {
    position: absolute;
    z-index: 5;
    top: 10px;
    left: 14px;
    right: 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
}

.chart-title {
    font-size: 11px;
    font-weight: 900;
}

.timeframes {
    display: flex;
    gap: 4px;
}

.timeframes button {
    border: 1px solid #263241;
    background: #101721;
    color: #7d899a;
    border-radius: 6px;
    padding: 6px 8px;
    font-size: 9px;
    cursor: pointer;
}

.timeframes button.active {
    color: white;
    background: #17233d;
    border-color: #4776ff;
}

#chart {
    width: 100%;
    height: 100%;
    display: block;
}


/* =========================================================
   DETAIL
========================================================= */

.detail {
    min-width: 0;
    background: #0b0f16;
    border-left: 1px solid #202936;
    padding: 11px;
    overflow-y: auto;
}

.panel {
    background: #0f151e;
    border: 1px solid #202b39;
    border-radius: 13px;
    padding: 12px;
    margin-bottom: 10px;
}

.panel-label {
    font-size: 9px;
    color: #7c8797;
    font-weight: 900;
}

.market-label {
    margin-top: 7px;
    font-size: 17px;
    font-weight: 900;
}

.market-up {
    color: #2be19b;
}

.market-down {
    color: #ff5b6b;
}

.market-neutral {
    color: #e3bd48;
}

.market-reason {
    margin-top: 6px;
    color: #7c8797;
    font-size: 9px;
    line-height: 1.45;
}

.detail-coin {
    font-size: 15px;
    font-weight: 900;
}

.detail-direction {
    margin-top: 5px;
    font-size: 21px;
    font-weight: 900;
}

.detail-direction.long {
    color: #2be19b;
}

.detail-direction.short {
    color: #ff5b6b;
}

.detail-row {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 0;
    border-bottom: 1px solid #1c2530;
    font-size: 9px;
}

.detail-row:last-child {
    border-bottom: 0;
}

.detail-row b {
    text-align: right;
}

.green {
    color: #2be19b;
}

.red {
    color: #ff5b6b;
}

.blue {
    color: #459bff;
}

.yellow {
    color: #e3bd48;
}

.info {
    margin-top: 9px;
    background: #111924;
    border-radius: 8px;
    padding: 9px;
    color: #7f8b9d;
    font-size: 9px;
    line-height: 1.55;
}


/* =========================================================
   TABLET
========================================================= */

@media (max-width: 950px) {

    body {
        overflow: auto;
    }

    .app {
        height: auto;
        min-height: 100dvh;
        display: block;
    }

    .sidebar {
        border-right: 0;
        border-bottom: 1px solid #202936;
        padding: 9px 10px 7px;
        overflow: hidden;
    }

    .logo {
        font-size: 15px;
    }

    .signal-list {
        display: flex;
        overflow-x: auto;
        gap: 8px;
        margin-top: 9px;
        padding-bottom: 2px;
    }

    .signal-card {
        flex: 0 0 185px;
    }

    .main {
        min-height: calc(100dvh - 145px);
    }

    .header {
        height: 62px;
        flex-basis: 62px;
        padding: 8px 10px;
    }

    .header-title {
        font-size: 14px;
    }

    .header-stats {
        gap: 9px;
    }

    .content {
        display: flex;
        flex-direction: column;
    }

    .chart-area {
        height: 56dvh;
        min-height: 340px;
    }

    .detail {
        border-left: 0;
        border-top: 1px solid #202936;
        overflow: visible;
    }

}


/* =========================================================
   PHONE
========================================================= */

@media (max-width: 520px) {

    .signal-card {
        flex-basis: 175px;
    }

    .header-stats span:first-child {
        display: none;
    }

    .header-title {
        font-size: 13px;
    }

    .header-sub {
        font-size: 8px;
    }

    .chart-area {
        height: 52dvh;
        min-height: 325px;
    }

    .chart-toolbar {
        top: 8px;
        left: 8px;
        right: 8px;
    }

    .chart-title {
        max-width: 40%;
        line-height: 1.25;
    }

    .timeframes {
        gap: 2px;
    }

    .timeframes button {
        padding: 5px 6px;
        font-size: 8px;
    }

    .detail {
        padding: 9px;
    }

}

</style>

</head>


<body>


<div class="app">


<aside class="sidebar">

    <div class="logo">

        🚀 Sonny AI Trader

        <small>
            BITGET USDT FUTURES ·
            4H/2H BREAKOUT ·
            15M RETEST ·
            5M OPTIONAL
        </small>

    </div>


    <div
        id="signalList"
        class="signal-list"
    >

        <div class="empty">
            Radar başlatılıyor...
        </div>

    </div>

</aside>


<main class="main">


<header class="header">

    <div>

        <div class="header-title">
            BREAKOUT RADAR
        </div>

        <div
            id="headerSub"
            class="header-sub"
        >
            Bağlanıyor...
        </div>

    </div>


    <div class="header-stats">

        <span>
            EVREN
            <b id="universe">0</b>
        </span>

        <span>
            SİNYAL
            <b id="signalCount">0</b>
        </span>

        <span>
            <b id="clock">--:--:--</b>
        </span>

    </div>

</header>


<section class="content">


<div class="chart-area">

    <div class="chart-toolbar">

        <div
            id="chartTitle"
            class="chart-title"
        >
            Sinyal seçin
        </div>


        <div class="timeframes">

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


<aside class="detail">


<div class="panel">

    <div class="panel-label">
        GENEL PİYASA
    </div>

    <div
        id="marketLabel"
        class="market-label market-neutral"
    >
        YÜKLENİYOR
    </div>

    <div
        id="marketReason"
        class="market-reason"
    >
        -
    </div>


    <div class="detail-row">

        <span>
            Breadth
        </span>

        <b id="breadth">
            -
        </b>

    </div>


    <div class="detail-row">

        <span>
            Ortalama 24H
        </span>

        <b id="averageMove">
            -
        </b>

    </div>


    <div class="detail-row">

        <span>
            BTC
        </span>

        <b id="btcMove">
            -
        </b>

    </div>


    <div class="detail-row">

        <span>
            ETH
        </span>

        <b id="ethMove">
            -
        </b>

    </div>

</div>


<div class="panel">

    <div
        id="detailCoin"
        class="detail-coin"
    >
        SİNYAL SEÇİN
    </div>


    <div
        id="detailDirection"
        class="detail-direction"
    >
        —
    </div>


    <div class="detail-row">

        <span>
            DURUM
        </span>

        <b
            id="detailStatus"
            class="green"
        >
            —
        </b>

    </div>


    <div class="detail-row">

        <span>
            ŞU AN
        </span>

        <b id="detailLive">
            —
        </b>

    </div>


    <div class="detail-row">

        <span>
            GİRİŞ
        </span>

        <b
            id="detailEntry"
            class="green"
        >
            —
        </b>

    </div>


    <div class="detail-row">

        <span>
            STOP
        </span>

        <b
            id="detailSL"
            class="red"
        >
            —
        </b>

    </div>


    <div class="detail-row">

        <span>
            TP1
        </span>

        <b
            id="detailTP1"
            class="blue"
        >
            —
        </b>

    </div>


    <div class="detail-row">

        <span>
            TP2
        </span>

        <b
            id="detailTP2"
            class="blue"
        >
            —
        </b>

    </div>


    <div class="detail-row">

        <span>
            TP3
        </span>

        <b
            id="detailTP3"
            class="blue"
        >
            —
        </b>

    </div>


    <div class="detail-row">

        <span>
            R:R
        </span>

        <b
            id="detailRR"
            class="yellow"
        >
            —
        </b>

    </div>


    <div class="detail-row">

        <span>
            Güven
        </span>

        <b id="detailScore">
            —
        </b>

    </div>


    <div
        id="detailInfo"
        class="info"
    >
        Sinyal seçilmedi.
    </div>

</div>


<div class="panel">

    <div class="panel-label">
        SİSTEM
    </div>


    <div class="detail-row">

        <span>
            Hacim
        </span>

        <b id="cfgVolume">
            —
        </b>

    </div>


    <div class="detail-row">

        <span>
            24H hareket
        </span>

        <b id="cfgMove">
            —
        </b>

    </div>


    <div class="detail-row">

        <span>
            Retest
        </span>

        <b id="cfgRetest">
            —
        </b>

    </div>


    <div class="detail-row">

        <span>
            5M
        </span>

        <b class="green">
            OPSİYONEL
        </b>

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

const UI = {

    signals: [],

    selected: null,

    timeframe: '15m',

    candles: []

};


/* =========================================================
   HELPERS
========================================================= */

function $(id) {

    return document.getElementById(id);

}


function clean(s) {

    return String(s || '')
        .replace('/USDT:USDT','')
        .replace('/USDT','')
        .replace('USDT','')
        .toUpperCase() +
        'USDT';

}


function value(v) {

    const x =
        Number(v);

    return Number.isFinite(x)
        ? x
        : null;

}


function formatPrice(v) {

    const x =
        value(v);

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


function direction(signal) {

    return String(
        signal?.direction ||
        signal?.taraf ||
        ''
    ).toUpperCase() ===
    'SHORT'
        ? 'SHORT'
        : 'LONG';

}


function ageText(seconds) {

    const s =
        Math.max(
            0,
            Number(seconds) || 0
        );


    if (s < 60) {

        return `${s} sn`;

    }


    return (
        `${Math.floor(s / 60)} dk ` +
        `${s % 60} sn`
    );

}


/* =========================================================
   SIGNAL LIST
========================================================= */

function renderSignals() {

    const container =
        $('signalList');


    if (
        !UI.signals.length
    ) {

        container.innerHTML =

            `<div class="empty">
                Aktif sinyal yok.
            </div>`;

        return;

    }


    container.innerHTML =
        UI.signals.map(
            (signal, index) => {

                const dir =
                    direction(
                        signal
                    );


                const selected =

                    UI.selected &&
                    UI.selected.id ===
                    signal.id;


                return `

                <div
                    class="signal-card
                    ${selected ? 'selected' : ''}"
                    data-index="${index}"
                >

                    <div class="card-top">

                        <span class="coin">
                            ${clean(
                                signal.coin ||
                                signal.symbol
                            )}
                        </span>

                        <span
                            class="badge
                            ${dir.toLowerCase()}"
                        >
                            ${dir}
                        </span>

                    </div>


                    <div class="card-price">

                        ${formatPrice(
                            signal.livePrice
                        )}

                    </div>


                    <div class="card-meta">

                        Güven
                        ${signal.confidence || 0}/100

                        · R:R
                        ${signal.rr || '—'}

                    </div>


                    <div
                        class="card-status
                        ${
                            signal.entryAvailable
                                ? ''
                                : 'wait'
                        }"
                    >

                        ●
                        ${
                            signal.statusText ||
                            'GİRİŞ AKTİF'
                        }

                    </div>


                    <div class="card-meta">

                        ${
                            signal.timeframeLevel ||
                            '—'
                        }

                        ·

                        ${
                            ageText(
                                signal.ageSeconds
                            )
                        }

                    </div>

                </div>

                `;

            }
        )
        .join('');


    container
        .querySelectorAll(
            '.signal-card'
        )
        .forEach(
            card => {

                card.onclick =
                    () => {

                        UI.selected =
                            UI.signals[
                                Number(
                                    card.dataset.index
                                )
                            ];


                        renderSignals();

                        renderDetails();

                        loadChart();

                    };

            }
        );

}


/* =========================================================
   DETAILS
========================================================= */

function renderDetails() {

    const signal =
        UI.selected;


    if (!signal) {

        return;

    }


    const dir =
        direction(
            signal
        );


    $('detailCoin')
        .textContent =
        clean(
            signal.coin ||
            signal.symbol
        );


    $('detailDirection')
        .textContent =
        dir;


    $('detailDirection')
        .className =
        'detail-direction ' +
        dir.toLowerCase();


    $('detailStatus')
        .textContent =
        signal.statusText ||
        '—';


    $('detailStatus')
        .className =
        signal.entryAvailable
            ? 'green'
            : 'yellow';


    $('detailLive')
        .textContent =
        formatPrice(
            signal.livePrice
        );


    $('detailEntry')
        .textContent =
        formatPrice(
            signal.giris
        );


    $('detailSL')
        .textContent =
        formatPrice(
            signal.sl
        );


    $('detailTP1')
        .textContent =
        formatPrice(
            signal.tp1
        );


    $('detailTP2')
        .textContent =
        formatPrice(
            signal.tp2
        );


    $('detailTP3')
        .textContent =
        formatPrice(
            signal.tp3
        );


    $('detailRR')
        .textContent =
        signal.rr ||
        '—';


    $('detailScore')
        .textContent =
        (
            signal.confidence ||
            0
        ) +
        '/100';


    $('detailInfo')
        .innerHTML =

        `Seviye:
        <b>${formatPrice(
            signal.level
        )}</b><br>` +

        `TF:
        <b>${signal.timeframeLevel || '—'}</b><br>` +

        `15M yapı:
        <b>${signal.structure15m || 'NEUTRAL'}</b><br>` +

        `4H trend:
        <b>${signal.trend4H || 'NEUTRAL'}</b><br>` +

        `5M:
        <b>${
            signal.fiveMinuteConfirmed
                ? 'TEYİT'
                : 'OPSİYONEL / TEYİT YOK'
        }</b><br>` +

        `Breakout hacmi:
        <b>${signal.volumeRatio || '—'}x</b><br>` +

        `${signal.reason || ''}`;

    
    $('chartTitle')
        .textContent =

        clean(
            signal.coin ||
            signal.symbol
        ) +

        ' · ' +

        UI.timeframe.toUpperCase() +

        ' · ' +

        dir;

}


/* =========================================================
   MARKET
========================================================= */

function renderMarket(
    market
) {

    const label =
        market?.label ||
        'YATAY / KARIŞIK';


    $('marketLabel')
        .textContent =
        label;


    let cls =
        'market-label market-neutral';


    if (
        market?.direction ===
        'LONG'
    ) {

        cls =
            'market-label market-up';

    }


    if (
        market?.direction ===
        'SHORT'
    ) {

        cls =
            'market-label market-down';

    }


    $('marketLabel')
        .className =
        cls;


    $('marketReason')
        .textContent =
        market?.reason ||
        '';


    $('breadth')
        .textContent =
        market?.breadthPct != null
            ? `${market.breadthPct}%`
            : '—';


    $('averageMove')
        .textContent =
        market?.averageMove != null
            ? `${market.averageMove}%`
            : '—';


    $('btcMove')
        .textContent =
        market?.btcMove != null
            ? `${market.btcMove.toFixed(2)}%`
            : '—';


    $('ethMove')
        .textContent =
        market?.ethMove != null
            ? `${market.ethMove.toFixed(2)}%`
            : '—';

}


/* =========================================================
   STATUS
========================================================= */

function applyStatus(
    data
) {

    UI.signals =
        data.signals ||
        [];


    $('universe')
        .textContent =
        data.stats?.universe ||
        0;


    $('signalCount')
        .textContent =
        UI.signals.length;


    $('headerSub')
        .textContent =

        data.lastScan

            ? (
                'Son tarama: ' +
                new Date(
                    data.lastScan
                ).toLocaleTimeString(
                    'tr-TR'
                )
            )

            : 'Tarama bekleniyor...';


    renderMarket(
        data.market ||
        {}
    );


    const cfg =
        data.config ||
        {};


    $('cfgVolume')
        .textContent =

        '$' +

        Number(
            cfg.minVolumeUSD ||
            0
        ).toLocaleString(
            'en-US'
        );


    $('cfgMove')
        .textContent =

        (
            cfg.min24hMove ||
            0
        ) +

        '%+';


    $('cfgRetest')
        .textContent =

        (
            cfg.retestMinutes ||
            0
        ) +

        ' dk';


    /*
     * Seçili coin artık yoksa
     * ilk sinyali seç.
     */

    if (

        !UI.selected ||

        !UI.signals.some(
            signal =>
                signal.id ===
                UI.selected.id
        )

    ) {

        UI.selected =
            UI.signals[0] ||
            null;

    } else {

        /*
         * Canlı fiyat / durum güncelle.
         */

        const latest =
            UI.signals.find(
                signal =>
                    signal.id ===
                    UI.selected.id
            );


        if (latest) {

            UI.selected =
                latest;

        }

    }


    renderSignals();

    renderDetails();


    if (
        UI.selected
    ) {

        loadChart();

    }

}


/* =========================================================
   LOAD STATUS
========================================================= */

async function loadStatus() {

    try {

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


        if (
            data.success
        ) {

            applyStatus(
                data
            );

        }

    } catch (error) {

        $('headerSub')
            .textContent =
            'Sunucu bağlantısı bekleniyor...';

    }

}


/* =========================================================
   CHART SETUP
========================================================= */

function canvasContext() {

    const canvas =
        $('chart');


    const rect =
        canvas.getBoundingClientRect();


    const dpr =
        window.devicePixelRatio ||
        1;


    const width =
        Math.max(
            1,
            Math.floor(
                rect.width *
                dpr
            )
        );


    const height =
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


    return {

        canvas,

        ctx,

        width:
            rect.width,

        height:
            rect.height

    };

}


/* =========================================================
   EMPTY CHART
========================================================= */

function emptyChart(
    text
) {

    const area =
        canvasContext();


    area.ctx.fillStyle =
        '#070a0f';


    area.ctx.fillRect(
        0,
        0,
        area.width,
        area.height
    );


    area.ctx.fillStyle =
        '#687487';


    area.ctx.font =
        '12px Arial';


    area.ctx.fillText(
        text,
        15,
        65
    );

}


/* =========================================================
   DRAW CHART
========================================================= */

function drawChart(
    candles,
    live,
    signal
) {

    if (
        !candles ||
        candles.length <
            2 ||
        !signal
    ) {

        emptyChart(
            'Grafik verisi yok'
        );

        return;

    }


    const area =
        canvasContext();


    const ctx =
        area.ctx;


    const width =
        area.width;

    const height =
        area.height;


    const mobile =
        width < 600;


    const padding = {

        left:
            mobile
                ? 7
                : 18,

        right:
            mobile
                ? 70
                : 92,

        top:
            mobile
                ? 38
                : 48,

        bottom:
            22

    };


    const chartWidth =
        width -
        padding.left -
        padding.right;


    const chartHeight =
        height -
        padding.top -
        padding.bottom;


    if (
        chartWidth < 80 ||
        chartHeight < 100
    ) {

        emptyChart(
            'Grafik alanı küçük'
        );

        return;

    }


    const values = [];


    candles.forEach(
        candle => {

            values.push(
                Number(candle.high)
            );

            values.push(
                Number(candle.low)
            );

        }
    );


    [
        signal.giris,
        signal.sl,
        signal.tp1,
        signal.tp2,
        signal.tp3,
        live
    ].forEach(
        v => {

            if (
                value(v) !==
                null
            ) {

                values.push(
                    Number(v)
                );

            }

        }
    );


    let low =
        Math.min(
            ...values
        );


    let high =
        Math.max(
            ...values
        );


    const margin =
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


    const range =
        high -
        low;


    function X(i) {

        return (

            padding.left +

            (
                i /
                (
                    candles.length -
                    1
                )
            ) *
            chartWidth

        );

    }


    function Y(price) {

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


    /*
     * Background
     */

    ctx.fillStyle =
        '#070a0f';


    ctx.fillRect(
        0,
        0,
        width,
        height
    );


    /*
     * Grid
     */

    ctx.strokeStyle =
        '#17202b';


    ctx.lineWidth =
        1;


    for (
        let i = 0;
        i <= 5;
        i++
    ) {

        const y =
            padding.top +
            chartHeight *
            i /
            5;


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

    }


    /*
     * Price labels
     */

    ctx.fillStyle =
        '#778397';


    ctx.font =
        (
            mobile
                ? '8px'
                : '10px'
        ) +
        ' Arial';


    for (
        let i = 0;
        i <= 5;
        i++
    ) {

        const p =
            high -
            range *
            i /
            5;


        const y =
            padding.top +
            chartHeight *
            i /
            5;


        ctx.fillText(

            formatPrice(
                p
            ),

            width -
            padding.right +
            5,

            y + 3

        );

    }


    /*
     * Candles
     */

    const candleWidth =
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
        (candle, index) => {

            const open =
                Number(
                    candle.open
                );

            const close =
                Number(
                    candle.close
                );

            const highValue =
                Number(
                    candle.high
                );

            const lowValue =
                Number(
                    candle.low
                );


            const x =
                X(index);


            const bullish =
                close >=
                open;


            ctx.strokeStyle =
                bullish
                    ? '#19d995'
                    : '#ff5667';


            ctx.fillStyle =
                bullish
                    ? '#19d995'
                    : '#ff5667';


            /*
             * Wick
             */

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


            /*
             * Body
             */

            const top =
                Y(
                    Math.max(
                        open,
                        close
                    )
                );


            const bottom =
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


    /*
     * Horizontal lines
     */

    function drawLine(
        priceValue,
        label,
        lineColor
    ) {

        if (
            value(priceValue) ===
            null
        ) {

            return;

        }


        const y =
            Y(
                Number(
                    priceValue
                )
            );


        ctx.strokeStyle =
            lineColor;


        ctx.setLineDash(
            [6,5]
        );


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


        ctx.setLineDash([]);


        ctx.fillStyle =
            lineColor;


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
            formatPrice(
                priceValue
            ),

            width -
            padding.right +
            5,

            y + 3

        );

    }


    drawLine(
        signal.level,
        'LEVEL',
        '#e3bd48'
    );


    drawLine(
        signal.giris,
        'GİRİŞ',
        '#19d995'
    );


    drawLine(
        signal.sl,
        'STOP',
        '#ff5667'
    );


    drawLine(
        signal.tp1,
        'TP1',
        '#459bff'
    );


    drawLine(
        signal.tp2,
        'TP2',
        '#459bff'
    );


    drawLine(
        signal.tp3,
        'TP3',
        '#459bff'
    );


    /*
     * Live price
     */

    if (
        value(live) !==
        null
    ) {

        const y =
            Y(
                Number(live)
            );


        ctx.strokeStyle =
            '#ff6875';


        ctx.setLineDash(
            [3,5]
        );


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
            formatPrice(
                live
            ),

            width -
            padding.right +
            5,

            Math.max(
                12,
                y - 5
            )

        );

    }


    /*
     * Title
     */

    const dir =
        direction(
            signal
        );


    ctx.fillStyle =
        dir ===
        'LONG'
            ? '#19d995'
            : '#ff5667';


    ctx.font =
        'bold ' +
        (
            mobile
                ? '11'
                : '14'
        ) +
        'px Arial';


    ctx.fillText(

        clean(
            signal.coin ||
            signal.symbol
        ) +

        ' · ' +

        dir,

        padding.left,

        22

    );

}


/* =========================================================
   LOAD CHART
========================================================= */

async function loadChart() {

    if (
        !UI.selected
    ) {

        emptyChart(
            'Sinyal seçin'
        );

        return;

    }


    try {

        const url =

            '/api/chart?symbol=' +

            encodeURIComponent(
                UI.selected.coin ||
                UI.selected.symbol
            ) +

            '&timeframe=' +

            UI.timeframe;


        const response =
            await fetch(
                url,
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
                'Grafik alınamadı'
            );

        }


        UI.candles =
            data.candles ||
            [];


        drawChart(

            UI.candles,

            data.price,

            UI.selected

        );

    } catch (error) {

        emptyChart(
            'Grafik verisi alınamadı'
        );

    }

}


/* =========================================================
   TIMEFRAME
========================================================= */

document
    .querySelectorAll(
        '[data-tf]'
    )
    .forEach(
        button => {

            button.onclick =
                () => {

                    document
                        .querySelectorAll(
                            '[data-tf]'
                        )
                        .forEach(
                            item =>
                                item.classList
                                    .remove(
                                        'active'
                                    )
                        );


                    button.classList
                        .add(
                            'active'
                        );


                    UI.timeframe =
                        button.dataset.tf;


                    renderDetails();

                    loadChart();

                };

        }
    );


/* =========================================================
   CLOCK
========================================================= */

setInterval(
    () => {

        $('clock')
            .textContent =
            new Date()
                .toLocaleTimeString(
                    'tr-TR'
                );

    },
    1000
);


/* =========================================================
   LIVE STATUS
========================================================= */

setInterval(
    loadStatus,
    5000
);


/* =========================================================
   LIVE CHART
========================================================= */

setInterval(
    () => {

        if (
            UI.selected
        ) {

            loadChart();

        }

    },
    15000
);


/* =========================================================
   RESIZE
========================================================= */

window.addEventListener(
    'resize',
    () => {

        if (
            UI.selected &&
            UI.candles.length
        ) {

            drawChart(

                UI.candles,

                UI.selected.livePrice,

                UI.selected

            );

        }

    }
);


/* =========================================================
   WEBSOCKET
========================================================= */

try {

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
        event => {

            try {

                const message =
                    JSON.parse(
                        event.data
                    );


                if (
                    message.type ===
                    'SNAPSHOT'
                ) {

                    applyStatus(
                        message.data
                    );

                }

            } catch (_) {}

        };

} catch (_) {}


/* =========================================================
   INITIAL
========================================================= */

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
            .type('html')
            .send(
                HTML
            );

    }
);


/* =========================================================
   BITGET INIT
   ========================================================= */

async function init() {

    console.log(
        '================================================='
    );

    console.log(
        '🚀 Sonny AI Trader — BREAKOUT ENGINE v4 FINAL'
    );

    console.log(
        '📡 Bitget USDT Futures'
    );

    console.log(
        '📊 4H + 2H BREAKOUT → 15M RETEST → ENTRY'
    );

    console.log(
        '🎯 5M CONFIRMATION: OPTIONAL'
    );

    console.log(

        '💰 Minimum Volume: $' +

        CFG.MIN_VOLUME_USD
            .toLocaleString()

    );

    console.log(

        '📈 Minimum 24H Move: %' +

        CFG.MIN_24H_MOVE

    );

    console.log(

        '🛰️ Maximum Radar: ' +
        CFG.MAX_COINS

    );

    console.log(

        '🎯 Retest Window: ' +
        CFG.RETEST_WINDOW_MIN +
        ' min'

    );

    console.log(

        '🎯 Minimum TP1 R:R: 1:' +
        CFG.MIN_RR_TP1

    );

    console.log(

        '⏱️ Scan: ' +
        (
            CFG.SCAN_MS /
            1000
        ) +
        ' sec'

    );

    console.log(
        '🤖 Automatic Orders: OFF'
    );

    console.log(
        '================================================='
    );


    /*
     * ÖNEMLİ:
     *
     * Binance YOK.
     * Bitget USDT swap kullanılıyor.
     */

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


    await safeRequest(
        () =>
            exchange.loadMarkets(
                true
            )
    );


    /*
     * İlk tarama.
     */

    await runScan();


    /*
     * Server.
     */

    server.listen(
        PORT,
        () => {

            console.log(
                `🌐 Server aktif: ${PORT}`
            );

        }
    );


    /*
     * Sürekli radar.
     */

    setInterval(
        runScan,
        CFG.SCAN_MS
    );

}


init()
    .catch(
        error => {

            console.error(
                'FATAL INIT ERROR:',
                error
            );

            process.exit(
                1
            );

        }
    );
