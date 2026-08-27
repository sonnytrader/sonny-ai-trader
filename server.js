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

const CFG = {
    RADAR: 500,
    CANDIDATES: 150,
    DEEP: 60,

    MAX_SIGNALS: 15,

    MIN_VOLUME_USDT:
        Number(
            process.env.MIN_VOLUME_USDT ||
            3000000
        ),

    SCAN_MS: 60000,
    LIVE_MS: 10000,
    CONCURRENCY: 6,

    H4: 240,
    H2: 240,
    M15: 160,
    M5: 80,
    CHART: 160,

    LEVEL_LOOKBACK: 20,
    BREAKOUT_LOOKBACK: 12,
    PIVOT_SPAN: 2,

    LEVEL_CLUSTER_PCT: 0.0035,
    MIN_TOUCHES: 2,

    BREAKOUT_VOL: 1.15,

    RETEST_TOL: 0.0045,
    RETEST_MIN: 120 * 60 * 1000,

    MIN_SCORE: 70,

    MIN_RR: 1.50,
    TP2_RR: 2.25,
    TP3_RR: 3.25,

    ATR_STOP: 1.00,

    SIGNAL_TTL:
        45 * 60 * 1000,

    COOLDOWN:
        4 * 60 * 60 * 1000,

    FIVE_MIN_REQUIRED: false,

    AUTO_TRADE: false
};

const exchange =
    new ccxt.bitget({
        enableRateLimit: true,
        timeout: 25000,
        options: {
            defaultType: 'swap'
        }
    });

