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
   SONNY AI TRADER FINAL
   BITGET USDT FUTURES
========================================================= */

const CFG = {
    RADAR: 500,
    CANDIDATES: 150,
    DEEP: 60,

    MIN_VOLUME_USDT: 3000000,

    SCAN_MS: 60000,
    CONCURRENCY: 5,

    H4_LIMIT: 180,
    H2_LIMIT: 180,
    M15_LIMIT: 220,
    M5_LIMIT: 140,

    CHART_LIMIT: 180,

    PIVOT_SPAN: 2,
    LEVEL_CLUSTER_PCT: 0.35,
    MIN_TOUCHES: 2,

    BREAKOUT_VOLUME_RATIO: 1.15,
    BREAKOUT_BODY_RATIO: 0.30,
    BREAKOUT_ATR_RATIO: 0.35,

    RETEST_TOLERANCE: 0.0045,
    RETEST_WINDOW: 12,

    INVALIDATION_PCT: 0.004,

    MIN_SCORE: 64,

    MIN_RR: 1.20,
    TP2_RR: 2.0,
    TP3_RR: 3.0,

    ATR_STOP_MULTIPLIER: 1.10,

    REQUIRE_5M: false,

    SIGNAL_TTL: 45 * 60 * 1000,
    PENDING_TTL: 90 * 60 * 1000,
    COOLDOWN: 4 * 60 * 60 * 1000,

    MAX_SIGNALS: 15
};

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

    pending: new Map(),
    signals: new Map(),
    cooldowns: new Map(),

    scanning: false,
    ready: false,

    selected: null,
    timeframe: '15m',

    lastScan: 0,
    lastError: null,

    stats: {
        universe: 0,
        candidates: 0,
        deep: 0,
        analyzed: 0,
        pending: 0,
        signals: 0,
        errors: 0
    },

    chart: {
        symbol: null,
        timeframe: '15m',
        candles: [],
        signal: null
    },

    market: {
        label: 'YATAY / KARIŞIK',
        direction: 'FLAT',
        breadth: 50,
        green: 0,
        red: 0,
        average: 0
    }
};

const candleCache = new Map();

/* =========================================================
   BASIC HELPERS
========================================================= */

function num(v, fallback = 0) {
    const x = Number(v);
    return Number.isFinite(x) ? x : fallback;
}

function avg(a) {
    if (!a || !a.length) return 0;
    return a.reduce((x, y) => x + y, 0) / a.length;
}

function cleanSymbol(symbol) {
    let s = String(symbol || '')
        .toUpperCase()
        .replace('/USDT:USDT', '')
        .replace('/USDT', '')
        .replace(':USDT', '');

    if (!s.endsWith('USDT')) s += 'USDT';

    return s;
}

function fmt(v) {
    const x = Number(v);

    if (!Number.isFinite(x)) return '-';

    if (x >= 1000) return x.toFixed(2);
    if (x >= 100) return x.toFixed(3);
    if (x >= 1) return x.toFixed(5);
    if (x >= 0.01) return x.toFixed(7);
    if (x >= 0.0001) return x.toFixed(8);

    return x.toFixed(10);
}

function closed(c) {
    return Array.isArray(c) && c.length > 1
        ? c.slice(0, -1)
        : (c || []);
}

/* =========================================================
   MARKET
========================================================= */

function findMarket(symbol) {
    const target = cleanSymbol(symbol);

    if (STATE.marketMap.has(target)) {
        return STATE.marketMap.get(target);
    }

    return STATE.markets.find(
        m => cleanSymbol(m.symbol) === target
    ) || null;
}

async function loadMarkets() {
    const all = await exchange.loadMarkets(true);

    const result = [];

    for (const market of Object.values(all)) {
        if (!market) continue;
        if (market.active === false) continue;
        if (market.swap !== true) continue;
        if (market.linear !== true) continue;
        if (market.quote !== 'USDT') continue;
        if (market.settle !== 'USDT') continue;

        result.push(market);
    }

    STATE.markets = result;

    STATE.marketMap = new Map(
        result.map(m => [
            cleanSymbol(m.symbol),
            m
        ])
    );

    console.log(
        'MARKETS | Gerçek USDT perpetual=' +
        result.length
    );
}

/* =========================================================
   CANDLES
========================================================= */

async function getCandles(symbol, timeframe, limit) {
    const market = findMarket(symbol);

    if (!market) return [];

    const key =
        cleanSymbol(symbol) +
        '|' +
        timeframe +
        '|' +
        limit;

    const cached = candleCache.get(key);

    if (
        cached &&
        Date.now() - cached.time < 8000
    ) {
        return cached.data;
    }

    const raw = await exchange.fetchOHLCV(
        market.symbol,
        timeframe,
        undefined,
        limit
    );

    const data = (raw || [])
        .map(x => [
            num(x[0]),
            num(x[1]),
            num(x[2]),
            num(x[3]),
            num(x[4]),
            num(x[5])
        ])
        .sort((a, b) => a[0] - b[0]);

    candleCache.set(key, {
        time: Date.now(),
        data
    });

    return data;
}

/* =========================================================
   INDICATORS
========================================================= */

function ema(candles, period) {
    const c = closed(candles);

    if (c.length < period) return null;

    let value = avg(
        c.slice(0, period).map(x => x[4])
    );

    const k = 2 / (period + 1);

    for (let i = period; i < c.length; i++) {
        value =
            c[i][4] * k +
            value * (1 - k);
    }

    return value;
}

