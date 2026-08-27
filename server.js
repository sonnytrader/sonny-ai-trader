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

   AUTO TRADE: KAPALI

   HTML: BU DOSYANIN İÇİNDE
   ========================================================= */

const CFG = {
    RADAR_SIZE: 500,
    CANDIDATE_SIZE: 150,
    DEEP_SIZE: 40,

    MAX_ACTIVE_SIGNALS: 15,

    MIN_VOLUME_USDT: Number(
        process.env.MIN_VOLUME_USDT || 750000
    ),

    SCAN_MS: 60000,
    LIVE_MS: 10000,

    CONCURRENCY: 5,

    H1_LIMIT: 260,
    M15_LIMIT: 180,
    M5_LIMIT: 120,

    CHART_LIMIT: 160,

    LEVEL_LOOKBACK: 24,

    BREAKOUT_VOLUME_RATIO: 1.10,

    RETEST_WINDOW: 8,
    RETEST_TOLERANCE: 0.0045,

    MIN_SCORE: 66,

    MIN_RR: 1.50,
    TP2_RR: 2.25,
    TP3_RR: 3.25,

    ATR_STOP_MULTIPLIER: 0.90,

    PENDING_TTL: 90 * 60 * 1000,
    SIGNAL_TTL: 45 * 60 * 1000,

    REQUIRE_5M: false,

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
    universe: [],
    candidates: [],
    deep: [],

    signals: new Map(),
    pending: new Map(),
    cooldowns: new Map(),

    selected: null,
    timeframe: '15m',

    scanning: false,
    ready: false,

    lastScan: 0,
    lastError: '',

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
        symbol: null,
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
    const x = Number(value);
    return Number.isFinite(x) ? x : fallback;
}

function avg(values) {
    if (!values.length) return 0;

    return values.reduce(
        (sum, value) => sum + value,
        0
    ) / values.length;
}

function closed(candles) {
    if (!Array.isArray(candles)) return [];
    if (candles.length <= 1) return candles;
    return candles.slice(0, -1);
}

function cleanSymbol(symbol) {
    let s = String(symbol || '')
        .toUpperCase()
        .replace('/USDT:USDT', '')
        .replace('/USDT', '')
        .replace(':USDT', '');

    if (s.endsWith('USDT')) {
        s = s.slice(0, -4);
    }

    return s + 'USDT';
}

function fmt(value) {
    const x = Number(value);

    if (!Number.isFinite(x)) return '-';

    if (x >= 1000) return x.toFixed(2);
    if (x >= 100) return x.toFixed(3);
    if (x >= 1) return x.toFixed(5);
    if (x >= 0.01) return x.toFixed(7);
    if (x >= 0.0001) return x.toFixed(8);

    return x.toFixed(10);
}


/* =========================================================
   KRİTİK MARKET FONKSİYONU
   ========================================================= */

function findMarket(symbol) {
    if (!STATE.markets.length) {
        return null;
    }

    const wanted = cleanSymbol(symbol);

    return (
        STATE.markets.find(
            market =>
                cleanSymbol(
                    market.symbol
                ) === wanted
        ) || null
    );
}


/* =========================================================
   CONCURRENCY
   ========================================================= */

async function mapLimit(items, limit, worker) {
    const result = new Array(items.length);

    let cursor = 0;

    async function runner() {
        while (true) {
            const index = cursor++;

            if (index >= items.length) {
                return;
            }

            try {
                result[index] =
                    await worker(items[index], index);
            } catch (error) {
                result[index] = null;

                STATE.stats.errors += 1;

                console.error(
                    'ANALİZ ERROR |',
                    items[index]?.symbol || 'UNKNOWN',
                    '|',
                    error.message
                );
            }
        }
    }

    const workers =
        Math.min(limit, items.length);

    await Promise.all(
        Array.from(
            { length: workers },
            runner
        )
    );

    return result.filter(Boolean);
}


/* =========================================================
   INDICATORS
   ========================================================= */

