'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = Number(process.env.PORT || 10000);
const API = 'https://api.bitget.com';

app.use(express.json({ limit: '1mb' }));

/* =========================================================
   SONNY AI TRADER FINAL
   500 RADAR
        ↓
   150 CANDIDATE
        ↓
   40 DEEP
        ↓
   4H + 2H
        ↓
   15M BREAKOUT
        ↓
   RETEST
        ↓
   5M BONUS
        ↓
   SIGNAL

   AUTO TRADE: KAPALI
   FRONTEND: BU DOSYANIN İÇİNDE
========================================================= */

const CFG = {
    RADAR: 500,
    CANDIDATES: 150,
    DEEP: 40,

    MAX_SIGNALS: 15,

    MIN_VOLUME_USDT: 750000,
    MIN_24H_MOVE: 0.8,

    SCAN_MS: 60000,
    LIVE_MS: 10000,

    CONCURRENCY: 6,

    H1_LIMIT: 260,
    M15_LIMIT: 180,
    M5_LIMIT: 120,

    CHART_LIMIT: 180,

    BREAKOUT_LOOKBACK: 12,
    BREAKOUT_VOLUME_RATIO: 1.05,
    BREAKOUT_BODY_ATR: 0.20,

    RETEST_WINDOW_MINUTES: 90,
    RETEST_TOLERANCE: 0.006,
    BREAKOUT_INVALIDATION: 0.003,

    MIN_SCORE: 58,

    MIN_RR: 1.20,
    TP2_RR: 2.00,
    TP3_RR: 3.00,

    ATR_STOP_MULTIPLIER: 0.65,

    REQUIRE_5M: false,

    SIGNAL_TTL: 45 * 60 * 1000,

    LEVEL_COOLDOWN: 4 * 60 * 60 * 1000,

    AUTO_TRADE: false
};


/* =========================================================
   STATE
========================================================= */

const STATE = {
    markets: [],
    marketSet: new Set(),

    tickers: new Map(),

    universe: [],
    candidates: [],
    deep: [],

    signals: new Map(),
    pending: new Map(),
    stopped: new Map(),

    scanning: false,
    ready: false,

    selected: 'BTCUSDT',
    timeframe: '15m',

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
        symbol: 'BTCUSDT',
        timeframe: '15m',
        candles: [],
        signal: null
    }
};


/* =========================================================
   CACHE
========================================================= */

const candleCache = new Map();

let tickerCache = {
    ts: 0,
    map: new Map()
};


/* =========================================================
   BASIC HELPERS
========================================================= */

function num(
    value,
    fallback = 0
) {
    const n = Number(value);

    return Number.isFinite(n)
        ? n
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
            total,
            value
        ) => total + value,
        0
    ) / values.length;
}


function fmt(
    value
) {
    const n = Number(value);

    if (
        !Number.isFinite(n)
    ) {
        return '-';
    }

    if (
        Math.abs(n) >= 1000
    ) {
        return n.toFixed(2);
    }

    if (
        Math.abs(n) >= 100
    ) {
        return n.toFixed(3);
    }

    if (
        Math.abs(n) >= 1
    ) {
        return n.toFixed(5);
    }

    if (
        Math.abs(n) >= 0.01
    ) {
        return n.toFixed(7);
    }

    if (
        Math.abs(n) >= 0.0001
    ) {
        return n.toFixed(8);
    }

    return n.toFixed(10);
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
        !s.endsWith('USDT')
    ) {
        s += 'USDT';
    }

    return s;
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
        candles.length <= 1
    ) {
        return candles;
    }

    return candles.slice(
        0,
        -1
    );
}


/* =========================================================
   CRITICAL MARKET LOOKUP
========================================================= */

function findMarket(
    symbol
) {

    const target =
        cleanSymbol(
            symbol
        );

    return (
        STATE.markets.find(
            market =>
                cleanSymbol(
                    market
                ) === target
        )
        ||
        null
    );
}


/* =========================================================
   HTTP
========================================================= */

async function get(
    url,
    timeout = 20000
) {

    const controller =
        new AbortController();

    const timer =
        setTimeout(
            () => controller.abort(),
            timeout
        );

    try {

        const response =
            await fetch(
                url,
                {
                    signal:
                        controller.signal,

                    headers: {
                        accept:
                            'application/json'
                    }
                }
            );


        const json =
            await response.json();


        if (
            !response.ok
        ) {

            throw new Error(
                `HTTP ${response.status}`
            );
        }


        if (
            json.code &&
            json.code !== '00000'
        ) {

            throw new Error(
                json.msg ||
                `Bitget ${json.code}`
            );
        }


        return json;

    }
    finally {

        clearTimeout(
            timer
        );

    }
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

            }
            catch (error) {

                result[index] =
                    null;

                console.error(
                    'ANALİZ ERROR |',
                    items[index]?.symbol ||
                    'UNKNOWN',
                    '|',
                    error.message
                );

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


    return result.filter(
        Boolean
    );

}