function rsi(candles, period = 14) {
    const c = closed(candles);

    if (c.length < period + 1) return 50;

    let gains = 0;
    let losses = 0;

    for (
        let i = c.length - period;
        i < c.length;
        i++
    ) {
        const diff =
            c[i][4] - c[i - 1][4];

        if (diff > 0) gains += diff;
        else losses += Math.abs(diff);
    }

    if (losses === 0) return 100;

    const rs = gains / losses;

    return 100 - 100 / (1 + rs);
}

function atr(candles, period = 14) {
    const c = closed(candles);

    if (c.length < period + 1) return 0;

    const values = [];

    for (let i = 1; i < c.length; i++) {
        values.push(
            Math.max(
                c[i][2] - c[i][3],
                Math.abs(c[i][2] - c[i - 1][4]),
                Math.abs(c[i][3] - c[i - 1][4])
            )
        );
    }

    return avg(values.slice(-period));
}

function trend(candles) {
    const c = closed(candles);

    if (c.length < 55) return 'NEUTRAL';

    const price = c.at(-1)[4];

    const e21 = ema(c, 21);
    const e50 = ema(c, 50);

    if (!e21 || !e50) return 'NEUTRAL';

    if (
        price > e21 &&
        e21 > e50
    ) {
        return 'LONG';
    }

    if (
        price < e21 &&
        e21 < e50
    ) {
        return 'SHORT';
    }

    return 'NEUTRAL';
}

/* =========================================================
   PIVOT + CLUSTER
========================================================= */

function findPivots(candles, type) {
    const c = closed(candles);
    const span = CFG.PIVOT_SPAN;
    const result = [];

    if (c.length < span * 2 + 5) {
        return result;
    }

    for (
        let i = span;
        i < c.length - span;
        i++
    ) {
        let valid = true;

        for (
            let j = 1;
            j <= span;
            j++
        ) {
            if (type === 'resistance') {
                if (
                    c[i][2] <= c[i - j][2] ||
                    c[i][2] <= c[i + j][2]
                ) {
                    valid = false;
                    break;
                }
            }
            else {
                if (
                    c[i][3] >= c[i - j][3] ||
                    c[i][3] >= c[i + j][3]
                ) {
                    valid = false;
                    break;
                }
            }
        }

        if (valid) {
            result.push({
                price:
                    type === 'resistance'
                        ? c[i][2]
                        : c[i][3],

                time: c[i][0]
            });
        }
    }

    return result;
}

function clusterLevels(points, tolerancePct) {
    const groups = [];

    for (
        const p of [...points].sort(
            (a, b) => a.price - b.price
        )
    ) {
        const last =
            groups[groups.length - 1];

        if (!last) {
            groups.push({
                prices: [p.price],
                times: [p.time]
            });
            continue;
        }

        const center =
            avg(last.prices);

        const distance =
            Math.abs(
                p.price - center
            ) /
            center *
            100;

        if (
            distance <= tolerancePct
        ) {
            last.prices.push(p.price);
            last.times.push(p.time);
        }
        else {
            groups.push({
                prices: [p.price],
                times: [p.time]
            });
        }
    }

    return groups
        .map(g => ({
            price: avg(g.prices),
            touches: g.prices.length,
            time: Math.max(...g.times)
        }))
        .filter(
            x =>
                x.touches >=
                CFG.MIN_TOUCHES
        );
}

function getLevels(candles) {
    const supports =
        clusterLevels(
            findPivots(
                candles,
                'support'
            ),
            CFG.LEVEL_CLUSTER_PCT
        );

    const resistances =
        clusterLevels(
            findPivots(
                candles,
                'resistance'
            ),
            CFG.LEVEL_CLUSTER_PCT
        );

    return {
        supports,
        resistances
    };
}

/* =========================================================
   HTF CONFLUENCE
========================================================= */

function mergeLevels(
    h4,
    h2
) {
    const all = [];

    for (const x of h4.supports) {
        all.push({
            ...x,
            side: 'support',
            tf: '4H'
        });
    }

    for (const x of h2.supports) {
        all.push({
            ...x,
            side: 'support',
            tf: '2H'
        });
    }

    for (const x of h4.resistances) {
        all.push({
            ...x,
            side: 'resistance',
            tf: '4H'
        });
    }

    for (const x of h2.resistances) {
        all.push({
            ...x,
            side: 'resistance',
            tf: '2H'
        });
    }

    const groups = [];

    for (
        const level of all.sort(
            (a, b) =>
                a.price - b.price
        )
    ) {
        let group =
            groups.find(
                g =>
                    g.side === level.side &&
                    Math.abs(
                        level.price -
                        g.price
                    ) /
                    g.price *
                    100 <=
                    CFG.LEVEL_CLUSTER_PCT
            );

        if (!group) {
            group = {
                side: level.side,
                price: level.price,
                touches: 0,
                tfs: new Set()
            };

            groups.push(group);
        }

        group.price =
            (
                group.price *
                group.touches +
                level.price
            ) /
            (
                group.touches + 1
            );

        group.touches += level.touches;
        group.tfs.add(level.tf);
    }

    return groups
        .filter(
            x =>
                x.touches >=
                CFG.MIN_TOUCHES
        )
        .map(x => ({
            side: x.side,
            price: x.price,
            touches: x.touches,
            timeframe:
                [...x.tfs].join('+')
        }));
}