function ema(candles, period) {
    const c = closed(candles);

    if (c.length < period) {
        return null;
    }

    let value =
        avg(
            c
                .slice(0, period)
                .map(
                    candle =>
                        num(candle[4])
                )
        );

    const k = 2 / (period + 1);

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

function rsi(candles, period = 14) {
    const c = closed(candles);

    if (c.length < period + 1) {
        return 50;
    }

    let gains = 0;
    let losses = 0;

    for (
        let i = c.length - period;
        i < c.length;
        i++
    ) {
        const diff =
            num(c[i][4]) -
            num(c[i - 1][4]);

        if (diff >= 0) {
            gains += diff;
        } else {
            losses += -diff;
        }
    }

    if (losses === 0) {
        return 100;
    }

    const rs =
        (gains / period) /
        (losses / period);

    return 100 - (100 / (1 + rs));
}

function atr(candles, period = 14) {
    const c = closed(candles);

    if (c.length < period + 1) {
        return 0;
    }

    const values = [];

    for (let i = 1; i < c.length; i++) {
        const high = num(c[i][2]);
        const low = num(c[i][3]);
        const previousClose = num(c[i - 1][4]);

        values.push(
            Math.max(
                high - low,
                Math.abs(high - previousClose),
                Math.abs(low - previousClose)
            )
        );
    }

    return avg(
        values.slice(-period)
    );
}

function trend(candles) {
    const c = closed(candles);

    if (c.length < 55) {
        return 'NEUTRAL';
    }

    const fast = ema(candles, 21);
    const slow = ema(candles, 50);

    const last =
        num(
            c[c.length - 1][4]
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

function structure(candles) {
    const c =
        closed(candles)
            .slice(-20);

    if (c.length < 8) {
        return 'NEUTRAL';
    }

    const middle =
        Math.floor(c.length / 2);

    const first =
        c.slice(0, middle);

    const second =
        c.slice(middle);

    const firstHigh =
        Math.max(
            ...first.map(
                x => num(x[2])
            )
        );

    const firstLow =
        Math.min(
            ...first.map(
                x => num(x[3])
            )
        );

    const secondHigh =
        Math.max(
            ...second.map(
                x => num(x[2])
            )
        );

    const secondLow =
        Math.min(
            ...second.map(
                x => num(x[3])
            )
        );

    if (
        secondHigh > firstHigh &&
        secondLow > firstLow
    ) {
        return 'LONG';
    }

    if (
        secondHigh < firstHigh &&
        secondLow < firstLow
    ) {
        return 'SHORT';
    }

    return 'NEUTRAL';
}


/* =========================================================
   LEVELS
   ========================================================= */

function getLevels(
    candles,
    lookback = CFG.LEVEL_LOOKBACK
) {
    const c = closed(candles);

    if (c.length < lookback + 3) {
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
                    x => num(x[2])
                )
            ),

        support:
            Math.min(
                ...base.map(
                    x => num(x[3])
                )
            )
    };
}


/* =========================================================
   AGGREGATE
   ========================================================= */

function aggregateCandles(
    candles,
    hours
) {
    if (!Array.isArray(candles)) {
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
            num(candle[0]);

        if (!timestamp) continue;

        const bucket =
            Math.floor(
                timestamp /
                bucketMs
            ) *
            bucketMs;

        if (!buckets.has(bucket)) {
            buckets.set(
                bucket,
                [
                    bucket,
                    num(candle[1]),
                    num(candle[2]),
                    num(candle[3]),
                    num(candle[4]),
                    num(candle[5])
                ]
            );
        } else {
            const item =
                buckets.get(bucket);

            item[2] =
                Math.max(
                    item[2],
                    num(candle[2])
                );

            item[3] =
                Math.min(
                    item[3],
                    num(candle[3])
                );

            item[4] =
                num(candle[4]);

            item[5] +=
                num(candle[5]);
        }
    }

    return [
        ...buckets.values()
    ].sort(
        (a, b) =>
            a[0] - b[0]
    );
}


/* =========================================================
   CANDLES
   ========================================================= */

async function getCandles(
    symbol,
    timeframe,
    limit
) {
    const candles =
        await exchange.fetchOHLCV(
            symbol,
            timeframe,
            undefined,
            limit
        );

    if (!Array.isArray(candles)) {
        return [];
    }

    return candles
        .filter(
            candle =>
                Array.isArray(candle) &&
                candle.length >= 6
        )
        .sort(
            (a, b) =>
                num(a[0]) -
                num(b[0])
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
        Object.values(markets)
            .filter(
                market =>

                    market &&
                    market.active !== false &&
                    market.swap === true &&
                    market.linear === true &&
                    market.quote === 'USDT' &&
                    market.settle === 'USDT'
            );

    console.log(
        'MARKETS | Gerçek USDT perpetual=' +
        STATE.markets.length
    );
}


/* =========================================================
   RADAR
   ========================================================= */

async function fetchRadar() {
    const tickers =
        await exchange.fetchTickers();

    const rows = [];

    for (
        const market
        of STATE.markets
    ) {
        const ticker =
            tickers[
                market.symbol
            ];

        if (!ticker) continue;

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

        if (
            !(price > 0) ||
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

            price,

            volume,

            change,

            range
        });
    }

    rows.sort(
        (a, b) => {

            const scoreA =
                a.volume *
                (
                    1 +
                    Math.min(
                        Math.abs(a.change),
                        30
                    ) /
                    100
                );

            const scoreB =
                b.volume *
                (
                    1 +
                    Math.min(
                        Math.abs(b.change),
                        30
                    ) /
                    100
                );

            return scoreB - scoreA;
        }
    );

    return rows.slice(
        0,
        CFG.RADAR_SIZE
    );
}


/* =========================================================
   MARKET REGIME
   ========================================================= */

async function updateMarket(
    rows
) {
    const valid =
        rows.filter(
            row =>
                Number.isFinite(
                    row.change
                )
        );

    const green =
        valid.filter(
            row =>
                row.change > 0
        ).length;

    const red =
        valid.filter(
            row =>
                row.change < 0
        ).length;

    const average =
        valid.length
            ? avg(
                valid.map(
                    row =>
                        row.change
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
        const market =
            findMarket(
                'BTCUSDT'
            );

        if (market) {
            btc =
                trend(
                    await getCandles(
                        market.symbol,
                        '1h',
                        100
                    )
                );
        }
    } catch (_) {}

    try {
        const market =
            findMarket(
                'ETHUSDT'
            );

        if (market) {
            eth =
                trend(
                    await getCandles(
                        market.symbol,
                        '1h',
                        100
                    )
                );
        }
    } catch (_) {}

    let direction =
        'FLAT';

    let label =
        'YATAY / KARIŞIK';

    if (
        breadth >= 62 &&
        average >= 0.35
    ) {
        direction =
            'LONG';

        label =
            'YÜKSELİŞ';

    } else if (
        breadth <= 38 &&
        average <= -0.35
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
                average.toFixed(2)
            ),

        btc,

        eth
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
        closed(candles);

    if (
        c.length < 15
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
        const current =
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
                        candle =>
                            num(candle[5])
                    )
                    .filter(
                        value =>
                            value > 0
                    )
            );

        const volume =
            num(
                current[5]
            );

        const volumeRatio =
            avgVolume > 0
                ? volume / avgVolume
                : 1;

        const previousClose =
            num(
                previous[4]
            );

        const close =
            num(
                current[4]
            );

        const range =
            Math.max(
                num(current[2]) -
                num(current[3]),
                1e-12
            );

        const body =
            Math.abs(
                num(current[4]) -
                num(current[1])
            );

        const bodyRatio =
            body / range;

        if (
            volumeRatio <
                CFG.BREAKOUT_VOLUME_RATIO ||
            bodyRatio <
                0.18
        ) {
            continue;
        }

        if (
            direction === 'LONG' &&
            previousClose <= level &&
            close > level
        ) {
            return {
                time:
                    num(current[0]),

                level,

                volumeRatio,

                close
            };
        }

        if (
            direction === 'SHORT' &&
            previousClose >= level &&
            close < level
        ) {
            return {
                time:
                    num(current[0]),

                level,

                volumeRatio,

                close
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
    if (!breakout) {
        return {
            ok: false,
            status: 'WAITING_RETEST'
        };
    }

    const age =
        Date.now() -
        breakout.time;

    if (
        age >
        CFG.PENDING_TTL
    ) {
        return {
            ok: false,
            status: 'EXPIRED'
        };
    }

    const c =
        closed(candles);

    const after =
        c.filter(
            candle =>
                num(candle[0]) >
                breakout.time
        )
        .slice(
            0,
            CFG.RETEST_WINDOW
        );

    if (!after.length) {
        return {
            ok: false,
            status: 'WAITING_RETEST'
        };
    }

    const tolerance =
        breakout.level *
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
        const high =
            num(candle[2]);

        const low =
            num(candle[3]);

        const close =
            num(candle[4]);

        const touch =
            high >=
                breakout.level -
                tolerance &&
            low <=
                breakout.level +
                tolerance;

        if (!touch) {
            continue;
        }

        touched = true;

        if (
            direction ===
            'LONG'
        ) {

            if (
                close <
                breakout.level *
                0.992
            ) {
                invalid = true;
            }

            if (
                close >=
                breakout.level
            ) {
                recovered = true;
            }

        } else {

            if (
                close >
                breakout.level *
                1.008
            ) {
                invalid = true;
            }

            if (
                close <=
                breakout.level
            ) {
                recovered = true;
            }
        }
    }

    if (invalid) {
        return {
            ok: false,
            status: 'INVALIDATED'
        };
    }

    if (
        touched &&
        recovered
    ) {
        return {
            ok: true,
            status: 'RETESTED',
            candle:
                after[
                    after.length - 1
                ]
        };
    }

    return {
        ok: false,
        status: 'WAITING_RETEST'
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
        closed(candles);

    if (c.length < 20) {
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
            candles,
            14
        ) ||
        current * 0.005;

    const recent =
        c.slice(-6);

    const swingLow =
        Math.min(
            ...recent.map(
                candle =>
                    num(
                        candle[3]
                    )
            )
        );

    const swingHigh =
        Math.max(
            ...recent.map(
                candle =>
                    num(
                        candle[2]
                    )
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
                currentAtr *
                CFG.ATR_STOP_MULTIPLIER
            );

        if (
            stop >= entry
        ) {
            stop =
                entry -
                currentAtr *
                CFG.ATR_STOP_MULTIPLIER;
        }

    } else {

        entry =
            Math.min(
                current,
                level
            );

        stop =
            Math.max(
                swingHigh,
                level +
                currentAtr *
                CFG.ATR_STOP_MULTIPLIER
            );

        if (
            stop <= entry
        ) {
            stop =
                entry +
                currentAtr *
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
                stop < entry &&
                entry < tp1 &&
                tp1 < tp2 &&
                tp2 < tp3
            )
        ) {
            return null;
        }

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

        if (
            !(
                tp3 < tp2 &&
                tp2 < tp1 &&
                tp1 < entry &&
                entry < stop
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

        entry,

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

        stop,

        tp1,

        tp2,

        tp3,

        rr
    };
}


/* =========================================================
   ANALYZE ONE COIN
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
        h1.length < 70 ||
        m15.length < 35 ||
        m5.length < 12
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
        h2.length < 45 ||
        h4.length < 45
    ) {
        return null;
    }

    const h4Trend =
        trend(h4);

    const h2Trend =
        trend(h2);

    const m15Structure =
        structure(m15);

    const m5Trend =
        trend(m5);

    const h4Levels =
        getLevels(h4);

    const h2Levels =
        getLevels(h2);

    if (
        !h4Levels ||
        !h2Levels
    ) {
        return null;
    }

    const possibilities = [

        {
            tf: '4H',
            type: 'RESISTANCE',
            price: h4Levels.resistance
        },

        {
            tf: '4H',
            type: 'SUPPORT',
            price: h4Levels.support
        },

        {
            tf: '2H',
            type: 'RESISTANCE',
            price: h2Levels.resistance
        },

        {
            tf: '2H',
            type: 'SUPPORT',
            price: h2Levels.support
        }

    ];

    const foundSignals = [];

    for (
        const direction
        of ['LONG', 'SHORT']
    ) {

        const targetType =
            direction ===
            'LONG'
                ? 'RESISTANCE'
                : 'SUPPORT';

        const levels =
            possibilities.filter(
                level =>
                    level.type ===
                    targetType
            );

        for (
            const level
            of levels
        ) {

            const breakout =
                detectBreakout(
                    m15,
                    direction,
                    level.price
                );

            if (
                !breakout
            ) {
                continue;
            }

            /*
            Çok sert ters trend varsa
            ele. Fakat sadece piyasa ters diye
            altcoin setup'ını öldürmüyoruz.
            */

            if (
                h4Trend !== 'NEUTRAL' &&
                h2Trend !== 'NEUTRAL' &&
                h4Trend !== direction &&
                h2Trend !== direction
            ) {
                continue;
            }

            const retest =
                detectRetest(
                    m15,
                    breakout,
                    direction
                );

            if (
                !retest.ok
            ) {

                if (
                    retest.status ===
                    'WAITING_RETEST'
                ) {

                    const key =
                        [
                            symbol,
                            direction,
                            level.tf,
                            fmt(level.price)
                        ].join('|');

                    STATE.pending.set(
                        key,
                        {
                            key,
                            symbol,
                            direction,
                            level:
                                level.price,
                            tf:
                                level.tf,
                            breakoutTime:
                                breakout.time,
                            breakoutVolumeRatio:
                                breakout.volumeRatio,
                            status:
                                retest.status,
                            createdAt:
                                Date.now(),
                            updatedAt:
                                Date.now()
                        }
                    );
                }

                continue;
            }

            const fiveMinute =
                confirm5M(
                    m5,
                    direction
                );

            if (
                CFG.REQUIRE_5M &&
                !fiveMinute
            ) {
                continue;
            }

            const currentRsi =
                rsi(m15);

            let score =
                42;

            const reasons = [];

            if (
                h4Trend === direction
            ) {
                score += 16;
                reasons.push(
                    '4H uyumlu'
                );
            }

            if (
                h2Trend === direction
            ) {
                score += 12;
                reasons.push(
                    '2H uyumlu'
                );
            }

            if (
                m15Structure === direction
            ) {
                score += 8;
                reasons.push(
                    '15M yapı uyumlu'
                );
            }

            if (
                fiveMinute
            ) {
                score += 8;
                reasons.push(
                    '5M teyit'
                );
            }

            if (
                breakout.volumeRatio >= 1.5
            ) {
                score += 8;
                reasons.push(
                    'hacim güçlü'
                );
            }

            if (
                breakout.volumeRatio >= 2
            ) {
                score += 5;
                reasons.push(
                    'hacim çok güçlü'
                );
            }

            if (
                STATE.market.direction ===
                direction
            ) {
                score += 6;
                reasons.push(
                    'piyasa uyumlu'
                );
            }

            if (
                direction === 'LONG' &&
                currentRsi >= 47 &&
                currentRsi <= 75
            ) {
                score += 5;
                reasons.push(
                    'RSI uygun'
                );
            }

            if (
                direction === 'SHORT' &&
                currentRsi >= 25 &&
                currentRsi <= 53
            ) {
                score += 5;
                reasons.push(
                    'RSI uygun'
                );
            }

            score =
                Math.min(
                    100,
                    score
                );

            if (
                score <
                CFG.MIN_SCORE
            ) {
                continue;
            }

            const plan =
                createTradePlan(
                    direction,
                    level.price,
                    m15
                );

            if (
                !plan
            ) {
                continue;
            }

            const id =
                symbol +
                '|' +
                direction;

            foundSignals.push({

                id,

                symbol,

                marketSymbol:
                    symbol,

                direction,

                score,

                confidence:
                    score,

                price:
                    row.price,

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
                        breakout.volumeRatio.toFixed(
                            2
                        )
                    ),

                breakoutLevel:
                    level.price,

                timeframeLevel:
                    level.tf,

                h4Trend,

                h2Trend,

                m15Trend:
                    m15Structure,

                m5Trend,

                status:
                    'GİRİŞ BEKLENİYOR',

                entryReady:
                    false,

                reasons,

                reason:
                    reasons.join(
                        ' • '
                    ),

                breakoutTime:
                    breakout.time,

                retestTime:
                    retest.candle
                        ? num(
                            retest.candle[0]
                        )
                        : 0,

                signalAt:
                    Date.now(),

                cooldownKey:
                    [
                        symbol,
                        direction,
                        level.tf,
                        fmt(level.price)
                    ].join('|')
            });
        }
    }

    if (
        !foundSignals.length
    ) {
        return null;
    }

    foundSignals.sort(
        (a, b) =>
            b.score -
            a.score
    );

    return {
        signal:
            foundSignals[0]
    };
}