/* =========================================================
   MARKETS
========================================================= */

async function loadMarkets() {

    const json =
        await get(
            `${API}/api/v2/mix/market/contracts?productType=USDT-FUTURES`
        );


    const markets = [];


    for (
        const item
        of json.data || []
    ) {

        const symbol =
            String(
                item.symbol || ''
            ).toUpperCase();


        const status =
            String(
                item.symbolStatus ||
                item.status ||
                ''
            )
            .toLowerCase();


        if (
            !symbol.endsWith(
                'USDT'
            )
        ) {
            continue;
        }


        if (
            status &&
            ![
                'normal',
                'online',
                'listed'
            ].includes(
                status
            )
        ) {
            continue;
        }


        markets.push(
            symbol
        );

    }


    STATE.markets =
        [
            ...new Set(
                markets
            )
        ];


    STATE.marketSet =
        new Set(
            STATE.markets
        );


    console.log(
        'MARKETS | Gerçek USDT perpetual=' +
        STATE.markets.length
    );

}


/* =========================================================
   TICKERS
========================================================= */

async function getTickers(
    force = false
) {

    if (
        !force &&
        tickerCache.map.size &&
        Date.now() -
        tickerCache.ts <
        8000
    ) {

        return tickerCache.map;
    }


    const json =
        await get(
            `${API}/api/v2/mix/market/tickers?productType=USDT-FUTURES`
        );


    const map =
        new Map();


    for (
        const row
        of json.data || []
    ) {

        const symbol =
            String(
                row.symbol || ''
            ).toUpperCase();


        if (
            !symbol.endsWith(
                'USDT'
            )
        ) {

            continue;
        }


        map.set(
            symbol,
            {

                symbol,

                last:
                    num(
                        row.lastPr
                    ),

                volume:
                    num(
                        row.quoteVolume ||
                        row.usdtVolume
                    ),

                change:
                    num(
                        row.change24h
                    ),

                high:
                    num(
                        row.high24h
                    ),

                low:
                    num(
                        row.low24h
                    )
            }
        );

    }


    tickerCache =
        {
            ts:
                Date.now(),

            map
        };


    STATE.tickers =
        map;


    return map;
}


/* =========================================================
   CANDLES
========================================================= */

async function getCandles(
    symbol,
    timeframe,
    limit
) {

    const normalized =
        cleanSymbol(
            symbol
        );


    const key =
        [
            normalized,
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
        cached.ts <
        12000
    ) {

        return cached.data;
    }


    const map = {

        '5m':
            '5m',

        '15m':
            '15m',

        '1h':
            '1H',

        '2h':
            '2H',

        '4h':
            '4H'

    };


    const granularity =
        map[
            timeframe
        ]
        ||
        timeframe;


    const json =
        await get(

            `${API}/api/v2/mix/market/candles` +
            `?symbol=${encodeURIComponent(normalized)}` +
            `&granularity=${encodeURIComponent(granularity)}` +
            `&limit=${limit}` +
            `&productType=USDT-FUTURES`

        );


    const candles =
        (json.data || [])
            .map(
                row =>
                    ({

                        time:
                            num(
                                row[0]
                            ),

                        open:
                            num(
                                row[1]
                            ),

                        high:
                            num(
                                row[2]
                            ),

                        low:
                            num(
                                row[3]
                            ),

                        close:
                            num(
                                row[4]
                            ),

                        volume:
                            num(
                                row[5]
                            )
                    })
            )
            .filter(
                candle =>
                    candle.close >
                    0
            )
            .sort(
                (
                    a,
                    b
                ) =>
                    a.time -
                    b.time
            );


    candleCache.set(
        key,
        {

            ts:
                Date.now(),

            data:
                candles
        }
    );


    return candles;
}


/* =========================================================
   EMA
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
                    x =>
                        x.close
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
            c[i].close *
            k +

            value *
            (
                1 -
                k
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
        closed(
            candles
        );


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

        const diff =
            c[i].close -
            c[i - 1].close;


        if (
            diff > 0
        ) {

            gain +=
                diff;

        }
        else if (
            diff < 0
        ) {

            loss +=
                -diff;
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
        (
            100 /
            (
                1 +
                rs
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
        closed(
            candles
        );


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
            c[i].high;


        const low =
            c[i].low;


        const previousClose =
            c[
                i - 1
            ].close;


        values.push(

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
        c[
            c.length - 1
        ].close;


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
   15M STRUCTURE
========================================================= */

