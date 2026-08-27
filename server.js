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
   SONNY AI TRADER
   500 RADAR -> 150 ADAY -> 40 DERİN
   4H + 2H -> 15M BREAKOUT -> RETEST -> 5M BONUS
========================================================= */

const CFG = {

    RADAR: 500,
    CANDIDATES: 150,
    DEEP: 40,

    MAX_SIGNALS: 15,

    MIN_VOLUME_USDT: 750000,

    SCAN_MS: 60000,
    LIVE_MS: 10000,

    CONCURRENCY: 5,

    H1_LIMIT: 260,
    M15_LIMIT: 180,
    M5_LIMIT: 120,

    CHART_LIMIT: 180,

    LEVEL_LOOKBACK: 24,

    BREAKOUT_VOLUME_MIN: 1.10,
    BREAKOUT_BODY_ATR_MIN: 0.20,
    BREAKOUT_BODY_RATIO_MIN: 0.18,

    RETEST_WINDOW_MIN: 90,
    RETEST_TOLERANCE: 0.006,

    /*
       Retest kalitesini düşürmek yerine
       iki ayrı teyit yolu kullanıyoruz:
       1) dokunma + rejection
       2) dokunma + yeniden breakout yönüne kapanış
    */

    RETEST_REJECTION_RATIO: 0.30,

    INVALIDATION_PCT: 0.0035,

    MIN_SCORE: 64,

    MIN_RR: 1.20,
    TP2_RR: 2.00,
    TP3_RR: 3.00,

    ATR_STOP_MULTIPLIER: 0.80,

    REQUIRE_5M: false,

    SIGNAL_TTL: 45 * 60 * 1000,

    PENDING_TTL: 90 * 60 * 1000,

    SAME_SETUP_COOLDOWN: 4 * 60 * 60 * 1000,

    AUTO_TRADE: false
};


/* =========================================================
   EXCHANGE
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

    marketMap: new Map(),

    universe: [],

    candidates: [],

    deep: [],

    signals: new Map(),

    pending: new Map(),

    cooldowns: new Map(),

    selected: 'BTC/USDT:USDT',

    timeframe: '15m',

    scanning: false,

    ready: false,

    lastScan: 0,

    lastError: null,

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

function num(value, fallback = 0) {

    const n = Number(value);

    return Number.isFinite(n)
        ? n
        : fallback;

}


function avg(values) {

    if (!values.length) {
        return 0;
    }

    return values.reduce(
        (a, b) => a + b,
        0
    ) / values.length;

}


function cleanSymbol(symbol) {

    let s =
        String(symbol || '')
            .toUpperCase()
            .replace('/USDT:USDT', '')
            .replace('/USDT', '')
            .replace(':USDT', '');

    if (!s.endsWith('USDT')) {
        s += 'USDT';
    }

    return s;

}


function fmt(value) {

    const n = Number(value);

    if (!Number.isFinite(n)) {
        return '-';
    }

    if (n >= 1000) {
        return n.toFixed(2);
    }

    if (n >= 100) {
        return n.toFixed(3);
    }

    if (n >= 1) {
        return n.toFixed(5);
    }

    if (n >= 0.01) {
        return n.toFixed(7);
    }

    if (n >= 0.0001) {
        return n.toFixed(8);
    }

    return n.toFixed(10);

}


function closed(candles) {

    if (!Array.isArray(candles)) {
        return [];
    }

    return candles.length > 1
        ? candles.slice(0, -1)
        : candles;

}


/* =========================================================
   TEK MARKET BULMA FONKSİYONU
========================================================= */