/* =========================================================
   BREAKOUT
========================================================= */

function detectBreakout(
    candles,
    level
) {
    const c = closed(candles);

    if (c.length < 30) {
        return null;
    }

    const last = c.at(-1);
    const previous = c.at(-2);

    const atrValue =
        atr(candles);

    if (!atrValue) return null;

    const body =
        Math.abs(
            last[4] - last[1]
        );

    const range =
        last[2] - last[3];

    const volumeBase =
        avg(
            c
                .slice(-21, -1)
                .map(x => x[5])
        );

    const volumeRatio =
        volumeBase > 0
            ? last[5] / volumeBase
            : 0;

    const bodyRatio =
        range > 0
            ? body / range
            : 0;

    const atrRatio =
        body / atrValue;

    const tolerance =
        level.price *
        0.0015;

    let direction = null;

    if (
        level.side === 'resistance' &&
        last[4] >
            level.price + tolerance &&
        previous[4] <=
            level.price + tolerance
    ) {
        direction = 'LONG';
    }

    if (
        level.side === 'support' &&
        last[4] <
            level.price - tolerance &&
        previous[4] >=
            level.price - tolerance
    ) {
        direction = 'SHORT';
    }

    if (!direction) return null;

    if (
        volumeRatio <
        CFG.BREAKOUT_VOLUME_RATIO
    ) {
        return null;
    }

    if (
        bodyRatio <
        CFG.BREAKOUT_BODY_RATIO
    ) {
        return null;
    }

    if (
        atrRatio <
        CFG.BREAKOUT_ATR_RATIO
    ) {
        return null;
    }

    return {
        direction,
        level: level.price,
        breakoutTime: last[0],
        volumeRatio,
        bodyRatio,
        atrRatio
    };
}

/* =========================================================
   RETEST
========================================================= */

function confirmRetest(
    candles,
    breakout
) {
    const c = closed(candles);

    const index =
        c.findIndex(
            x =>
                x[0] ===
                breakout.breakoutTime
        );

    if (index < 0) {
        return null;
    }

    const future =
        c.slice(
            index + 1,
            index +
                1 +
                CFG.RETEST_WINDOW
        );

    const tolerance =
        breakout.level *
        CFG.RETEST_TOLERANCE;

    for (const candle of future) {

        const touched =
            candle[3] <=
                breakout.level +
                tolerance &&
            candle[2] >=
                breakout.level -
                tolerance;

        if (!touched) continue;

        const invalid =
            breakout.direction === 'LONG'
                ? candle[4] <
                    breakout.level *
                    (1 -
                        CFG.INVALIDATION_PCT)
                : candle[4] >
                    breakout.level *
                    (1 +
                        CFG.INVALIDATION_PCT);

        if (invalid) {
            return null;
        }

        const body =
            Math.abs(
                candle[4] -
                candle[1]
            );

        const lowerWick =
            Math.min(
                candle[1],
                candle[4]
            ) -
            candle[3];

        const upperWick =
            candle[2] -
            Math.max(
                candle[1],
                candle[4]
            );

        const recovery =
            breakout.direction === 'LONG'
                ? candle[4] >
                    breakout.level
                : candle[4] <
                    breakout.level;

        const rejection =
            breakout.direction === 'LONG'
                ? lowerWick >
                    body * 0.20
                : upperWick >
                    body * 0.20;

        if (
            recovery &&
            (rejection || body > 0)
        ) {
            return {
                confirmed: true,
                time: candle[0],
                price: candle[4]
            };
        }
    }

    return null;
}

/* =========================================================
   5M BONUS
========================================================= */

function confirm5m(
    candles,
    direction
) {
    const c = closed(candles);

    if (c.length < 30) {
        return false;
    }

    const e9 = ema(c, 9);
    const e21 = ema(c, 21);

    if (!e9 || !e21) {
        return false;
    }

    const price =
        c.at(-1)[4];

    if (direction === 'LONG') {
        return (
            price > e9 &&
            e9 >= e21
        );
    }

    return (
        price < e9 &&
        e9 <= e21
    );
}

/* =========================================================
   SCORE
========================================================= */

function scoreSignal(data) {
    let score = 0;

    if (
        data.h4Trend ===
        data.direction
    ) {
        score += 20;
    }

    if (
        data.h2Trend ===
        data.direction
    ) {
        score += 20;
    }

    if (
        data.levelTimeframe
            .includes('4H') &&
        data.levelTimeframe
            .includes('2H')
    ) {
        score += 10;
    }

    if (
        data.touches >= 3
    ) {
        score += 10;
    }
    else if (
        data.touches >= 2
    ) {
        score += 7;
    }

    if (
        data.volumeRatio >= 2
    ) {
        score += 10;
    }
    else if (
        data.volumeRatio >= 1.5
    ) {
        score += 8;
    }
    else {
        score += 5;
    }

    if (data.retest) {
        score += 15;
    }

    if (data.fiveMin) {
        score += 5;
    }

    return Math.min(
        100,
        score
    );
}

/* =========================================================
   STRUCTURAL TARGET
========================================================= */

