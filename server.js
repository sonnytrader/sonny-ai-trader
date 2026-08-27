'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = Number(process.env.PORT || 10000);

/*
==============================================================
 SONNY AI TRADER V5.4
 BITGET USDT FUTURES SCALP ENGINE

 500 RADAR
    ↓
 150 ADAY
    ↓
 40 DERİN ANALİZ
    ↓
 4H TREND
    ↓
 2H SEVİYE
    ↓
 15M BREAKOUT
    ↓
 15M RETEST
    ↓
 5M BONUS TEYİT
    ↓
 SCALP SİNYALİ

 ÖNEMLİ:
 5M teyidi ZORUNLU DEĞİL.
 Altcoin fırsatlarını kaçırmamak için skora bonus verir.

 AUTO TRADE: KAPALI
 FRONTEND: SERVER.JS İÇİNDE
==============================================================
*/

const CFG = {

    PRODUCT_TYPE: 'USDT-FUTURES',

    MAX_RADAR: 500,
    CANDIDATES: 150,
    DEEP: 40,

    MAX_SIGNALS: 15,

    /*
    Altcoinleri kaçırmamak için çok yüksek hacim
    şartı kullanılmıyor.
    */
    MIN_VOLUME_USD: 750000,

    MIN_24H_MOVE: 0.60,

    SCAN_MS: 60000,

    MARKET_REFRESH_MS:
        10 * 60 * 1000,

    REQUEST_CONCURRENCY: 5,

    /*
    Candle
    */
    CANDLE_LIMIT: 120,
    CHART_LIMIT: 180,

    /*
    Breakout
    */
    BREAKOUT_LOOKBACK: 12,

    MIN_BREAKOUT_VOLUME_RATIO: 1.05,

    MIN_BREAKOUT_BODY_ATR:
        0.18,

    /*
    Retest
    */
    RETEST_WINDOW_MINUTES: 90,

    RETEST_TOLERANCE:
        0.006,

    BREAKOUT_INVALIDATION:
        0.006,

    /*
    5M
    */
    FIVE_MIN_VOLUME_MIN:
        0.85,

    /*
    Score
    */
    MIN_SCORE: 62,

    /*
    Scalp RR
    */
    MIN_RR: 1.15,

    /*
    Entry
    */
    ENTRY_ZONE:
        0.0035,

    /*
    Stop
    */
    ATR_STOP:
        0.65,

    MIN_STOP_PCT:
        0.0025,

    MAX_STOP_PCT:
        0.012,

    /*
    Signal lifetime
    */
    SIGNAL_TTL:
        45 * 60 * 1000,

    LEVEL_COOLDOWN:
        4 * 60 * 60 * 1000

};


/*
==============================================================
 STATE
==============================================================
*/

const STATE = {

    markets: [],

    candidates: [],

    deep: [],

    signals:
        new Map(),

    pending:
        new Map(),

    cooldowns:
        new Map(),

    candles:
        new Map(),

    chart: {

        symbol:
            'BTCUSDT',

        tf:
            '15m',

        data: [],

        plan:
            null

    },

    market: {

        label:
            'VERİ BEKLENİYOR',

        breadth:
            50,

        average:
            0,

        green:
            0,

        red:
            0

    },

    stats: {

        radar:
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
            0

    },

    lastScan:
        0,

    lastError:
        null,

    scanning:
        false,

    marketLoadedAt:
        0

};


/*
==============================================================
 HELPERS
==============================================================
*/

function sleep(ms) {

    return new Promise(
        resolve => setTimeout(resolve, ms)
    );

}


function n(value, digits = 8) {

    const x =
        Number(value);

    if (!Number.isFinite(x)) {

        return 0;

    }

    return Number(
        x.toFixed(digits)
    );

}


function pct(value, base) {

    if (
        !Number.isFinite(value) ||
        !Number.isFinite(base) ||
        base === 0
    ) {

        return 0;

    }

    return (
        value / base
    ) * 100;

}


function clamp(value, min, max) {

    return Math.max(
        min,
        Math.min(max, value)
    );

}


function formatPrice(value) {

    const x =
        Number(value);

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

        return x.toFixed(4);

    }

    if (x >= 0.1) {

        return x.toFixed(5);

    }

    if (x >= 0.01) {

        return x.toFixed(6);

    }

    return x.toFixed(8);

}


function closed(candles) {

    if (
        !Array.isArray(candles) ||
        candles.length < 2
    ) {

        return candles || [];

    }

    /*
    Bitget son mum bazen halen açık olabilir.
    Son mumu kapalı kabul etmiyoruz.
    */

    return candles.slice(0, -1);

}


function candleObject(row) {

    return {

        time:
            Number(row[0]),

        open:
            Number(row[1]),

        high:
            Number(row[2]),

        low:
            Number(row[3]),

        close:
            Number(row[4]),

        volume:
            Number(row[5] || 0)

    };

}


/*
==============================================================
 INDICATORS
==============================================================
*/

function sma(values, period) {

    if (
        values.length <
        period
    ) {

        return null;

    }

    let sum = 0;

    for (
        let i =
            values.length - period;

        i <
            values.length;

        i++
    ) {

        sum +=
            values[i];

    }

    return (
        sum / period
    );

}


function ema(values, period) {

    if (
        values.length <
        period
    ) {

        return null;

    }

    let e =
        sma(
            values.slice(
                0,
                period
            ),
            period
        );

    const k =
        2 /
        (period + 1);

    for (
        let i =
            period;

        i <
            values.length;

        i++
    ) {

        e =
            values[i] * k +
            e * (1 - k);

    }

    return e;

}


function atr(candles, period = 14) {

    if (
        candles.length <
        period + 1
    ) {

        return 0;

    }

    const tr = [];

    for (
        let i = 1;

        i <
            candles.length;

        i++
    ) {

        const current =
            candles[i];

        const previous =
            candles[i - 1];

        tr.push(

            Math.max(

                current.high -
                    current.low,

                Math.abs(
                    current.high -
                    previous.close
                ),

                Math.abs(
                    current.low -
                    previous.close
                )

            )

        );

    }

    return (
        sma(
            tr,
            period
        ) || 0
    );

}


function rsi(candles, period = 14) {

    if (
        candles.length <
        period + 1
    ) {

        return 50;

    }

    let gain = 0;
    let loss = 0;

    for (
        let i =
            candles.length - period;

        i <
            candles.length;

        i++
    ) {

        const diff =
            candles[i].close -
            candles[i - 1].close;

        if (diff >= 0) {

            gain += diff;

        } else {

            loss -= diff;

        }

    }

    if (loss === 0) {

        return 100;

    }

    const rs =
        gain / loss;

    return (
        100 -
        100 /
            (1 + rs)
    );

}


function volumeRatio(
    candles,
    period = 20
) {

    if (
        candles.length <
        period + 2
    ) {

        return 1;

    }

    const current =
        candles[
            candles.length - 1
        ].volume;

    const previous =
        candles.slice(
            -period - 1,
            -1
        );

    const average =
        previous.reduce(
            (sum, item) =>
                sum + item.volume,
            0
        ) /
        previous.length;

    if (
        average <= 0
    ) {

        return 1;

    }

    return (
        current /
        average
    );

}


/*
==============================================================
 BITGET PUBLIC API
==============================================================
*/

async function bitget(
    path,
    params = {}
) {

    const url =
        new URL(
            'https://api.bitget.com' +
            path
        );

    Object.entries(
        params
    ).forEach(
        ([key, value]) => {

            if (
                value !== undefined &&
                value !== null
            ) {

                url.searchParams.set(
                    key,
                    String(value)
                );

            }

        }
    );

    const response =
        await fetch(
            url,
            {
                headers: {
                    Accept:
                        'application/json'
                }
            }
        );

    const text =
        await response.text();

    if (
        !response.ok
    ) {

        throw new Error(
            'Bitget HTTP ' +
            response.status
        );

    }

    let json;

    try {

        json =
            JSON.parse(text);

    } catch {

        throw new Error(
            'Bitget JSON parse hatası'
        );

    }

    if (
        json.code !==
        '00000'
    ) {

        throw new Error(
            'Bitget ' +
            json.code +
            ': ' +
            (
                json.msg ||
                'API error'
            )
        );

    }

    return json.data;

}