/* =========================================================
   5M CONFIRM
========================================================= */

function confirm5M(
    candles,
    direction
) {
    const c =
        closed(candles);

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
        direction === 'LONG'
    ) {

        return (
            num(last[4]) >
            num(last[1]) &&
            num(last[4]) >=
            num(previous[4])
        );

    }

    return (
        num(last[4]) <
        num(last[1]) &&
        num(last[4]) <=
        num(previous[4])
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

    STATE.stats.pending =
        STATE.pending.size;

    STATE.stats.signals =
        STATE.signals.size;
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
        console.error(
            'CHART MARKET YOK:',
            STATE.selected
        );

        return;
    }

    let candles = [];

    if (
        STATE.timeframe ===
        '2h'
    ) {

        const h1 =
            await getCandles(
                market.symbol,
                '1h',
                CFG.CHART_LIMIT * 2
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
                CFG.CHART_LIMIT * 4
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
        ].find(
            item =>
                item.symbol ===
                market.symbol
        ) || null;

    STATE.chart = {

        symbol:
            market.symbol,

        timeframe:
            STATE.timeframe,

        candles:

            Array.isArray(
                candles
            )
                ? candles
                : [],

        signal
    };
}


/* =========================================================
   CANLI FİYAT
========================================================= */

async function updateLiveSignals() {

    try {

        const signals =
            [
                ...STATE.signals.values()
            ];

        if (
            !signals.length
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

        await refreshChart();

    }
    catch (error) {

        STATE.lastError =
            error.message;

        console.error(
            'LIVE ERROR:',
            error.message
        );
    }
}


/* =========================================================
   KRİTİK runScan()
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

    STATE.stats.errors =
        0;

    STATE.stats.analyzed =
        0;

    const started =
        Date.now();

    try {

        if (
            !STATE.markets.length
        ) {

            await loadMarkets();
        }


        /*
        500 RADAR
        */

        STATE.universe =
            await fetchRadar();

        STATE.stats.universe =
            STATE.universe.length;


        /*
        MARKET
        */

        await updateMarket(
            STATE.universe
        );


        /*
        500 -> 150
        */

        STATE.candidates =
            STATE.universe
                .filter(
                    coin =>
                        coin.volume >=
                        CFG.MIN_VOLUME_USDT
                )
                .slice(
                    0,
                    CFG.CANDIDATE_SIZE
                );

        STATE.stats.candidates =
            STATE.candidates.length;


        /*
        150 -> 40
        */

        STATE.deep =
            STATE.candidates.slice(
                0,
                CFG.DEEP_SIZE
            );

        STATE.stats.deep =
            STATE.deep.length;


        /*
        40 DEEP
        */

        const results =
            await mapLimit(
                STATE.deep,
                CFG.CONCURRENCY,
                async coin => {

                    const result =
                        await analyzeCoin(
                            coin
                        );

                    STATE.stats.analyzed +=
                        1;

                    return result;
                }
            );


        /*
        SIGNAL
        */

        for (
            const result
            of results
        ) {

            if (
                !result ||
                !result.signal
            ) {
                continue;
            }

            const signal =
                result.signal;


            if (
                STATE.signals.has(
                    signal.id
                )
            ) {
                continue;
            }


            if (
                STATE.signals.size >=
                CFG.MAX_ACTIVE_SIGNALS
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

                'SIGNAL | ' +

                cleanSymbol(
                    signal.symbol
                ) +

                ' | ' +

                signal.direction +

                ' | SCORE ' +

                signal.score +

                ' | ENTRY ' +

                fmt(
                    signal.entry
                ) +

                ' | STOP ' +

                fmt(
                    signal.stop
                ) +

                ' | TP1 ' +

                fmt(
                    signal.tp1
                ) +

                ' | TP2 ' +

                fmt(
                    signal.tp2
                ) +

                ' | TP3 ' +

                fmt(
                    signal.tp3
                )
            );
        }


        cleanup();


        STATE.lastScan =
            Date.now();


        /*
        Chart daima yenileniyor.
        */

        try {

            await refreshChart();

        }
        catch (chartError) {

            console.error(
                'CHART REFRESH ERROR:',
                chartError.message
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
            ).toFixed(1) +

            's'
        );

    }
    catch (error) {

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
   PUBLIC DATA
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
            signal.marketSymbol
    };
}


