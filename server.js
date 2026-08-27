'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');

const app = express();

app.use(express.json({ limit: '1mb' }));

const server = http.createServer(app);

const wss = new WebSocket.Server({
    server
});

const PORT =
    Number(
        process.env.PORT || 10000
    );

/* =========================================================
   CONFIG
========================================================= */

const CFG = {

    MAX_RADAR:
        500,

    CANDIDATES:
        150,

    DEEP:
        40,

    MAX_SIGNALS:
        15,

    MIN_VOLUME_USDT:
        Number(
            process.env.MIN_VOLUME_USDT ||
            750000
        ),

    SCAN_MS:
        60 * 1000,

    LIVE_MS:
        10 * 1000,

    MARKET_REFRESH_MS:
        15 * 60 * 1000,

    CONCURRENCY:
        6,

    H4:
        100,

    H2:
        100,

    M15:
        140,

    M5:
        80,

    CHART:
        180,

    MIN_SCORE:
        70,

    BREAKOUT_LOOKBACK:
        8,

    BREAKOUT_VOL:
        1.15,

    RETEST_TOL:
        0.006,

    ENTRY_ZONE:
        0.0035,

    MAX_ENTRY_DISTANCE:
        0.008,

    MIN_RR:
        1.50,

    ATR_STOP:
        1.20,

    SIGNAL_TTL:
        45 * 60 * 1000,

    PENDING_TTL:
        90 * 60 * 1000,

    REQUIRE_5M:
        true,

    AUTO_TRADE:
        false

};

/* =========================================================
   BITGET
========================================================= */

const exchange =
    new ccxt.bitget({

        enableRateLimit:
            true,

        timeout:
            20000,

        options: {
            defaultType:
                'swap'
        },

        apiKey:
            process.env.BITGET_API_KEY ||
            '',

        secret:
            process.env.BITGET_SECRET ||
            '',

        password:
            process.env.BITGET_PASSPHRASE ||
            ''

    });

/* =========================================================
   STATE
========================================================= */

const STATE = {

    markets:
        [],

    candidates:
        [],

    deepWatch:
        [],

    signals:
        new Map(),

    pending:
        new Map(),

    history:
        [],

    scanning:
        false,

    lastScan:
        0,

    lastError:
        '',

    selected:
        'BTC/USDT:USDT',

    market: {

        label:
            'YATAY',

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

        reason:
            'Piyasa analiz ediliyor.'

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

        signals:
            0,

        pending:
            0

    },

    marketsAt:
        0

};

/* =========================================================
   HELPERS
========================================================= */

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

function round(
    value,
    digits = 4
) {

    const p =
        10 ** digits;

    return Math.round(
        n(value) * p
    ) / p;

}

function cleanSymbol(
    symbol
) {

    return String(
        symbol || ''
    )
        .replace(
            ':USDT',
            ''
        )
        .replace(
            '/USDT',
            ''
        ) + 'USDT';

}

function rawSymbol(
    symbol
) {

    const s =
        String(
            symbol || ''
        )
        .toUpperCase();

    if (
        s.includes('/')
    ) {

        return s;

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

function priceDigits(
    value
) {

    const x =
        Math.abs(
            n(value)
        );

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

    return 8;

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
        priceDigits(x)
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
        c.length < period
    ) {

        return null;

    }

    let value =
        c
            .slice(
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
        closed(candles);

    if (
        c.length <
        period + 1
    ) {

        return 50;

    }

    let gain =
        0;

    let loss =
        0;

    for (
        let i =
            c.length - period;

        i <
            c.length;

        i++
    ) {

        const diff =
            n(c[i][4]) -
            n(c[i - 1][4]);

        if (
            diff >= 0
        ) {

            gain +=
                diff;

        }
        else {

            loss -=
                diff;

        }

    }

    if (
        loss === 0
    ) {

        return 100;

    }

    const rs =
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
        100 /
        (
            1 + rs
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
            n(c[i][2]);

        const low =
            n(c[i][3]);

        const previousClose =
            n(c[i - 1][4]);

        values.push(

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

    const last =
        values.slice(
            -period
        );

    if (
        !last.length
    ) {

        return 0;

    }

    return (
        last.reduce(
            (
                a,
                b
            ) =>
                a + b,
            0
        ) /
        last.length
    );

}

/* =========================================================
   VOLUME RATIO
========================================================= */

function volumeRatio(
    candles,
    lookback = 20
) {

    const c =
        closed(candles);

    if (
        c.length <
        lookback + 1
    ) {

        return 1;

    }

    const last =
        n(
            c[
                c.length - 1
            ][5]
        );

    const base =
        c
            .slice(
                -lookback - 1,
                -1
            )
            .map(
                x =>
                    n(x[5])
            )
            .filter(
                x =>
                    x > 0
            );

    if (
        !base.length
    ) {

        return 1;

    }

    const average =
        base.reduce(
            (
                a,
                b
            ) =>
                a + b,
            0
        ) /
        base.length;

    if (
        average <= 0
    ) {

        return 1;

    }

    return (
        last /
        average
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

    const e20 =
        ema(
            candles,
            20
        );

    const e50 =
        ema(
            candles,
            50
        );

    if (
        !c.length ||
        e20 === null ||
        e50 === null
    ) {

        return 'NEUTRAL';

    }

    const last =
        n(
            c[
                c.length - 1
            ][4]
        );

    if (
        last > e20 &&
        e20 > e50
    ) {

        return 'LONG';

    }

    if (
        last < e20 &&
        e20 < e50
    ) {

        return 'SHORT';

    }

    return 'NEUTRAL';

}

/* =========================================================
   SUPPORT / RESISTANCE
========================================================= */

function levels(
    candles,
    lookback = 40
) {

    const c =
        closed(
            candles
        )
        .slice(
            -lookback
        );

    if (
        c.length < 10
    ) {

        return {
            high: 0,
            low: 0
        };

    }

    let high =
        -Infinity;

    let low =
        Infinity;

    for (
        const candle
        of c.slice(
            0,
            -2
        )
    ) {

        high =
            Math.max(
                high,
                n(candle[2])
            );

        low =
            Math.min(
                low,
                n(candle[3])
            );

    }

    return {
        high,
        low
    };

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
                        items[index],
                        index
                    );

            }
            catch (_) {

                result[index] =
                    null;

            }

        }

    }

    const count =
        Math.min(
            limit,
            items.length
        );

    await Promise.all(

        Array
            .from(
                {
                    length:
                        count
                }
            )
            .map(
                () =>
                    runner()
            )

    );

    return result.filter(
        Boolean
    );

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
        Object
            .values(
                markets
            )
            .filter(
                market =>

                    market &&

                    market.active !==
                        false &&

                    market.swap &&

                    market.linear &&

                    market.quote ===
                        'USDT' &&

                    market.settle ===
                        'USDT'

            );

    return STATE.markets;

}

/* =========================================================
   TICKERS
========================================================= */

async function fetchTickersSafe() {

    let tickers;

    try {

        tickers =
            await exchange.fetchTickers();

    }
    catch (_) {

        tickers =
            {};

    }

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
            n(
                ticker.last ||
                ticker.close
            );

        const quoteVolume =
            n(
                ticker.quoteVolume ||
                (
                    last *
                    n(
                        ticker.baseVolume
                    )
                )
            );

        const percentage =
            n(
                ticker.percentage
            );

        if (
            !(last > 0) ||
            !(quoteVolume > 0)
        ) {

            continue;

        }

        const high =
            n(
                ticker.high
            );

        const low =
            n(
                ticker.low
            );

        const range =
            high > 0 &&
            low > 0
                ? (
                    (
                        high -
                        low
                    ) /
                    low
                ) * 100
                : 0;

        rows.push({

            symbol:
                market.symbol,

            id:
                market.id,

            price:
                last,

            quoteVolume,

            percentage,

            high,

            low,

            range

        });

    }

    rows.sort(
        (
            a,
            b
        ) =>
            b.quoteVolume -
            a.quoteVolume
    );

    return rows.slice(
        0,
        CFG.MAX_RADAR
    );

}