function structure15m(
    candles
) {

    const c =
        closed(
            candles
        )
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
                    x.high
            )
        );


    const firstLow =
        Math.min(
            ...first.map(
                x =>
                    x.low
            )
        );


    const secondHigh =
        Math.max(
            ...second.map(
                x =>
                    x.high
            )
        );


    const secondLow =
        Math.min(
            ...second.map(
                x =>
                    x.low
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
        closed(
            candles
        );


    if (
        c.length <
        30
    ) {

        return null;
    }


    const base =
        c.slice(
            -25,
            -1
        );


    return {

        resistance:
            Math.max(
                ...base.map(
                    x =>
                        x.high
                )
            ),

        support:
            Math.min(
                ...base.map(
                    x =>
                        x.low
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
        closed(
            candles
        );


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
                history
                    .map(
                        x =>
                            x.volume
                    )
                    .filter(
                        x =>
                            x > 0
                    )
            );


        const volumeRatio =
            averageVolume >
            0

                ?

                current.volume /
                averageVolume

                :

                1;


        const range =
            Math.max(
                current.high -
                current.low,
                1e-12
            );


        const body =
            Math.abs(
                current.close -
                current.open
            );


        const bodyRatio =
            body /
            range;


        const currentAtr =
            atr(
                candles
            )
            ||
            current.close *
            0.005;


        const bodyAtr =
            body /
            currentAtr;


        if (
            volumeRatio <
            CFG.BREAKOUT_VOLUME_RATIO
        ) {

            continue;
        }


        if (
            bodyAtr <
            CFG.BREAKOUT_BODY_ATR
        ) {

            continue;
        }


        if (
            bodyRatio <
            0.15
        ) {

            continue;
        }


        if (
            direction ===
            'LONG' &&

            previous.close <=
            level &&

            current.close >
            level
        ) {

            return {

                time:
                    current.time,

                level,

                volumeRatio,

                bodyAtr,

                bodyRatio

            };
        }


        if (
            direction ===
            'SHORT' &&

            previous.close >=
            level &&

            current.close <
            level
        ) {

            return {

                time:
                    current.time,

                level,

                volumeRatio,

                bodyAtr,

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
                'EXPIRED'

        };
    }


    const c =
        closed(
            candles
        );


    const maxBars =
        Math.ceil(
            CFG.RETEST_WINDOW_MINUTES /
            15
        );


    const after =
        c
            .filter(
                x =>
                    x.time >
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
                'WAITING_RETEST'

        };
    }


    const tolerance =
        pending.level *
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

        const touch =
            candle.high >=
                pending.level -
                tolerance &&

            candle.low <=
                pending.level +
                tolerance;


        if (
            !touch
        ) {

            continue;
        }


        touched =
            true;


        if (
            pending.direction ===
            'LONG'
        ) {

            if (
                candle.close <
                pending.level *
                (
                    1 -
                    CFG.BREAKOUT_INVALIDATION
                )
            ) {

                invalid =
                    true;
            }


            if (
                candle.close >=
                pending.level
            ) {

                recovered =
                    true;
            }

        }
        else {

            if (
                candle.close >
                pending.level *
                (
                    1 +
                    CFG.BREAKOUT_INVALIDATION
                )
            ) {

                invalid =
                    true;
            }


            if (
                candle.close <=
                pending.level
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
                    after.length -
                    1
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
   5M BONUS
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

            last.close >
            last.open &&

            last.close >=
            previous.close

        );

    }


    return (

        last.close <
        last.open &&

        last.close <=
        previous.close

    );
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


    const current =
        c[
            c.length -
            1
        ].close;


    const volatility =
        atr(
            candles
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
                    x.low
            )
        );


    const swingHigh =
        Math.max(
            ...recent.map(
                x =>
                    x.high
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

        entry,

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

function scoreSetup(
    direction,
    h4Trend,
    h2Trend,
    m15Trend,
    m5Trend,
    volumeRatio,
    rsiValue
) {

    let score =
        42;


    const reasons =
        [];


    if (
        h4Trend ===
        direction
    ) {

        score +=
            15;

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
        m15Trend ===
        direction
    ) {

        score +=
            8;

        reasons.push(
            '15M uyumlu'
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
        (
            direction ===
            'LONG' &&

            rsiValue >=
            45 &&

            rsiValue <=
            75
        )
        ||
        (
            direction ===
            'SHORT' &&

            rsiValue >=
            25 &&

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
   ADD PENDING
========================================================= */

function addPending(
    symbol,
    direction,
    breakout,
    timeframeLevel
) {

    const key =
        [
            cleanSymbol(symbol),
            direction,
            timeframeLevel,
            fmt(
                breakout.level
            )
        ].join('|');


    const existing =
        STATE.pending.get(
            key
        );


    if (
        existing
    ) {

        existing.updatedAt =
            Date.now();

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

            level:
                breakout.level,

            timeframeLevel,

            breakoutTime:
                breakout.time,

            breakoutVolumeRatio:
                breakout.volumeRatio,

            breakoutBodyAtr:
                breakout.bodyAtr,

            breakoutBodyRatio:
                breakout.bodyRatio,

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
        h1.length <
        70
        ||

        m15.length <
        35
        ||

        m5.length <
        15
    ) {

        return {

            analyzed:
                false,

            signal:
                null

        };
    }


    /*
       1H verisinden
       2H + 4H oluşturuyoruz.
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
        h2.length <
        45 ||

        h4.length <
        45
    ) {

        return {

            analyzed:
                false,

            signal:
                null

        };
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

        return {

            analyzed:
                true,

            signal:
                null

        };
    }


    const levels = [

        {
            tf:
                '4H',

            direction:
                'LONG',

            price:
                h4Levels.resistance
        },

        {
            tf:
                '4H',

            direction:
                'SHORT',

            price:
                h4Levels.support
        },

        {
            tf:
                '2H',

            direction:
                'LONG',

            price:
                h2Levels.resistance
        },

        {
            tf:
                '2H',

            direction:
                'SHORT',

            price:
                h2Levels.support
        }

    ];


    /*
       Yeni breakout state oluştur.
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

            addPending(
                symbol,
                item.direction,
                breakout,
                item.tf
            );

        }

    }


    const pendingForCoin =
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


    const currentRsi =
        rsi(
            m15
        );


    /*
       Bekleyen breakout -> retest -> signal
    */

    for (
        const pending
        of pendingForCoin
    ) {

        const retest =
            detectRetest(
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
            !retest.ok
        ) {

            /*
               Burada hemen sinyal vermiyoruz.
               Bekleyen breakout'u koruyoruz.
            */

            continue;
        }


        /*
           Sadece iki üst timeframe
           tamamen ters ise engelle.
        */

        if (
            h4Trend !==
            'NEUTRAL' &&

            h2Trend !==
            'NEUTRAL' &&

            h4Trend !==
            pending.direction &&

            h2Trend !==
            pending.direction
        ) {

            pending.status =
                'REJECTED_TREND';

            continue;
        }


        const fiveOk =
            confirm5m(
                m5,
                pending.direction
            );


        /*
           5M zorunlu değil.
           Bonus.
        */

        if (
            CFG.REQUIRE_5M &&
            !fiveOk
        ) {

            pending.status =
                'WAITING_5M';

            continue;
        }


        const scored =
            scoreSetup(
                pending.direction,
                h4Trend,
                h2Trend,
                m15Trend,
                m5Trend,
                pending.breakoutVolumeRatio,
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


        const trade =
            createTradePlan(
                pending.direction,
                pending.level,
                m15
            );


        if (
            !trade
        ) {

            pending.status =
                'REJECTED_RR';

            continue;
        }


        /*
           Aynı coin/yön tekrar açılmasın.
        */

        const already =
            [
                ...STATE.signals.values()
            ].some(
                signal =>

                    signal.symbol ===
                    cleanSymbol(
                        symbol
                    ) &&

                    signal.direction ===
                    pending.direction
            );


        if (
            already
        ) {

            continue;
        }


        pending.status =
            'SIGNAL_CREATED';


        const timestamp =
            Date.now();


        return {

            analyzed:
                true,

            signal: {

                id:
                    [
                        cleanSymbol(symbol),
                        pending.direction,
                        timestamp
                    ].join('|'),

                symbol:
                    cleanSymbol(
                        symbol
                    ),

                marketSymbol:
                    cleanSymbol(
                        symbol
                    ),

                direction:
                    pending.direction,

                score:
                    scored.score,

                confidence:
                    scored.score,

                currentPrice:
                    row.price,

                price:
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

                sl:
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
                        ? retest.candle.time
                        : 0,

                signalAt:
                    timestamp,

                timestamp,

                cooldownKey:
                    pending.key

            }

        };

    }


    return {

        analyzed:
            true,

        signal:
            null
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

        const bucket =
            Math.floor(
                candle.time /
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
                        candle.open,

                    high:
                        candle.high,

                    low:
                        candle.low,

                    close:
                        candle.close,

                    volume:
                        candle.volume

                }
            );

        }
        else {

            const item =
                buckets.get(
                    bucket
                );


            item.high =
                Math.max(
                    item.high,
                    candle.high
                );


            item.low =
                Math.min(
                    item.low,
                    candle.low
                );


            item.close =
                candle.close;


            item.volume +=
                candle.volume;

        }

    }


    return [
        ...buckets.values()
    ]
    .sort(
        (
            a,
            b
        ) =>
            a.time -
            b.time
    );

}


/* =========================================================
   MARKET SENTIMENT
========================================================= */

async function updateMarket() {

    const rows =
        STATE.universe;


    const valid =
        rows.filter(
            x =>
                Number.isFinite(
                    x.change
                )
        );


    const green =
        valid.filter(
            x =>
                x.change >
                0
        ).length;


    const red =
        valid.filter(
            x =>
                x.change <
                0
        ).length;


    const average =
        valid.length
            ? avg(
                valid.map(
                    x =>
                        x.change
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

            btc =
                trend(
                    await getCandles(
                        btcMarket,
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
                        ethMarket,
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
        breadth >=
        62 &&

        average >=
        0.35
    ) {

        label =
            'YÜKSELİŞ';

        direction =
            'LONG';

    }
    else if (
        breadth <=
        38 &&

        average <=
        -0.35
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

            CFG.RETEST_WINDOW_MINUTES *
            60 *
            1000
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
        of STATE.stopped
    ) {

        if (
            now -
            timestamp >
            CFG.LEVEL_COOLDOWN
        ) {

            STATE.stopped.delete(
                key
            );
        }
    }

}


/* =========================================================
   LIVE SIGNAL
========================================================= */

function updateSignalState(
    signal,
    current
) {

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

}


/* =========================================================
   LIVE UPDATE
========================================================= */

async function updateLiveSignals() {

    if (
        !STATE.signals.size
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
                signal.symbol
            );


        if (
            !ticker ||
            !ticker.last
        ) {

            continue;
        }


        updateSignalState(
            signal,
            ticker.last
        );


        signal.ageSeconds =
            Math.floor(
                (
                    now -
                    signal.signalAt
                ) /
                1000
            );


        if (
            signal.status ===
            'STOP'
        ) {

            STATE.stopped.set(
                signal.cooldownKey,
                now
            );

            STATE.signals.delete(
                id
            );

        }


        if (
            signal.status ===
            'TP3'
        ) {

            STATE.signals.delete(
                id
            );

        }

    }


    cleanup();

}


/* =========================================================
   CHART
========================================================= */

async function refreshChart() {

    if (
        !STATE.selected ||
        !STATE.marketSet.has(
            cleanSymbol(
                STATE.selected
            )
        )
    ) {

        STATE.selected =
            STATE.marketSet.has(
                'BTCUSDT'
            )
                ? 'BTCUSDT'
                : STATE.markets[0] ||
                  'BTCUSDT';
    }


    let candles =
        [];


    if (
        STATE.timeframe ===
        '2h'
    ) {

        const h1 =
            await getCandles(
                STATE.selected,
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
                STATE.selected,
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
                STATE.selected,
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
                cleanSymbol(
                    STATE.selected
                )
        )
        ||
        null;


    STATE.chart = {

        symbol:
            cleanSymbol(
                STATE.selected
            ),

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


    STATE.stats =
        STATE.stats ||
        {};


    const started =
        Date.now();


    try {

        /*
        MARKETS
        */

        if (
            !STATE.markets.length
        ) {

            await loadMarkets();

        }


        /*
        TICKERS
        */

        const tickers =
            await getTickers(
                true
            );


        /*
        500 RADAR
        */

        const rows =
            [];


        for (
            const symbol
            of STATE.markets
        ) {

            const ticker =
                tickers.get(
                    symbol
                );


            if (
                !ticker ||
                !(ticker.last > 0)
            ) {

                continue;
            }


            const movement =
                Math.abs(
                    ticker.change
                );


            const range =
                ticker.low >
                0

                    ?

                    (
                        (
                            ticker.high -
                            ticker.low
                        ) /
                        ticker.low
                    ) *
                    100

                    :

                    0;


            if (
                ticker.volume <
                CFG.MIN_VOLUME_USDT
            ) {

                continue;
            }


            /*
            Buradaki hareket filtresi çok sert değil.
            Altcoin kaçırmamak için %0.8.
            */

            if (
                Math.max(
                    movement,
                    range
                ) <
                CFG.MIN_24H_MOVE
            ) {

                continue;
            }


            rows.push({

                symbol,

                price:
                    ticker.last,

                volume:
                    ticker.volume,

                change:
                    ticker.change,

                range,

                activity:
                    ticker.volume *
                    (
                        1 +
                        Math.min(
                            movement,
                            30
                        ) /
                        100
                    )

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


        STATE.universe =
            rows.slice(
                0,
                CFG.RADAR
            );


        /*
        500 -> 150
        */

        STATE.candidates =
            STATE.universe.slice(
                0,
                CFG.CANDIDATES
            );


        /*
        150 -> 40
        */

        STATE.deep =
            STATE.candidates.slice(
                0,
                CFG.DEEP
            );


        /*
        MARKET
        */

        await updateMarket();


        /*
        DEEP ANALYSIS
        */

        let analyzed =
            0;


        const results =
            await mapLimit(
                STATE.deep,
                CFG.CONCURRENCY,
                async coin => {

                    const result =
                        await analyzeCoin(
                            coin
                        );


                    if (
                        result?.analyzed
                    ) {

                        analyzed +=
                            1;
                    }


                    return result;

                }
            );


        /*
        SIGNALS
        */

        const found =
            results
                .map(
                    result =>
                        result?.signal
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
                            signal.symbol &&

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
                signal.symbol;


            console.log(

                'SIGNAL |',

                signal.symbol,

                '|',

                signal.direction,

                '| SCORE',

                signal.score,

                '| RR 1:' +

                signal.rr

            );

        }


        STATE.lastAnalyzed =
            analyzed;


        STATE.lastScan =
            Date.now();


        /*
        LIVE CHECK
        */

        await updateLiveSignals();


        /*
        CHART
        */

        try {

            await refreshChart();

        }
        catch (
            chartError
        ) {

            console.error(
                'CHART REFRESH ERROR:',
                chartError.message
            );

        }


        cleanup();


        console.log(

            'RADAR tamamlandı |' +

            ' Universe=' +
            STATE.universe.length +

            ' | Candidates=' +
            STATE.candidates.length +

            ' | Deep=' +
            STATE.deep.length +

            ' | Analiz=' +
            analyzed +

            ' | Pending=' +
            STATE.pending.size +

            ' | SIGNAL=' +
            STATE.signals.size +

            ' | ERR=0' +

            ' | ' +

            (
                (
                    Date.now() -
                    started
                ) /
                1000
            ).toFixed(
                1
            ) +

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
   PUBLIC SIGNAL
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


/* =========================================================
   STATUS
========================================================= */

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
                STATE.universe.length,

            candidates:
                STATE.candidates.length,

            deep:
                STATE.deep.length,

            analyzed:
                STATE.lastAnalyzed,

            pending:
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
            )
            .map(
                pending => ({

                    symbol:
                        cleanSymbol(
                            pending.symbol
                        ),

                    marketSymbol:
                        pending.symbol,

                    direction:
                        pending.direction,

                    level:
                        fmt(
                            pending.level
                        ),

                    timeframeLevel:
                        pending.timeframeLevel,

                    volumeRatio:
                        Number(
                            pending
                                .breakoutVolumeRatio
                                .toFixed(
                                    2
                                )
                        ),

                    status:
                        pending.status

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

        const data =
            statusData();


        res.json({

            success:
                true,

            signals:
                data.signals,

            pending:
                data.pending,

            stats:
                data.stats,

            market:
                data.market

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


        runScan()
            .catch(
                error =>
                    console.error(
                        'MANUAL SCAN:',
                        error.message
                    )
            );


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

            const requestedSymbol =
                req.query.symbol ||
                STATE.selected ||
                'BTCUSDT';


            const symbol =
                cleanSymbol(
                    requestedSymbol
                );


            if (
                !STATE.marketSet.has(
                    symbol
                )
            ) {

                return res
                    .status(404)
                    .json({

                        success:
                            false,

                        error:
                            'Coin bulunamadı: ' +
                            symbol

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
                ).toLowerCase();


            STATE.selected =
                symbol;


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

                price:
                    STATE.chart.candles.length

                        ?

                        STATE.chart.candles[
                            STATE.chart.candles.length -
                            1
                        ].close

                        :

                        0,

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
font-family:
Arial,
Helvetica,
sans-serif;
}

body{
overflow:hidden;
}

.app{
width:100%;
height:100vh;
display:grid;
grid-template-columns:
220px
minmax(0,1fr)
275px;
}

.sidebar{
background:#0b1017;
border-right:
1px solid #202a38;
padding:10px;
overflow:auto;
}

.brand{
font-size:18px;
font-weight:900;
line-height:1.15;
}

.brand small{
display:block;
font-size:8px;
color:#718096;
margin-top:5px;
font-weight:500;
}

.scan{
width:100%;
margin-top:10px;
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
grid-template-columns:
repeat(3,1fr);
gap:5px;
margin-top:9px;
}

.stat{
background:#101721;
border:1px solid #233044;
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
background:#101721;
border:1px solid #263345;
border-left:
3px solid #13dba0;
border-radius:8px;
padding:9px;
cursor:pointer;
}

.card.short{
border-left-color:
#ff5570;
}

.card.active{
border-color:
#4776ff;
background:#121d2b;
}

.top{
display:flex;
align-items:center;
justify-content:space-between;
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

.card-price{
font-size:18px;
font-weight:900;
margin-top:7px;
}

.card-meta{
font-size:9px;
color:#718096;
margin-top:5px;
}

.empty{
padding:10px;
font-size:10px;
color:#718096;
line-height:1.5;
}

.main{
min-width:0;
display:flex;
flex-direction:column;
}

.header{
height:60px;
display:flex;
align-items:center;
justify-content:space-between;
gap:8px;
padding:
0 12px;
border-bottom:
1px solid #202a38;
}

.title{
font-size:18px;
font-weight:900;
}

.sub{
font-size:9px;
color:#718096;
margin-top:4px;
}

.pill{
font-size:8px;
color:#13dba0;
background:#073323;
border:1px solid #0b684a;
padding:7px 9px;
border-radius:18px;
white-space:nowrap;
}

.chartArea{
position:relative;
flex:1;
min-height:0;
}

.toolbar{
position:absolute;
z-index:5;
left:10px;
right:10px;
top:9px;
display:flex;
align-items:center;
justify-content:space-between;
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
border:
1px solid #29384c;
border-radius:5px;
padding:5px 7px;
font-size:8px;
cursor:pointer;
}

.tf button.active{
background:#182c4a;
border-color:#428cff;
color:#fff;
}

#chart{
display:block;
width:100%;
height:100%;
}

.right{
background:#0b1017;
border-left:
1px solid #202a38;
padding:10px;
overflow:auto;
}

.box{
background:#101721;
border:
1px solid #233044;
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

.info{
font-size:9px;
line-height:1.6;
color:#718096;
margin-top:5px;
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
grid-template-columns:
1fr
1fr;
gap:5px;
margin-top:8px;
}

.level{
background:#09111a;
padding:7px;
border-radius:5px;
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
border-left:
2px solid #f4c84a;
border-radius:4px;
padding:6px;
margin-top:5px;
font-size:8px;
}

@media(max-width:900px){

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

body{
overflow:auto;
}

.app{
display:block;
height:auto;
min-height:100vh;
}

.sidebar{
height:205px;
border-right:0;
border-bottom:
1px solid #202a38;
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
205px
);

min-height:420px;
}

.header{
height:48px;
padding:
0 8px;
}

.title{
font-size:14px;
}

.pill{
font-size:7px;
padding:6px;
}

.chartArea{
height:
calc(
100vh -
253px
);

min-height:350px;
}

.tf button{
padding:
5px 6px;
}

}

</style>

</head>


<body>


<div class="app">


<!-- LEFT -->

<aside class="sidebar">


<div class="brand">

⚡ SONNY AI TRADER

<small>
4H/2H DESTEK-DİRENÇ •
15M BREAKOUT •
RETEST •
5M SCALP
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

<b id="radar">
0
</b>

<span>
RADAR
</span>

</div>


<div class="stat">

<b id="candidate">
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
id="cards"
class="cards"
>

<div class="empty">
Teyit edilmiş sinyal yok.
</div>

</div>


</aside>


<!-- CENTER -->

<main class="main">


<header class="header">


<div>

<div class="title">

<span id="symbol">
BTCUSDT
</span>

•

<span id="tfText">
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


<div class="chartArea">


<div class="toolbar">


<div
id="chartName"
class="chartName"
>
BTCUSDT • 15M
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
>
</canvas>


</div>


</main>


<!-- RIGHT -->

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


<div id="active">


<div class="empty">
Henüz teyit edilmiş sinyal yok.
</div>


</div>


</div>


<div class="box">


<div class="boxTitle">
BEKLEYEN KIRILIM / RETEST
</div>


<div id="pending">


<div class="empty">
Bekleyen setup yok.
</div>


</div>


</div>


<div class="box">


<div class="boxTitle">
SİSTEM
</div>


<div
id="system"
class="info"
>
Bağlanıyor...
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


let selectedSignal =
null;


/* =====================================================
   HELPERS
===================================================== */

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
character
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
character
];

}
);

}


function price(
value
){

const n =
Number(
value
);


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


if(
n >= 0.0001
){

return n.toFixed(8);

}


return n.toFixed(10);

}


function normalize(
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

if(
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
)

&&

Number.isFinite(
item.open
)

&&

Number.isFinite(
item.high
)

&&

Number.isFinite(
item.low
)

&&

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

const clean =
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


const tf =
timeframe.toUpperCase();


$('symbol')
.textContent =
clean;


$('tfText')
.textContent =
tf;


$('chartName')
.textContent =
clean +
' • ' +
tf;

}


/* =====================================================
   ACTIVE SIGNAL
===================================================== */

function renderActive(
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


const cls =
signal.direction ===
'LONG'
?
'long'
:
'short';


$('active')
.innerHTML =

'<div class="activeName '+
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

'<div class="plan">'+


level(
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


level(
'STOP',
price(
signal.stop
),
'red'
)+


level(
'TP1',
price(
signal.tp1
),
'blue'
)+


level(
'TP2',
price(
signal.tp2
),
'blue'
)+


level(
'TP3',
price(
signal.tp3
),
'blue'
)+


level(
'R:R',
'1:'+
signal.rr,
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
esc(
value
)+
'</b>'+

'</div>'

);

}


/* =====================================================
   RENDER
===================================================== */

function render(
data
){

const stats =
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
0;


$('scanText')
.textContent =

data.lastScan

?

'Son tarama: '+
new Date(
data.lastScan
)
.toLocaleTimeString(
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

'<div class="empty">'+
'Teyit edilmiş sinyal yok.'+
'</div>';

}
else{

signals.forEach(
function(
item
){

const card =
document.createElement(
'div'
);


card.className =

'card '+

(
item.direction ===
'SHORT'
?
'short '
:
''
)+

(
item.marketSymbol ===
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
item.symbol
)+
'</div>'+

'<div class="badge '+
(
item.direction ===
'LONG'
?
'long'
:
'short'
)+
'">'+
esc(
item.direction
)+
'</div>'+

'</div>'+

'<div class="card-price">'+
price(
item.currentPrice ||
item.entry
)+
'</div>'+

'<div class="card-meta">'+
'● GİRİŞ ALANI • GÜÇ '+
esc(
item.score
)+
'/100'+
'</div>';


card.onclick =
function(){

selected =
item.marketSymbol;

selectedSignal =
item;

renderActive(
item
);

loadChart();

};


cards.appendChild(
card
);

}
);


}


const current =
signals.find(
function(
item
){

return (
item.marketSymbol ===
selected
);

}
)
||
signals[0]
||
null;


if(
current
){

selected =
current.marketSymbol;

selectedSignal =
current;

}


renderActive(
selectedSignal
);


const pending =
data.pending ||
[];


$('pending').innerHTML =

pending.length

?

pending.map(
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

'<br>Seviye '+
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
).join('')

:

'<div class="empty">'+
'Bekleyen setup yok.'+
'</div>';


$('system')
.textContent =

data.error

?

'HATA: '+
data.error

:

data.scanning

?

'Tarama devam ediyor...'

:

'SİSTEM AKTİF';


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


selectedSignal =
data.chart.signal ||
selectedSignal;


updateHeader();

drawChart();

}

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


if(
!data.success
){

throw new Error(
data.error ||
'Grafik alınamadı.'
);

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

selectedSignal =
data.signal;

renderActive(
data.signal
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


/* =====================================================
   CANVAS CHART
===================================================== */

function drawChart(){

const canvas =
$('chart');


if(
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
candle
){

values.push(
candle.high,
candle.low
);

});


if(
selectedSignal
){

[

selectedSignal.entryLow,
selectedSignal.entryHigh,
selectedSignal.entry,
selectedSignal.stop,
selectedSignal.tp1,
selectedSignal.tp2,
selectedSignal.tp3

]
.forEach(
function(
value
){

if(
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


const padding =
range *
0.07;


min -=
padding;


max +=
padding;


const left =
55;


const right =
85;


const top =
30;


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
gy +
3
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
candle,
index
){

const xx =
x(index);


const rising =
candle.close >=
candle.open;


const color =
rising
?
'#13e0a2'
:
'#ff4d6d';


ctx.strokeStyle =
color;


ctx.fillStyle =
color;


ctx.beginPath();

ctx.moveTo(
xx,
y(
candle.high
)
);

ctx.lineTo(
xx,
y(
candle.low
)
);

ctx.stroke();


const openY =
y(
candle.open
);


const closeY =
y(
candle.close
);


ctx.fillRect(

xx -
bodyWidth /
2,

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

}
);


/* ENTRY ZONE */

if(
selectedSignal &&
Number.isFinite(
Number(
selectedSignal.entryLow
)
) &&
Number.isFinite(
Number(
selectedSignal.entryHigh
)
)
){

const a =
y(
selectedSignal.entryLow
);


const b =
y(
selectedSignal.entryHigh
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
selectedSignal
){

drawLevel(
selectedSignal.stop,
'#ff5570',
'STOP'
);


drawLevel(
selectedSignal.entry,
'#13e0a2',
'GİRİŞ'
);


drawLevel(
selectedSignal.tp1,
'#55a7ff',
'TP1'
);


drawLevel(
selectedSignal.tp2,
'#55a7ff',
'TP2'
);


drawLevel(
selectedSignal.tp3,
'#55a7ff',
'TP3'
);

}


function drawLevel(
value,
color,
label
){

const number =
Number(value);


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

label+
' '+
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
   TIMEFRAME
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


/* =====================================================
   MANUAL SCAN
===================================================== */

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


/* =====================================================
   WEBSOCKET
===================================================== */

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


/* =====================================================
   INITIAL STATUS
===================================================== */

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


/* =====================================================
   CHART REFRESH
===================================================== */

setInterval(
function(){

loadChart();

},
15000
);


/* =====================================================
   RESIZE
===================================================== */

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

        console.error(
            'UNHANDLED:',
            error
        );

        STATE.lastError =
            error?.message ||
            String(
                error
            );

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
            String(
                error
            );

    }
);


/* =========================================================
   SERVER
========================================================= */

server.listen(
    PORT,
    '0.0.0.0',
    () => {

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
            '🌐 Server listening on ' +
            PORT
        );

        console.log(
            '================================================='
        );


        initialize()
            .catch(
                error => {

                    STATE.lastError =
                        error.message;

                    console.error(
                        'INITIALIZE ERROR:',
                        error.message
                    );

                }
            );

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


        /*
           İlk radar
        */

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


    /*
       60 saniyelik radar
    */

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


    /*
       Canlı fiyat,
       TP / SL durumları
    */

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
                    error => {

                        STATE.lastError =
                            error.message;

                        console.error(
                            'LIVE LOOP:',
                            error.message
                        );

                    }
                );

        },
        CFG.LIVE_MS
    );


    /*
       Cleanup
    */

    setInterval(
        function(){

            cleanup();

            broadcast();

        },
        5000
    );

}