function statusData() {

    return {

        success:
            true,

        engine:
            'SONNY AI TRADER FINAL',

        autoTrade:
            CFG.AUTO_TRADE,

        ready:
            STATE.ready,

        scanning:
            STATE.scanning,

        lastScan:
            STATE.lastScan,

        error:
            STATE.lastError,

        stats:
            STATE.stats,

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
                CFG.MAX_ACTIVE_SIGNALS
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

                    tf:
                        item.tf,

                    breakoutVolumeRatio:
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

        chart:
            {

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
                STATE.stats,

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

        res.json(
            statusData()
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
                );


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
                    STATE.chart.candles.map(
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
                    ),

                signal:
                    STATE.chart.signal
                        ? publicSignal(
                            STATE.chart.signal
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
   EMBEDDED HTML
========================================================= */

const HTML = String.raw`<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
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
background:#070a0f;
color:#eef3f8;
font-family:Arial,Helvetica,sans-serif;
}

body{
overflow:hidden;
}

.app{
width:100%;
height:100vh;
display:grid;
grid-template-columns:245px minmax(0,1fr) 285px;
}

.sidebar{
background:#0b0f16;
border-right:1px solid #202936;
padding:11px;
overflow:auto;
}

.brand{
font-size:19px;
font-weight:900;
}

.brand small{
display:block;
margin-top:4px;
font-size:9px;
font-weight:500;
color:#718096;
}

.scan{
width:100%;
margin-top:10px;
padding:10px;
border:0;
border-radius:7px;
background:#172742;
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
background:#0f151e;
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
margin-top:10px;
}

.signal-card{
background:#0f151e;
border:1px solid #202c3b;
border-left:3px solid #13e0a2;
border-radius:8px;
padding:9px;
cursor:pointer;
}

.signal-card.short{
border-left-color:#ff5d6d;
}

.signal-card.active{
border-color:#4776ff;
background:#101a26;
}

.card-top{
display:flex;
justify-content:space-between;
align-items:center;
}

.coin{
font-size:13px;
font-weight:900;
}

.badge{
font-size:9px;
font-weight:900;
padding:3px 6px;
border-radius:4px;
}

.badge.long{
color:#13e0a2;
background:#073c2e;
}

.badge.short{
color:#ff5d6d;
background:#451322;
}

.card-price{
margin-top:6px;
font-size:18px;
font-weight:900;
}

.card-meta{
margin-top:5px;
font-size:9px;
color:#718096;
}

.empty{
padding:10px;
font-size:10px;
line-height:1.5;
color:#718096;
}

.main{
min-width:0;
display:flex;
flex-direction:column;
}

.header{
height:62px;
display:flex;
justify-content:space-between;
align-items:center;
padding:0 12px;
border-bottom:1px solid #202936;
gap:10px;
}

.title{
font-size:19px;
font-weight:900;
}

.title small{
display:block;
margin-top:4px;
font-size:9px;
font-weight:500;
color:#718096;
}

.pill{
white-space:nowrap;
font-size:9px;
color:#13e0a2;
background:#073323;
border:1px solid #0b684a;
padding:7px 10px;
border-radius:18px;
}

.chart-area{
position:relative;
flex:1;
min-height:0;
}

.chart-toolbar{
position:absolute;
z-index:5;
top:10px;
left:10px;
right:10px;
display:flex;
justify-content:space-between;
align-items:center;
pointer-events:none;
}

.chart-name{
font-size:12px;
font-weight:900;
}

.tf{
display:flex;
gap:4px;
pointer-events:auto;
}

.tf button{
background:#111b29;
border:1px solid #26384f;
color:#8995a6;
border-radius:5px;
padding:5px 8px;
font-size:9px;
cursor:pointer;
}

.tf button.active{
background:#172a47;
border-color:#428cff;
color:#fff;
}

canvas{
display:block;
width:100%;
height:100%;
}

.right{
background:#0b0f16;
border-left:1px solid #202936;
padding:10px;
overflow:auto;
}

.box{
background:#0f151e;
border:1px solid #202c3b;
border-radius:8px;
padding:11px;
margin-bottom:9px;
}

.box-title{
font-size:9px;
font-weight:900;
color:#8292a6;
}

.regime{
margin-top:6px;
font-size:20px;
font-weight:900;
color:#f4c84a;
}

.regime.long{
color:#13e0a2;
}

.regime.short{
color:#ff5d6d;
}

.info{
margin-top:6px;
font-size:9px;
line-height:1.6;
color:#718096;
}

.active-name{
margin-top:6px;
font-size:15px;
font-weight:900;
}

.active-name.long{
color:#13e0a2;
}

.active-name.short{
color:#ff5d6d;
}

.plan{
display:grid;
grid-template-columns:1fr 1fr;
gap:5px;
margin-top:8px;
}

.level{
background:#0a1017;
border:1px solid #182534;
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
font-size:11px;
}

.green{
color:#13e0a2;
}

.red{
color:#ff5d6d;
}

.blue{
color:#4da3ff;
}

.pending-item{
margin-top:5px;
padding:7px;
border-left:2px solid #f4c84a;
border-radius:4px;
background:#0a1017;
font-size:9px;
}

@media(max-width:950px){

.app{
grid-template-columns:210px minmax(0,1fr);
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
border-right:0;
border-bottom:1px solid #202936;
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
height:calc(100vh - 220px);
min-height:400px;
}

.header{
height:49px;
padding:0 8px;
}

.title{
font-size:15px;
}

.pill{
font-size:8px;
padding:6px;
}

.chart-area{
height:calc(100vh - 269px);
min-height:350px;
}

.tf button{
padding:5px 6px;
}

}

</style>
</head>

<body>

<div class="app">

<aside class="sidebar">

<div class="brand">
⚡ SONNY AI TRADER
<small>
FINAL • BITGET USDT FUTURES • SCALP
</small>
</div>

<button
id="scanBtn"
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
id="signals"
class="signal-list"
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

<span id="timeframe">
15M
</span>

</div>

<small
id="scanInfo"
class="title small"
>
Sistem hazırlanıyor...
</small>

</div>

<div class="pill">
● AUTO TRADE KAPALI
</div>

</header>


<div class="chart-area">

<div class="chart-toolbar">

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


<canvas
id="chart"
>
</canvas>

</div>

</main>


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
class="info"
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
'BTC/USDT:USDT';


let timeframe =
'15m';


let candles =
[];


let signal =
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

}[character];

}
);

}


function price(
value
){

const x =
Number(
value
);

if(
!Number.isFinite(
x
)
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

return x.toFixed(3);

}

if(
x >= 1
){

return x.toFixed(5);

}

if(
x >= 0.01
){

return x.toFixed(7);

}

if(
x >= 0.0001
){

return x.toFixed(8);

}

return x.toFixed(10);

}


/* =====================================================
   NORMALIZE CANDLES
===================================================== */

function normalizeCandles(
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
selected ||
'BTCUSDT'
)
.replace(
'/USDT:USDT',
'USDT'
);


const tf =
String(
timeframe ||
'15m'
)
.toUpperCase();


$('symbol')
.textContent =
clean;


$('timeframe')
.textContent =
tf;


$('chartName')
.textContent =
clean +
' • ' +
tf;

}


/* =====================================================
   ACTIVE
===================================================== */

function renderActive(){

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

'<div class="active-name '+
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


if(
data.lastScan
){

$('scanInfo')
.textContent =
'Son tarama: '+
new Date(
data.lastScan
)
.toLocaleTimeString(
'tr-TR'
);

}
else{

$('scanInfo')
.textContent =
'Tarama bekleniyor...';

}


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


const list =
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
item
){

const card =
document.createElement(
'div'
);


card.className =

'signal-card '+

(
item.direction ===
'SHORT'
?
'short'
:
''
)+

(
item.marketSymbol ===
selected
?
' active'
:
''
);


card.innerHTML =

'<div class="card-top">'+

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

signal =
item;

renderActive();

loadChart();

};


list.appendChild(
card
);

}
);


}


const selectedSignal =
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
selectedSignal
){

selected =
selectedSignal.marketSymbol;

signal =
selectedSignal;

}


renderActive();


const pending =
data.pending ||
[];


if(
!pending.length
){

$('pending').innerHTML =

'<div class="empty">'+
'Bekleyen setup yok.'+
'</div>';

}
else{

$('pending').innerHTML =
pending.map(
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
).join('');

}


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
normalizeCandles(
data.chart.candles
);


selected =
data.chart.symbol ||
selected;


timeframe =
data.chart.timeframe ||
timeframe;


signal =
data.chart.signal ||
signal ||
null;


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

console.error(
data.error
);

return;

}


candles =
normalizeCandles(
data.candles
);


selected =
data.ccxtSymbol ||
selected;


timeframe =
data.timeframe ||
timeframe;


if(
data.signal
){

signal =
data.signal;

renderActive();

}


updateHeader();

drawChart();

}
catch(
error
){

console.error(
'GRAFİK:',
error
);

}

}


/* =====================================================
   CANVAS
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
range <= 0
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
52;


const right =
82;


const top =
25;


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
price(pv),
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


const open =
Number(
candle.open
);


const high =
Number(
candle.high
);


const low =
Number(
candle.low
);


const close =
Number(
candle.close
);


const rising =
close >=
open;


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
y(high)
);

ctx.lineTo(
xx,
y(low)
);

ctx.stroke();


const openY =
y(open);


const closeY =
y(close);


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


/* GİRİŞ BÖLGESİ */

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

const a =
y(
signal.entryLow
);


const b =
y(
signal.entryHigh
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
signal
){

drawLevel(
signal.stop,
'#ff5d6d',
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

const number =
Number(
value
);


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

yy+
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
   SCAN
===================================================== */

$('scanBtn')
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


/* INITIAL */

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


/* GRAFİĞİ 15 SANİYEDE BİR YENİLE */

setInterval(
function(){

if(
selected
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
    (
        req,
        res
    ) => {

        res
            .type('html')
            .send(HTML);

    }
);


/* =========================================================
   PROCESS ERRORS
========================================================= */

process.on(
    'unhandledRejection',
    error => {

        STATE.lastError =
            error?.message ||
            String(error);

        console.error(
            'UNHANDLED:',
            error
        );
    }
);


process.on(
    'uncaughtException',
    error => {

        STATE.lastError =
            error?.message ||
            String(error);

        console.error(
            'UNCAUGHT:',
            error
        );
    }
);


/* =========================================================
   SERVER START
   ÖNCE PORT AÇILIR
   SONRA BITGET
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


        /*
        Render portu gördükten sonra
        Bitget bağlantısı başlıyor.
        */

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


        /*
        İlk tarama.
        */

        await runScan();


    }
    catch (error) {

        STATE.lastError =
            error.message;

        console.error(
            'INITIALIZE ERROR:',
            error.message
        );

        broadcast();

    }


    /*
    60 saniye radar.
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
    Canlı fiyat / TP / STOP.
    */

    setInterval(
        function(){

            updateLiveSignals()
                .then(
                    broadcast
                )
                .catch(
                    error => {

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
    State temizleme.
    */

    setInterval(
        function(){

            cleanup();

            broadcast();

        },
        5000
    );

}