/* =========================================================
   MARKET DIRECTION
========================================================= */

function marketDirection(
    rows
) {

    const valid =
        rows.filter(
            x =>
                Number.isFinite(
                    x.percentage
                )
        );

    if (
        !valid.length
    ) {

        return STATE.market;

    }

    const green =
        valid.filter(
            x =>
                x.percentage >
                0
        ).length;

    const red =
        valid.filter(
            x =>
                x.percentage <
                0
        ).length;

    const average =
        valid.reduce(
            (
                sum,
                x
            ) =>
                sum +
                x.percentage,
            0
        ) /
        valid.length;

    const breadth =
        (
            green /
            valid.length
        ) *
        100;

    let direction =
        'FLAT';

    let label =
        'YATAY';

    if (
        breadth >= 58 &&
        average > 0.15
    ) {

        direction =
            'LONG';

        label =
            'YÜKSELİŞ';

    }
    else if (
        breadth <= 42 &&
        average < -0.15
    ) {

        direction =
            'SHORT';

        label =
            'DÜŞÜŞ';

    }

    return {

        label,

        direction,

        breadth:
            round(
                breadth,
                0
            ),

        green,

        red,

        average:
            round(
                average,
                2
            ),

        reason:
            'Yeşil ' +
            green +
            ' • Kırmızı ' +
            red +
            ' • Ortalama ' +
            average.toFixed(
                2
            ) +
            '%'

    };

}

/* =========================================================
   CANDIDATES
========================================================= */

function buildCandidates(
    rows
) {

    return rows

        .map(
            row => {

                const volumeScore =
                    clamp(
                        Math.log10(
                            Math.max(
                                row.quoteVolume,
                                1
                            )
                        ) * 4 - 20,
                        0,
                        30
                    );

                const rangeScore =
                    clamp(
                        row.range * 3,
                        0,
                        25
                    );

                const momentumScore =
                    clamp(
                        Math.abs(
                            row.percentage
                        ) * 4,
                        0,
                        25
                    );

                const activityScore =
                    row.quoteVolume >=
                    CFG.MIN_VOLUME_USDT
                        ? 20
                        : 5;

                const radarScore =
                    Math.round(
                        clamp(
                            volumeScore +
                            rangeScore +
                            momentumScore +
                            activityScore,
                            0,
                            100
                        )
                    );

                return {

                    ...row,

                    radarScore

                };

            }
        )

        .sort(
            (
                a,
                b
            ) =>
                b.radarScore -
                a.radarScore
        )

        .slice(
            0,
            CFG.CANDIDATES
        );

}

/* =========================================================
   DEEP ANALYSIS
========================================================= */

async function analyzeCoin(
    row
) {

    const results =
        await Promise.all([

            exchange.fetchOHLCV(
                row.symbol,
                '4h',
                undefined,
                CFG.H4
            ),

            exchange.fetchOHLCV(
                row.symbol,
                '2h',
                undefined,
                CFG.H2
            ),

            exchange.fetchOHLCV(
                row.symbol,
                '15m',
                undefined,
                CFG.M15
            )

        ]);

    const h4 =
        results[0];

    const h2 =
        results[1];

    const m15 =
        results[2];

    const h4Trend =
        trend(h4);

    const h2Trend =
        trend(h2);

    const h4Levels =
        levels(
            h4,
            40
        );

    const m15Closed =
        closed(
            m15
        );

    if (
        m15Closed.length <
        12
    ) {

        return null;

    }

    const last =
        n(
            m15Closed[
                m15Closed.length - 1
            ][4]
        );

    const previous =
        m15Closed.slice(
            -(
                CFG.BREAKOUT_LOOKBACK +
                1
            ),
            -1
        );

    const localHigh =
        Math.max(
            ...previous.map(
                candle =>
                    n(candle[2])
            )
        );

    const localLow =
        Math.min(
            ...previous.map(
                candle =>
                    n(candle[3])
            )
        );

    const vr =
        volumeRatio(
            m15,
            20
        );

    const atr15 =
        atr(
            m15,
            14
        ) ||
        last * 0.006;

    const r =
        rsi(
            m15,
            14
        );

    let direction =
        null;

    let breakoutLevel =
        0;

    if (
        last >
            localHigh &&
        vr >=
            CFG.BREAKOUT_VOL
    ) {

        direction =
            'LONG';

        breakoutLevel =
            localHigh;

    }
    else if (
        last <
            localLow &&
        vr >=
            CFG.BREAKOUT_VOL
    ) {

        direction =
            'SHORT';

        breakoutLevel =
            localLow;

    }

    const distanceHigh =
        Math.abs(
            last -
            localHigh
        ) /
        last;

    const distanceLow =
        Math.abs(
            last -
            localLow
        ) /
        last;

    let preparing =
        null;

    if (
        !direction
    ) {

        if (
            distanceHigh <=
                CFG.MAX_ENTRY_DISTANCE &&
            h4Trend !==
                'SHORT' &&
            h2Trend !==
                'SHORT'
        ) {

            preparing = {

                direction:
                    'LONG',

                trigger:
                    localHigh,

                distance:
                    distanceHigh *
                    100

            };

        }
        else if (
            distanceLow <=
                CFG.MAX_ENTRY_DISTANCE &&
            h4Trend !==
                'LONG' &&
            h2Trend !==
                'LONG'
        ) {

            preparing = {

                direction:
                    'SHORT',

                trigger:
                    localLow,

                distance:
                    distanceLow *
                    100

            };

        }

    }

    let score =
        row.radarScore *
        0.35;

    if (
        direction &&
        direction ===
            h4Trend
    ) {

        score +=
            20;

    }

    if (
        direction &&
        direction ===
            h2Trend
    ) {

        score +=
            20;

    }

    if (
        vr >= 1.5
    ) {

        score +=
            10;

    }
    else if (
        vr >=
        CFG.BREAKOUT_VOL
    ) {

        score +=
            5;

    }

    if (
        direction ===
            'LONG' &&
        r >= 45 &&
        r <= 72
    ) {

        score +=
            5;

    }

    if (
        direction ===
            'SHORT' &&
        r >= 28 &&
        r <= 55
    ) {

        score +=
            5;

    }

    return {

        ...row,

        h4Trend,

        h2Trend,

        nearbyLevel:
            direction
                ? breakoutLevel
                : (
                    preparing
                        ? preparing.trigger
                        : (
                            h4Trend ===
                            'LONG'
                                ? h4Levels.high
                                : h4Levels.low
                        )
                ),

        nearbyLevelType:
            direction
                ? 'BREAKOUT'
                : 'WATCH',

        rsi:
            round(
                r,
                1
            ),

        volumeRatio:
            round(
                vr,
                2
            ),

        atr15,

        score:
            Math.round(
                clamp(
                    score,
                    0,
                    100
                )
            ),

        breakout:
            Boolean(
                direction
            ),

        direction,

        breakoutLevel,

        preparing

    };

}