function findMarket(symbol) {

    const target =
        cleanSymbol(symbol);

    return (
        STATE.markets.find(
            market =>
                cleanSymbol(
                    market.symbol
                ) === target
        ) || null
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
        new Array(items.length);

    let index = 0;


    async function runner() {

        while (true) {

            const current =
                index++;

            if (
                current >=
                items.length
            ) {
                return;
            }

            try {

                result[current] =
                    await worker(
                        items[current]
                    );

            }
            catch (error) {

                result[current] =
                    null;

                STATE.stats.errors++;

                console.error(
                    'ANALİZ ERROR |',
                    items[current]?.symbol ||
                    'UNKNOWN',
                    '|',
                    error.message
                );

            }

        }

    }


    await Promise.all(
        Array.from(
            {
                length:
                    Math.min(
                        limit,
                        items.length
                    )
            },
            runner
        )
    );


    return result.filter(Boolean);

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
        avg(
            c
                .slice(
                    0,
                    period
                )
                .map(
                    x =>
                        num(x[4])
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
            num(c[i][4]) * k +
            value * (1 - k);

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


    let gains = 0;
    let losses = 0;


    for (
        let i =
            c.length -
            period;
        i < c.length;
        i++
    ) {

        const diff =
            num(c[i][4]) -
            num(c[i - 1][4]);


        if (
            diff > 0
        ) {
            gains += diff;
        }
        else {
            losses += -diff;
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
            (1 + rs)
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


    const tr = [];


    for (
        let i = 1;
        i < c.length;
        i++
    ) {

        const high =
            num(c[i][2]);

        const low =
            num(c[i][3]);

        const prev =
            num(c[i - 1][4]);


        tr.push(
            Math.max(

                high - low,

                Math.abs(
                    high -
                    prev
                ),

                Math.abs(
                    low -
                    prev
                )

            )
        );

    }


    return avg(
        tr.slice(-period)
    );

}


function trend(
    candles
) {

    const c =
        closed(candles);

    if (
        c.length <
        55
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
        num(
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
        last >
        e21 &&
        e21 >
        e50
    ) {
        return 'LONG';
    }


    if (
        last <
        e21 &&
        e21 <
        e50
    ) {
        return 'SHORT';
    }


    return 'NEUTRAL';

}


function structure15m(
    candles
) {

    const c =
        closed(candles)
            .slice(-20);


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
        c.slice(mid);


    const firstHigh =
        Math.max(
            ...first.map(
                x =>
                    num(x[2])
            )
        );


    const firstLow =
        Math.min(
            ...first.map(
                x =>
                    num(x[3])
            )
        );


    const secondHigh =
        Math.max(
            ...second.map(
                x =>
                    num(x[2])
            )
        );


    const secondLow =
        Math.min(
            ...second.map(
                x =>
                    num(x[3])
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
        closed(candles);


    if (
        c.length <
        CFG.LEVEL_LOOKBACK + 3
    ) {
        return null;
    }


    const base =
        c.slice(
            -(
                CFG.LEVEL_LOOKBACK +
                1
            ),
            -1
        );


    return {

        resistance:
            Math.max(
                ...base.map(
                    x =>
                        num(x[2])
                )
            ),

        support:
            Math.min(
                ...base.map(
                    x =>
                        num(x[3])
                )
            )

    };

}


/* =========================================================
   RETEST QUALITY
========================================================= */

function evaluateRetest(
    candles,
    pending
) {

    const c =
        closed(candles);


    const age =
        Date.now() -
        pending.breakoutTime;


    if (
        age >
        CFG.RETEST_WINDOW_MIN *
        60 *
        1000
    ) {

        return {

            ok: false,

            status: 'EXPIRED',

            quality: 0

        };

    }


    const maxBars =
        Math.max(
            2,
            Math.ceil(
                CFG.RETEST_WINDOW_MIN /
                15
            )
        );


    const after =
        c
            .filter(
                candle =>
                    num(
                        candle[0]
                    ) >
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

            ok: false,

            status:
                'WAITING_RETEST',

            quality: 0

        };

    }


    const level =
        pending.level;


    const tolerance =
        level *
        CFG.RETEST_TOLERANCE;


    let touch =
        null;


    let rejection =
        false;


    let recovery =
        false;


    let invalid =
        false;


    for (
        const candle
        of after
    ) {

        const open =
            num(candle[1]);

        const high =
            num(candle[2]);

        const low =
            num(candle[3]);

        const close =
            num(candle[4]);


        const touches =
            high >=
                level -
                tolerance &&

            low <=
                level +
                tolerance;


        if (
            !touches
        ) {
            continue;
        }


        touch =
            candle;


        const range =
            Math.max(
                high -
                low,
                1e-12
            );


        if (
            pending.direction ===
            'LONG'
        ) {

            /*
               Seviye ciddi şekilde
               aşağı kırılmışsa setup bozulur.
            */

            if (
                close <
                level *
                (
                    1 -
                    CFG.INVALIDATION_PCT
                )
            ) {

                invalid =
                    true;

            }


            /*
               Alt iğne + gövde tekrar yukarı.
            */

            const lowerWick =
                Math.min(
                    open,
                    close
                ) -
                low;


            if (
                lowerWick /
                range >=
                CFG.RETEST_REJECTION_RATIO
            ) {

                rejection =
                    true;

            }


            if (
                close >=
                level
            ) {

                recovery =
                    true;
            }

        }
        else {

            if (
                close >
                level *
                (
                    1 +
                    CFG.INVALIDATION_PCT
                )
            ) {

                invalid =
                    true;

            }


            const upperWick =
                high -
                Math.max(
                    open,
                    close
                );


            if (
                upperWick /
                range >=
                CFG.RETEST_REJECTION_RATIO
            ) {

                rejection =
                    true;

            }


            if (
                close <=
                level
            ) {

                recovery =
                    true;

            }

        }

    }


    if (
        invalid
    ) {

        return {

            ok: false,

            status:
                'INVALIDATED',

            quality: 0

        };

    }


    /*
       Kaliteli retest:

       A) dokunma + rejection
       VEYA
       B) dokunma + recovery

       Ancak dokunma tek başına sinyal değildir.
    */

    if (
        touch &&
        (
            rejection ||
            recovery
        )
    ) {

        let quality =
            50;


        if (
            rejection
        ) {
            quality += 20;
        }


        if (
            recovery
        ) {
            quality += 20;
        }


        if (
            touch
        ) {
            quality += 10;
        }


        return {

            ok: true,

            status:
                'RETEST_CONFIRMED',

            quality,

            candle:
                touch

        };

    }


    return {

        ok: false,

        status:
            'WAITING_RETEST',

        quality: 0

    };

}


/* =========================================================
   BREAKOUT
========================================================= */

function findBreakout(
    candles,
    direction,
    level
) {

    const c =
        closed(candles);


    if (
        c.length <
        20
    ) {
        return null;
    }


    const start =
        Math.max(
            1,
            c.length - 6
        );


    for (
        let i = start;
        i < c.length;
        i++
    ) {

        const candle =
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


        const avgVolume =
            avg(
                history
                    .map(
                        x =>
                            num(x[5])
                    )
                    .filter(
                        x =>
                            x > 0
                    )
            );


        const volumeRatio =
            avgVolume >
            0

                ?

                num(
                    candle[5]
                ) /
                avgVolume

                :

                1;


        const range =
            Math.max(
                num(candle[2]) -
                num(candle[3]),
                1e-12
            );


        const body =
            Math.abs(
                num(candle[4]) -
                num(candle[1])
            );


        const bodyRatio =
            body /
            range;


        const currentAtr =
            atr(
                candles
            )
            ||
            num(
                candle[4]
            ) *
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
            bodyRatio <
            CFG.BREAKOUT_BODY_RATIO_MIN
        ) {
            continue;
        }


        if (
            bodyAtr <
            CFG.BREAKOUT_BODY_ATR_MIN
        ) {
            continue;
        }


        if (
            direction ===
            'LONG' &&

            num(
                previous[4]
            ) <= level &&

            num(
                candle[4]
            ) > level
        ) {

            return {

                time:
                    num(
                        candle[0]
                    ),

                level,

                volumeRatio,

                bodyRatio,

                bodyAtr

            };

        }


        if (
            direction ===
            'SHORT' &&

            num(
                previous[4]
            ) >= level &&

            num(
                candle[4]
            ) < level
        ) {

            return {

                time:
                    num(
                        candle[0]
                    ),

                level,

                volumeRatio,

                bodyRatio,

                bodyAtr

            };

        }

    }


    return null;

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
        closed(candles);


    if (
        c.length <
        20
    ) {
        return null;
    }


    const current =
        num(
            c[
                c.length -
                1
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
            -6
        );


    const swingLow =
        Math.min(
            ...recent.map(
                x =>
                    num(x[3])
            )
        );


    const swingHigh =
        Math.max(
            ...recent.map(
                x =>
                    num(x[2])
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

        entryLow:
            Math.min(
                level,
                entry
            ),

        entryHigh:
            Math.max(
                level,
                entry
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
        40;


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
            9;

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
            '5M bonus teyit'
        );
    }


    if (
        volumeRatio >=
        1.50
    ) {

        score +=
            7;

        reasons.push(
            'hacim güçlü'
        );
    }


    if (
        volumeRatio >=
        2.00
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
   PENDING KEY
========================================================= */

function pendingKey(
    symbol,
    direction,
    tf,
    level
) {

    return [
        cleanSymbol(
            symbol
        ),
        direction,
        tf,
        fmt(level)
    ].join('|');

}


/* =========================================================
   SAVE BREAKOUT
========================================================= */

function saveBreakout(
    symbol,
    direction,
    breakout,
    tf
) {

    const key =
        pendingKey(
            symbol,
            direction,
            tf,
            breakout.level
        );


    /*
       Aynı kurulum cooldown içindeyse
       tekrar oluşturma.
    */

    const cooldown =
        STATE.cooldowns.get(
            key
        );


    if (
        cooldown &&
        Date.now() -
        cooldown <
        CFG.SAME_SETUP_COOLDOWN
    ) {

        return;
    }


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

            timeframeLevel:
                tf,

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
        45
        ||

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


    /*
       4H ve 2H seviyelerini
       breakout için kullan.
    */

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
       Yeni breakout ara.
    */

    for (
        const level
        of levels
    ) {

        const breakout =
            findBreakout(
                m15,
                level.direction,
                level.price
            );


        if (
            breakout
        ) {

            saveBreakout(
                symbol,
                level.direction,
                breakout,
                level.tf
            );

        }

    }


    /*
       Bu coin için mevcut
       pending setup'ları incele.
    */

    const pendings =
        [
            ...STATE.pending.values()
        ]
        .filter(
            item =>
                item.symbol ===
                cleanSymbol(
                    symbol
                )
        );


    const currentRsi =
        rsi(
            m15
        );


    for (
        const pending
        of pendings
    ) {

        const retest =
            evaluateRetest(
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
            retest.status ===
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
            !retest.ok
        ) {

            continue;
        }


        /*
           İki üst timeframe tamamen
           ters ise kaliteyi korumak için ele.
        */

        if (
            h4Trend !==
            'NEUTRAL'
            &&

            h2Trend !==
            'NEUTRAL'
            &&

            h4Trend !==
            pending.direction
            &&

            h2Trend !==
            pending.direction
        ) {

            pending.status =
                'REJECTED_TREND';

            continue;
        }


        /*
           5M bonus.
        */

        const fiveMinute =
            confirm5m(
                m5,
                pending.direction
            );


        if (
            CFG.REQUIRE_5M &&
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
                retest.quality,
                currentRsi
            );


        /*
           SIGNAL için kalite eşiği.
        */

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
           Aynı coin + yön aktifse
           yeni kopya üretme.
        */

        const duplicate =
            [
                ...STATE.signals.values()
            ]
            .some(
                signal =>
                    signal.symbol ===
                    cleanSymbol(
                        symbol
                    )
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


        return {

            analyzed:
                true,

            signal: {

                id:
                    [
                        cleanSymbol(
                            symbol
                        ),

                        pending.direction,

                        now
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
                        pending
                            .breakoutVolumeRatio
                            .toFixed(
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

                retestQuality:
                    retest.quality,

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
                    retest.candle
                        ? retest.candle[0]
                        : 0,

                signalAt:
                    now,

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
   5M
========================================================= */

function confirm5m(
    candles,
    direction
) {

    const c =
        closed(candles);


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
   CANDLES AGGREGATE
========================================================= */

function aggregateCandles(
    candles,
    hours
) {

    const map =
        new Map();


    const ms =
        hours *
        60 *
        60 *
        1000;


    for (
        const candle
        of candles
    ) {

        const bucket =
            Math.floor(
                num(
                    candle[0]
                ) /
                ms
            ) *
            ms;


        if (
            !map.has(
                bucket
            )
        ) {

            map.set(
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

            const item =
                map.get(
                    bucket
                );


            item[2] =
                Math.max(
                    item[2],
                    num(
                        candle[2]
                    )
                );


            item[3] =
                Math.min(
                    item[3],
                    num(
                        candle[3]
                    )
                );


            item[4] =
                num(
                    candle[4]
                );


            item[5] +=
                num(
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
   RADAR
========================================================= */

async function buildUniverse() {

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


        const high =
            num(
                ticker.high
            );


        const low =
            num(
                ticker.low
            );


        if (
            !(price > 0) ||
            !(volume > 0)
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
                ) *
                100
                : 0;


        /*
           Çok katı hareket filtresi yok.
           Ama tamamen ölü coinleri almayız.
        */

        if (
            volume <
            CFG.MIN_VOLUME_USDT
        ) {

            continue;
        }


        const activity =
            volume *
            (
                1 +
                Math.min(
                    Math.abs(
                        change
                    ),
                    30
                ) /
                100
            );


        rows.push({

            symbol:
                market.symbol,

            price,

            volume,

            change,

            range,

            activity

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


    return rows.slice(
        0,
        CFG.RADAR
    );

}


/* =========================================================
   MARKET REGIME
========================================================= */

async function updateMarket() {

    const rows =
        STATE.universe;


    const green =
        rows.filter(
            x =>
                x.change > 0
        ).length;


    const red =
        rows.filter(
            x =>
                x.change < 0
        ).length;


    const average =
        rows.length
            ? avg(
                rows.map(
                    x =>
                        x.change
                )
            )
            : 0;


    const breadth =
        rows.length
            ? (
                green /
                rows.length
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
                        btcMarket.symbol,
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
                        ethMarket.symbol,
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
        62
        &&
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
        38
        &&
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
            time
        ]
        of STATE.cooldowns
    ) {

        if (
            now -
            time >
            CFG.SAME_SETUP_COOLDOWN
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
   LIVE SIGNAL UPDATE
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

                STATE.cooldowns.set(
                    signal.cooldownKey,
                    now
                );

                STATE.signals.delete(
                    id
                );

                continue;
            }


            if (
                current >=
                signal.tp3
            ) {

                signal.status =
                    'TP3';

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

                STATE.cooldowns.set(
                    signal.cooldownKey,
                    now
                );

                STATE.signals.delete(
                    id
                );

                continue;
            }


            if (
                current <=
                signal.tp3
            ) {

                signal.status =
                    'TP3';

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

}


/* =========================================================
   CHART
========================================================= */

async function refreshChart() {

    if (
        !STATE.selected
    ) {

        STATE.selected =
            'BTC/USDT:USDT';

    }


    const market =
        findMarket(
            STATE.selected
        );


    if (
        !market
    ) {

        return;
    }


    let candles =
        [];


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
                cleanSymbol(
                    market.symbol
                )
        )
        || null;


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

        }


        STATE.universe =
            await buildUniverse();


        STATE.stats.universe =
            STATE.universe.length;


        /*
           500 -> 150
        */

        STATE.candidates =
            STATE.universe
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
            STATE.candidates
                .slice(
                    0,
                    CFG.DEEP
                );


        STATE.stats.deep =
            STATE.deep.length;


        await updateMarket();


        /*
           DEEP
        */

        const results =
            await mapLimit(
                STATE.deep,
                CFG.CONCURRENCY,
                async coin =>
                    analyzeCoin(
                        coin
                    )
            );


        STATE.stats.analyzed =
            results.length;


        /*
           Bulunan kaliteli sinyalleri
           score'a göre sırala.
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
                        signal.symbol
                        &&
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

                signal.rr,

                '| ENTRY',

                fmt(
                    signal.entry
                ),

                '| STOP',

                fmt(
                    signal.stop
                ),

                '| TP1',

                fmt(
                    signal.tp1
                ),

                '| TP2',

                fmt(
                    signal.tp2
                ),

                '| TP3',

                fmt(
                    signal.tp3
                )

            );

        }


        cleanup();


        STATE.lastScan =
            Date.now();


        /*
           Chart her taramada güncel.
        */

        try {

            await refreshChart();

        }
        catch (
            error
        ) {

            console.error(
                'CHART REFRESH ERROR:',
                error.message
            );

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
            )

    };

}


function getStatus() {

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

                    marketSymbol:
                        item.symbol,

                    direction:
                        item.direction,

                    level:
                        fmt(
                            item.level
                        ),

                    timeframeLevel:
                        item.timeframeLevel,

                    volumeRatio:
                        Number(
                            item
                                .breakoutVolumeRatio
                                .toFixed(
                                    2
                                )
                        ),

                    status:
                        item.status

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
                getStatus().stats,

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

            const requested =
                req.query.symbol ||
                STATE.selected ||
                'BTCUSDT';


            const market =
                findMarket(
                    requested
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
                            'Coin bulunamadı: ' +
                            requested

                    });

            }


            const allowed = [

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
                ).toLowerCase();


            STATE.selected =
                market.symbol;


            STATE.timeframe =
                allowed.includes(
                    requestedTf
                )
                    ? requestedTf
                    : '15m';


            await refreshChart();


            res.json({

                success:
                    true,

                symbol:
                    cleanSymbol(
                        STATE.chart.symbol
                    ),

                ccxtSymbol:
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
font-family:Arial,Helvetica,sans-serif;
}

body{
overflow:hidden;
}

.app{
width:100%;
height:100vh;
display:grid;
grid-template-columns:220px minmax(0,1fr) 280px;
}

.side{
background:#0b1017;
border-right:1px solid #202b38;
padding:10px;
overflow:auto;
}

.brand{
font-size:18px;
font-weight:900;
}

.brand small{
display:block;
font-size:8px;
color:#718096;
margin-top:4px;
}

.scan{
width:100%;
margin-top:10px;
padding:10px;
background:#17263f;
border:0;
border-radius:7px;
color:#fff;
font-weight:900;
cursor:pointer;
}

.stats{
display:grid;
grid-template-columns:repeat(3,1fr);
gap:5px;
margin-top:9px;
}

.stat{
background:#101721;
border:1px solid #243143;
border-radius:6px;
padding:7px;
text-align:center;
}

.stat b{
display:block;
font-size:14px;
}

.stat span{
display:block;
font-size:8px;
color:#718096;
margin-top:2px;
}

.cards{
display:flex;
flex-direction:column;
gap:7px;
margin-top:10px;
}

.card{
background:#101721;
border:1px solid #243143;
border-left:3px solid #13dba0;
border-radius:8px;
padding:9px;
cursor:pointer;
}

.card.short{
border-left-color:#ff5570;
}

.card.active{
border-color:#4776ff;
background:#121d2a;
}

.cardTop{
display:flex;
justify-content:space-between;
align-items:center;
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

.price{
font-size:18px;
font-weight:900;
margin-top:6px;
}

.meta{
font-size:8px;
color:#718096;
margin-top:4px;
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
padding:0 12px;
border-bottom:1px solid #202b38;
}

.title{
font-size:18px;
font-weight:900;
}

.sub{
font-size:8px;
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

.chartWrap{
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
justify-content:space-between;
align-items:center;
pointer-events:none;
}

.chartName{
font-size:11px;
font-weight:900;
}

.tfs{
display:flex;
gap:4px;
pointer-events:auto;
}

.tfs button{
background:#111a26;
border:1px solid #29384c;
color:#8290a3;
border-radius:5px;
padding:5px 7px;
font-size:8px;
cursor:pointer;
}

.tfs button.active{
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
border-left:1px solid #202b38;
padding:10px;
overflow:auto;
}

.box{
background:#101721;
border:1px solid #243143;
border-radius:8px;
padding:10px;
margin-bottom:8px;
}

.boxTitle{
font-size:8px;
font-weight:900;
color:#8290a3;
}

.regime{
font-size:19px;
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
line-height:1.55;
color:#718096;
margin-top:5px;
}

.activeName{
font-size:14px;
font-weight:900;
margin-top:5px;
}

.activeName.long{
color:#13dba0;
}

.activeName.short{
color:#ff5570;
}

.plan{
display:grid;
grid-template-columns:1fr 1fr;
gap:5px;
margin-top:7px;
}

.level{
background:#09111a;
border-radius:5px;
padding:7px;
}

.level span{
display:block;
font-size:8px;
color:#718096;
}

.level b{
display:block;
margin-top:2px;
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

.pending{
background:#09111a;
border-left:2px solid #f4c84a;
border-radius:4px;
padding:7px;
margin-top:5px;
font-size:8px;
}

.empty{
font-size:10px;
color:#718096;
padding:9px;
}

@media(max-width:900px){

.app{
grid-template-columns:200px minmax(0,1fr);
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
height:205px;
border-right:0;
border-bottom:1px solid #202b38;
}

.cards{
flex-direction:row;
overflow-x:auto;
}

.card{
min-width:165px;
}

.main{
height:calc(100vh - 205px);
min-height:410px;
}

.header{
height:48px;
padding:0 8px;
}

.title{
font-size:14px;
}

.pill{
font-size:7px;
padding:6px;
}

.chartWrap{
height:calc(100vh - 253px);
min-height:350px;
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
4H/2H SEVİYE • 15M BREAKOUT • RETEST • 5M BONUS
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
<b id="candidate">0</b>
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


<div class="chartWrap">


<div class="toolbar">

<div
id="chartName"
class="chartName"
>
BTCUSDT • 15M
</div>


<div class="tfs">

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

<div
id="active"
>

<div class="empty">
Henüz teyit edilmiş sinyal yok.
</div>

</div>

</div>


<div class="box">

<div class="boxTitle">
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


function formatPrice(
value
){

const n =
Number(value);


if(
!Number.isFinite(
n
)
){

return '-';

}


if(
n >=
1000
){

return n.toFixed(2);

}


if(
n >=
100
){

return n.toFixed(3);

}


if(
n >=
1
){

return n.toFixed(5);

}


if(
n >=
0.01
){

return n.toFixed(7);

}


if(
n >=
0.0001
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
Number(item[0]),

open:
Number(item[1]),

high:
Number(item[2]),

low:
Number(item[3]),

close:
Number(item[4]),

volume:
Number(item[5] || 0)

};

}


return {

time:
Number(item.time),

open:
Number(item.open),

high:
Number(item.high),

low:
Number(item.low),

close:
Number(item.close),

volume:
Number(item.volume || 0)

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
formatPrice(
signal.entryLow
)+
' — '+
formatPrice(
signal.entryHigh
),
'green'
)+

level(
'STOP',
formatPrice(
signal.stop
),
'red'
)+

level(
'TP1',
formatPrice(
signal.tp1
),
'blue'
)+

level(
'TP2',
formatPrice(
signal.tp2
),
'blue'
)+

level(
'TP3',
formatPrice(
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

'<br>'+
'RSI '+
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

'<div class="cardTop">'+

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

'<div class="price">'+
formatPrice(
item.currentPrice ||
item.entry
)+
'</div>'+

'<div class="meta">'+
'● GİRİŞ ALANI • SKOR '+
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


const active =
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
active
){

selected =
active.marketSymbol;

selectedSignal =
active;

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

'<div class="pending">'+

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
   CHART LOAD
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
'Grafik alınamadı'
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
   DRAW CHART
===================================================== */

function drawChart(){

const canvas =
$('chart');


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
formatPrice(
pv
),
5,
gy+3
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


const up =
candle.close >=
candle.open;


const color =
up
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
selectedSignal
){

const low =
Number(
selectedSignal.entryLow
);


const high =
Number(
selectedSignal.entryHigh
);


if(
Number.isFinite(
low
)
&&
Number.isFinite(
high
)
){

const a =
y(low);


const b =
y(high);


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
formatPrice(
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
   INITIAL
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

});


setInterval(
function(){

loadChart();

},
15000
);


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
            .type('html')
            .send(
                HTML
            );

    }
);


/* =========================================================
   ERROR HANDLING
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
            '📊 4H + 2H → 15M Breakout → Retest → 5M BONUS'
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


        initialize();

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
       Radar
    */

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


    /*
       Canlı TP/SL
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