const STATE = {

    markets: [],
    marketMap: new Map(),

    universe: [],
    candidates: [],
    deep: [],

    signals: new Map(),
    pending: new Map(),
    cooldowns: new Map(),

    selected:
        'BTC/USDT:USDT',

    selectedTf:
        '15m',

    scanning: false,

    lastScan: 0,

    lastError: '',

    market: {
        label:
            'YATAY / KARIŞIK',

        direction:
            'FLAT',

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

function n(
    v,
    d = 0
) {

    const x =
        Number(v);

    return Number.isFinite(x)
        ? x
        : d;
}


function avg(a) {

    return a.length
        ? a.reduce(
            (s, v) =>
                s + v,
            0
        ) / a.length
        : 0;
}


function sleep(ms) {

    return new Promise(
        r => setTimeout(
            r,
            ms
        )
    );
}


function closed(c) {

    return Array.isArray(c) &&
        c.length > 1

        ? c.slice(
            0,
            -1
        )

        : (
            c || []
        );
}


function cleanSymbol(s) {

    let x =
        String(
            s || ''
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
        x.endsWith(
            'USDT'
        )
    ) {

        x =
            x.slice(
                0,
                -4
            );
    }

    return x + 'USDT';
}


function fmt(v) {

    const x =
        Number(v);

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
   MARKET
========================================================= */

function findMarket(
    symbol
) {

    const wanted =
        cleanSymbol(
            symbol
        );

    if (
        !STATE.markets.length
    ) {

        return null;
    }

    return (
        STATE.markets.find(
            m =>
                cleanSymbol(
                    m.symbol
                ) === wanted
        ) ||
        null
    );
}


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
            m =>
                m &&
                m.active !== false &&
                m.swap === true &&
                m.linear === true &&
                m.quote === 'USDT' &&
                m.settle === 'USDT'
        );

    STATE.marketMap =
        new Map(
            STATE.markets.map(
                m => [
                    m.symbol,
                    m
                ]
            )
        );
}


/* =========================================================
   CANDLES
========================================================= */

async function getCandles(
    symbol,
    tf,
    limit
) {

    const data =
        await exchange.fetchOHLCV(
            symbol,
            tf,
            undefined,
            limit
        );

    return Array.isArray(
        data
    )
        ? data
            .filter(
                x =>
                    Array.isArray(x) &&
                    x.length >= 6
            )
            .sort(
                (a, b) =>
                    a[0] - b[0]
            )

        : [];
}


/* =========================================================
   TICKERS
========================================================= */

async function getTickers() {

    const tickers =
        await exchange.fetchTickers();

    const rows = [];

    for (
        const m of STATE.markets
    ) {

        const t =
            tickers[
                m.symbol
            ];

        if (!t) {

            continue;
        }

        const last =
            n(
                t.last ||
                t.close
            );

        const volume =
            n(
                t.quoteVolume
            );

        if (
            !(last > 0) ||
            !(volume > 0)
        ) {

            continue;
        }

        const high =
            n(t.high);

        const low =
            n(t.low);

        rows.push({

            symbol:
                m.symbol,

            price:
                last,

            volume,

            change:
                n(
                    t.percentage
                ),

            range:
                low > 0
                    ? (
                        (
                            high -
                            low
                        ) /
                        low
                    ) *
                    100
                    : 0
        });
    }

    rows.sort(
        (a, b) =>
            b.volume -
            a.volume
    );

    return rows.slice(
        0,
        CFG.RADAR
    );
}


/* =========================================================
   INDICATORS
========================================================= */

function ema(
    candles,
    p
) {

    const c =
        closed(
            candles
        );

    if (
        c.length < p
    ) {

        return null;
    }

    let e =
        avg(
            c
                .slice(
                    0,
                    p
                )
                .map(
                    x =>
                        n(x[4])
                )
        );

    const k =
        2 /
        (
            p + 1
        );

    for (
        let i = p;
        i < c.length;
        i++
    ) {

        e =
            n(
                c[i][4]
            ) *
            k
            +
            e *
            (
                1 - k
            );
    }

    return e;
}


function rsi(
    candles,
    p = 14
) {

    const c =
        closed(
            candles
        );

    if (
        c.length <
        p + 1
    ) {

        return 50;
    }

    let g = 0;
    let l = 0;

    for (
        let i =
            c.length - p;
        i < c.length;
        i++
    ) {

        const d =
            n(c[i][4]) -
            n(c[i - 1][4]);

        if (
            d > 0
        ) {

            g += d;

        }
        else {

            l -= d;
        }
    }

    if (
        l === 0
    ) {

        return 100;
    }

    const rs =
        (
            g / p
        ) /
        (
            l / p
        );

    return (
        100 -
        100 /
        (
            1 + rs
        )
    );
}


function atr(
    candles,
    p = 14
) {

    const c =
        closed(
            candles
        );

    if (
        c.length <
        p + 1
    ) {

        return 0;
    }

    const a = [];

    for (
        let i = 1;
        i < c.length;
        i++
    ) {

        const h =
            n(c[i][2]);

        const lo =
            n(c[i][3]);

        const pc =
            n(c[i - 1][4]);

        a.push(
            Math.max(
                h - lo,
                Math.abs(
                    h - pc
                ),
                Math.abs(
                    lo - pc
                )
            )
        );
    }

    return avg(
        a.slice(-p)
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
        c.length < 55
    ) {

        return 'NEUTRAL';
    }

    const e21 =
        ema(
            candles,
            21
        );

    const e50 =
        ema(
            candles,
            50
        );

    const last =
        n(
            c[
                c.length - 1
            ][4]
        );

    if (
        e21 === null ||
        e50 === null
    ) {

        return 'NEUTRAL';
    }

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


function structure(
    candles,
    lookback = 20
) {

    const c =
        closed(
            candles
        )
        .slice(
            -lookback
        );

    if (
        c.length < 8
    ) {

        return 'NEUTRAL';
    }

    const h =
        Math.floor(
            c.length / 2
        );

    const a =
        c.slice(
            0,
            h
        );

    const b =
        c.slice(
            h
        );

    const ah =
        Math.max(
            ...a.map(
                x =>
                    n(x[2])
            )
        );

    const al =
        Math.min(
            ...a.map(
                x =>
                    n(x[3])
            )
        );

    const bh =
        Math.max(
            ...b.map(
                x =>
                    n(x[2])
            )
        );

    const bl =
        Math.min(
            ...b.map(
                x =>
                    n(x[3])
            )
        );

    if (
        bh > ah &&
        bl > al
    ) {

        return 'LONG';
    }

    if (
        bh < ah &&
        bl < al
    ) {

        return 'SHORT';
    }

    return 'NEUTRAL';
}


function volumeRatio(
    candles,
    p = 20
) {

    const x =
        closed(
            candles
        );

    if (
        x.length <
        p + 1
    ) {

        return 1;
    }

    const cur =
        n(
            x[
                x.length - 1
            ][5]
        );

    const base =
        x
            .slice(
                -p - 1,
                -1
            )
            .map(
                z =>
                    n(z[5])
            )
            .filter(Boolean);

    const a =
        avg(base);

    return a > 0
        ? cur / a
        : 1;
}


/* =========================================================
   PIVOTS / LEVELS
========================================================= */

function pivots(
    candles,
    span =
        CFG.PIVOT_SPAN
) {

    const c =
        closed(
            candles
        );

    const out = [];

    if (
        c.length <
        span * 2 + 8
    ) {

        return out;
    }

    for (
        let i = span;
        i < c.length - span;
        i++
    ) {

        const hi =
            n(c[i][2]);

        const lo =
            n(c[i][3]);

        let isH = true;
        let isL = true;

        for (
            let j = 1;
            j <= span;
            j++
        ) {

            if (
                hi <=
                n(
                    c[i - j][2]
                ) ||
                hi <=
                n(
                    c[i + j][2]
                )
            ) {

                isH = false;
            }

            if (
                lo >=
                n(
                    c[i - j][3]
                ) ||
                lo >=
                n(
                    c[i + j][3]
                )
            ) {

                isL = false;
            }
        }

        if (isH) {

            out.push({
                price: hi,
                type:
                    'resistance',
                time:
                    c[i][0]
            });
        }

        if (isL) {

            out.push({
                price: lo,
                type:
                    'support',
                time:
                    c[i][0]
            });
        }
    }

    return out;
}


function getLevels(
    candles
) {

    const raw =
        pivots(
            candles
        );

    const groups = [];

    for (
        const point of raw
    ) {

        let group =
            groups.find(
                g =>
                    g.type ===
                        point.type
                    &&
                    Math.abs(
                        point.price -
                        g.price
                    ) /
                    Math.max(
                        g.price,
                        1e-12
                    )
                    <=
                    CFG.LEVEL_CLUSTER_PCT
            );

        if (!group) {

            group = {

                type:
                    point.type,

                price:
                    point.price,

                items: []
            };

            groups.push(
                group
            );
        }

        group.items.push(
            point
        );

        group.price =
            avg(
                group.items.map(
                    x =>
                        x.price
                )
            );
    }

    return groups

        .map(
            g => ({

                type:
                    g.type,

                price:
                    g.price,

                touches:
                    g.items.length,

                lastTouch:
                    Math.max(
                        ...g.items.map(
                            x =>
                                x.time
                        )
                    )
            })
        )

        .filter(
            g =>
                g.touches >=
                CFG.MIN_TOUCHES
        );
}


/* =========================================================
   BREAKOUT
========================================================= */

function detectBreakouts(
    candles,
    levels
) {

    const c =
        closed(
            candles
        );

    const out = [];

    if (
        c.length < 30
    ) {

        return out;
    }

    const start =
        Math.max(
            1,
            c.length - 8
        );

    for (
        let i = start;
        i < c.length;
        i++
    ) {

        const candle =
            c[i];

        const prev =
            c[i - 1];

        const history =
            c.slice(
                Math.max(
                    0,
                    i - 20
                ),
                i
            );

        const avgVol =
            avg(
                history.map(
                    x =>
                        n(x[5])
                )
                .filter(Boolean)
            );

        const vr =
            avgVol > 0
                ? n(
                    candle[5]
                ) /
                avgVol
                : 1;

        const body =
            Math.abs(
                n(candle[4]) -
                n(candle[1])
            );

        const range =
            Math.max(
                n(candle[2]) -
                n(candle[3]),
                1e-12
            );

        const bodyRatio =
            body /
            range;

        const atrValue =
            atr(
                candles
            ) ||
            n(
                candle[4]
            ) *
            0.003;

        const bodyAtr =
            body /
            Math.max(
                atrValue,
                1e-12
            );

        if (
            vr <
            CFG.BREAKOUT_VOL
        ) {

            continue;
        }

        if (
            bodyRatio <
            0.30
        ) {

            continue;
        }

        if (
            bodyAtr <
            0.35
        ) {

            continue;
        }

        for (
            const level of levels
        ) {

            const proximity =
                Math.abs(
                    n(prev[4]) -
                    level.price
                ) /
                Math.max(
                    level.price,
                    1e-12
                );

            if (
                proximity >
                0.006
            ) {

                continue;
            }

            const buffer =
                level.price *
                0.0012;


            /* LONG */

            if (
                level.type ===
                    'resistance'
                &&
                n(prev[4]) <=
                    level.price
                &&
                n(candle[4]) >
                    level.price +
                    buffer
            ) {

                out.push({

                    direction:
                        'LONG',

                    level,

                    time:
                        n(
                            candle[0]
                        ),

                    breakoutVolumeRatio:
                        vr,

                    breakoutBodyAtr:
                        bodyAtr,

                    bodyRatio
                });
            }


            /* SHORT */

            if (
                level.type ===
                    'support'
                &&
                n(prev[4]) >=
                    level.price
                &&
                n(candle[4]) <
                    level.price -
                    buffer
            ) {

                out.push({

                    direction:
                        'SHORT',

                    level,

                    time:
                        n(
                            candle[0]
                        ),

                    breakoutVolumeRatio:
                        vr,

                    breakoutBodyAtr:
                        bodyAtr,

                    bodyRatio
                });
            }
        }
    }

    return out.sort(
        (a, b) =>
            b.time -
            a.time
    );
}


/* =========================================================
   RETEST
========================================================= */

function retest(
    candles,
    p
) {

    const c =
        closed(
            candles
        );

    const after =
        c.filter(
            x =>
                n(x[0]) >
                p.breakoutTime
        );

    if (
        !after.length
    ) {

        return {

            status:
                'WAITING_RETEST',

            quality:
                0
        };
    }

    if (
        Date.now() -
        p.breakoutTime >
        CFG.RETEST_MIN
    ) {

        return {

            status:
                'EXPIRED',

            quality:
                0
        };
    }

    const tol =
        p.level.price *
        CFG.RETEST_TOL;

    const invalidation =
        p.level.price *
        0.0035;

    for (
        const x of
        after.slice(
            0,
            8
        )
    ) {

        const open =
            n(x[1]);

        const high =
            n(x[2]);

        const low =
            n(x[3]);

        const close =
            n(x[4]);

        const range =
            Math.max(
                high - low,
                1e-12
            );


        /* LONG INVALIDATION */

        if (
            p.direction ===
                'LONG'
            &&
            close <
                p.level.price -
                invalidation
        ) {

            return {

                status:
                    'INVALIDATED',

                quality:
                    0
            };
        }


        /* SHORT INVALIDATION */

        if (
            p.direction ===
                'SHORT'
            &&
            close >
                p.level.price +
                invalidation
        ) {

            return {

                status:
                    'INVALIDATED',

                quality:
                    0
            };
        }


        const touched =
            high >=
                p.level.price -
                tol
            &&
            low <=
                p.level.price +
                tol;

        if (
            !touched
        ) {

            continue;
        }


        const body =
            Math.abs(
                close -
                open
            );

        const lowerWick =
            Math.min(
                open,
                close
            ) -
            low;

        const upperWick =
            high -
            Math.max(
                open,
                close
            );


        /* LONG RETEST */

        if (
            p.direction ===
            'LONG'
        ) {

            const recovered =
                close >=
                p.level.price;

            const rejection =
                lowerWick /
                range >=
                0.30;

            const healthy =
                close > open ||
                rejection ||
                body /
                    range >=
                    0.45;

            if (
                recovered &&
                healthy
            ) {

                return {

                    status:
                        'RETESTED',

                    quality:
                        Math.min(
                            100,
                            60 +
                            (
                                rejection
                                    ? 20
                                    : 0
                            ) +
                            (
                                close >
                                open
                                    ? 20
                                    : 0
                            )
                        ),

                    candle:
                        x
                };
            }
        }


        /* SHORT RETEST */

        if (
            p.direction ===
            'SHORT'
        ) {

            const recovered =
                close <=
                p.level.price;

            const rejection =
                upperWick /
                range >=
                0.30;

            const healthy =
                close < open ||
                rejection ||
                body /
                    range >=
                    0.45;

            if (
                recovered &&
                healthy
            ) {

                return {

                    status:
                        'RETESTED',

                    quality:
                        Math.min(
                            100,
                            60 +
                            (
                                rejection
                                    ? 20
                                    : 0
                            ) +
                            (
                                close <
                                open
                                    ? 20
                                    : 0
                            )
                        ),

                    candle:
                        x
                };
            }
        }
    }

    return {

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
        closed(
            candles
        );

    if (
        c.length < 20
    ) {

        return null;
    }

    const current =
        n(
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
        current *
        0.005;

    const recent =
        c.slice(
            -8
        );

    const swingLow =
        Math.min(
            ...recent.map(
                x =>
                    n(x[3])
            )
        );

    const swingHigh =
        Math.max(
            ...recent.map(
                x =>
                    n(x[2])
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
                level.price
            );

        stop =
            Math.min(
                swingLow,
                level.price -
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
                current,
                level.price
            );

        stop =
            Math.max(
                swingHigh,
                level.price +
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
                level.price,
                entry
            ),

        entryHigh:
            Math.max(
                level.price,
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

    const reasons = [];


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
                CFG.H4
            ),

            getCandles(
                symbol,
                '15m',
                CFG.M15
            ),

            getCandles(
                symbol,
                '5m',
                CFG.M5
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
        h2.length < 55 ||
        h4.length < 55
    ) {

        return null;
    }


    const h4Trend =
        trend(h4);

    const h2Trend =
        trend(h2);

    const m15Trend =
        structure(
            m15
        );

    const m5Trend =
        trend(m5);


    const l4 =
        getLevels(
            h4
        );

    const l2 =
        getLevels(
            h2
        );


    if (
        !l4.length &&
        !l2.length
    ) {

        return null;
    }


    const levels = [];


    for (
        const l of l4
    ) {

        levels.push({

            tf:
                '4H',

            direction:
                l.type ===
                'resistance'
                    ? 'LONG'
                    : 'SHORT',

            level:
                l
        });
    }


    for (
        const l of l2
    ) {

        levels.push({

            tf:
                '2H',

            direction:
                l.type ===
                'resistance'
                    ? 'LONG'
                    : 'SHORT',

            level:
                l
        });
    }


    const breakouts =
        detectBreakouts(
            m15,
            levels.map(
                x =>
                    x.level
            )
        );


    /*
       Breakout seviyesini
       doğru timeframe ile eşleştir.
    */

    for (
        const breakout of
        breakouts
    ) {

        const candidates =
            levels.filter(
                x =>
                    x.direction ===
                        breakout.direction
                    &&
                    Math.abs(
                        x.level.price -
                        breakout.level.price
                    ) /
                    breakout.level.price
                    <
                    0.0035
            );

        if (
            !candidates.length
        ) {

            continue;
        }

        const best =
            candidates.sort(
                (a, b) =>
                    b.level.touches -
                    a.level.touches
            )[0];

        createPending(
            symbol,
            breakout.direction,
            best.tf,
            {
                level:
                    best.level.price,

                time:
                    breakout.time,

                volumeRatio:
                    breakout.breakoutVolumeRatio,

                bodyRatio:
                    breakout.bodyRatio,

                bodyAtr:
                    breakout.breakoutBodyAtr
            }
        );
    }


    const currentRsi =
        rsi(m15);


    const pendings =
        [
            ...STATE.pending.values()
        ]
        .filter(
            p =>
                p.symbol ===
                cleanSymbol(
                    symbol
                )
        );


    for (
        const pending of
        pendings
    ) {

        const rt =
            retest(
                m15,
                pending
            );


        pending.status =
            rt.status;

        pending.updatedAt =
            Date.now();


        if (
            rt.status ===
            'EXPIRED'
        ) {

            STATE.pending.delete(
                pending.key
            );

            continue;
        }


        if (
            rt.status ===
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
            !rt.quality
        ) {

            continue;
        }


        /*
           ÜST TIMEFRAME TERSLİĞİ.

           Eskiden sadece ikisi birden tersse
           eliyordu.

           Şimdi net ters 4H veya 2H
           setup'ı reddediyor.
        */

        if (
            h4Trend !==
                'NEUTRAL'
            &&
            h4Trend !==
            pending.direction
        ) {

            pending.status =
                'REJECTED_4H';

            continue;
        }


        if (
            h2Trend !==
                'NEUTRAL'
            &&
            h2Trend !==
            pending.direction
        ) {

            pending.status =
                'REJECTED_2H';

            continue;
        }


        const fiveMinute =
            confirm5m(
                m5,
                pending.direction
            );


        if (
            CFG.FIVE_MIN_REQUIRED
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

                rt.quality,

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

                {
                    price:
                        pending.level
                },

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


        const signal = {

            id:
                [
                    pending.symbol,
                    pending.direction,
                    now
                ].join('|'),

            symbol:
                pending.symbol,

            marketSymbol:
                symbol,

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
                    pending
                        .breakoutVolumeRatio
                        .toFixed(2)
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
                rt.quality,

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
                rt.candle
                    ? rt.candle[0]
                    : 0,

            signalAt:
                now,

            cooldownKey:
                pending.key
        };


        STATE.signals.set(
            signal.id,
            signal
        );


        /*
           Maksimum sinyal sayısı.
        */

        while (
            STATE.signals.size >
            CFG.MAX_SIGNALS
        ) {

            const first =
                STATE.signals
                    .keys()
                    .next()
                    .value;

            STATE.signals.delete(
                first
            );
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
            cleanSymbol(
                symbol
            ),
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
                breakout.bodyAtr,

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
   5M
========================================================= */

function confirm5m(
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
        const candle of
        candles
    ) {

        const bucket =
            Math.floor(
                n(candle[0]) /
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
                    n(candle[1]),
                    n(candle[2]),
                    n(candle[3]),
                    n(candle[4]),
                    n(candle[5])
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
                    n(candle[2])
                );

            item[3] =
                Math.min(
                    item[3],
                    n(candle[3])
                );

            item[4] =
                n(
                    candle[4]
                );

            item[5] +=
                n(
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
   MARKET REGIME
========================================================= */

function calculateMarketRegime(
    rows
) {

    if (
        !rows.length
    ) {

        STATE.market = {

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
                'NEUTRAL'
        };

        return;
    }


    let green = 0;
    let red = 0;

    let total = 0;


    for (
        const r of rows
    ) {

        if (
            r.change > 0
        ) {

            green++;

        }

        else if (
            r.change < 0
        ) {

            red++;
        }

        total +=
            r.change;
    }


    const breadth =
        (
            green /
            Math.max(
                green + red,
                1
            )
        ) *
        100;


    const average =
        total /
        rows.length;


    let direction =
        'FLAT';

    let label =
        'YATAY / KARIŞIK';


    if (
        breadth >= 60 &&
        average >= 0.35
    ) {

        direction =
            'LONG';

        label =
            'POZİTİF / YÜKSELİŞ';
    }

    else if (
        breadth <= 40 &&
        average <= -0.35
    ) {

        direction =
            'SHORT';

        label =
            'NEGATİF / DÜŞÜŞ';
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

        btc:
            'NEUTRAL',

        eth:
            'NEUTRAL'
    };
}


/* =========================================================
   SCAN
========================================================= */

async function runScan() {

    if (
        STATE.scanning
    ) {

        return;
    }


    STATE.scanning =
        true;

    STATE.stats.errors =
        0;


    try {

        const rows =
            await getTickers();


        STATE.universe =
            rows;

        STATE.stats.universe =
            rows.length;


        calculateMarketRegime(
            rows
        );


        /*
           Hacim + hareket sıralaması.

           Radar 500.
           Aday 150.
        */

        const candidates =
            rows
                .filter(
                    r =>
                        r.volume >=
                        CFG.MIN_VOLUME_USDT
                )
                .sort(
                    (a, b) =>
                        (
                            Math.abs(
                                b.change
                            ) *
                            Math.log10(
                                b.volume + 1
                            )
                        )
                        -
                        (
                            Math.abs(
                                a.change
                            ) *
                            Math.log10(
                                a.volume + 1
                            )
                        )
                )
                .slice(
                    0,
                    CFG.CANDIDATES
                );


        STATE.candidates =
            candidates;

        STATE.stats.candidates =
            candidates.length;


        /*
           Deep 60.
        */

        const deep =
            candidates.slice(
                0,
                CFG.DEEP
            );


        STATE.deep =
            deep;

        STATE.stats.deep =
            deep.length;


        STATE.stats.analyzed =
            0;


        /*
           Kontrollü paralel analiz.
        */

        for (
            let i = 0;
            i < deep.length;
            i +=
                CFG.CONCURRENCY
        ) {

            const batch =
                deep.slice(
                    i,
                    i +
                    CFG.CONCURRENCY
                );


            await Promise.all(
                batch.map(
                    async row => {

                        try {

                            await analyzeCoin(
                                row
                            );

                            STATE.stats.analyzed++;

                        }

                        catch (
                            error
                        ) {

                            STATE.stats.errors++;

                            console.error(
                                'ANALYZE ERROR |',
                                row.symbol,
                                '|',
                                error.message
                            );
                        }
                    }
                )
            );
        }


        STATE.lastScan =
            Date.now();

    }

    catch (
        error
    ) {

        STATE.lastError =
            error.message;

        STATE.stats.errors++;

        console.error(
            'SCAN ERROR:',
            error.message
        );
    }

    finally {

        STATE.scanning =
            false;

        STATE.stats.pending =
            STATE.pending.size;

        STATE.stats.signals =
            STATE.signals.size;

        broadcast();
    }
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

        if (
            now -
            signal.signalAt >
            CFG.SIGNAL_TTL
        ) {

            STATE.signals.delete(
                id
            );

            continue;
        }


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
            n(
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

    STATE.stats.signals =
        STATE.signals.size;

    STATE.stats.pending =
        STATE.pending.size;

    broadcast();
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
            CFG.RETEST_MIN
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

async function getChart(
    symbol,
    timeframe
) {

    const market =
        findMarket(
            symbol
        );

    if (
        !market
    ) {

        return [];
    }


    if (
        timeframe ===
        '2h'
    ) {

        const h1 =
            await getCandles(
                market.symbol,
                '1h',
                CFG.CHART *
                2
            );

        return aggregateCandles(
            h1,
            2
        );
    }


    if (
        timeframe ===
        '4h'
    ) {

        const h1 =
            await getCandles(
                market.symbol,
                '1h',
                CFG.CHART *
                4
            );

        return aggregateCandles(
            h1,
            4
        );
    }


    return getCandles(
        market.symbol,
        timeframe,
        CFG.CHART
    );
}


/* =========================================================
   STATUS
========================================================= */

function status() {

    cleanup();


    const signals =
        [
            ...STATE.signals.values()
        ]
        .sort(
            (a, b) =>
                b.score -
                a.score
        );


    const pending =
        [
            ...STATE.pending.values()
        ]
        .sort(
            (a, b) =>
                b.breakoutTime -
                a.breakoutTime
        );


    return {

        ok:
            true,

        lastScan:
            STATE.lastScan,

        error:
            STATE.lastError,

        stats:
            {
                ...STATE.stats
            },

        signals,

        pending,

        market:
            STATE.market
    };
}


/* =========================================================
   API STATUS
========================================================= */

app.get(
    '/api/status',
    (
        req,
        res
    ) => {

        res.json(
            status()
        );
    }
);


/* =========================================================
   MANUAL SCAN
========================================================= */

app.get(
    '/api/scan',
    async (
        req,
        res
    ) => {

        try {

            await runScan();

            res.json({

                success:
                    true,

                data:
                    status()
            });

        }

        catch (
            error
        ) {

            res.status(
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
   CHART API
========================================================= */

app.get(
    '/api/chart',
    async (
        req,
        res
    ) => {

        try {

            const symbol =
                req.query.symbol ||
                'BTC/USDT:USDT';

            const timeframe =
                req.query.timeframe ||
                '15m';


            const candles =
                await getChart(
                    symbol,
                    timeframe
                );


            const signal =
                [
                    ...STATE.signals.values()
                ]
                .find(
                    s =>
                        s.marketSymbol ===
                        symbol
                );


            res.json({

                success:
                    true,

                symbol,

                timeframe,

                candles,

                signal:
                    signal || null
            });

        }

        catch (
            error
        ) {

            res.status(
                500
            )
            .json({

                success:
                    false,

                error:
                    error.message,

                candles:
                    []
            });
        }
    }
);


/* =========================================================
   ROOT
========================================================= */

app.get(
    '/',
    (
        req,
        res
    ) => {

        res.send(`
<!doctype html>
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

* {
    box-sizing:
        border-box;
}

body {
    margin:
        0;

    background:
        #071018;

    color:
        #e8eef5;

    font-family:
        Arial,
        Helvetica,
        sans-serif;
}

main {

    max-width:
        1500px;

    margin:
        0 auto;

    padding:
        20px;
}

header {

    display:
        flex;

    justify-content:
        space-between;

    align-items:
        center;

    gap:
        20px;

    margin-bottom:
        20px;
}

h1 {

    margin:
        0 0 6px 0;
}

.sub {

    color:
        #8ea0b2;

    font-size:
        14px;
}

button {

    border:
        1px solid #2c4051;

    background:
        #10212f;

    color:
        #ffffff;

    border-radius:
        8px;

    padding:
        10px 14px;

    cursor:
        pointer;

    font-weight:
        600;
}

button:hover {

    background:
        #183044;
}

.grid {

    display:
        grid;

    grid-template-columns:
        repeat(
            6,
            minmax(
                0,
                1fr
            )
        );

    gap:
        10px;

    margin-bottom:
        14px;
}

.card {

    background:
        #0d1822;

    border:
        1px solid #203241;

    border-radius:
        10px;

    padding:
        14px;
}

.label {

    color:
        #7f91a3;

    font-size:
        12px;

    margin-bottom:
        8px;
}

.value {

    font-size:
        25px;

    font-weight:
        700;
}

.panel {

    background:
        #0d1822;

    border:
        1px solid #203241;

    border-radius:
        10px;

    padding:
        15px;

    margin-bottom:
        14px;
}

.panel-head {

    display:
        flex;

    justify-content:
        space-between;

    align-items:
        center;

    margin-bottom:
        12px;
}

.panel-head h2 {

    margin:
        0;

    font-size:
        17px;
}

.reg {

    font-size:
        18px;

    font-weight:
        700;
}

.reg.long {

    color:
        #13d99a;
}

.reg.short {

    color:
        #ff5572;
}

.reg.flat {

    color:
        #b4c0cb;
}

.meta {

    color:
        #7f91a3;

    font-size:
        12px;

    margin-top:
        5px;
}

.signal {

    border:
        1px solid #293d4d;

    border-radius:
        9px;

    padding:
        13px;

    margin:
        9px 0;

    background:
        #0b151e;
}

.signal-top {

    display:
        flex;

    justify-content:
        space-between;

    align-items:
        center;

    gap:
        10px;

    margin-bottom:
        10px;
}

.direction {

    font-size:
        18px;

    font-weight:
        800;
}

.long {

    color:
        #13d99a;
}

.short {

    color:
        #ff5572;
}

.status {

    padding:
        4px 8px;

    border-radius:
        6px;

    border:
        1px solid #304656;

    color:
        #d9e2ea;

    font-size:
        12px;
}

.row {

    display:
        flex;

    flex-wrap:
        wrap;

    gap:
        8px;

}

.pill {

    padding:
        6px 9px;

    border-radius:
        6px;

    background:
        #122330;

    color:
        #c7d4de;

    font-size:
        12px;

}

.empty {

    color:
        #718292;

    padding:
        15px 0;

}

canvas {

    width:
        100%;

    height:
        420px;

    background:
        #08131c;

    border-radius:
        8px;

}

@media (
    max-width: 1000px
) {

    .grid {

        grid-template-columns:
            repeat(
                3,
                1fr
            );
    }
}

@media (
    max-width: 600px
) {

    .grid {

        grid-template-columns:
            repeat(
                2,
                1fr
            );
    }

    header {

        flex-direction:
            column;

        align-items:
            flex-start;
    }
}

</style>

</head>

<body>

<main>

<header>

<div>

<h1>
🚀 SONNY AI TRADER
</h1>

<div class="sub">
4H + 2H → 15M Breakout → Retest → 5M
</div>

</div>

<button
    onclick="manualScan()"
>
SCAN NOW
</button>

</header>


<div class="grid">

<div class="card">
<div class="label">
Radar
</div>
<div
    class="value"
    id="universe"
>
0
</div>
</div>

<div class="card">
<div class="label">
Candidates
</div>
<div
    class="value"
    id="candidates"
>
0
</div>
</div>

<div class="card">
<div class="label">
Deep
</div>
<div
    class="value"
    id="deep"
>
0
</div>
</div>

<div class="card">
<div class="label">
Analyzed
</div>
<div
    class="value"
    id="analyzed"
>
0
</div>
</div>

<div class="card">
<div class="label">
Pending
</div>
<div
    class="value"
    id="pendingCount"
>
0
</div>
</div>

<div class="card">
<div class="label">
Signals
</div>
<div
    class="value"
    id="signalsCount"
>
0
</div>
</div>

</div>


<div class="panel">

<div class="panel-head">

<div>
<div
    class="reg flat"
    id="regime"
>
YATAY / KARIŞIK
</div>

<div
    class="meta"
    id="scanInfo"
>
Tarama bekleniyor...
</div>

</div>

<div
    class="meta"
    id="errorInfo"
>
</div>

</div>

</div>


<div class="panel">

<div class="panel-head">
<h2>
Aktif Sinyaller
</h2>
</div>

<div
    id="signals"
>
<div class="empty">
Henüz aktif sinyal yok.
</div>
</div>

</div>


<div class="panel">

<div class="panel-head">
<h2>
Bekleyen Breakout / Retest
</h2>
</div>

<div
    id="pending"
>
<div class="empty">
Bekleyen setup yok.
</div>
</div>

</div>


<div class="panel">

<div class="panel-head">

<h2>
BTC / USDT
</h2>

<div
    class="meta"
    id="chartInfo"
>
15M
</div>

</div>

<canvas
    id="chart"
    width="1400"
    height="420"
></canvas>

</div>

</main>


<script>

const $ = id =>
    document.getElementById(id);


function fmt(v) {

    const x =
        Number(v);

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


function escapeHtml(
    v
) {

    return String(
        v ?? ''
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
        '&#039;'
    );
}


function render(data) {

    const st =
        data.stats ||
        {};

    $('universe').textContent =
        st.universe ||
        0;

    $('candidates').textContent =
        st.candidates ||
        0;

    $('deep').textContent =
        st.deep ||
        0;

    $('analyzed').textContent =
        st.analyzed ||
        0;

    $('pendingCount').textContent =
        st.pending ||
        0;

    $('signalsCount').textContent =
        st.signals ||
        0;


    $('scanInfo').textContent =
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


    const market =
        data.market ||
        {};

    const regime =
        $('regime');

    regime.textContent =
        market.label ||
        'YATAY / KARIŞIK';

    regime.className =
        'reg ' +
        (
            market.direction ===
            'LONG'
                ? 'long'
                : market.direction ===
                  'SHORT'
                    ? 'short'
                    : 'flat'
        );


    $('errorInfo').textContent =
        data.error
            ? 'Hata: ' +
              data.error
            : '';


    renderSignals(
        data.signals ||
        []
    );

    renderPending(
        data.pending ||
        []
    );
}


function renderSignals(
    signals
) {

    const root =
        $('signals');

    if (
        !signals.length
    ) {

        root.innerHTML =
            '<div class="empty">Henüz aktif sinyal yok.</div>';

        return;
    }


    root.innerHTML =
        signals
            .map(
                s => {

                    const d =
                        s.direction ===
                        'LONG'
                            ? 'long'
                            : 'short';

                    return `
<div class="signal">

<div class="signal-top">

<div>

<span
    class="direction ${d}"
>
${escapeHtml(s.direction)}
</span>

<strong>
${escapeHtml(s.symbol)}
</strong>

</div>

<span class="status">
${escapeHtml(s.status)}
</span>

</div>

<div class="row">

<span class="pill">
Score: ${escapeHtml(s.score)}
</span>

<span class="pill">
Entry: ${fmt(s.entry)}
</span>

<span class="pill">
SL: ${fmt(s.stop)}
</span>

<span class="pill">
TP1: ${fmt(s.tp1)}
</span>

<span class="pill">
TP2: ${fmt(s.tp2)}
</span>

<span class="pill">
TP3: ${fmt(s.tp3)}
</span>

<span class="pill">
R:R 1:${escapeHtml(s.rr)}
</span>

<span class="pill">
RSI ${escapeHtml(s.rsi)}
</span>

<span class="pill">
VOL ${escapeHtml(s.volumeRatio)}x
</span>

</div>

<div class="meta">
${escapeHtml(s.reason || '')}
</div>

</div>
`;

                }
            )
            .join('');
}


function renderPending(
    pending
) {

    const root =
        $('pending');

    if (
        !pending.length
    ) {

        root.innerHTML =
            '<div class="empty">Bekleyen setup yok.</div>';

        return;
    }


    root.innerHTML =
        pending
            .map(
                p => {

                    const d =
                        p.direction ===
                        'LONG'
                            ? 'long'
                            : 'short';

                    return `
<div class="signal">

<div class="signal-top">

<div>

<span
    class="direction ${d}"
>
${escapeHtml(p.direction)}
</span>

<strong>
${escapeHtml(p.symbol)}
</strong>

</div>

<span class="status">
${escapeHtml(p.status)}
</span>

</div>

<div class="row">

<span class="pill">
TF: ${escapeHtml(p.timeframeLevel)}
</span>

<span class="pill">
Level: ${fmt(p.level)}
</span>

<span class="pill">
VOL ${escapeHtml(
    Number(
        p.breakoutVolumeRatio ||
        0
    ).toFixed(2)
)}x
</span>

</div>

</div>
`;

                }
            )
            .join('');
}


async function manualScan() {

    try {

        await fetch(
            '/api/scan',
            {
                cache:
                    'no-store'
            }
        );

    }

    catch (
        error
    ) {

        console.error(
            error
        );
    }
}


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

        render(
            data
        );

    }

    catch (
        error
    ) {

        console.error(
            error
        );
    }
}


async function loadChart() {

    try {

        const response =
            await fetch(
                '/api/chart?symbol=' +
                encodeURIComponent(
                    'BTC/USDT:USDT'
                ) +
                '&timeframe=15m',
                {
                    cache:
                        'no-store'
                }
            );

        const data =
            await response.json();

        drawChart(
            data.candles ||
            [],
            data.signal ||
            null
        );

    }

    catch (
        error
    ) {

        console.error(
            error
        );
    }
}


function drawChart(
    candles,
    signal
) {

    const canvas =
        $('chart');

    const ctx =
        canvas.getContext(
            '2d'
        );

    const width =
        canvas.width;

    const height =
        canvas.height;


    ctx.clearRect(
        0,
        0,
        width,
        height
    );


    if (
        !candles.length
    ) {

        return;
    }


    const values =
        candles.map(
            c => ({

                open:
                    Number(
                        c[1]
                    ),

                high:
                    Number(
                        c[2]
                    ),

                low:
                    Number(
                        c[3]
                    ),

                close:
                    Number(
                        c[4]
                    )
            })
        );


    const max =
        Math.max(
            ...values.map(
                x =>
                    x.high
            )
        );

    const min =
        Math.min(
            ...values.map(
                x =>
                    x.low
            )
        );


    const left =
        55;

    const right =
        85;

    const top =
        10;

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


    const y =
        price =>
            top +
            (
                (
                    max -
                    price
                ) /
                Math.max(
                    max -
                    min,
                    1e-12
                )
            ) *
            plotHeight;


    const step =
        plotWidth /
        Math.max(
            values.length - 1,
            1
        );


    ctx.font =
        '12px Arial';

    ctx.fillStyle =
        '#728292';


    for (
        let i = 0;
        i <= 5;
        i++
    ) {

        const yy =
            top +
            plotHeight *
            i /
            5;

        const price =
            max -
            (
                max -
                min
            ) *
            i /
            5;

        ctx.fillText(
            fmt(price),
            5,
            yy + 4
        );

        ctx.strokeStyle =
            '#152531';

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
    }


    values.forEach(
        (c, i) => {

            const x =
                left +
                i *
                step;

            const up =
                c.close >=
                c.open;

            ctx.strokeStyle =
                up
                    ? '#13d99a'
                    : '#ff5572';

            ctx.fillStyle =
                up
                    ? '#13d99a'
                    : '#ff5572';


            ctx.beginPath();

            ctx.moveTo(
                x,
                y(c.high)
            );

            ctx.lineTo(
                x,
                y(c.low)
            );

            ctx.stroke();


            const yo =
                y(c.open);

            const yc =
                y(c.close);

            const bodyY =
                Math.min(
                    yo,
                    yc
                );

            const bodyH =
                Math.max(
                    1,
                    Math.abs(
                        yc -
                        yo
                    )
                );

            ctx.fillRect(
                x - 2,
                bodyY,
                4,
                bodyH
            );
        }
    );


    if (
        signal
    ) {

        const lines = [

            {
                price:
                    signal.stop,

                label:
                    'SL',

                color:
                    '#ff5572'
            },

            {
                price:
                    signal.entry,

                label:
                    'ENTRY',

                color:
                    '#13d99a'
            },

            {
                price:
                    signal.tp1,

                label:
                    'TP1',

                color:
                    '#4ea6ff'
            },

            {
                price:
                    signal.tp2,

                label:
                    'TP2',

                color:
                    '#4ea6ff'
            },

            {
                price:
                    signal.tp3,

                label:
                    'TP3',

                color:
                    '#4ea6ff'
            }

        ];


        for (
            const line of lines
        ) {

            if (
                !Number.isFinite(
                    Number(
                        line.price
                    )
                )
            ) {

                continue;
            }

            const yy =
                y(
                    Number(
                        line.price
                    )
                );

            ctx.strokeStyle =
                line.color;

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


            ctx.fillStyle =
                line.color;

            ctx.fillText(
                line.label +
                ' ' +
                fmt(
                    line.price
                ),
                width -
                right +
                5,
                yy + 4
            );
        }
    }
}


const wsProtocol =
    location.protocol ===
    'https:'
        ? 'wss://'
        : 'ws://';


function connectWS() {

    try {

        const ws =
            new WebSocket(
                wsProtocol +
                location.host
            );


        ws.onmessage =
            event => {

                try {

                    const message =
                        JSON.parse(
                            event.data
                        );

                    if (
                        message.type ===
                        'snapshot'
                    ) {

                        render(
                            message.data
                        );
                    }

                }

                catch (
                    error
                ) {

                    console.error(
                        error
                    );
                }
            };


        ws.onclose =
            () => {

                setTimeout(
                    connectWS,
                    2500
                );
            };

    }

    catch (
        error
    ) {

        console.error(
            error
        );

        setTimeout(
            connectWS,
            2500
        );
    }
}


connectWS();

loadStatus();

loadChart();


setInterval(
    loadStatus,
    10000
);

setInterval(
    loadChart,
    15000
);

</script>

</body>
</html>
        `);
    }
);


/* =========================================================
   ERROR HANDLERS
========================================================= */

process.on(
    'unhandledRejection',
    e => {

        STATE.lastError =
            e?.message ||
            String(e);

        console.error(
            'UNHANDLED',
            e
        );
    }
);


process.on(
    'uncaughtException',
    e => {

        STATE.lastError =
            e?.message ||
            String(e);

        console.error(
            'UNCAUGHT',
            e
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
            '=============================================='
        );

        console.log(
            '🚀 SONNY AI TRADER FINAL'
        );

        console.log(
            '📡 Bitget USDT Futures'
        );

        console.log(
            '🛰️ Radar: ' +
            CFG.RADAR +
            ' Coin'
        );

        console.log(
            '🎯 Candidate: ' +
            CFG.CANDIDATES
        );

        console.log(
            '🔬 Deep: ' +
            CFG.DEEP
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


            console.log(
                'MARKETS | Gerçek USDT perpetual=' +
                STATE.markets.length
            );


            await runScan();

        }

        catch (
            e
        ) {

            STATE.lastError =
                e.message;

            console.error(
                'BOOT ERROR',
                e.message
            );
        }


        setInterval(
            () =>
                runScan()
                .catch(
                    e => {

                        STATE.lastError =
                            e.message;

                        console.error(
                            'SCAN LOOP',
                            e.message
                        );
                    }
                ),

            CFG.SCAN_MS
        );


        setInterval(
            () =>
                updateLiveSignals()
                .catch(
                    e =>
                        console.error(
                            'LIVE LOOP',
                            e.message
                        )
                ),

            CFG.LIVE_MS
        );
    }
);