/* =========================================================
   TRADE PLAN
========================================================= */

function makePlan(
    analysis
) {

    const direction =
        analysis.direction;

    const level =
        n(
            analysis.breakoutLevel ||
            analysis.nearbyLevel
        );

    const current =
        n(
            analysis.price
        );

    const atrValue =
        n(
            analysis.atr15
        ) ||
        current *
        0.006;

    let entryLow;
    let entryHigh;
    let entry;

    if (
        direction ===
        'LONG'
    ) {

        entryLow =
            level;

        entryHigh =
            level *
            (
                1 +
                CFG.ENTRY_ZONE
            );

        entry =
            (
                entryLow +
                entryHigh
            ) /
            2;

    }
    else {

        entryLow =
            level *
            (
                1 -
                CFG.ENTRY_ZONE
            );

        entryHigh =
            level;

        entry =
            (
                entryLow +
                entryHigh
            ) /
            2;

    }

    let stop;

    if (
        direction ===
        'LONG'
    ) {

        stop =
            level -
            atrValue *
            CFG.ATR_STOP;

    }
    else {

        stop =
            level +
            atrValue *
            CFG.ATR_STOP;

    }

    const minimumRisk =
        Math.max(
            current *
            0.004,
            Number.EPSILON
        );

    if (
        Math.abs(
            entry -
            stop
        ) <
        minimumRisk
    ) {

        if (
            direction ===
            'LONG'
        ) {

            stop =
                entry -
                minimumRisk;

        }
        else {

            stop =
                entry +
                minimumRisk;

        }

    }

    const risk =
        Math.abs(
            entry -
            stop
        );

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
            2.25;

        tp3 =
            entry +
            risk *
            3.25;

    }
    else {

        tp1 =
            entry -
            risk *
            CFG.MIN_RR;

        tp2 =
            entry -
            risk *
            2.25;

        tp3 =
            entry -
            risk *
            3.25;

    }

    return {

        entry,

        entryLow,

        entryHigh,

        stop,

        tp1,

        tp2,

        tp3,

        risk,

        rr:
            CFG.MIN_RR

    };

}

/* =========================================================
   5M CONFIRMATION
========================================================= */

async function confirm5m(
    symbol,
    direction
) {

    try {

        const candles =
            await exchange.fetchOHLCV(
                symbol,
                '5m',
                undefined,
                CFG.M5
            );

        const c =
            closed(
                candles
            );

        if (
            c.length < 20
        ) {

            return {

                ok:
                    false,

                candles

            };

        }

        const last =
            c[
                c.length - 1
            ];

        const previous =
            c[
                c.length - 2
            ];

        const ratio =
            volumeRatio(
                candles,
                20
            );

        const body =
            Math.abs(
                n(last[4]) -
                n(last[1])
            );

        const range =
            Math.max(
                n(last[2]) -
                n(last[3]),
                1e-12
            );

        const bullish =
            n(last[4]) >
                n(last[1]) &&
            n(last[4]) >=
                n(previous[4]);

        const bearish =
            n(last[4]) <
                n(last[1]) &&
            n(last[4]) <=
                n(previous[4]);

        const directional =
            direction ===
            'LONG'
                ? bullish
                : bearish;

        const ok =
            ratio >= 0.90 &&
            directional &&
            body /
                range >=
                0.25;

        return {

            ok,

            volumeRatio:
                ratio,

            candles

        };

    }
    catch (_) {

        return {

            ok:
                false,

            candles:
                []

        };

    }

}

/* =========================================================
   SIGNAL
========================================================= */

function signalKey(
    symbol,
    direction
) {

    return (
        symbol +
        ':' +
        direction
    );

}

function createSignal(
    analysis,
    plan,
    five
) {

    const reason = [

        '4H ' +
        analysis.h4Trend,

        '2H ' +
        analysis.h2Trend,

        '15M BREAKOUT',

        'VOL ' +
        analysis.volumeRatio +
        'x',

        'RSI ' +
        analysis.rsi,

        five.ok
            ? '5M TEYİT'
            : '5M ZAYIF'

    ].join(
        ' • '
    );

    return {

        symbol:
            analysis.symbol,

        coin:
            cleanSymbol(
                analysis.symbol
            ),

        direction:
            analysis.direction,

        price:
            analysis.price,

        score:
            Math.min(
                100,
                analysis.score +
                (
                    five.ok
                        ? 8
                        : 0
                )
            ),

        strategy:
            '4H + 2H → 15M Breakout → Retest → 5M',

        entry:
            round(
                plan.entry,
                8
            ),

        entryLow:
            round(
                plan.entryLow,
                8
            ),

        entryHigh:
            round(
                plan.entryHigh,
                8
            ),

        stop:
            round(
                plan.stop,
                8
            ),

        tp1:
            round(
                plan.tp1,
                8
            ),

        tp2:
            round(
                plan.tp2,
                8
            ),

        tp3:
            round(
                plan.tp3,
                8
            ),

        rr:
            plan.rr,

        rsi:
            analysis.rsi,

        volumeRatio:
            analysis.volumeRatio,

        breakoutLevel:
            round(
                analysis.breakoutLevel,
                8
            ),

        reason,

        status:
            'GİRİŞ BEKLENİYOR',

        entryReady:
            false,

        signalAt:
            Date.now(),

        updatedAt:
            Date.now(),

        timeframe:
            '15m'

    };

}