/*
==============================================================
 MARKET DISCOVERY
==============================================================
*/

async function discoverMarkets() {

    const [
        contracts,
        tickers
    ] =
        await Promise.all([

            bitget(
                '/api/v2/mix/market/contracts',
                {
                    productType:
                        CFG.PRODUCT_TYPE
                }
            ),

            bitget(
                '/api/v2/mix/market/tickers',
                {
                    productType:
                        CFG.PRODUCT_TYPE
                }
            )

        ]);


    const valid =
        new Set(

            (
                contracts ||
                []
            )
                .filter(
                    item =>

                        String(
                            item.quoteCoin ||
                            ''
                        )
                            .toUpperCase() ===
                        'USDT'

                        &&

                        String(
                            item.symbolStatus ||
                            ''
                        )
                            .toLowerCase() ===
                        'normal'
                )
                .map(
                    item =>
                        item.symbol
                )

        );


    const rows =
        (
            tickers ||
            []
        )
            .filter(
                ticker =>
                    valid.has(
                        ticker.symbol
                    )
            )
            .map(
                ticker => {

                    const price =
                        Number(
                            ticker.lastPr
                        );

                    const volume =
                        Number(
                            ticker.quoteVolume ||
                            ticker.usdtVolume ||
                            0
                        );

                    let change =
                        Number(
                            ticker.change24h ||
                            0
                        );

                    /*
                    Bitget bazı endpointlerde
                    değişimi decimal verir.
                    */

                    if (
                        Math.abs(change) <= 1
                    ) {

                        change *= 100;

                    }

                    return {

                        symbol:
                            ticker.symbol,

                        price,

                        volume24h:
                            volume,

                        change24h:
                            change,

                        absMove:
                            Math.abs(change)

                    };

                }
            )
            .filter(
                item =>

                    item.price > 0 &&

                    item.volume24h >=
                    CFG.MIN_VOLUME_USD &&

                    item.absMove >=
                    CFG.MIN_24H_MOVE
            );


    /*
    Önce hacim,
    sonra hareketlilik.
    */

    rows.sort(
        (a, b) => {

            const scoreA =
                a.volume24h *
                (
                    1 +
                    Math.min(
                        a.absMove,
                        30
                    ) /
                    100
                );

            const scoreB =
                b.volume24h *
                (
                    1 +
                    Math.min(
                        b.absMove,
                        30
                    ) /
                    100
                );

            return (
                scoreB -
                scoreA
            );

        }
    );


    STATE.markets =
        rows.slice(
            0,
            CFG.MAX_RADAR
        );


    STATE.stats.radar =
        STATE.markets.length;


    /*
    GERÇEK MARKET BREADTH
    */

    const green =
        STATE.markets.filter(
            x =>
                x.change24h > 0
        ).length;

    const red =
        STATE.markets.filter(
            x =>
                x.change24h < 0
        ).length;

    const average =
        STATE.markets.length
            ? STATE.markets.reduce(
                (
                    sum,
                    item
                ) =>
                    sum +
                    item.change24h,
                0
            ) /
            STATE.markets.length
            : 0;

    const breadth =
        STATE.markets.length
            ? (
                green /
                STATE.markets.length
            ) * 100
            : 50;


    let label =
        'YATAY';


    if (
        breadth >= 60 &&
        average >= 0.35
    ) {

        label =
            'YÜKSELİŞ';

    } else if (
        breadth <= 40 &&
        average <= -0.35
    ) {

        label =
            'DÜŞÜŞ';

    } else if (
        Math.abs(average) < 0.25 ||
        (
            breadth > 40 &&
            breadth < 60
        )
    ) {

        label =
            'YATAY / KARIŞIK';

    } else {

        label =
            average > 0
                ? 'POZİTİF'
                : 'NEGATİF';

    }


    STATE.market = {

        label,

        breadth:
            n(breadth, 1),

        average:
            n(average, 2),

        green,

        red

    };


    return STATE.markets;

}


/*
==============================================================
 CANDLE CACHE
==============================================================
*/

async function getCandles(
    symbol,
    timeframe,
    limit =
        CFG.CANDLE_LIMIT
) {

    const cacheKey =
        symbol +
        '|' +
        timeframe;


    let ttl;

    if (
        timeframe === '4H'
    ) {

        ttl =
            10 * 60 * 1000;

    } else if (
        timeframe === '2H'
    ) {

        ttl =
            5 * 60 * 1000;

    } else if (
        timeframe === '15m'
    ) {

        ttl =
            60 * 1000;

    } else {

        ttl =
            20 * 1000;

    }


    const cached =
        STATE.candles.get(
            cacheKey
        );


    if (
        cached &&
        Date.now() -
            cached.time <
            ttl
    ) {

        return cached.data;

    }


    const raw =
        await bitget(
            '/api/v2/mix/market/candles',
            {

                symbol,

                productType:
                    CFG.PRODUCT_TYPE,

                granularity:
                    timeframe,

                limit

            }
        );


    const data =
        (
            raw ||
            []
        )
            .map(
                candleObject
            )
            .filter(
                item =>
                    item.time &&
                    item.open > 0
            )
            .sort(
                (a, b) =>
                    a.time -
                    b.time
            );


    STATE.candles.set(
        cacheKey,
        {

            time:
                Date.now(),

            data

        }
    );


    return data;

}


/*
==============================================================
 CONCURRENT MAP
==============================================================
*/

async function mapLimit(
    items,
    limit,
    worker
) {

    const result =
        new Array(
            items.length
        );

    let index = 0;


    async function runWorker() {

        while (true) {

            const i =
                index++;

            if (
                i >=
                items.length
            ) {

                return;

            }


            try {

                result[i] =
                    await worker(
                        items[i],
                        i
                    );

            } catch {

                result[i] =
                    null;

            }


            await sleep(30);

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
            runWorker
        )

    );


    return result;

}


/*
==============================================================
 4H TREND
==============================================================
*/

function trend4H(candles) {

    const data =
        closed(candles);

    const closes =
        data.map(
            x =>
                x.close
        );


    const e21 =
        ema(
            closes,
            21
        );

    const e50 =
        ema(
            closes,
            50
        );


    if (
        !e21 ||
        !e50
    ) {

        return 'NEUTRAL';

    }


    const distance =
        pct(
            e21 - e50,
            e50
        );


    if (
        distance > 0.35
    ) {

        return 'LONG';

    }


    if (
        distance < -0.35
    ) {

        return 'SHORT';

    }


    return 'NEUTRAL';

}


/*
==============================================================
 4H LEVEL
==============================================================
*/

function level4H(candles) {

    const data =
        closed(candles);


    if (
        data.length < 30
    ) {

        return {

            resistance:
                null,

            support:
                null

        };

    }


    const window =
        data.slice(
            -25,
            -1
        );


    return {

        resistance:
            Math.max(
                ...window.map(
                    x =>
                        x.high
                )
            ),

        support:
            Math.min(
                ...window.map(
                    x =>
                        x.low
                )
            )

    };

}


/*
==============================================================
 2H LEVEL
==============================================================
*/

function level2H(candles) {

    const data =
        closed(candles);


    if (
        data.length < 30
    ) {

        return {

            resistance:
                null,

            support:
                null

        };

    }


    const window =
        data.slice(
            -25,
            -1
        );


    return {

        resistance:
            Math.max(
                ...window.map(
                    x =>
                        x.high
                )
            ),

        support:
            Math.min(
                ...window.map(
                    x =>
                        x.low
                )
            )

    };

}


/*
==============================================================
 15M BREAKOUT
==============================================================
*/