function nextStructuralTarget(
    candles,
    direction,
    entry
) {
    const levels =
        getLevels(candles);

    const list =
        direction === 'LONG'
            ? levels.resistances
            : levels.supports;

    const valid =
        list
            .map(x => x.price)
            .filter(
                p =>
                    direction === 'LONG'
                        ? p > entry
                        : p < entry
            );

    if (!valid.length) {
        return null;
    }

    return direction === 'LONG'
        ? Math.min(...valid)
        : Math.max(...valid);
}

/* =========================================================
   TRADE PLAN
========================================================= */

function createTradePlan(
    symbol,
    direction,
    level,
    c15,
    score,
    meta
) {
    const a =
        atr(c15);

    if (!a) return null;

    const entry =
        meta.retestPrice ||
        level;

    const stopDistance =
        Math.max(
            a *
            CFG.ATR_STOP_MULTIPLIER,
            entry * 0.0025
        );

    const stopLoss =
        direction === 'LONG'
            ? entry - stopDistance
            : entry + stopDistance;

    const risk =
        Math.abs(
            entry - stopLoss
        );

    const structural =
        nextStructuralTarget(
            c15,
            direction,
            entry
        );

    let tp1 = structural;

    if (!tp1) {
        tp1 =
            direction === 'LONG'
                ? entry +
                    risk *
                    CFG.MIN_RR
                : entry -
                    risk *
                    CFG.MIN_RR;
    }

    const structuralRR =
        Math.abs(
            tp1 - entry
        ) / risk;

    if (
        structuralRR <
        CFG.MIN_RR - 0.001
    ) {
        tp1 =
            direction === 'LONG'
                ? entry +
                    risk *
                    CFG.MIN_RR
                : entry -
                    risk *
                    CFG.MIN_RR;
    }

    const rr =
        Math.abs(
            tp1 - entry
        ) / risk;

    if (
        rr <
        CFG.MIN_RR - 0.001
    ) {
        return null;
    }

    const tp2 =
        direction === 'LONG'
            ? entry +
                risk *
                CFG.TP2_RR
            : entry -
                risk *
                CFG.TP2_RR;

    const tp3 =
        direction === 'LONG'
            ? entry +
                risk *
                CFG.TP3_RR
            : entry -
                risk *
                CFG.TP3_RR;

    const zone =
        entry *
        CFG.RETEST_TOLERANCE;

    return {
        symbol:
            cleanSymbol(symbol),

        direction,

        entry,

        entryLow:
            entry - zone,

        entryHigh:
            entry + zone,

        stopLoss,

        tp1,
        tp2,
        tp3,

        rr,

        score,

        rsi:
            rsi(c15),

        touches:
            meta.touches,

        levelTimeframe:
            meta.levelTimeframe,

        volumeRatio:
            meta.volumeRatio,

        reason:
            meta.reason,

        createdAt:
            Date.now(),

        breakoutTime:
            meta.breakoutTime
    };
}

/* =========================================================
   ANALYZE
========================================================= */