/* =========================================================
   PENDING
========================================================= */

function addPending(
    analysis
) {

    if (
        !analysis.preparing
    ) {

        return;

    }

    const key =
        signalKey(
            analysis.symbol,
            analysis.preparing.direction
        );

    if (
        STATE.pending.has(
            key
        )
    ) {

        return;

    }

    STATE.pending.set(
        key,
        {

            symbol:
                analysis.symbol,

            direction:
                analysis.preparing.direction,

            level:
                analysis.preparing.trigger,

            price:
                analysis.price,

            distance:
                round(
                    analysis.preparing.distance,
                    2
                ),

            rsi:
                analysis.rsi,

            volumeRatio:
                analysis.volumeRatio,

            status:
                'WAITING_BREAKOUT',

            createdAt:
                Date.now(),

            expiresAt:
                Date.now() +
                CFG.PENDING_TTL

        }
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

        const terminal =
            [
                'STOP',
                'TP3',
                'KAÇTI'
            ].includes(
                signal.status
            );

        if (
            terminal ||
            now -
                signal.signalAt >
                CFG.SIGNAL_TTL
        ) {

            STATE.history.unshift({

                ...signal,

                closedAt:
                    now,

                closedReason:
                    terminal
                        ? signal.status
                        : 'TTL'

            });

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
            now >
            pending.expiresAt
        ) {

            STATE.pending.delete(
                key
            );

        }

    }

    STATE.history =
        STATE.history.slice(
            0,
            30
        );

}

/* =========================================================
   LIVE SIGNAL UPDATE
========================================================= */