function findRecentBreakout(
    candles,
    higherLevel,
    direction
) {

    const data =
        closed(candles);


    if (
        data.length <
        CFG.BREAKOUT_LOOKBACK + 3
    ) {

        return null;

    }


    if (
        !higherLevel
    ) {

        return null;

    }


    /*
    Son 8 kapalı mumda
    breakout ara.
    */

    const start =
        Math.max(
            CFG.BREAKOUT_LOOKBACK,
            data.length - 8
        );


    /*
    4H/2H seviyesi ile
    15M breakout seviyesi
    arasında maksimum %1.2 fark.
    */

    const maxDistance =
        1.2;


    for (
        let i =
            start;

        i <
            data.length;

        i++
    ) {

        const history =
            data.slice(
                i -
                    CFG.BREAKOUT_LOOKBACK,
                i
            );


        const resistance =
            Math.max(
                ...history.map(
                    x =>
                        x.high
                )
            );


        const support =
            Math.min(
                ...history.map(
                    x =>
                        x.low
                )
            );


        const localLevel =
            direction === 'LONG'
                ? resistance
                : support;


        if (
            Math.abs(
                pct(
                    localLevel -
                        higherLevel,
                    higherLevel
                )
            ) >
            maxDistance
        ) {

            continue;

        }


        const partial =
            data.slice(
                0,
                i + 1
            );


        const current =
            data[i];


        const currentATR =
            atr(
                partial,
                14
            ) ||
            current.close *
                0.005;


        const volume =
            volumeRatio(
                partial,
                20
            );


        const body =
            Math.abs(
                current.close -
                current.open
            );


        if (
            direction === 'LONG' &&

            current.close >
                localLevel &&

            body >=
                currentATR *
                CFG.MIN_BREAKOUT_BODY_ATR &&

            volume >=
                CFG.MIN_BREAKOUT_VOLUME_RATIO
        ) {

            return {

                time:
                    current.time,

                level:
                    localLevel,

                volumeRatio:
                    volume,

                close:
                    current.close

            };

        }


        if (
            direction === 'SHORT' &&

            current.close <
                localLevel &&

            body >=
                currentATR *
                CFG.MIN_BREAKOUT_BODY_ATR &&

            volume >=
                CFG.MIN_BREAKOUT_VOLUME_RATIO
        ) {

            return {

                time:
                    current.time,

                level:
                    localLevel,

                volumeRatio:
                    volume,

                close:
                    current.close

            };

        }

    }


    return null;

}


/*
==============================================================
 RETEST
==============================================================
*/

function retestState(
    candles,
    breakout
) {

    if (
        !breakout
    ) {

        return {

            state:
                'NONE'

        };

    }


    const data =
        closed(candles);


    const cutoff =
        breakout.time;


    const maxTime =
        cutoff +
        CFG.RETEST_WINDOW_MINUTES *
            60 *
            1000;


    const recent =
        data.filter(
            candle =>
                candle.time >
                    cutoff &&

                candle.time <=
                    maxTime
        );


    if (
        !recent.length
    ) {

        return {

            state:
                'WAITING'

        };

    }


    const level =
        breakout.level;


    let touched =
        false;

    let held =
        false;


    for (
        const candle
            of recent
    ) {

        const tolerance =
            level *
            CFG.RETEST_TOLERANCE;


        if (
            candle.low <=
                level +
                tolerance &&

            candle.high >=
                level -
                tolerance
        ) {

            touched =
                true;


            if (
                breakout.direction ===
                    'LONG'
            ) {

                if (
                    candle.close >=
                    level *
                    (
                        1 -
                        CFG.BREAKOUT_INVALIDATION
                    )
                ) {

                    held =
                        true;

                }

            } else {

                if (
                    candle.close <=
                    level *
                    (
                        1 +
                        CFG.BREAKOUT_INVALIDATION
                    )
                ) {

                    held =
                        true;

                }

            }

        }

    }


    if (
        !touched
    ) {

        return {

            state:
                'WAITING'

        };

    }


    if (
        !held
    ) {

        return {

            state:
                'INVALID'

        };

    }


    const last =
        recent[
            recent.length - 1
        ];


    if (
        breakout.direction ===
            'LONG' &&

        last.close >
            level
    ) {

        return {

            state:
                'RETESTED',

            candle:
                last

        };

    }


    if (
        breakout.direction ===
            'SHORT' &&

        last.close <
            level
    ) {

        return {

            state:
                'RETESTED',

            candle:
                last

        };

    }


    return {

        state:
            'WAITING'

    };

}


/*
==============================================================
 5M TEYİT
==============================================================
*/

function fiveMinConfirm(
    candles,
    direction
) {

    const data =
        closed(candles);


    if (
        data.length <
        25
    ) {

        return {

            ok:
                false,

            score:
                0,

            rsi:
                50,

            volume:
                1

        };

    }


    const last =
        data[
            data.length - 1
        ];

    const previous =
        data[
            data.length - 2
        ];


    const currentRSI =
        rsi(
            data,
            14
        );


    const volume =
        volumeRatio(
            data,
            20
        );


    const closes =
        data.map(
            x =>
                x.close
        );


    const e9 =
        ema(
            closes,
            9
        );


    const e21 =
        ema(
            closes,
            21
        );


    const currentATR =
        atr(
            data,
            14
        ) ||
        last.close *
            0.003;


    const body =
        Math.abs(
            last.close -
            last.open
        );


    const impulse =
        body >=
        currentATR *
        0.10;


    let ok =
        false;

    let score =
        0;


    if (
        direction ===
            'LONG'
    ) {

        ok =
            last.close >
                previous.high

            ||

            (
                last.close >
                    last.open &&

                e9 >
                    e21 &&

                currentRSI >=
                    48 &&

                currentRSI <=
                    72
            );


        if (
            last.close >
                last.open
        ) {

            score +=
                5;

        }


        if (
            e9 >
                e21
        ) {

            score +=
                5;

        }


        if (
            currentRSI >=
                48 &&

            currentRSI <=
                72
        ) {

            score +=
                5;

        }

    } else {

        ok =
            last.close <
                previous.low

            ||

            (
                last.close <
                    last.open &&

                e9 <
                    e21 &&

                currentRSI >=
                    28 &&

                currentRSI <=
                    52
            );


        if (
            last.close <
                last.open
        ) {

            score +=
                5;

        }


        if (
            e9 <
                e21
        ) {

            score +=
                5;

        }


        if (
            currentRSI >=
                28 &&

            currentRSI <=
                52
        ) {

            score +=
                5;

        }

    }


    if (
        volume >=
        CFG.FIVE_MIN_VOLUME_MIN
    ) {

        score +=
            3;

    }


    if (
        impulse
    ) {

        score +=
            2;

    }


    return {

        ok,

        score:
            Math.min(
                score,
                20
            ),

        rsi:
            currentRSI,

        volume

    };

}


/*
==============================================================
 SCORE
==============================================================
*/

function scoreSetup({
    trend,
    direction,
    breakout4H,
    breakout2H,
    retest,
    five
}) {

    let score =
        0;


    /*
    4H
    */

    if (
        breakout4H
    ) {

        score +=
            24;

    }


    /*
    2H
    */

    if (
        breakout2H
    ) {

        score +=
            20;

    }


    /*
    Retest
    */

    if (
        retest
    ) {

        score +=
            24;

    }


    /*
    Trend
    */

    if (
        trend ===
        direction
    ) {

        score +=
            12;

    } else if (
        trend ===
        'NEUTRAL'
    ) {

        score +=
            5;

    }


    /*
    5M BONUS
    */

    if (
        five
    ) {

        score +=
            five.score;

    }


    return Math.min(
        100,
        score
    );

}


/*
==============================================================
 TRADE PLAN
==============================================================
*/