async function analyzeCoin(row) {

    STATE.stats.analyzed++;

    const symbol =
        row.symbol;

    const c4 =
        await getCandles(
            symbol,
            '4h',
            CFG.H4_LIMIT
        );

    const c2 =
        await getCandles(
            symbol,
            '2h',
            CFG.H2_LIMIT
        );

    const c15 =
        await getCandles(
            symbol,
            '15m',
            CFG.M15_LIMIT
        );

    const c5 =
        await getCandles(
            symbol,
            '5m',
            CFG.M5_LIMIT
        );

    if (
        c4.length < 80 ||
        c2.length < 80 ||
        c15.length < 60
    ) {
        return null;
    }

    const h4Trend =
        trend(c4);

    const h2Trend =
        trend(c2);

    const levels4 =
        getLevels(c4);

    const levels2 =
        getLevels(c2);

    const levels =
        mergeLevels(
            levels4,
            levels2
        );

    if (!levels.length) {
        return null;
    }

    const candidates =
        levels
            .filter(level => {

                if (
                    level.side ===
                    'resistance'
                ) {
                    return (
                        h4Trend !== 'SHORT' &&
                        h2Trend !== 'SHORT'
                    );
                }

                return (
                    h4Trend !== 'LONG' &&
                    h2Trend !== 'LONG'
                );
            })
            .sort(
                (a, b) =>
                    b.touches -
                    a.touches
            );

    for (
        const level
        of candidates
    ) {

        const breakout =
            detectBreakout(
                c15,
                level
            );

        if (!breakout) {
            continue;
        }

        const direction =
            breakout.direction;

        /*
          NET TERS TREND:
          Herhangi bir net HTF tersse reddet.
        */

        if (
            (
                h4Trend !== 'NEUTRAL' &&
                h4Trend !== direction
            ) ||
            (
                h2Trend !== 'NEUTRAL' &&
                h2Trend !== direction
            )
        ) {
            continue;
        }

        const retest =
            confirmRetest(
                c15,
                breakout
            );

        if (!retest) {
            continue;
        }

        const fiveMin =
            confirm5m(
                c5,
                direction
            );

        if (
            CFG.REQUIRE_5M &&
            !fiveMin
        ) {
            continue;
        }

        const data = {
            h4Trend,
            h2Trend,
            direction,

            levelTimeframe:
                level.timeframe,

            touches:
                level.touches,

            volumeRatio:
                breakout.volumeRatio,

            retest: true,

            fiveMin
        };

        const score =
            scoreSignal(data);

        if (
            score <
            CFG.MIN_SCORE
        ) {
            continue;
        }

        const plan =
            createTradePlan(
                symbol,
                direction,
                breakout.level,
                c15,
                score,
                {
                    ...data,

                    retestPrice:
                        retest.price,

                    breakoutTime:
                        breakout.breakoutTime,

                    reason:
                        `4H ${h4Trend} • ` +
                        `2H ${h2Trend} • ` +
                        `15M BREAKOUT • ` +
                        `RETEST • ` +
                        `5M ${fiveMin ? 'BONUS' : 'NO BONUS'}`
                }
            );

        if (!plan) {
            continue;
        }

        return plan;
    }

    return null;
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
        new Array(items.length);

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
                        items[index]
                    );
            }
            catch (error) {

                STATE.stats.errors++;

                console.error(
                    'ANALİZ ERROR |',
                    items[index]?.symbol,
                    '|',
                    error.message
                );

                result[index] =
                    null;
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
   UNIVERSE
========================================================= */

async function fetchUniverse() {

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

        const high =
            num(ticker.high);

        const low =
            num(ticker.low);

        if (
            price <= 0 ||
            volume <
            CFG.MIN_VOLUME_USDT
        ) {
            continue;
        }

        const range =
            low > 0
                ? (
                    (high - low) /
                    low
                ) * 100
                : 0;

        if (
            range < 0.7 &&
            Math.abs(change) < 0.7
        ) {
            continue;
        }

        const activity =
            volume *
            (
                1 +
                Math.min(
                    Math.abs(change),
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
        (a, b) =>
            b.activity -
            a.activity
    );

    return rows.slice(
        0,
        CFG.RADAR
    );
}

/* =========================================================
   CLEAN OLD STATE
========================================================= */

function cleanupState() {

    const now =
        Date.now();

    for (
        const [
            key,
            time
        ]
        of STATE.cooldowns
    ) {
        if (
            now - time >
            CFG.COOLDOWN
        ) {
            STATE.cooldowns.delete(key);
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
            signal.createdAt >
            CFG.SIGNAL_TTL
        ) {
            STATE.signals.delete(key);
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
            STATE.pending.delete(key);
        }
    }
}

/* =========================================================
   ADD SIGNAL
========================================================= */

function addSignal(signal) {

    const key =
        signal.symbol +
        ':' +
        signal.direction;

    if (
        STATE.cooldowns.has(key)
    ) {
        return false;
    }

    /*
      Aynı breakout zamanını tekrar ekleme.
    */

    for (
        const old
        of STATE.signals.values()
    ) {
        if (
            old.symbol ===
                signal.symbol &&
            old.direction ===
                signal.direction &&
            old.breakoutTime ===
                signal.breakoutTime
        ) {
            return false;
        }
    }

    STATE.signals.set(
        signal.symbol,
        signal
    );

    STATE.cooldowns.set(
        key,
        Date.now()
    );

    console.log(
        'SIGNAL | ' +
        signal.symbol +
        ' | ' +
        signal.direction +
        ' | SCORE ' +
        signal.score +
        ' | RR 1:' +
        signal.rr.toFixed(2)
    );

    return true;
}

/* =========================================================
   MARKET BREADTH
========================================================= */

function updateMarket() {

    const rows =
        STATE.universe;

    const green =
        rows.filter(
            x => x.change > 0
        ).length;

    const red =
        rows.filter(
            x => x.change < 0
        ).length;

    const average =
        avg(
            rows.map(
                x => x.change
            )
        );

    const breadth =
        rows.length
            ? green /
                rows.length *
                100
            : 50;

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
    }
    else if (
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
            )
    };
}

/* =========================================================
   CHART
========================================================= */

async function updateChart(
    symbol,
    timeframe = '15m'
) {
    try {

        const market =
            findMarket(symbol);

        if (!market) return;

        const candles =
            await getCandles(
                market.symbol,
                timeframe,
                CFG.CHART_LIMIT
            );

        const signal =
            STATE.signals.get(
                cleanSymbol(
                    market.symbol
                )
            ) || null;

        STATE.chart = {
            symbol:
                market.symbol,

            timeframe,

            candles,

            signal
        };

        broadcast();

    }
    catch (error) {

        console.error(
            'CHART ERROR:',
            error.message
        );
    }
}

/* =========================================================
   SCAN
========================================================= */