async function updateLive() {

    const symbols =
        [
            ...STATE.signals.values(),
            ...STATE.pending.values()
        ]
        .map(
            item =>
                item.symbol
        );

    const unique =
        [
            ...new Set(
                symbols
            )
        ];

    if (
        !unique.length
    ) {

        return;

    }

    const prices =
        await mapLimit(
            unique,
            CFG.CONCURRENCY,
            async symbol => {

                try {

                    const ticker =
                        await exchange.fetchTicker(
                            symbol
                        );

                    return {

                        symbol,

                        price:
                            n(
                                ticker.last ||
                                ticker.close
                            )

                    };

                }
                catch (_) {

                    return null;

                }

            }
        );

    const priceMap =
        new Map(
            prices.map(
                item => [
                    item.symbol,
                    item.price
                ]
            )
        );

    for (
        const [
            key,
            signal
        ]
        of STATE.signals
    ) {

        const current =
            priceMap.get(
                signal.symbol
            );

        if (
            !Number.isFinite(
                current
            )
        ) {

            continue;

        }

        signal.price =
            current;

        signal.updatedAt =
            Date.now();

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
                    signal.entryLow &&
                current <=
                    signal.entryHigh
            ) {

                signal.status =
                    'GİRİŞ ALANI';

                signal.entryReady =
                    true;

            }
            else if (
                current >
                signal.entryHigh *
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
                current >=
                signal.stop
            ) {

                signal.status =
                    'STOP';

            }
            else if (
                current <=
                signal.tp3
            ) {

                signal.status =
                    'TP3';

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
            else if (
                current <
                signal.entryLow *
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

    cleanup();

    STATE.stats.signals =
        STATE.signals.size;

    STATE.stats.pending =
        STATE.pending.size;

    broadcast();

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

    try {

        if (
            !STATE.markets.length ||
            Date.now() -
                STATE.marketsAt >
                CFG.MARKET_REFRESH_MS
        ) {

            await loadMarkets();

            STATE.marketsAt =
                Date.now();

        }

        const rows =
            await fetchTickersSafe();

        STATE.market =
            marketDirection(
                rows
            );

        STATE.stats.universe =
            rows.length;

        STATE.candidates =
            buildCandidates(
                rows
            );

        STATE.stats.candidates =
            STATE.candidates.length;

        STATE.deepWatch =
            STATE.candidates.slice(
                0,
                CFG.DEEP
            );

        STATE.stats.deep =
            STATE.deepWatch.length;

        const analyzed =
            await mapLimit(
                STATE.deepWatch,
                CFG.CONCURRENCY,
                analyzeCoin
            );

        STATE.stats.analyzed =
            analyzed.length;

        const analyzedMap =
            new Map(
                analyzed.map(
                    item => [
                        item.symbol,
                        item
                    ]
                )
            );

        STATE.deepWatch =
            STATE.deepWatch.map(
                item =>
                    analyzedMap.get(
                        item.symbol
                    ) ||
                    item
            );

        for (
            const analysis
            of analyzed
        ) {

            addPending(
                analysis
            );

            if (
                !analysis.breakout
            ) {

                continue;

            }

            if (
                !analysis.direction
            ) {

                continue;

            }

            if (
                analysis.score <
                CFG.MIN_SCORE
            ) {

                continue;

            }

            const five =
                await confirm5m(
                    analysis.symbol,
                    analysis.direction
                );

            if (
                CFG.REQUIRE_5M &&
                !five.ok
            ) {

                continue;

            }

            const plan =
                makePlan(
                    analysis
                );

            const key =
                signalKey(
                    analysis.symbol,
                    analysis.direction
                );

            const old =
                STATE.signals.get(
                    key
                );

            if (
                !old ||
                Date.now() -
                    old.signalAt >
                    CFG.SIGNAL_TTL
            ) {

                STATE.signals.set(
                    key,
                    createSignal(
                        analysis,
                        plan,
                        five
                    )
                );

            }

        }

        cleanup();

        STATE.lastScan =
            Date.now();

        STATE.stats.signals =
            STATE.signals.size;

        STATE.stats.pending =
            STATE.pending.size;

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
    catch (error) {

        STATE.lastError =
            error &&
            error.message
                ? error.message
                : String(error);

        console.error(
            'RADAR ERROR:',
            STATE.lastError
        );

    }
    finally {

        STATE.scanning =
            false;

        broadcast();

    }

}

/* =========================================================
   PUBLIC DATA
========================================================= */

function publicSignal(
    signal
) {

    return {

        ...signal,

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

function publicWatch(
    coin
) {

    return {

        symbol:
            cleanSymbol(
                coin.symbol
            ),

        marketSymbol:
            coin.symbol,

        price:
            coin.price,

        change24h:
            coin.percentage,

        volume24h:
            coin.quoteVolume,

        radarScore:
            coin.radarScore,

        score:
            coin.score ||
            coin.radarScore,

        trend:
            coin.h4Trend ||
            'NEUTRAL',

        level:
            coin.nearbyLevel ||
            null,

        levelType:
            coin.nearbyLevelType ||
            null

    };

}

function getStatus() {

    return {

        success:
            true,

        engine:
            'SONNY AI TRADER V5.1',

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

            deepWatch:
                STATE.stats.deep,

            analyzed:
                STATE.stats.analyzed,

            pending:
                STATE.pending.size,

            pendingBreakouts:
                STATE.pending.size,

            signals:
                STATE.signals.size

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
                ),

        watchlist:
            STATE.deepWatch.map(
                publicWatch
            ),

        history:
            STATE.history
                .slice(
                    0,
                    20
                )
                .map(
                    publicSignal
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

        try {

            ws.send(
                JSON.stringify({

                    type:
                        'snapshot',

                    data:
                        getStatus()

                })
            );

        }
        catch (_) {}

    }
);

/* =========================================================
   MARKET FIND
========================================================= */

function findMarket(
    query
) {

    const target =
        rawSymbol(
            query
        );

    return (

        STATE.markets.find(
            market =>
                market.symbol ===
                target
        ) ||

        STATE.markets.find(
            market =>
                cleanSymbol(
                    market.symbol
                ) ===
                cleanSymbol(
                    query
                )
        )

    );

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
                'Sonny AI Trader V5.1',

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

            deep:
                STATE.stats.deep,

            signals:
                STATE.signals.size,

            pending:
                STATE.pending.size,

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
            getStatus()
        );

    }
);

app.get(
    '/api/signals',
    (
        req,
        res
    ) => {

        const status =
            getStatus();

        res.json({

            success:
                true,

            signals:
                status.signals,

            pending:
                status.pending,

            stats:
                status.stats,

            market:
                status.market

        });

    }
);

app.get(
    '/api/scalp-radar',
    (
        req,
        res
    ) => {

        res.json(
            getStatus()
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

            const allowed =
                [
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

            const candles =
                await exchange.fetchOHLCV(
                    market.symbol,
                    timeframe,
                    undefined,
                    CFG.CHART
                );

            const signal =
                [
                    ...STATE.signals.values()
                ].find(
                    item =>
                        item.symbol ===
                        market.symbol
                ) ||

                [
                    ...STATE.pending.values()
                ].find(
                    item =>
                        item.symbol ===
                        market.symbol
                ) ||

                null;

            STATE.selected =
                market.symbol;

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
    Sonny AI Trader V5.1
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

    font:inherit;

}

.app{

    width:100%;

    height:100vh;

    display:grid;

    grid-template-columns:
        245px
        1fr
        280px;

}

.side,
.right{

    background:#0b0f16;

    border-color:#202936;

}

.side{

    border-right:
        1px solid #202936;

    padding:12px;

    overflow:auto;

}

.right{

    border-left:
        1px solid #202936;

    padding:12px;

    overflow:auto;

}

.brand{

    font-size:18px;

    font-weight:900;

}

.brand small{

    display:block;

    color:#718096;

    font-size:9px;

    margin-top:4px;

}

.radarStats{

    display:grid;

    grid-template-columns:
        repeat(
            3,
            1fr
        );

    gap:5px;

    margin-top:12px;

}

.stat{

    background:#101722;

    border:
        1px solid #202b39;

    border-radius:7px;

    padding:7px;

}

.stat span{

    display:block;

    color:#718096;

    font-size:8px;

}

.stat b{

    display:block;

    margin-top:2px;

    font-size:13px;

}

.scan{

    width:100%;

    margin:
        10px 0;

    background:#17233b;

    color:#fff;

    border:
        1px solid #2b416b;

    border-radius:8px;

    padding:9px;

    cursor:pointer;

}

.cards{

    display:grid;

    gap:7px;

}

.card{

    background:#0f151e;

    border:
        1px solid #202b39;

    border-radius:10px;

    padding:9px;

    cursor:pointer;

}

.card:hover,
.card.active{

    border-color:#4776ff;

}

.cardTop{

    display:flex;

    justify-content:space-between;

    gap:4px;

}

.coin{

    font-weight:900;

    font-size:12px;

}

.price{

    font-size:15px;

    font-weight:900;

    margin-top:5px;

}

.meta{

    font-size:9px;

    color:#778397;

    margin-top:4px;

}

.tag{

    font-size:8px;

    padding:
        3px 5px;

    border-radius:5px;

    background:#17233b;

}

.long{

    color:#2be19b;

}

.short{

    color:#ff5d6d;

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
        0 14px;

    display:flex;

    align-items:center;

    justify-content:space-between;

}

.title{

    font-size:18px;

    font-weight:900;

}

.sub{

    font-size:9px;

    color:#788598;

    margin-top:4px;

}

.stats{

    display:flex;

    gap:12px;

    color:#778397;

    font-size:9px;

}

.stats b{

    color:#eef3f8;

}

.chartwrap{

    position:relative;

    flex:1;

    min-height:0;

    background:#070a0f;

}

.toolbar{

    position:absolute;

    z-index:2;

    left:12px;

    right:12px;

    top:10px;

    display:flex;

    justify-content:space-between;

    pointer-events:none;

}

.chartName{

    font-size:12px;

    font-weight:900;

}

.tf{

    display:flex;

    gap:4px;

    pointer-events:auto;

}

.tf button{

    background:#101722;

    color:#8995a6;

    border:
        1px solid #273241;

    border-radius:5px;

    padding:
        5px 8px;

    font-size:9px;

    cursor:pointer;

}

.tf button.active{

    color:#fff;

    background:#17233b;

    border-color:#4776ff;

}

canvas{

    display:block;

    width:100%;

    height:100%;

}

.box{

    background:#0f151e;

    border:
        1px solid #202b39;

    border-radius:11px;

    padding:11px;

    margin-bottom:10px;

}

.label{

    font-size:9px;

    color:#7e899a;

    font-weight:900;

}

.market{

    font-size:20px;

    font-weight:900;

    margin-top:5px;

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

.reason{

    font-size:9px;

    color:#778397;

    margin-top:5px;

    line-height:1.4;

}

.detailGrid{

    display:grid;

    grid-template-columns:
        1fr
        1fr;

    gap:5px;

    margin-top:9px;

}

.detail{

    background:#0a1017;

    padding:7px;

    border-radius:6px;

}

.detail span{

    display:block;

    color:#69778a;

    font-size:8px;

}

.detail b{

    display:block;

    margin-top:3px;

    font-size:11px;

}

.empty{

    color:#69778a;

    font-size:10px;

    line-height:1.5;

}

.pending{

    border-left:
        3px solid #e2a83d;

}

.signalHead{

    display:flex;

    justify-content:space-between;

    gap:5px;

}

.signalName{

    font-size:14px;

    font-weight:900;

}

.score{

    font-size:9px;

    padding:
        4px 6px;

    border-radius:5px;

    background:#17233b;

}

.plan{

    display:grid;

    grid-template-columns:
        1fr
        1fr;

    gap:5px;

    margin-top:9px;

}

.entry{

    color:#55a6ff;

}

.tp{

    color:#2be19b;

}

.sl{

    color:#ff5d6d;

}

.status{

    font-size:9px;

    margin-top:8px;

    font-weight:900;

}

.footer{

    font-size:8px;

    color:#59677a;

    line-height:1.4;

    margin-top:10px;

}

@media(max-width:950px){

    .app{

        grid-template-columns:
            200px
            1fr;

    }

    .right{

        display:none;

    }

}

@media(max-width:650px){

    .app{

        grid-template-columns:
            1fr;

    }

    .side{

        display:none;

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
        V5.1 • BITGET USDT FUTURES • AUTO TRADE KAPALI
    </small>

</div>

<div class="radarStats">

    <div class="stat">
        <span>RADAR</span>
        <b id="radar">0</b>
    </div>

    <div class="stat">
        <span>ADAY</span>
        <b id="candidate">0</b>
    </div>

    <div class="stat">
        <span>DERİN</span>
        <b id="deep">0</b>
    </div>

</div>

<button
    id="scan"
    class="scan"
>
    RADARI YENİLE
</button>

<div
    id="cards"
    class="cards"
>

    <div class="empty">
        Sistem tarama yapıyor...
    </div>

</div>

</aside>

<main class="main">

<header class="head">

<div>

    <div
        id="title"
        class="title"
    >
        BTCUSDT • 15M
    </div>

    <div class="sub">

        500 RADAR →
        150 ADAY →
        40 DERİN →
        4H + 2H →
        15M BREAKOUT →
        RETEST →
        5M

    </div>

</div>

<div class="stats">

    <span>
        ANALİZ
        <b id="analyzed">0</b>
    </span>

    <span>
        BEKLEYEN
        <b id="pendingCount">0</b>
    </span>

    <span>
        SİNYAL
        <b id="signalCount">0</b>
    </span>

</div>

</header>

<div class="chartwrap">

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
></canvas>

</div>

</main>

<aside class="right">

<div class="box">

    <div class="label">
        GENEL PİYASA
    </div>

    <div
        id="marketDirection"
        class="market flat"
    >
        YÜKLENİYOR...
    </div>

    <div
        id="marketReason"
        class="reason"
    >
        Piyasa analiz ediliyor.
    </div>

    <div class="detailGrid">

        <div class="detail">
            <span>BREADTH</span>
            <b id="breadth">-</b>
        </div>

        <div class="detail">
            <span>ORTALAMA</span>
            <b id="average">-</b>
        </div>

    </div>

</div>

<div class="box">

    <div class="label">
        AKTİF SCALP SİNYALİ
    </div>

    <div id="activeSignal">

        <div class="empty">
            Henüz teyit edilmiş scalp sinyali yok.
        </div>

    </div>

</div>

<div class="box">

    <div class="label">
        BEKLEYEN BREAKOUT / RETEST
    </div>

    <div id="pendingList">

        <div class="empty">
            Bekleyen setup yok.
        </div>

    </div>

</div>

<div class="box">

    <div class="label">
        SİSTEM
    </div>

    <div class="status">

        <span
            id="dot"
            style="
                display:inline-block;
                width:7px;
                height:7px;
                border-radius:50%;
                background:#ff5d6d
            "
        ></span>

        <span id="connection">
            BAĞLANIYOR
        </span>

    </div>

    <div
        id="error"
        class="reason"
    ></div>

    <div class="footer">

        Sinyal;

        4H / 2H yönü,
        15M breakout,
        retest,
        RSI ve 5M teyidi
        birlikte uygunsa oluşturulur.

        Auto Trade kapalıdır.

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
        null,

    timeframe:
        '15m',

    candles:
        []

};

function $(
    id
){

    return document.getElementById(
        id
    );

}

function num(
    value
){

    var x =
        Number(
            value
        );

    return Number.isFinite(
        x
    )
        ? x
        : null;

}

function price(
    value
){

    var x =
        num(
            value
        );

    if (
        x === null
    ){

        return '-';

    }

    var digits =
        x >= 100
            ? 2
            : x >= 1
                ? 4
                : x >= 0.01
                    ? 6
                    : 8;

    return x.toFixed(
        digits
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
            /[&<>\"']/g,
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

                    '\"':
                        '&quot;',

                    "'":
                        '&#39;'

                }[c];

            }
        );

}

function volume(
    value
){

    var x =
        Number(
            value
        );

    if (
        !Number.isFinite(x)
    ){

        return '-';

    }

    if (
        x >= 1000000000
    ){

        return (
            x /
            1000000000
        ).toFixed(
            1
        ) +
        'B';

    }

    if (
        x >= 1000000
    ){

        return (
            x /
            1000000
        ).toFixed(
            1
        ) +
        'M';

    }

    if (
        x >= 1000
    ){

        return (
            x /
            1000
        ).toFixed(
            0
        ) +
        'K';

    }

    return x.toFixed(
        0
    );

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

    $('radar')
        .textContent =
            stats.universe ||
            0;

    $('candidate')
        .textContent =
            stats.candidates ||
            0;

    $('deep')
        .textContent =
            stats.deep ||
            stats.deepWatch ||
            0;

    $('analyzed')
        .textContent =
            stats.analyzed ||
            0;

    $('pendingCount')
        .textContent =
            stats.pending ||
            stats.pendingBreakouts ||
            0;

    $('signalCount')
        .textContent =
            (
                data.signals ||
                []
            ).length;

    var market =
        data.market ||
        {};

    $('marketDirection')
        .textContent =
            market.label ||
            'YATAY';

    $('marketDirection')
        .className =
            'market ' +
            (
                market.direction ===
                'LONG'
                    ? 'up'
                    : market.direction ===
                      'SHORT'
                        ? 'down'
                        : 'flat'
            );

    $('marketReason')
        .textContent =
            market.reason ||
            '';

    $('breadth')
        .textContent =
            market.breadth ==
            null
                ? '-'
                : market.breadth +
                  '%';

    $('average')
        .textContent =
            market.average ==
            null
                ? '-'
                : market.average +
                  '%';

    var signals =
        data.signals ||
        [];

    var active =
        signals[0];

    if (
        active
    ){

        state.selected =
            active.symbol;

        renderActive(
            active
        );

    }

    if (
        !state.selected &&
        data.watchlist &&
        data.watchlist[0]
    ){

        state.selected =
            data.watchlist[0]
                .marketSymbol;

    }

    var cards =
        data.watchlist ||
        [];

    var html =
        '';

    cards.forEach(
        function(
            item
        ){

            var cls =
                item.trend ===
                'LONG'
                    ? 'long'
                    : item.trend ===
                      'SHORT'
                        ? 'short'
                        : '';

            html +=
                '<div class="card ' +
                (
                    state.selected ===
                    item.marketSymbol
                        ? 'active'
                        : ''
                ) +
                '" data-symbol="' +
                esc(
                    item.marketSymbol
                ) +
                '">' +

                '<div class="cardTop">' +

                '<span class="coin ' +
                cls +
                '">' +
                esc(
                    item.symbol
                ) +
                '</span>' +

                '<span class="tag">' +
                'RADAR' +
                '</span>' +

                '</div>' +

                '<div class="price">' +
                price(
                    item.price
                ) +
                '</div>' +

                '<div class="meta">' +

                '24H ' +

                (
                    item.change24h ==
                    null
                        ? '-'
                        : Number(
                            item.change24h
                        ).toFixed(
                            2
                        )
                ) +

                '% • HACİM ' +

                volume(
                    item.volume24h
                ) +

                '</div>' +

                '</div>';

        }
    );

    $('cards')
        .innerHTML =
            html ||
            '<div class="empty">' +
            'Aday bulunamadı.' +
            '</div>';

    Array.prototype.forEach.call(
        document.querySelectorAll(
            '.card'
        ),
        function(
            element
        ){

            element.onclick =
                function(){

                    state.selected =
                        element.getAttribute(
                            'data-symbol'
                        );

                    Array.prototype.forEach.call(
                        document.querySelectorAll(
                            '.card'
                        ),
                        function(
                            card
                        ){

                            card.classList
                                .remove(
                                    'active'
                                );

                        }
                    );

                    element.classList.add(
                        'active'
                    );

                    loadChart();

                };

        }
    );

    renderPending(
        data.pending ||
        []
    );

    renderConnection(
        !data.error
    );

    if (
        state.selected
    ){

        loadChart();

    }

}

/* =========================================================
   ACTIVE SIGNAL
========================================================= */

function renderActive(
    signal
){

    $('activeSignal')
        .innerHTML =

        '<div class="signalHead">' +

        '<div class="signalName ' +
        (
            signal.direction ===
            'LONG'
                ? 'long'
                : 'short'
        ) +
        '">' +

        esc(
            signal.coin ||
            signal.symbol
        ) +

        ' ' +

        esc(
            signal.direction
        ) +

        '</div>' +

        '<div class="score">' +

        'GÜÇ ' +

        esc(
            signal.score
        ) +

        '/100' +

        '</div>' +

        '</div>' +

        '<div class="status">' +

        esc(
            signal.status ||
            'GİRİŞ BEKLENİYOR'
        ) +

        ' • RSI ' +

        esc(
            signal.rsi
        ) +

        '</div>' +

        '<div class="plan">' +

        detail(
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

        detail(
            'STOP',
            price(
                signal.stop
            ),
            'sl'
        ) +

        detail(
            'TP1',
            price(
                signal.tp1
            ),
            'tp'
        ) +

        detail(
            'TP2',
            price(
                signal.tp2
            ),
            'tp'
        ) +

        detail(
            'TP3',
            price(
                signal.tp3
            ),
            'tp'
        ) +

        detail(
            'R:R',
            '1:' +
            (
                signal.rr ||
                '1.5'
            ),
            ''
        ) +

        '</div>' +

        '<div class="reason">' +

        esc(
            signal.reason ||
            ''
        ) +

        '</div>';

}

function detail(
    label,
    value,
    cls
){

    return (

        '<div class="detail">' +

        '<span>' +
        label +
        '</span>' +

        '<b class="' +
        cls +
        '">' +
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
        $('pendingList');

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
        '';

    items
        .slice(
            0,
            10
        )
        .forEach(
            function(
                item
            ){

                var element =
                    document.createElement(
                        'div'
                    );

                element.className =
                    'box pending';

                element.style.margin =
                    '0 0 7px 0';

                element.innerHTML =

                    '<div class="signalName ' +
                    (
                        item.direction ===
                        'LONG'
                            ? 'long'
                            : 'short'
                    ) +
                    '">' +

                    esc(
                        item.symbol
                            .replace(
                                '/USDT:USDT',
                                'USDT'
                            )
                    ) +

                    ' ' +

                    esc(
                        item.direction
                    ) +

                    '</div>' +

                    '<div class="meta">' +

                    'Seviye ' +

                    price(
                        item.level
                    ) +

                    ' • Fiyat ' +

                    price(
                        item.price
                    ) +

                    '</div>' +

                    '<div class="meta">' +

                    'VOL ' +

                    Number(
                        item.volumeRatio ||
                        1
                    ).toFixed(
                        2
                    ) +

                    'x • ' +

                    esc(
                        item.status
                    ) +

                    '</div>';

                box.appendChild(
                    element
                );

            }
        );

}

/* =========================================================
   CONNECTION
========================================================= */

function renderConnection(
    online
){

    $('dot')
        .style
        .background =
            online
                ? '#2be19b'
                : '#ff5d6d';

    $('connection')
        .textContent =
            online
                ? 'SİSTEM AKTİF'
                : 'HATA';

    $('error')
        .textContent =
            (
                state.data &&
                state.data.error
            ) ||
            '';

}

/* =========================================================
   STATUS
========================================================= */

async function getStatus(){

    try {

        var response =
            await fetch(
                '/api/status',
                {
                    cache:
                        'no-store'
                }
            );

        var data =
            await response.json();

        render(
            data
        );

    }
    catch (
        error
    ){

        renderConnection(
            false
        );

    }

}

/* =========================================================
   CHART
========================================================= */

async function loadChart(){

    if (
        !state.selected
    ){

        return;

    }

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

        var signal =
            data.signal;

        if (
            !signal &&
            state.data
        ){

            signal =
                (
                    state.data.signals ||
                    []
                ).find(
                    function(
                        item
                    ){

                        return (
                            item.symbol ===
                                state.selected ||
                            item.coin ===
                                state.selected
                                    .replace(
                                        '/USDT:USDT',
                                        'USDT'
                                    )
                        );

                    }
                ) ||
                null;

        }

        var displaySymbol =
            state.selected
                .replace(
                    '/USDT:USDT',
                    'USDT'
                );

        $('title')
            .textContent =
                displaySymbol +
                ' • ' +
                state.timeframe
                    .toUpperCase();

        $('chartName')
            .textContent =
                displaySymbol +
                ' • ' +
                state.timeframe
                    .toUpperCase();

        drawChart(
            state.candles,
            signal
        );

    }
    catch (
        error
    ){

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

    var canvas =
        $('chart');

    var rect =
        canvas.getBoundingClientRect();

    var dpr =
        window.devicePixelRatio ||
        1;

    var width =
        Math.max(
            300,
            rect.width
        );

    var height =
        Math.max(
            250,
            rect.height
        );

    canvas.width =
        width *
        dpr;

    canvas.height =
        height *
        dpr;

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

    if (
        !candles.length
    ){

        ctx.fillStyle =
            '#69778a';

        ctx.font =
            '12px Arial';

        ctx.fillText(
            'Grafik verisi bekleniyor...',
            20,
            40
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

    if (
        signal
    ){

        [

            signal.entry,
            signal.entryLow,
            signal.entryHigh,
            signal.stop,
            signal.tp1,
            signal.tp2,
            signal.tp3

        ]
            .forEach(
                function(
                    value
                ){

                    if (
                        Number.isFinite(
                            Number(
                                value
                            )
                        )
                    ){

                        values.push(
                            Number(
                                value
                            )
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

    var padding =
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
                    Number(
                        value
                    ) -
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

    var step =
        width /
        Math.max(
            candles.length - 1,
            1
        );

    /* GRID */

    ctx.strokeStyle =
        '#18212d';

    ctx.lineWidth =
        1;

    for (
        var grid =
            1;

        grid <
            6;

        grid++
    ){

        var gy =
            height *
            grid /
            6;

        ctx.beginPath();

        ctx.moveTo(
            0,
            gy
        );

        ctx.lineTo(
            width,
            gy
        );

        ctx.stroke();

    }

    /* CANDLES */

    candles.forEach(
        function(
            candle,
            index
        ){

            var x =
                index *
                step;

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
                    ? '#2be19b'
                    : '#ff5d6d';

            ctx.fillStyle =
                ctx.strokeStyle;

            ctx.beginPath();

            ctx.moveTo(
                x,
                y(high)
            );

            ctx.lineTo(
                x,
                y(low)
            );

            ctx.stroke();

            var top =
                y(
                    Math.max(
                        open,
                        close
                    )
                );

            var bottom =
                y(
                    Math.min(
                        open,
                        close
                    )
                );

            var candleWidth =
                Math.max(
                    2,
                    Math.min(
                        9,
                        step *
                        0.65
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

    /* SIGNAL LEVELS */

    if (
        signal
    ){

        drawLevel(
            ctx,
            width,
            y,
            signal.entryLow,
            'ENTRY',
            '#55a6ff'
        );

        drawLevel(
            ctx,
            width,
            y,
            signal.entryHigh,
            'ENTRY',
            '#55a6ff'
        );

        drawLevel(
            ctx,
            width,
            y,
            signal.stop,
            'STOP',
            '#ff5d6d'
        );

        drawLevel(
            ctx,
            width,
            y,
            signal.tp1,
            'TP1',
            '#2be19b'
        );

        drawLevel(
            ctx,
            width,
            y,
            signal.tp2,
            'TP2',
            '#2be19b'
        );

        drawLevel(
            ctx,
            width,
            y,
            signal.tp3,
            'TP3',
            '#2be19b'
        );

    }

}

/* =========================================================
   DRAW LEVEL
========================================================= */

function drawLevel(
    ctx,
    width,
    y,
    value,
    label,
    color
){

    var priceValue =
        Number(
            value
        );

    if (
        !Number.isFinite(
            priceValue
        )
    ){

        return;

    }

    var yy =
        y(
            priceValue
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
        0,
        yy
    );

    ctx.lineTo(
        width,
        yy
    );

    ctx.stroke();

    ctx.setLineDash(
        []
    );

    ctx.font =
        'bold 10px Arial';

    ctx.fillText(

        label +
        ' ' +
        price(
            priceValue
        ),

        8,

        Math.max(
            12,
            yy - 4
        )

    );

    ctx.restore();

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

                        item.classList
                            .remove(
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
   MANUAL SCAN
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
   REFRESH
========================================================= */

setInterval(
    getStatus,
    5000
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

window.addEventListener(
    'resize',
    function(){

        if (
            state.candles.length
        ){

            loadChart();

        }

    }
);

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

                }
                catch (_) {}

            };

        ws.onclose =
            function(){

                setTimeout(
                    connect,
                    3000
                );

            };

    }
    catch (_) {

        setTimeout(
            connect,
            3000
        );

    }

}

/* =========================================================
   START FRONTEND
========================================================= */

connect();

getStatus();

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
            .type(
                'html'
            )
            .send(
                HTML
            );

    }
);

/* =========================================================
   PROCESS SAFETY
========================================================= */

process.on(
    'unhandledRejection',
    error => {

        STATE.lastError =
            error &&
            error.message
                ? error.message
                : String(error);

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
                : String(error);

        console.error(
            'UNCAUGHT:',
            STATE.lastError
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
            '=============================================='
        );

        try {

            await loadMarkets();

            STATE.marketsAt =
                Date.now();

            console.log(
                'MARKETS | Gerçek USDT perpetual=' +
                STATE.markets.length
            );

        }
        catch (error) {

            STATE.lastError =
                error.message;

            console.error(
                'MARKETS ERROR:',
                error.message
            );

        }

        runScan();

        setInterval(
            runScan,
            CFG.SCAN_MS
        );

        setInterval(
            function(){

                updateLive()
                    .catch(
                        function(error){

                            STATE.lastError =
                                error.message;

                        }
                    );

            },
            CFG.LIVE_MS
        );

    }
);