function createTradePlan({
    market,
    direction,
    level,
    candles5,
    score,
    reason
}) {

    const data =
        closed(
            candles5
        );


    const last =
        data[
            data.length - 1
        ];


    const currentATR =
        atr(
            data,
            14
        ) ||
        market.price *
            0.003;


    /*
    Son 6 mumun swing noktası.
    */

    const swingLow =
        Math.min(
            ...data
                .slice(-6)
                .map(
                    x =>
                        x.low
                )
        );


    const swingHigh =
        Math.max(
            ...data
                .slice(-6)
                .map(
                    x =>
                        x.high
                )
        );


    let stop;


    if (
        direction ===
            'LONG'
    ) {

        stop =
            Math.min(

                level *
                    (
                        1 -
                        CFG.MIN_STOP_PCT
                    ),

                swingLow -
                    currentATR *
                    0.08

            );

    } else {

        stop =
            Math.max(

                level *
                    (
                        1 +
                        CFG.MIN_STOP_PCT
                    ),

                swingHigh +
                    currentATR *
                    0.08

            );

    }


    let distance =
        Math.abs(
            level -
            stop
        );


    const minimumDistance =
        market.price *
        CFG.MIN_STOP_PCT;


    const maximumDistance =
        market.price *
        CFG.MAX_STOP_PCT;


    distance =
        clamp(

            Math.max(
                distance,
                currentATR *
                    CFG.ATR_STOP
            ),

            minimumDistance,

            maximumDistance

        );


    stop =
        direction ===
            'LONG'

            ? level -
                distance

            : level +
                distance;


    /*
    Giriş bölgesi
    */

    const entryLow =
        level *
        (
            1 -
            CFG.ENTRY_ZONE
        );


    const entryHigh =
        level *
        (
            1 +
            CFG.ENTRY_ZONE
        );


    const entry =
        (
            entryLow +
            entryHigh
        ) /
        2;


    /*
    Risk
    */

    const risk =
        Math.abs(
            entry -
            stop
        );


    /*
    Scalp TP
    */

    const tp1 =
        direction ===
            'LONG'

            ? entry +
                risk *
                1.15

            : entry -
                risk *
                1.15;


    const tp2 =
        direction ===
            'LONG'

            ? entry +
                risk *
                1.80

            : entry -
                risk *
                1.80;


    const tp3 =
        direction ===
            'LONG'

            ? entry +
                risk *
                2.50

            : entry -
                risk *
                2.50;


    const rr =
        risk > 0
            ? Math.abs(
                tp1 -
                entry
            ) /
            risk
            : 0;


    return {

        symbol:
            market.symbol,

        direction,

        status:
            'GİRİŞ BEKLENİYOR',

        score:
            Math.round(score),

        price:
            n(
                market.price,
                8
            ),

        entryLow:
            n(
                Math.min(
                    entryLow,
                    entryHigh
                ),
                8
            ),

        entryHigh:
            n(
                Math.max(
                    entryLow,
                    entryHigh
                ),
                8
            ),

        entry:
            n(
                entry,
                8
            ),

        stop:
            n(
                stop,
                8
            ),

        tp1:
            n(
                tp1,
                8
            ),

        tp2:
            n(
                tp2,
                8
            ),

        tp3:
            n(
                tp3,
                8
            ),

        rr:
            n(
                rr,
                2
            ),

        rsi:
            n(
                rsi(
                    data,
                    14
                ),
                1
            ),

        level:
            n(
                level,
                8
            ),

        reason,

        timeframe:
            '4H + 2H + 15M + 5M',

        createdAt:
            Date.now(),

        updatedAt:
            Date.now(),

        candleTime:
            last
                ? last.time
                : Date.now()

    };

}


/*
==============================================================
 KEY
==============================================================
*/

function setupKey(
    symbol,
    direction,
    level
) {

    return (

        symbol +
        '|' +
        direction +
        '|' +
        n(
            level,
            6
        )

    );

}


/*
==============================================================
 ANALYZE ONE COIN
==============================================================
*/

async function analyzeMarket(
    market
) {

    const symbol =
        market.symbol;


    const [
        candles4H,
        candles2H,
        candles15M
    ] =
        await Promise.all([

            getCandles(
                symbol,
                '4H'
            ),

            getCandles(
                symbol,
                '2H'
            ),

            getCandles(
                symbol,
                '15m'
            )

        ]);


    if (
        candles4H.length <
            60 ||

        candles2H.length <
            60 ||

        candles15M.length <
            40
    ) {

        return null;

    }


    const level4 =
        level4H(
            candles4H
        );


    const level2 =
        level2H(
            candles2H
        );


    const trend =
        trend4H(
            candles4H
        );


    let bestSignal =
        null;


    for (
        const direction
            of [
                'LONG',
                'SHORT'
            ]
    ) {

        const higher4HLevel =
            direction ===
                'LONG'

                ? level4.resistance

                : level4.support;


        const higher2HLevel =
            direction ===
                'LONG'

                ? level2.resistance

                : level2.support;


        /*
        Önce 4H seviyeyi ara.
        Bulamazsa 2H seviyeyi kullan.
        */

        const breakout4H =
            findRecentBreakout(
                candles15M,
                higher4HLevel,
                direction
            );


        const breakout2H =
            findRecentBreakout(
                candles15M,
                higher2HLevel,
                direction
            );


        const breakout =
            breakout4H ||
            breakout2H;


        if (
            !breakout
        ) {

            continue;

        }


        breakout.direction =
            direction;


        /*
        Retest
        */

        const retest =
            retestState(
                candles15M,
                breakout
            );


        /*
        Retest henüz oluşmadıysa
        pending'e al.
        */

        if (
            retest.state ===
            'WAITING'
        ) {

            const key =
                setupKey(
                    symbol,
                    direction,
                    breakout.level
                );


            STATE.pending.set(
                key,
                {

                    key,

                    symbol,

                    direction,

                    level:
                        breakout.level,

                    breakoutTime:
                        breakout.time,

                    volumeRatio:
                        breakout.volumeRatio,

                    trend,

                    state:
                        'YENİDEN TEST BEKLENİYOR',

                    updatedAt:
                        Date.now()

                }
            );


            console.log(

                'BREAKOUT | ' +
                symbol +
                ' | ' +
                direction +
                ' | ' +
                formatPrice(
                    breakout.level
                ) +
                ' | VOL ' +
                n(
                    breakout.volumeRatio,
                    2
                ) +
                'x'

            );


            continue;

        }


        if (
            retest.state ===
            'INVALID'
        ) {

            continue;

        }


        if (
            retest.state !==
            'RETESTED'
        ) {

            continue;

        }


        /*
        5M sadece bonus.
        ZORUNLU DEĞİL.
        */

        const candles5 =
            await getCandles(
                symbol,
                '5m',
                100
            );


        const five =
            fiveMinConfirm(
                candles5,
                direction
            );


        const score =
            scoreSetup({

                trend,

                direction,

                breakout4H:
                    !!breakout4H,

                breakout2H:
                    !!breakout2H,

                retest:
                    true,

                five

            });


        /*
        5M çok kötü ise engelle.
        Ama normal 5M teyidi zorunlu değil.
        */

        if (
            !five.ok &&
            five.score < 7
        ) {

            continue;

        }


        const plan =
            createTradePlan({

                market,

                direction,

                level:
                    breakout.level,

                candles5,

                score,

                reason:

                    '15M breakout + retest; ' +

                    '4H trend: ' +
                    trend +
                    '; ' +

                    '5M teyit: ' +
                    (
                        five.ok
                            ? 'UYUMLU'
                            : 'BONUS YOK'
                    )

            });


        /*
        RR şartı
        */

        if (
            plan.rr <
            CFG.MIN_RR
        ) {

            continue;

        }


        /*
        Minimum skor
        */

        if (
            score <
            CFG.MIN_SCORE
        ) {

            continue;

        }


        /*
        Fiyat giriş bölgesinden
        çok uzaklaştıysa giriş kovalamıyoruz.
        */

        const distanceFromEntry =
            Math.abs(
                pct(
                    market.price -
                    plan.entry,
                    plan.entry
                )
            );


        if (
            distanceFromEntry >
            1.20
        ) {

            continue;

        }


        bestSignal =
            plan;


        break;

    }


    return bestSignal;

}


/*
==============================================================
 CLEANUP
==============================================================
*/

function cleanup() {

    const now =
        Date.now();


    /*
    Eski pending
    */

    for (
        const [
            key,
            item
        ]
            of STATE.pending
    ) {

        if (
            now -
                item.breakoutTime
            >
            CFG.RETEST_WINDOW_MINUTES *
                60 *
                1000
        ) {

            STATE.pending.delete(
                key
            );

        }

    }


    /*
    Cooldown
    */

    for (
        const [
            key,
            time
        ]
            of STATE.cooldowns
    ) {

        if (
            now - time >
            CFG.LEVEL_COOLDOWN
        ) {

            STATE.cooldowns.delete(
                key
            );

        }

    }


    /*
    Eski sinyaller
    */

    for (
        const [
            key,
            signal
        ]
            of STATE.signals
    ) {

        if (
            now -
                signal.createdAt
            >
            CFG.SIGNAL_TTL
        ) {

            STATE.signals.delete(
                key
            );

        }

    }

}


/*
==============================================================
 CHART
==============================================================
*/