async function runScan() {

    if (STATE.scanning) {
        return;
    }

    STATE.scanning = true;

    STATE.stats = {
        universe: 0,
        candidates: 0,
        deep: 0,
        analyzed: 0,
        pending: 0,
        signals:
            STATE.signals.size,
        errors: 0
    };

    const started =
        Date.now();

    try {

        cleanupState();

        STATE.universe =
            await fetchUniverse();

        STATE.stats.universe =
            STATE.universe.length;

        STATE.candidates =
            STATE.universe.slice(
                0,
                CFG.CANDIDATES
            );

        STATE.stats.candidates =
            STATE.candidates.length;

        STATE.deep =
            STATE.candidates.slice(
                0,
                CFG.DEEP
            );

        STATE.stats.deep =
            STATE.deep.length;

        updateMarket();

        /*
          analyzeCoin artık gerçekten her
          işlenen coin için analyzed++ yapıyor.
        */

        const results =
            await mapLimit(
                STATE.deep,
                CFG.CONCURRENCY,
                analyzeCoin
            );

        for (
            const signal
            of results
        ) {
            addSignal(signal);
        }

        cleanupState();

        STATE.stats.pending =
            STATE.pending.size;

        STATE.stats.signals =
            STATE.signals.size;

        STATE.lastScan =
            Date.now();

        STATE.ready = true;

        if (
            !STATE.chart.symbol
        ) {

            const first =
                [
                    ...STATE.signals.values()
                ]
                .sort(
                    (a, b) =>
                        b.score -
                        a.score
                )[0];

            STATE.chart.symbol =
                first?.symbol ||
                STATE.universe[0]?.symbol ||
                null;
        }

        if (
            STATE.chart.symbol
        ) {
            await updateChart(
                STATE.chart.symbol,
                STATE.timeframe
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
            STATE.stats.pending +
            ' | SIGNAL=' +
            STATE.stats.signals +
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

        broadcast();

    }
    catch (error) {

        STATE.lastError =
            error.message;

        console.error(
            'RADAR ERROR:',
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

function publicSignal(signal) {

    if (!signal) return null;

    return {
        symbol:
            signal.symbol,

        direction:
            signal.direction,

        score:
            signal.score,

        entry:
            fmt(signal.entry),

        entryZone:
            fmt(signal.entryLow) +
            ' - ' +
            fmt(signal.entryHigh),

        stopLoss:
            fmt(signal.stopLoss),

        tp1:
            fmt(signal.tp1),

        tp2:
            fmt(signal.tp2),

        tp3:
            fmt(signal.tp3),

        rr:
            Number(
                signal.rr.toFixed(2)
            ),

        rsi:
            Number(
                signal.rsi.toFixed(2)
            ),

        touches:
            signal.touches,

        levelTimeframe:
            signal.levelTimeframe,

        volumeRatio:
            Number(
                signal.volumeRatio.toFixed(2)
            ),

        reason:
            signal.reason,

        createdAt:
            signal.createdAt,

        breakoutTime:
            signal.breakoutTime
    };
}

/* =========================================================
   STATUS
========================================================= */

function statusData() {

    if (
        !STATE.stats
    ) {
        STATE.stats = {
            universe: 0,
            candidates: 0,
            deep: 0,
            analyzed: 0,
            pending: 0,
            signals: 0,
            errors: 0
        };
    }

    return {

        ready:
            STATE.ready,

        scanning:
            STATE.scanning,

        lastError:
            STATE.lastError,

        stats: {
            universe:
                STATE.stats.universe || 0,

            candidates:
                STATE.stats.candidates || 0,

            deep:
                STATE.stats.deep || 0,

            analyzed:
                STATE.stats.analyzed || 0,

            pending:
                STATE.pending.size,

            signals:
                STATE.signals.size,

            errors:
                STATE.stats.errors || 0
        },

        market:
            STATE.market,

        signals:
            [
                ...STATE.signals.values()
            ]
            .sort(
                (a, b) =>
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

        chart: {

            symbol:
                STATE.chart.symbol,

            timeframe:
                STATE.chart.timeframe,

            candles:
                STATE.chart.candles,

            signal:
                publicSignal(
                    STATE.chart.signal
                )
        }
    };
}

/* =========================================================
   BROADCAST
========================================================= */

function broadcast() {

    const message =
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
            client.send(message);
        }
    }
}

/* =========================================================
   FRONTEND
========================================================= */

const INDEX = String.raw`<!doctype html>
<html lang="tr">

<head>

<meta charset="UTF-8">

<meta
name="viewport"
content="width=device-width,initial-scale=1.0"
>

<title>SONNY AI TRADER</title>

<script src="https://cdn.jsdelivr.net/npm/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.min.js"></script>

<style>

* {
    box-sizing: border-box;
}

body {
    margin: 0;
    background: #0b0e14;
    color: #e6edf5;
    font-family:
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        sans-serif;
}

.app {
    display: grid;
    grid-template-columns: 320px 1fr;
    height: 100vh;
}

.sidebar {
    background: #111827;
    border-right: 1px solid #263244;
    padding: 14px;
    overflow-y: auto;
}

.brand {
    color: #00e5ff;
    font-weight: 800;
    font-size: 19px;
    margin-bottom: 8px;
}

.stats {
    color: #8795a8;
    font-size: 12px;
    margin-bottom: 15px;
}

.signal {
    background: #171e2c;
    border: 1px solid #263244;
    border-left: 4px solid #64748b;
    border-radius: 8px;
    padding: 12px;
    margin-bottom: 9px;
    cursor: pointer;
}

.signal:hover {
    background: #1c2636;
}

.signal.LONG {
    border-left-color: #16c784;
}

.signal.SHORT {
    border-left-color: #ea3943;
}

.signalHead {
    display: flex;
    justify-content: space-between;
    font-weight: 800;
}

.long {
    color: #16c784;
}

.short {
    color: #ea3943;
}

.signalRow {
    display: flex;
    justify-content: space-between;
    margin-top: 6px;
    font-size: 12px;
    color: #94a3b8;
}

.main {
    min-width: 0;
    display: flex;
    flex-direction: column;
    padding: 14px;
}

.top {
    background: #111827;
    border-radius: 9px;
    padding: 13px;
    margin-bottom: 10px;
}

.symbol {
    font-size: 19px;
    font-weight: 800;
}

.direction {
    margin-left: 8px;
    font-weight: 800;
}

.levels {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
}

.level {
    background: #182131;
    border-radius: 6px;
    padding: 8px 11px;
    min-width: 100px;
}

.levelTitle {
    color: #718096;
    font-size: 10px;
}

.levelValue {
    margin-top: 3px;
    font-weight: 700;
}

.entry {
    border: 1px solid #00e5ff;
}

.stop .levelValue {
    color: #ea3943;
}

.tp .levelValue {
    color: #16c784;
}

#chart {
    flex: 1;
    min-height: 400px;
    background: #0b0e14;
}

.reason {
    color: #718096;
    font-size: 11px;
    margin-top: 10px;
}

@media(max-width:800px) {

    .app {
        grid-template-columns: 1fr;
        height: auto;
    }

    .sidebar {
        max-height: 390px;
        border-right: 0;
        border-bottom: 1px solid #263244;
    }

    #chart {
        height: 600px;
    }
}

</style>

</head>

<body>

<div class="app">

<aside class="sidebar">

<div class="brand">
⚡ SONNY AI TRADER
</div>

<div
id="stats"
class="stats"
>
Radar başlatılıyor...
</div>

<div id="signals"></div>

</aside>

<main class="main">

<div
id="top"
class="top"
>
Sinyal seçilmedi.
</div>

<div id="chart"></div>

</main>

</div>

<script>

let DATA = null;
let chart = null;
let candleSeries = null;

let priceLines = [];

function initChart() {

    chart =
        LightweightCharts.createChart(
            document.getElementById(
                "chart"
            ),
            {
                layout: {
                    background: {
                        color:
                            "#0b0e14"
                    },
                    textColor:
                        "#8a99ad"
                },

                grid: {
                    vertLines: {
                        color:
                            "#18202d"
                    },
                    horzLines: {
                        color:
                            "#18202d"
                    }
                },

                rightPriceScale: {
                    borderColor:
                        "#263244"
                },

                timeScale: {
                    borderColor:
                        "#263244"
                }
            }
        );

    candleSeries =
        chart.addCandlestickSeries({
            upColor:
                "#16c784",

            downColor:
                "#ea3943",

            borderUpColor:
                "#16c784",

            borderDownColor:
                "#ea3943",

            wickUpColor:
                "#16c784",

            wickDownColor:
                "#ea3943"
        });

    resizeChart();
}

function resizeChart() {

    if (!chart) return;

    const box =
        document.getElementById(
            "chart"
        );

    chart.resize(
        box.clientWidth,
        box.clientHeight
    );
}

window.addEventListener(
    "resize",
    resizeChart
);

function renderSignal(signal) {

    if (!signal) {

        document.getElementById(
            "top"
        ).innerHTML =
            "Sinyal seçilmedi.";

        return;
    }

    const cls =
        signal.direction === "LONG"
            ? "long"
            : "short";

    document.getElementById(
        "top"
    ).innerHTML =

        "<div class='symbol'>" +

        signal.symbol +

        "<span class='direction " +
        cls +
        "'>" +

        signal.direction +

        "</span>" +

        " <span style='font-size:12px;color:#718096'>" +
        "SKOR " +
        signal.score +
        " • R:R 1:" +
        signal.rr +
        "</span>" +

        "</div>" +

        "<div class='levels'>" +

        levelHtml(
            "GİRİŞ",
            signal.entryZone,
            "entry"
        ) +

        levelHtml(
            "STOP",
            signal.stopLoss,
            "stop"
        ) +

        levelHtml(
            "TP1",
            signal.tp1,
            "tp"
        ) +

        levelHtml(
            "TP2",
            signal.tp2,
            "tp"
        ) +

        levelHtml(
            "TP3",
            signal.tp3,
            "tp"
        ) +

        "</div>" +

        "<div class='reason'>" +

        signal.reason +

        " • RSI " +
        signal.rsi +

        " • Hacim " +
        signal.volumeRatio +
        "x" +

        "</div>";
}

function levelHtml(
    title,
    value,
    cls
) {

    return (
        "<div class='level " +
        cls +
        "'>" +

        "<div class='levelTitle'>" +
        title +
        "</div>" +

        "<div class='levelValue'>" +
        value +
        "</div>" +

        "</div>"
    );
}

function renderSignals() {

    const list =
        DATA.signals || [];

    const box =
        document.getElementById(
            "signals"
        );

    box.innerHTML =
        list
        .map(
            (s, i) =>

                "<div class='signal " +
                s.direction +
                "' onclick='choose(" +
                i +
                ")'>" +

                "<div class='signalHead'>" +

                "<span>" +
                s.symbol +
                "</span>" +

                "<span class='" +
                (
                    s.direction === "LONG"
                        ? "long"
                        : "short"
                ) +
                "'>" +

                s.direction +

                "</span>" +

                "</div>" +

                "<div class='signalRow'>" +
                "<span>SKOR</span>" +
                "<b>" +
                s.score +
                "</b>" +
                "</div>" +

                "<div class='signalRow'>" +
                "<span>Giriş</span>" +
                "<span>" +
                s.entryZone +
                "</span>" +
                "</div>" +

                "<div class='signalRow'>" +
                "<span>Stop</span>" +
                "<span>" +
                s.stopLoss +
                "</span>" +
                "</div>" +

                "<div class='signalRow'>" +
                "<span>TP1</span>" +
                "<span>" +
                s.tp1 +
                "</span>" +
                "</div>" +

                "</div>"
        )
        .join("");
}

function clearPriceLines() {

    if (!candleSeries) return;

    for (
        const line
        of priceLines
    ) {
        try {
            candleSeries.removePriceLine(
                line
            );
        }
        catch (_) {}
    }

    priceLines = [];
}

function addLine(
    price,
    title
) {

    if (!price) return;

    const line =
        candleSeries.createPriceLine({
            price:
                Number(price),

            color:
                title === "STOP"
                    ? "#ea3943"
                    : title === "ENTRY"
                        ? "#00e5ff"
                        : "#16c784",

            lineWidth:
                title === "ENTRY"
                    ? 2
                    : 1,

            lineStyle:
                title === "STOP"
                    ? 2
                    : 0,

            axisLabelVisible:
                true,

            title
        });

    priceLines.push(line);
}

function renderChart() {

    if (!DATA.chart) return;

    const c =
        DATA.chart.candles || [];

    if (!c.length) return;

    candleSeries.setData(
        c.map(
            x => ({
                time:
                    Math.floor(
                        x[0] / 1000
                    ),

                open:
                    x[1],

                high:
                    x[2],

                low:
                    x[3],

                close:
                    x[4]
            })
        )
    );

    clearPriceLines();

    const s =
        DATA.chart.signal;

    if (s) {

        addLine(
            s.entry,
            "ENTRY"
        );

        addLine(
            s.stopLoss,
            "STOP"
        );

        addLine(
            s.tp1,
            "TP1"
        );

        addLine(
            s.tp2,
            "TP2"
        );

        addLine(
            s.tp3,
            "TP3"
        );

        renderSignal(s);
    }

    chart.timeScale()
        .fitContent();
}

function choose(index) {

    const signal =
        DATA.signals[index];

    if (!signal) return;

    renderSignal(signal);

    fetch(
        "/api/chart?symbol=" +
        encodeURIComponent(
            signal.symbol
        ) +
        "&timeframe=15m"
    )
    .catch(() => {});
}

function render() {

    if (!DATA) return;

    const st =
        DATA.stats || {};

    document.getElementById(
        "stats"
    ).innerText =

        (
            st.universe || 0
        ) +
        " Tarandı • " +

        (
            st.candidates || 0
        ) +
        " Aday • " +

        (
            st.analyzed || 0
        ) +
        " Analiz • " +

        (
            st.signals || 0
        ) +
        " Aktif Sinyal";

    renderSignals();
    renderChart();
}

function connect() {

    const protocol =
        location.protocol ===
        "https:"
            ? "wss:"
            : "ws:";

    const socket =
        new WebSocket(
            protocol +
            "//" +
            location.host
        );

    socket.onmessage =
        event => {

            try {

                const packet =
                    JSON.parse(
                        event.data
                    );

                DATA =
                    packet.data;

                render();

            }
            catch (_) {}
        };

    socket.onclose =
        () => {

            setTimeout(
                connect,
                2000
            );
        };
}

initChart();
connect();

</script>

</body>
</html>`;

/* =========================================================
   ROUTES
========================================================= */

app.get(
    '/',
    (req, res) => {
        res.type('html').send(INDEX);
    }
);

app.get(
    '/api/status',
    (req, res) => {
        res.json(
            statusData()
        );
    }
);

app.get(
    '/api/chart',
    async (req, res) => {

        try {

            const symbol =
                req.query.symbol ||
                STATE.selected ||
                STATE.universe[0]?.symbol;

            const timeframe =
                req.query.timeframe ||
                '15m';

            if (!symbol) {
                return res.json({
                    success: false,
                    error:
                        'Henüz market bulunamadı.'
                });
            }

            await updateChart(
                symbol,
                timeframe
            );

            res.json({
                success: true,

                symbol:
                    STATE.chart.symbol,

                timeframe:
                    STATE.chart.timeframe,

                candles:
                    STATE.chart.candles,

                signal:
                    publicSignal(
                        STATE.chart.signal
                    )
            });

        }
        catch (error) {

            res.status(500).json({
                success: false,
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
   START
========================================================= */

async function start() {

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
        '🔬 Deep: 60'
    );

    console.log(
        '📊 4H + 2H → 15M Breakout → Retest → 5M BONUS'
    );

    console.log(
        '💰 Minimum Volume: $3000000'
    );

    console.log(
        '🎯 Minimum R:R: 1:1.20'
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
        '================================================='
    );

    try {

        await loadMarkets();

        await runScan();

    }
    catch (error) {

        STATE.lastError =
            error.message;

        console.error(
            'INITIALIZE ERROR:',
            error.message
        );
    }

    server.listen(
        PORT,
        () => {

            console.log(
                '🌐 Server listening on ' +
                PORT
            );
        }
    );
}

/* =========================================================
   SCAN LOOP
========================================================= */

setInterval(
    () => {

        runScan()
            .catch(
                error => {

                    STATE.lastError =
                        error.message;

                    console.error(
                        'SCAN LOOP ERROR:',
                        error.message
                    );
                }
            );

    },
    CFG.SCAN_MS
);

start();