async function loadChart(
    symbol,
    timeframe,
    plan = null
) {

    try {

        const data =
            await getCandles(
                symbol,
                timeframe,
                CFG.CHART_LIMIT
            );


        STATE.chart = {

            symbol,

            tf:
                timeframe,

            data,

            plan:
                plan ||
                (
                    [
                        ...STATE
                            .signals
                            .values()
                    ]
                        .find(
                            item =>
                                item.symbol ===
                                symbol
                        )
                ) ||
                null

        };


    } catch (
        error
    ) {

        console.error(
            'CHART ERROR |',
            error.message
        );

    }

}


/*
==============================================================
 SNAPSHOT
==============================================================
*/

function snapshot() {

    return {

        success:
            true,

        stats: {

            radar:
                STATE.markets.length,

            candidates:
                STATE.candidates.length,

            deep:
                STATE.deep.length,

            analyzed:
                STATE.stats.analyzed,

            pending:
                STATE.pending.size,

            signals:
                STATE.signals.size

        },

        market:
            STATE.market,

        signals:
            [
                ...STATE
                    .signals
                    .values()
            ]
                .sort(
                    (a, b) =>
                        b.score -
                        a.score
                )
                .slice(
                    0,
                    CFG.MAX_SIGNALS
                ),

        pending:
            [
                ...STATE
                    .pending
                    .values()
            ]
                .sort(
                    (a, b) =>
                        b.updatedAt -
                        a.updatedAt
                )
                .slice(
                    0,
                    15
                ),

        radar:
            STATE.candidates
                .slice(
                    0,
                    40
                )
                .map(
                    item => ({

                        symbol:
                            item.symbol,

                        price:
                            item.price,

                        volume24h:
                            item.volume24h,

                        change24h:
                            item.change24h

                    })
                ),

        chart:
            STATE.chart,

        lastScan:
            STATE.lastScan,

        error:
            STATE.lastError,

        scanning:
            STATE.scanning

    };

}


/*
==============================================================
 BROADCAST
==============================================================
*/

function broadcast() {

    const payload =
        JSON.stringify(
            snapshot()
        );


    wss.clients.forEach(
        client => {

            if (
                client.readyState ===
                WebSocket.OPEN
            ) {

                client.send(
                    payload
                );

            }

        }
    );

}


/*
==============================================================
 RADAR
==============================================================
*/

async function runRadar() {

    if (
        STATE.scanning
    ) {

        return snapshot();

    }


    STATE.scanning =
        true;

    STATE.lastError =
        null;


    try {

        /*
        Market listesini
        10 dakikada bir yenile.
        */

        if (
            !STATE.markets.length ||

            Date.now() -
                STATE.marketLoadedAt
            >
            CFG.MARKET_REFRESH_MS
        ) {

            await discoverMarkets();

            STATE.marketLoadedAt =
                Date.now();

        }


        /*
        Hacim + hareketlilik
        */

        const sorted =
            [
                ...STATE.markets
            ].sort(
                (a, b) => {

                    const scoreA =
                        a.volume24h *
                        (
                            1 +
                            a.absMove /
                                100
                        );

                    const scoreB =
                        b.volume24h *
                        (
                            1 +
                            b.absMove /
                                100
                        );

                    return (
                        scoreB -
                        scoreA
                    );

                }
            );


        STATE.candidates =
            sorted.slice(
                0,
                CFG.CANDIDATES
            );


        STATE.deep =
            STATE.candidates.slice(
                0,
                CFG.DEEP
            );


        STATE.stats.candidates =
            STATE.candidates.length;


        STATE.stats.deep =
            STATE.deep.length;


        let analyzed =
            0;


        const foundSignals =
            [];


        await mapLimit(

            STATE.deep,

            CFG.REQUEST_CONCURRENCY,

            async market => {

                const signal =
                    await analyzeMarket(
                        market
                    );


                analyzed++;


                if (
                    signal
                ) {

                    foundSignals.push(
                        signal
                    );

                }

            }

        );


        STATE.stats.analyzed =
            analyzed;


        /*
        Sinyalleri kaydet.
        */

        for (
            const signal
                of foundSignals
        ) {

            const key =
                signal.symbol +
                '|' +
                signal.direction;


            const cooldown =
                STATE.cooldowns.get(
                    key
                );


            if (
                cooldown &&

                Date.now() -
                    cooldown
                <
                CFG.LEVEL_COOLDOWN
            ) {

                continue;

            }


            STATE.signals.set(
                key,
                signal
            );


            console.log(

                'SIGNAL | ' +

                signal.symbol +

                ' | ' +

                signal.direction +

                ' | SCORE ' +

                signal.score +

                ' | RR 1:' +

                signal.rr

            );

        }


        cleanup();


        STATE.stats.pending =
            STATE.pending.size;


        STATE.stats.signals =
            STATE.signals.size;


        STATE.lastScan =
            Date.now();


        /*
        En iyi sinyalin grafiğini aç.
        */

        if (
            STATE.signals.size
        ) {

            const first =
                [
                    ...STATE
                        .signals
                        .values()
                ]
                    .sort(
                        (a, b) =>
                            b.score -
                            a.score
                    )[0];


            await loadChart(
                first.symbol,
                '15m',
                first
            );

        } else if (
            !STATE.chart.data.length
        ) {

            await loadChart(
                'BTCUSDT',
                '15m',
                null
            );

        }


        broadcast();


        console.log(

            'RADAR tamamlandı | ' +

            'Universe=' +
            STATE.markets.length +

            ' | Candidates=' +
            STATE.candidates.length +

            ' | Deep=' +
            STATE.deep.length +

            ' | Analiz=' +
            analyzed +

            ' | Pending=' +
            STATE.pending.size +

            ' | SIGNAL=' +
            STATE.signals.size

        );


        return snapshot();


    } catch (
        error
    ) {

        STATE.lastError =
            error.message;


        console.error(
            'RADAR ERROR |',
            error.message
        );


        broadcast();


        return snapshot();


    } finally {

        STATE.scanning =
            false;

    }

}


/*
==============================================================
 FRONTEND
 SERVER.JS İÇİNDE
==============================================================
*/

const HTML = `

<!doctype html>

<html lang="tr">

<head>

<meta charset="utf-8">

<meta
    name="viewport"
    content="width=device-width, initial-scale=1"
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
        #070b12;

    color:
        #e8edf5;

    font-family:
        Arial,
        Helvetica,
        sans-serif;

}


.app {

    display:
        grid;

    grid-template-columns:
        245px
        minmax(0, 1fr)
        285px;

    min-height:
        100vh;

}


.side,
.right {

    background:
        #0b111b;

    border-color:
        #1b2637;

}


.side {

    border-right:
        1px solid #1b2637;

    padding:
        14px;

    overflow:
        auto;

}


.right {

    border-left:
        1px solid #1b2637;

    padding:
        12px;

    overflow:
        auto;

}


.brand {

    font-size:
        19px;

    font-weight:
        800;

}


.brand small {

    display:
        block;

    color:
        #71819a;

    font-size:
        10px;

    margin-top:
        5px;

}


.radarStats {

    display:
        grid;

    grid-template-columns:
        repeat(
            3,
            1fr
        );

    gap:
        5px;

    margin:
        14px 0;

}


.stat {

    background:
        #101927;

    border:
        1px solid #1c2a3d;

    border-radius:
        7px;

    padding:
        8px;

    text-align:
        center;

}


.stat b {

    display:
        block;

    font-size:
        16px;

}


.stat span {

    font-size:
        8px;

    color:
        #71819a;

}


.scan {

    width:
        100%;

    padding:
        11px;

    border:
        0;

    border-radius:
        7px;

    background:
        #1a3157;

    color:
        #fff;

    font-weight:
        800;

    cursor:
        pointer;

    margin-bottom:
        10px;

}


.coin {

    background:
        #0f1724;

    border:
        1px solid #1c2b3f;

    border-left:
        3px solid #3478db;

    border-radius:
        8px;

    padding:
        10px;

    margin:
        7px 0;

    cursor:
        pointer;

}


.coin:hover {

    background:
        #142033;

}


.coin b {

    font-size:
        13px;

}


.coin .p {

    font-size:
        17px;

    font-weight:
        800;

    margin-top:
        5px;

}


.coin small {

    color:
        #73839a;

    font-size:
        9px;

}


.main {

    min-width:
        0;

    padding:
        12px;

}


.top {

    display:
        flex;

    justify-content:
        space-between;

    align-items:
        center;

    gap:
        12px;

    border-bottom:
        1px solid #1b2637;

    padding:
        8px 0 12px;

}


.title {

    font-size:
        19px;

    font-weight:
        800;

}


.sub {

    color:
        #71819a;

    font-size:
        9px;

    margin-top:
        5px;

}


.chartHead {

    display:
        flex;

    justify-content:
        space-between;

    align-items:
        center;

    margin:
        10px 0;

}


.tf button {

    background:
        #101a2a;

    color:
        #9eb0c8;

    border:
        1px solid #263852;

    border-radius:
        5px;

    padding:
        6px 9px;

    margin-left:
        4px;

    font-size:
        10px;

    cursor:
        pointer;

}


.tf button.active {

    color:
        #fff;

    border-color:
        #42a5ff;

    background:
        #173157;

}


.chartWrap {

    height:
        610px;

    background:
        #080d15;

    border:
        1px solid #1a2638;

    border-radius:
        8px;

    position:
        relative;

    overflow:
        hidden;

}


.chartWrap canvas {

    width:
        100%;

    height:
        100%;

    display:
        block;

}


.legend {

    display:
        flex;

    gap:
        13px;

    font-size:
        10px;

    color:
        #8494aa;

    padding:
        7px;

}


.dot {

    display:
        inline-block;

    width:
        8px;

    height:
        8px;

    border-radius:
        50%;

    margin-right:
        4px;

}


.market {

    background:
        #101823;

    border:
        1px solid #1c2939;

    border-radius:
        8px;

    padding:
        12px;

    margin-bottom:
        10px;

}


.market h3 {

    margin:
        0 0 8px;

    font-size:
        11px;

    color:
        #75869e;

}


.market .big {

    font-size:
        20px;

    font-weight:
        900;

}


.up {

    color:
        #20d99a;

}


.down {

    color:
        #ff5870;

}


.yellow {

    color:
        #ffc84a;

}


.mgrid {

    display:
        grid;

    grid-template-columns:
        1fr 1fr;

    gap:
        7px;

    margin-top:
        10px;

}


.mini {

    background:
        #0a111b;

    border-radius:
        6px;

    padding:
        8px;

}


.mini small {

    display:
        block;

    color:
        #73839a;

    font-size:
        8px;

}


.mini b {

    font-size:
        12px;

}


.signal {

    background:
        #101823;

    border:
        1px solid #26374e;

    border-radius:
        8px;

    padding:
        11px;

    margin-bottom:
        9px;

}


.signal.LONG {

    border-left:
        3px solid #20d99a;

}


.signal.SHORT {

    border-left:
        3px solid #ff4f6b;

}


.sigTop {

    display:
        flex;

    justify-content:
        space-between;

}


.badge {

    font-size:
        9px;

    padding:
        4px 6px;

    border-radius:
        4px;

    background:
        #17324b;

}


.signal h2 {

    font-size:
        15px;

    margin:
        7px 0;

}


.rows {

    display:
        grid;

    grid-template-columns:
        1fr 1fr;

    gap:
        6px;

}


.row {

    background:
        #0a111b;

    padding:
        7px;

    border-radius:
        5px;

}


.row small {

    display:
        block;

    color:
        #71819a;

    font-size:
        8px;

}


.row b {

    font-size:
        11px;

}


.note {

    font-size:
        9px;

    color:
        #8b9bb1;

    line-height:
        1.45;

    margin-top:
        8px;

}


.pending {

    border-left:
        3px solid #ffc84a;

}


.mobileBottom {

    display:
        none;

}


@media (
    max-width: 1100px
) {

    .app {

        grid-template-columns:
            205px
            minmax(0, 1fr);

    }


    .right {

        display:
            none;

    }


    .chartWrap {

        height:
            560px;

    }

}


@media (
    max-width: 720px
) {

    .app {

        display:
            block;

    }


    .side {

        border:
            0;

        padding:
            9px;

    }


    .brand {

        font-size:
            17px;

    }


    .radarStats {

        margin:
            8px 0;

    }


    .coin {

        display:
            none;

    }


    .coin:nth-of-type(-n+5) {

        display:
            block;

    }


    .main {

        padding:
            8px;

    }


    .top {

        align-items:
            flex-start;

    }


    .title {

        font-size:
            16px;

    }


    .chartWrap {

        height:
            55vh;

        min-height:
            360px;

    }


    .mobileBottom {

        display:
            block;

        position:
            sticky;

        bottom:
            0;

        background:
            #0b111b;

        border-top:
            1px solid #1b2637;

        padding:
            8px;

        margin:
            0 -8px;

    }


    .mobileBottom .signal {

        margin:
            0;

    }


    .rows {

        grid-template-columns:
            1fr 1fr;

    }


    .tf button {

        padding:
            6px 7px;

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

V5.4 • BITGET USDT FUTURES • SCALP ENGINE

</small>

</div>


<div class="radarStats">


<div class="stat">

<b id="radar">
0
</b>

<span>
RADAR
</span>

</div>


<div class="stat">

<b id="cand">
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


<button
    class="scan"
    id="scan"
>
RADARI YENİLE
</button>


<div id="coins">
</div>


</aside>


<main class="main">


<div class="top">


<div>

<div
    class="title"
    id="chartTitle"
>
BTCUSDT • 15M
</div>


<div class="sub">

500 RADAR →
150 ADAY →
40 DERİN →
4H/2H SEVİYE →
15M BREAKOUT →
RETEST →
5M SCALP

</div>

</div>


<div
    class="sub"
    id="last"
>
Bekleniyor...
</div>


</div>


<div class="chartHead">


<b>
GRAFİK
</b>


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

<button data-tf="1H">
1H
</button>

<button data-tf="2H">
2H
</button>

<button data-tf="4H">
4H
</button>

</div>


</div>


<div class="chartWrap">

<canvas id="chart">
</canvas>

</div>


<div class="legend">

<span>

<i
    class="dot"
    style="background:#27d9a0"
></i>

Fiyat

</span>


<span>

<i
    class="dot"
    style="background:#36a3ff"
></i>

TP

</span>


<span>

<i
    class="dot"
    style="background:#ff536d"
></i>

STOP

</span>


<span>

<i
    class="dot"
    style="background:#ffc84a"
></i>

GİRİŞ

</span>

</div>


<div
    id="mobileSignal"
    class="mobileBottom"
>
</div>


</main>


<aside class="right">


<div class="market">

<h3>
GENEL PİYASA
</h3>


<div
    class="big"
    id="marketLabel"
>
VERİ BEKLENİYOR
</div>


<div class="mgrid">


<div class="mini">

<small>
BREADTH
</small>

<b id="breadth">
--
</b>

</div>


<div class="mini">

<small>
ORTALAMA
</small>

<b id="avg">
--
</b>

</div>


<div class="mini">

<small>
YEŞİL
</small>

<b id="green">
--
</b>

</div>


<div class="mini">

<small>
KIRMIZI
</small>

<b id="red">
--
</b>

</div>


</div>

</div>


<div>

<h3
    style="font-size:11px"
>
AKTİF SCALP SİNYALLERİ
</h3>

<div id="signals">
</div>

</div>


<div>

<h3
    style="font-size:11px"
>
BEKLEYEN BREAKOUT / RETEST
</h3>

<div id="pending">
</div>

</div>


</aside>


</div>


<script>

let state =
    null;

let currentTF =
    '15m';


const $ =
    id =>
        document.getElementById(id);


/*
==========================================================
 FORMAT
==========================================================
*/

function formatPrice(
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

        return x.toFixed(4);

    }

    if (
        x >= 0.1
    ) {

        return x.toFixed(5);

    }

    if (
        x >= 0.01
    ) {

        return x.toFixed(6);

    }

    return x.toFixed(8);

}


function escapeText(
    value
) {

    return String(
        value || ''
    )
        .replace(
            /[&<>]/g,
            char => ({

                '&':
                    '&amp;',

                '<':
                    '&lt;',

                '>':
                    '&gt;'

            }[char])
        );

}


/*
==========================================================
 SIGNAL CARD
==========================================================
*/

function signalCard(
    signal
) {

    return `

<div class="signal ${signal.direction}">

<div class="sigTop">

<b>

${escapeText(
    signal.symbol
)}
•
${escapeText(
    signal.direction
)}

</b>

<span class="badge">

SKOR
${signal.score}

</span>

</div>


<h2>

${escapeText(
    signal.status
)}

</h2>


<div class="rows">


<div class="row">

<small>
GİRİŞ BÖLGESİ
</small>

<b>

${formatPrice(
    signal.entryLow
)}

—

${formatPrice(
    signal.entryHigh
)}

</b>

</div>


<div class="row">

<small>
STOP
</small>

<b class="down">

${formatPrice(
    signal.stop
)}

</b>

</div>


<div class="row">

<small>
TP1
</small>

<b class="up">

${formatPrice(
    signal.tp1
)}

</b>

</div>


<div class="row">

<small>
TP2
</small>

<b class="up">

${formatPrice(
    signal.tp2
)}

</b>

</div>


<div class="row">

<small>
TP3
</small>

<b class="up">

${formatPrice(
    signal.tp3
)}

</b>

</div>


<div class="row">

<small>
R:R / RSI
</small>

<b>

1:${signal.rr}
/
${signal.rsi}

</b>

</div>


</div>


<div class="note">

${escapeText(
    signal.reason
)}

</div>


</div>

`;

}


/*
==========================================================
 RENDER
==========================================================
*/

function render(
    data
) {

    state =
        data;


    $('radar')
        .textContent =
        data.stats.radar;


    $('cand')
        .textContent =
        data.stats.candidates;


    $('deep')
        .textContent =
        data.stats.deep;


    $('marketLabel')
        .textContent =
        data.market.label;


    $('breadth')
        .textContent =
        data.market.breadth +
        '%';


    $('avg')
        .textContent =
        data.market.average +
        '%';


    $('green')
        .textContent =
        data.market.green;


    $('red')
        .textContent =
        data.market.red;


    $('last')
        .textContent =
        data.lastScan
            ? new Date(
                data.lastScan
            ).toLocaleTimeString(
                'tr-TR'
            )
            : 'Tarama...';


    const marketName =
        data.market.label;


    $('marketLabel')
        .className =
        'big ' +

        (
            marketName.includes(
                'YÜK'
            ) ||
            marketName ===
                'POZİTİF'

                ? 'up'

                : marketName ===
                      'DÜŞÜŞ' ||
                  marketName ===
                      'NEGATİF'

                    ? 'down'

                    : 'yellow'
        );


    /*
    Radar
    */

    $('coins')
        .innerHTML =

        data.radar
            .map(
                item => `

<div
    class="coin"
    data-symbol="${item.symbol}"
>

<b>
${item.symbol}
</b>

<div class="p">

${formatPrice(
    item.price
)}

</div>

<small>

24H
${item.change24h >= 0 ? '+' : ''}
${Number(
    item.change24h
).toFixed(2)}%

•

HACİM
${Math.round(
    item.volume24h /
    1000000
)}M

</small>

</div>

`
            )
            .join('');


    /*
    Coin click
    */

    data.radar.forEach(
        item => {

            const element =
                document.querySelector(
                    '.coin[data-symbol="' +
                    item.symbol +
                    '"]'
                );


            if (
                element
            ) {

                element.onclick =
                    () =>
                        loadChart(
                            item.symbol,
                            currentTF
                        );

            }

        }
    );


    /*
    Signals
    */

    $('signals')
        .innerHTML =

        data.signals.length

            ? data.signals
                .map(
                    signalCard
                )
                .join('')

            :

            `

<div class="note">

Henüz teyit edilmiş
scalp sinyali yok.

</div>

`;


    /*
    Pending
    */

    $('pending')
        .innerHTML =

        data.pending.length

            ? data.pending
                .map(
                    item => `

<div class="signal pending">

<b>

${item.symbol}
${item.direction}

</b>

<div class="note">

Seviye
${formatPrice(
    item.level
)}

•

Hacim
${Number(
    item.volumeRatio
).toFixed(2)}x

•

${escapeText(
    item.state
)}

</div>

</div>

`
                )
                .join('')

            :

            `

<div class="note">

Bekleyen
breakout/retest yok.

</div>

`;


    /*
    Chart
    */

    if (
        data.chart &&
        data.chart.data &&
        data.chart.data.length
    ) {

        drawChart(
            data.chart
        );


        $('chartTitle')
            .textContent =

            data.chart.symbol +
            ' • ' +
            data.chart.tf
                .toUpperCase();

    }


    /*
    Mobile active signal
    */

    $('mobileSignal')
        .innerHTML =

        data.signals[0]
            ? signalCard(
                data.signals[0]
            )
            : '';

}


/*
==========================================================
 CHART
==========================================================
*/

function drawChart(
    chart
) {

    const canvas =
        $('chart');


    const box =
        canvas.getBoundingClientRect();


    const dpr =
        window.devicePixelRatio ||
        1;


    const width =
        Math.max(
            300,
            box.width
        );


    const height =
        Math.max(
            300,
            box.height
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


    ctx.clearRect(
        0,
        0,
        width,
        height
    );


    const candles =
        chart.data.slice(
            -130
        );


    if (
        !candles.length
    ) {

        return;

    }


    /*
    ======================================================
    RANGE
    ======================================================
    */

    let min =
        Math.min(
            ...candles.map(
                x =>
                    x.low
            )
        );


    let max =
        Math.max(
            ...candles.map(
                x =>
                    x.high
            )
        );


    /*
    Plan seviyeleri grafiğe dahil.
    Böylece giriş/stop/TP
    kesinlikle görünür.
    */

    if (
        chart.plan
    ) {

        [

            chart.plan.stop,

            chart.plan.entryLow,

            chart.plan.entryHigh,

            chart.plan.tp1,

            chart.plan.tp2,

            chart.plan.tp3

        ]
            .forEach(
                value => {

                    const x =
                        Number(value);

                    if (
                        Number.isFinite(x)
                    ) {

                        min =
                            Math.min(
                                min,
                                x
                            );

                        max =
                            Math.max(
                                max,
                                x
                            );

                    }

                }
            );

    }


    const padding = {

        left:
            52,

        right:
            78,

        top:
            25,

        bottom:
            30

    };


    const plotWidth =
        width -
        padding.left -
        padding.right;


    const plotHeight =
        height -
        padding.top -
        padding.bottom;


    function y(
        value
    ) {

        return (

            padding.top +

            (
                max -
                value
            ) /
            (
                max -
                min ||
                1
            ) *

            plotHeight

        );

    }


    function x(
        index
    ) {

        return (

            padding.left +

            index /
            (
                candles.length -
                1
            ) *

            plotWidth

        );

    }


    /*
    ======================================================
    GRID
    ======================================================
    */

    ctx.strokeStyle =
        '#142032';

    ctx.lineWidth =
        1;


    for (
        let i = 0;
        i < 6;
        i++
    ) {

        const gridY =
            padding.top +
            i *
            plotHeight /
            5;


        ctx.beginPath();

        ctx.moveTo(
            padding.left,
            gridY
        );

        ctx.lineTo(
            width -
                padding.right,
            gridY
        );

        ctx.stroke();


        ctx.fillStyle =
            '#64748b';

        ctx.font =
            '9px Arial';


        ctx.fillText(

            formatPrice(

                max -

                (
                    max -
                    min
                ) *
                i /
                5

            ),

            5,

            gridY + 3

        );

    }


    /*
    ======================================================
    CANDLES
    ======================================================
    */

    const candleWidth =
        Math.max(
            2,
            plotWidth /
                candles.length *
                0.62
        );


    candles.forEach(
        (candle, index) => {

            const X =
                x(index);


            const openY =
                y(
                    candle.open
                );


            const closeY =
                y(
                    candle.close
                );


            const highY =
                y(
                    candle.high
                );


            const lowY =
                y(
                    candle.low
                );


            const rising =
                candle.close >=
                candle.open;


            ctx.strokeStyle =
                rising
                    ? '#24d9a0'
                    : '#ff4e6a';


            ctx.fillStyle =
                ctx.strokeStyle;


            /*
            Wick
            */

            ctx.beginPath();

            ctx.moveTo(
                X,
                highY
            );

            ctx.lineTo(
                X,
                lowY
            );

            ctx.stroke();


            /*
            Body
            */

            ctx.fillRect(

                X -
                    candleWidth /
                    2,

                Math.min(
                    openY,
                    closeY
                ),

                candleWidth,

                Math.max(
                    1,
                    Math.abs(
                        closeY -
                        openY
                    )
                )

            );

        }
    );


    /*
    ======================================================
    LEVEL DRAW
    ======================================================
    */

    if (
        chart.plan
    ) {

        drawLevel(
            chart.plan.stop,
            '#ff536d',
            'STOP'
        );


        drawLevel(

            (
                Number(
                    chart.plan.entryLow
                ) +

                Number(
                    chart.plan.entryHigh
                )

            ) / 2,

            '#ffc84a',

            'GİRİŞ'

        );


        drawLevel(
            chart.plan.tp1,
            '#36a3ff',
            'TP1'
        );


        drawLevel(
            chart.plan.tp2,
            '#36a3ff',
            'TP2'
        );


        drawLevel(
            chart.plan.tp3,
            '#36a3ff',
            'TP3'
        );

    }


    function drawLevel(
        value,
        color,
        label
    ) {

        const price =
            Number(value);


        if (
            !Number.isFinite(price)
        ) {

            return;

        }


        if (
            price < min ||
            price > max
        ) {

            return;

        }


        const lineY =
            y(price);


        ctx.strokeStyle =
            color;

        ctx.lineWidth =
            1;

        ctx.setLineDash(
            [
                6,
                5
            ]
        );


        ctx.beginPath();

        ctx.moveTo(
            padding.left,
            lineY
        );

        ctx.lineTo(
            width -
                padding.right,
            lineY
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
            formatPrice(
                price
            ),

            width -
                padding.right +
                5,

            lineY + 3

        );

    }

}


/*
==========================================================
 CHART REQUEST
==========================================================
*/

async function loadChartFromUI(
    symbol,
    timeframe
) {

    try {

        const response =
            await fetch(

                '/api/chart?symbol=' +
                encodeURIComponent(
                    symbol
                ) +
                '&tf=' +
                encodeURIComponent(
                    timeframe
                )

            );


        const data =
            await response.json();


        if (
            data.success
        ) {

            state.chart =
                data.chart;


            drawChart(
                state.chart
            );


            $('chartTitle')
                .textContent =

                state.chart.symbol +
                ' • ' +
                state.chart.tf
                    .toUpperCase();

        }

    } catch {

    }

}


/*
==========================================================
 TIMEFRAME BUTTONS
==========================================================
*/

document
    .querySelectorAll(
        '.tf button'
    )
    .forEach(
        button => {

            button.onclick =
                () => {

                    currentTF =
                        button.dataset.tf;


                    document
                        .querySelectorAll(
                            '.tf button'
                        )
                        .forEach(
                            item =>

                                item.classList
                                    .toggle(
                                        'active',
                                        item ===
                                        button
                                    )

                        );


                    loadChartFromUI(

                        state &&
                        state.chart
                            ? state.chart.symbol
                            : 'BTCUSDT',

                        currentTF

                    );

                };

        }
    );


/*
==========================================================
 SCAN BUTTON
==========================================================
*/

$('scan')
    .onclick =
    () => {

        fetch(
            '/api/scan'
        )
            .catch(
                () => {}
            );

    };


/*
==========================================================
 WEBSOCKET
==========================================================
*/

const protocol =
    location.protocol ===
    'https:'
        ? 'wss:'
        : 'ws:';


let socket;


function connectSocket() {

    socket =
        new WebSocket(
            protocol +
            '//' +
            location.host
        );


    socket.onmessage =
        event => {

            try {

                render(
                    JSON.parse(
                        event.data
                    )
                );

            } catch {

            }

        };


    socket.onclose =
        () => {

            setTimeout(
                connectSocket,
                2000
            );

        };

}


connectSocket();


/*
==========================================================
 INITIAL LOAD
==========================================================
*/

fetch(
    '/api/result'
)
    .then(
        response =>
            response.json()
    )
    .then(
        data =>
            render(data)
    )
    .catch(
        () => {}
    );


/*
==========================================================
 RESIZE
==========================================================
*/

window.addEventListener(
    'resize',
    () => {

        if (
            state &&
            state.chart &&
            state.chart.data &&
            state.chart.data.length
        ) {

            drawChart(
                state.chart
            );

        }

    }
);

</script>


</body>

</html>

`;


/*
==============================================================
 ROUTES
==============================================================
*/

app.get(
    '/',
    (
        req,
        res
    ) => {

        res.setHeader(
            'Cache-Control',
            'no-store, no-cache, must-revalidate'
        );

        res.setHeader(
            'Content-Type',
            'text/html; charset=utf-8'
        );

        res.send(
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

            success:
                true,

            status:
                'healthy',

            uptime:
                process.uptime(),

            stats:
                STATE.stats

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
            snapshot()
        );

    }
);


app.get(
    '/api/result',
    (
        req,
        res
    ) => {

        res.setHeader(
            'Cache-Control',
            'no-store'
        );

        res.json(
            snapshot()
        );

    }
);


app.get(
    '/api/scan',
    async (
        req,
        res
    ) => {

        const result =
            await runRadar();

        res.json(
            result
        );

    }
);


/*
==============================================================
 CHART API
==============================================================
*/

app.get(
    '/api/chart',
    async (
        req,
        res
    ) => {

        try {

            const symbol =
                String(
                    req.query.symbol ||
                    'BTCUSDT'
                )
                    .toUpperCase()
                    .replace(
                        '/USDT:USDT',
                        ''
                    )
                    .replace(
                        '/USDT',
                        ''
                    );


            const timeframeMap = {

                '5m':
                    '5m',

                '15m':
                    '15m',

                '1h':
                    '1H',

                '1H':
                    '1H',

                '2h':
                    '2H',

                '2H':
                    '2H',

                '4h':
                    '4H',

                '4H':
                    '4H'

            };


            const timeframe =
                timeframeMap[
                    String(
                        req.query.tf ||
                        '15m'
                    )
                ] ||
                '15m';


            const market =
                STATE.markets.find(
                    item =>
                        item.symbol ===
                        symbol
                );


            /*
            İlk açılışta BTC henüz
            market listesine girmemişse
            chart yine çalışabilsin.
            */

            const candles =
                await getCandles(
                    symbol,
                    timeframe,
                    CFG.CHART_LIMIT
                );


            const plan =
                [
                    ...STATE
                        .signals
                        .values()
                ]
                    .find(
                        item =>
                            item.symbol ===
                            symbol
                    ) ||
                null;


            STATE.chart = {

                symbol,

                tf:
                    timeframe,

                data:
                    candles,

                plan

            };


            res.json({

                success:
                    true,

                chart:
                    STATE.chart

            });


        } catch (
            error
        ) {

            res.status(
                500
            ).json({

                success:
                    false,

                error:
                    error.message

            });

        }

    }
);


/*
==============================================================
 WEBSOCKET
==============================================================
*/

wss.on(
    'connection',
    socket => {

        socket.send(
            JSON.stringify(
                snapshot()
            )
        );

    }
);


/*
==============================================================
 START
==============================================================
*/

async function boot() {

    console.log(
        '=============================================='
    );

    console.log(
        '🚀 SONNY AI TRADER V5.4'
    );

    console.log(
        '📡 Bitget USDT Futures'
    );

    console.log(
        '🛰️ Radar: 500'
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
        '🎯 5M teyidi: BONUS / ZORUNLU DEĞİL'
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
        '=============================================='
    );


    server.listen(
        PORT,
        () => {

            console.log(
                '🌐 Server listening on ' +
                PORT
            );

        }
    );


    /*
    İlk tarama
    */

    await runRadar();


    /*
    Sonraki taramalar
    */

    setInterval(
        runRadar,
        CFG.SCAN_MS
    );

}


boot()
    .catch(
        error => {

            console.error(
                'BOOT ERROR',
                error
            );

            process.exit(
                1
            );

        }
    );
