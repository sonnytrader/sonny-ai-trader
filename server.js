'use strict';

/*
===============================================================
 SONNY AI TRADER FINAL v5.2
 BITGET FUTURES SCALP RADAR

 500 COIN RADAR
       ↓
 150 CANDIDATE
       ↓
 40 DEEP WATCH
       ↓
 4H TREND
       ↓
 2H LEVEL
       ↓
 15M BREAKOUT
       ↓
 15M RETEST
       ↓
 5M ENTRY CONFIRM
       ↓
 SIGNAL

 AUTO TRADE: KAPALI
 FRONTEND: server.js İÇİNDE
===============================================================
*/

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());

const PORT = Number(process.env.PORT || 10000);

const exchange = new ccxt.bitget({
    enableRateLimit: true,
    timeout: 20000,
    options: {
        defaultType: 'swap'
    }
});

/* =========================================================
   CONFIG
========================================================= */

const CFG = {
    MAX_COINS: 500,
    CANDIDATE_LIMIT: 150,
    DEEP_LIMIT: 40,

    MAX_SIGNALS: 15,

    MIN_VOLUME_USD: 750000,
    MIN_24H_MOVE: 0.8,

    SCAN_MS: 60000,
    LIVE_MS: 10000,

    CONCURRENCY: 6,

    H4_LIMIT: 150,
    H2_LIMIT: 150,
    M15_LIMIT: 180,
    M5_LIMIT: 120,

    CHART_LIMIT: 180,

    PIVOT_LOOKBACK: 3,
    CLUSTER_TOLERANCE: 0.004,

    BREAKOUT_LOOKBACK: 12,

    MIN_BREAKOUT_VOLUME_RATIO: 1.05,
    MIN_BREAKOUT_BODY_ATR: 0.20,

    RETEST_WINDOW_MINUTES: 90,
    RETEST_TOLERANCE: 0.006,

    BREAKOUT_INVALIDATION: 0.003,

    FIVE_MIN_VOLUME_RATIO: 0.95,

    /*
     * 5M teyidini sert biçimde zorlamıyoruz.
     * Çünkü amaç altcoin scalp fırsatlarını kaçırmamak.
     *
     * Önce breakout + retest bulunur.
     * 5M uyumu skora katkı verir.
     * Çok kötü 5M yapı ise sinyali engeller.
     */
    REQUIRE_5M: false,

    MIN_SCORE: 58,

    MIN_RR: 1.20,

    ATR_STOP_MULTIPLIER: 0.65,

    SIGNAL_TTL_MS: 45 * 60 * 1000,

    LEVEL_COOLDOWN_MS:
        4 * 60 * 60 * 1000,

    AUTO_TRADE: false
};

/* =========================================================
   STATE
========================================================= */

const STATE = {
    scanning: false,

    lastScan: 0,

    lastError: null,

    marketRows: [],

    candidates: [],

    deepWatch: [],

    signals: new Map(),

    pendingBreakouts: new Map(),

    stoppedLevels: new Map(),

    stats: {
        universe: 0,
        candidates: 0,
        deepWatch: 0,
        analyzed: 0,
        pending: 0,
        signals: 0,
        seconds: 0
    },

    market: {
        label: 'VERİ BEKLENİYOR',
        direction: 'NEUTRAL',
        breadth: 50,
        average: 0,
        reason: 'Piyasa verisi bekleniyor.'
    }
};

const candleCache = new Map();

let tickerCache = {
    time: 0,
    data: new Map()
};

/* =========================================================
   HELPERS
========================================================= */

function n(value, fallback = 0) {
    const x = Number(value);

    return Number.isFinite(x)
        ? x
        : fallback;
}

function sleep(ms) {
    return new Promise(
        resolve => setTimeout(resolve, ms)
    );
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

function fmtPrice(value) {
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
        return Number(x.toFixed(7));
    }

    return Number(x.toFixed(10));
}

function percentDistance(a, b) {
    if (!b) {
        return 999;
    }

    return Math.abs(a - b) / b * 100;
}

function closedCandles(candles) {
    if (
        !Array.isArray(candles) ||
        candles.length < 3
    ) {
        return [];
    }

    /*
     * Bitget'in halen oluşan son mumunu kullanmıyoruz.
     */
    return candles.slice(0, -1);
}

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
                    await worker(items[index]);
            } catch (error) {
                result[index] = null;
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
            { length: workers },
            runner
        )
    );

    return result;
}

/* =========================================================
   MARKET SYMBOL
========================================================= */

function symbolForMarket(input) {
    if (!input) {
        return null;
    }

    const wanted =
        String(input)
            .toUpperCase()
            .replace(
                /[^A-Z0-9]/g,
                ''
            )
            .replace(
                'USDT',
                ''
            ) + 'USDT';

    const markets =
        exchange.markets || {};

    for (
        const market
        of Object.values(markets)
    ) {
        if (
            market.swap &&
            market.active !== false &&
            market.quote === 'USDT' &&
            market.settle === 'USDT'
        ) {
            const base =
                String(
                    market.base || ''
                ).toUpperCase();

            if (
                base + 'USDT' ===
                wanted
            ) {
                return market.symbol;
            }
        }
    }

    return null;
}

/* =========================================================
   TICKERS
========================================================= */

async function getTickers(force = false) {
    if (
        !force &&
        tickerCache.data.size > 0 &&
        Date.now() -
        tickerCache.time <
        10000
    ) {
        return tickerCache.data;
    }

    try {
        const tickers =
            await exchange.fetchTickers();

        const map = new Map();

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
                market.settle !== 'USDT' ||
                market.active === false
            ) {
                continue;
            }

            const last =
                n(ticker.last);

            const volume =
                n(ticker.quoteVolume);

            const change =
                n(ticker.percentage);

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
            time: Date.now(),
            data: map
        };

        return map;

    } catch (error) {
        STATE.lastError =
            error.message;

        console.error(
            'TICKER:',
            error.message
        );

        return tickerCache.data;
    }
}

/* =========================================================
   CANDLES
========================================================= */

function candleTTL(timeframe) {
    if (timeframe === '5m') {
        return 5000;
    }

    if (timeframe === '15m') {
        return 10000;
    }

    return 30000;
}

async function getCandles(
    symbol,
    timeframe,
    limit
) {
    const key =
        symbol +
        '|' +
        timeframe +
        '|' +
        limit;

    const cached =
        candleCache.get(key);

    if (
        cached &&
        Date.now() -
        cached.time <
        candleTTL(timeframe)
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

        const cleaned =
            (data || [])
                .filter(
                    x =>
                        Array.isArray(x) &&
                        x.length >= 6
                )
                .sort(
                    (a, b) =>
                        Number(a[0]) -
                        Number(b[0])
                );

        candleCache.set(
            key,
            {
                time: Date.now(),
                data: cleaned
            }
        );

        return cleaned;

    } catch (error) {
        return [];
    }
}

/* =========================================================
   500 COIN RADAR
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
                CFG.MIN_24H_MOVE &&
            Math.abs(
                ticker.change
            ) <
                CFG.MIN_24H_MOVE
        ) {
            continue;
        }

        /*
         * Radar skoru:
         *
         * Hacim
         * Hareket
         * Günlük volatilite
         * Momentum
         *
         * Burada sinyal üretmiyoruz.
         * Sadece fırsat havuzu oluşturuyoruz.
         */

        const volumeScore =
            Math.min(
                35,
                Math.log10(
                    Math.max(
                        ticker.volume,
                        1
                    )
                ) * 4
            );

        const rangeScore =
            Math.min(
                25,
                range * 5
            );

        const momentumScore =
            Math.min(
                25,
                Math.abs(
                    ticker.change
                ) * 5
            );

        const activityScore =
            Math.abs(
                ticker.change
            ) >= 2
                ? 15
                : 7;

        const radarScore =
            Math.round(
                Math.min(
                    100,
                    volumeScore +
                    rangeScore +
                    momentumScore +
                    activityScore
                )
            );

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

            range,

            radarScore
        });
    }

    rows.sort(
        (a, b) =>
            b.radarScore -
            a.radarScore
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
   500 -> 150
========================================================= */

function buildCandidates(rows) {
    STATE.candidates =
        rows
            .slice()
            .sort(
                (a, b) =>
                    b.radarScore -
                    a.radarScore
            )
            .slice(
                0,
                CFG.CANDIDATE_LIMIT
            );

    STATE.stats.candidates =
        STATE.candidates.length;

    return STATE.candidates;
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
        (period + 1);

    let value =
        c
            .slice(
                0,
                period
            )
            .reduce(
                (sum, x) =>
                    sum +
                    n(x[4]),
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
            value * (1 - k);
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

        if (diff > 0) {
            gains += diff;
        } else {
            losses +=
                Math.abs(diff);
        }
    }

    if (losses === 0) {
        return 100;
    }

    const rs =
        (gains / period) /
        (losses / period);

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

        const prev =
            n(c[i - 1][4]);

        tr.push(
            Math.max(
                high - low,
                Math.abs(
                    high - prev
                ),
                Math.abs(
                    low - prev
                )
            )
        );
    }

    const recent =
        tr.slice(-period);

    return (
        recent.reduce(
            (sum, x) =>
                sum + x,
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
        ema(candles, 21);

    const slow =
        ema(candles, 50);

    if (
        !fast ||
        !slow
    ) {
        return {
            direction:
                'NEUTRAL',
            diff: 0
        };
    }

    const diff =
        (
            (
                fast -
                slow
            ) /
            slow
        ) * 100;

    if (
        diff > 0.15
    ) {
        return {
            direction:
                'LONG',
            diff
        };
    }

    if (
        diff < -0.15
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
    candles
) {
    const c =
        closedCandles(
            candles
        );

    const result = [];

    const lb =
        CFG.PIVOT_LOOKBACK;

    for (
        let i = lb;
        i < c.length - lb;
        i++
    ) {
        const high =
            n(c[i][2]);

        const low =
            n(c[i][3]);

        let isHigh = true;
        let isLow = true;

        for (
            let j = 1;
            j <= lb;
            j++
        ) {
            if (
                high <=
                    n(c[i - j][2]) ||
                high <=
                    n(c[i + j][2])
            ) {
                isHigh = false;
            }

            if (
                low >=
                    n(c[i - j][3]) ||
                low >=
                    n(c[i + j][3])
            ) {
                isLow = false;
            }
        }

        if (isHigh) {
            result.push({
                price:
                    high,

                type:
                    'resistance',

                time:
                    n(c[i][0])
            });
        }

        if (isLow) {
            result.push({
                price:
                    low,

                type:
                    'support',

                time:
                    n(c[i][0])
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
        levels
            .slice()
            .sort(
                (a, b) =>
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

        if (existing) {
            existing.items.push(
                level
            );

            existing.price =
                existing.items.reduce(
                    (sum, x) =>
                        sum +
                        x.price,
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
                        x =>
                            x.time
                    )
                )
        })
    );
}

function getLevels(
    candles
) {
    return clusterLevels(
        pivots(candles)
    );
}

/* =========================================================
   BREAKOUT VOLUME
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
            (sum, x) =>
                sum + n(x[5]),
            0
        ) /
        previous.length;

    return average > 0
        ? current / average
        : 1;
}

/* =========================================================
   BREAKOUT DETECTION
========================================================= */

function detectBreakouts(
    candles,
    levels
) {
    const c =
        closedCandles(
            candles
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

    const currentATR =
        atr(
            candles,
            14
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

        const close =
            n(current[4]);

        const previousClose =
            n(previous[4]);

        const atrValue =
            currentATR ||
            close * 0.003;

        const body =
            Math.abs(
                close -
                n(current[1])
            );

        const bodyAtr =
            body /
            atrValue;

        const volumeRatio =
            volumeRatioAt(
                candles,
                i
            );

        if (
            volumeRatio <
            CFG.MIN_BREAKOUT_VOLUME_RATIO
        ) {
            continue;
        }

        if (
            bodyAtr <
            CFG.MIN_BREAKOUT_BODY_ATR
        ) {
            continue;
        }

        for (
            const level
            of levels
        ) {
            /*
             * DİRENÇ KIRILDI
             * => LONG
             */

            if (
                level.type ===
                    'resistance' &&
                previousClose <=
                    level.price &&
                close >
                    level.price
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
                        bodyAtr
                });
            }

            /*
             * DESTEK KIRILDI
             * => SHORT
             */

            if (
                level.type ===
                    'support' &&
                previousClose >=
                    level.price &&
                close <
                    level.price
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
                        bodyAtr
                });
            }
        }
    }

    return found;
}

/* =========================================================
   PENDING STATE
========================================================= */

function pendingKey(
    symbol,
    breakout
) {
    return [
        symbol,
        breakout.direction,
        fmtPrice(
            breakout.level.price
        ),
        breakout.breakoutTime
    ].join('|');
}

function saveBreakouts(
    symbol,
    breakouts
) {
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

        /*
         * Aynı seviyede ters yönlü
         * saçma sinyal üretimini azalt.
         */

        const duplicate =
            [
                ...STATE
                    .pendingBreakouts
                    .values()
            ].some(
                p =>
                    p.symbol ===
                        symbol &&
                    Math.abs(
                        p.level.price -
                        breakout.level.price
                    ) /
                    breakout.level.price <
                        0.001 &&
                    p.direction ===
                        breakout.direction
            );

        if (duplicate) {
            continue;
        }

        STATE.pendingBreakouts.set(
            key,
            {
                ...breakout,

                key,

                symbol,

                createdAt:
                    Date.now(),

                status:
                    'WAITING_RETEST'
            }
        );

        console.log(
            'BREAKOUT | ' +
            cleanSymbol(symbol) +
            ' | ' +
            breakout.direction +
            ' | ' +
            fmtPrice(
                breakout.level.price
            ) +
            ' | VOL ' +
            breakout.breakoutVolumeRatio.toFixed(
                2
            ) +
            'x'
        );
    }
}

/* =========================================================
   RETEST
========================================================= */

function detectRetest(
    candles,
    pending
) {
    const c =
        closedCandles(
            candles
        );

    const index =
        c.findIndex(
            candle =>
                n(candle[0]) ===
                pending.breakoutTime
        );

    if (index < 0) {
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
        let i = index + 1;
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

        if (
            pending.direction ===
            'LONG'
        ) {
            /*
             * Seviye aşağı kırıldıysa
             * breakout başarısız.
             */

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
                        'INVALIDATED'
                };
            }

            if (
                close >
                level *
                1.0015
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

        } else {
            /*
             * SHORT için destek
             * yukarı kırılırsa başarısız.
             */

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
                        'INVALIDATED'
                };
            }

            if (
                close <
                level *
                0.9985
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
        c.length - 1 >=
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
        c.length < 10 ||
        !retest ||
        !retest.candle
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

        const index =
            c.indexOf(
                current
            );

        const volumeRatio =
            volumeRatioAt(
                candles,
                index
            );

        if (
            direction ===
            'LONG'
        ) {
            if (
                close > open &&
                close > prevHigh &&
                close > level &&
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

        } else {
            if (
                close < open &&
                close < prevLow &&
                close < level &&
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

    const first =
        n(
            recent[0][4]
        );

    const last =
        n(
            recent[
                recent.length - 1
            ][4]
        );

    if (
        recentHigh >
            previousHigh &&
        recentLow >
            previousLow &&
        last >
            first
    ) {
        return 'LONG';
    }

    if (
        recentHigh <
            previousHigh &&
        recentLow <
            previousLow &&
        last <
            first
    ) {
        return 'SHORT';
    }

    return 'NEUTRAL';
}

/* =========================================================
   SCORE
========================================================= */

function calculateScore(
    data
) {
    let score = 30;

    const reasons = [];

    if (
        data.trend ===
        data.direction
    ) {
        score += 15;

        reasons.push(
            '4H yön uyumlu'
        );

    } else if (
        data.trend ===
        'NEUTRAL'
    ) {
        score += 6;

        reasons.push(
            '4H nötr'
        );

    } else {
        score -= 10;

        reasons.push(
            '4H ters'
        );
    }

    if (
        data.confluence
    ) {
        score += 12;

        reasons.push(
            '4H+2H seviye'
        );

    } else {
        score += 6;

        reasons.push(
            data.levelTF +
            ' seviye'
        );
    }

    if (
        data.touches >= 4
    ) {
        score += 8;

        reasons.push(
            'güçlü seviye'
        );

    } else if (
        data.touches >= 2
    ) {
        score += 4;

        reasons.push(
            'seviye teyitli'
        );
    }

    if (
        data.breakoutVolume >=
        2
    ) {
        score += 12;

        reasons.push(
            'yüksek breakout hacmi'
        );

    } else if (
        data.breakoutVolume >=
        1.05
    ) {
        score += 6;

        reasons.push(
            'breakout hacmi'
        );
    }

    if (
        data.breakoutBodyAtr >=
        0.7
    ) {
        score += 7;

        reasons.push(
            'güçlü breakout'
        );
    }

    if (
        data.structure ===
        data.direction
    ) {
        score += 8;

        reasons.push(
            '15M yapı uyumlu'
        );

    } else if (
        data.structure ===
        'NEUTRAL'
    ) {
        score += 2;

        reasons.push(
            '15M nötr'
        );

    } else {
        score -= 5;

        reasons.push(
            '15M ters'
        );
    }

    if (
        data.confirm5M
    ) {
        score += 8;

        reasons.push(
            '5M teyit'
        );
    }

    if (
        data.direction ===
        'LONG'
    ) {
        if (
            data.rsi >= 42 &&
            data.rsi <= 75
        ) {
            score += 3;

            reasons.push(
                'RSI uygun'
            );
        }

        if (
            data.rsi > 88
        ) {
            score -= 7;

            reasons.push(
                'RSI aşırı yüksek'
            );
        }

    } else {
        if (
            data.rsi >= 25 &&
            data.rsi <= 58
        ) {
            score += 3;

            reasons.push(
                'RSI uygun'
            );
        }

        if (
            data.rsi < 12
        ) {
            score -= 7;

            reasons.push(
                'RSI aşırı düşük'
            );
        }
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
   TRADE PLAN
========================================================= */

function buildTradePlan(
    direction,
    level,
    candles,
    oppositeLevels
) {
    const c =
        closedCandles(
            candles
        );

    if (
        !c.length
    ) {
        return null;
    }

    const current =
        n(
            c[
                c.length - 1
            ][4]
        );

    const atrValue =
        atr(
            candles,
            14
        ) ||
        current * 0.003;

    /*
     * Scalp için 15M ATR stopunu
     * gereksiz yere geniş bırakmıyoruz.
     */

    const risk =
        Math.max(
            atrValue *
                CFG.ATR_STOP_MULTIPLIER,
            current *
                0.0015
        );

    const zone =
        Math.max(
            current *
                0.0007,
            risk *
                0.18
        );

    const entry =
        level.price;

    let stop;

    if (
        direction ===
        'LONG'
    ) {
        stop =
            entry -
            risk;
    } else {
        stop =
            entry +
            risk;
    }

    const realRisk =
        Math.abs(
            entry -
            stop
        );

    /*
     * Önce gerçek karşı seviyeleri
     * buluyoruz.
     */

    const valid =
        oppositeLevels
            .filter(
                x =>
                    direction ===
                    'LONG'
                        ? x.price > entry
                        : x.price < entry
            )
            .sort(
                (a, b) =>
                    Math.abs(
                        a.price -
                        entry
                    ) -
                    Math.abs(
                        b.price -
                        entry
                    )
            );

    const minimumTP =
        direction ===
        'LONG'
            ? entry +
              realRisk *
              CFG.MIN_RR
            : entry -
              realRisk *
              CFG.MIN_RR;

    let tp1 =
        direction ===
        'LONG'
            ? entry +
              realRisk *
              1.25
            : entry -
              realRisk *
              1.25;

    let tp2 =
        direction ===
        'LONG'
            ? entry +
              realRisk *
              2
            : entry -
              realRisk *
              2;

    let tp3 =
        direction ===
        'LONG'
            ? entry +
              realRisk *
              2.75
            : entry -
              realRisk *
              2.75;

    /*
     * Karşı seviyeleri kullan.
     * Fakat TP1'i anlamsız derecede yakın
     * bir seviyeye kırpma.
     */

    for (
        const target
        of valid
    ) {
        if (
            direction ===
            'LONG'
        ) {
            if (
                target.price >=
                    minimumTP &&
                target.price <
                    tp1
            ) {
                tp1 =
                    target.price;

                break;
            }

        } else {
            if (
                target.price <=
                    minimumTP &&
                target.price >
                    tp1
            ) {
                tp1 =
                    target.price;

                break;
            }
        }
    }

    for (
        const target
        of valid
    ) {
        if (
            direction ===
            'LONG' &&
            target.price >
                tp1 &&
            target.price <
                tp2
        ) {
            tp2 =
                target.price;

            break;
        }

        if (
            direction ===
            'SHORT' &&
            target.price <
                tp1 &&
            target.price >
                tp2
        ) {
            tp2 =
                target.price;

            break;
        }
    }

    for (
        const target
        of valid
    ) {
        if (
            direction ===
            'LONG' &&
            target.price >
                tp2 &&
            target.price <
                tp3
        ) {
            tp3 =
                target.price;

            break;
        }

        if (
            direction ===
            'SHORT' &&
            target.price <
                tp2 &&
            target.price >
                tp3
        ) {
            tp3 =
                target.price;

            break;
        }
    }

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
        'LONG'
    ) {
        if (
            !(
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

    } else {
        if (
            !(
                entry >
                tp1 &&
                tp1 >
                tp2 &&
                tp2 >
                tp3
            )
        ) {
            return null;
        }
    }

    return {
        entryLow:
            fmtPrice(
                entry -
                zone
            ),

        entryHigh:
            fmtPrice(
                entry +
                zone
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

        rr:
            Number(
                rr.toFixed(2)
            ),

        riskReward:
            '1:' +
            rr.toFixed(2)
    };
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

    const trend =
        trend4H(
            h4
        );

    const confirmation =
        confirm5M(
            m5,
            retest,
            pending.direction,
            pending.level.price
        );

    /*
     * 5M artık tek başına gate değil.
     *
     * Ama 5M açıkça ters ise
     * düşük kaliteli sinyali engelle.
     */

    const structure =
        structure15M(
            m15
        );

    if (
        CFG.REQUIRE_5M &&
        !confirmation.confirmed
    ) {
        pending.status =
            'WAITING_5M';

        return null;
    }

    if (
        structure !==
            'NEUTRAL' &&
        structure !==
            pending.direction &&
        trend.direction !==
            pending.direction
    ) {
        pending.status =
            'WEAK_STRUCTURE';

        return null;
    }

    const current =
        n(coin.last);

    if (!current) {
        return null;
    }

    /*
     * Fiyat retest bölgesinden çok uzaklaştıysa
     * sinyali kovalamıyoruz.
     */

    if (
        percentDistance(
            current,
            pending.level.price
        ) > 1.2
    ) {
        pending.status =
            'MISSED_ENTRY';

        return null;
    }

    const levels4 =
        getLevels(h4);

    const levels2 =
        getLevels(h2);

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

    const near4 =
        levels4.some(
            x =>
                x.type ===
                    pending.level.type &&
                percentDistance(
                    x.price,
                    pending.level.price
                ) <= 0.45
        );

    const near2 =
        levels2.some(
            x =>
                x.type ===
                    pending.level.type &&
                percentDistance(
                    x.price,
                    pending.level.price
                ) <= 0.45
        );

    const trade =
        buildTradePlan(
            pending.direction,
            pending.level,
            m15,
            oppositeLevels
        );

    if (!trade) {
        pending.status =
            'BAD_RR';

        return null;
    }

    const currentRSI =
        rsi(
            m15
        );

    const scored =
        calculateScore({
            direction:
                pending.direction,

            trend:
                trend.direction,

            confluence:
                near4 &&
                near2,

            touches:
                pending.level.touches,

            levelTF:
                near4 &&
                near2
                    ? '4H+2H'
                    : near4
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
                confirmation.confirmed
        });

    if (
        scored.score <
        CFG.MIN_SCORE
    ) {
        pending.status =
            'LOW_SCORE';

        return null;
    }

    const cooldownKey =
        pending.symbol +
        '|' +
        fmtPrice(
            pending.level.price
        );

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

    const signal = {
        id:
            cleanSymbol(
                pending.symbol
            ) +
            '_' +
            Date.now(),

        symbol:
            pending.symbol,

        coin:
            cleanSymbol(
                pending.symbol
            ),

        direction:
            pending.direction,

        type:
            pending.direction,

        taraf:
            pending.direction,

        score:
            scored.score,

        confidence:
            scored.score,

        level:
            fmtPrice(
                pending.level.price
            ),

        levelType:
            pending.direction ===
            'LONG'
                ? 'KIRILAN DİRENÇ'
                : 'KIRILAN DESTEK',

        timeframeLevel:
            near4 &&
            near2
                ? '4H + 2H'
                : near4
                    ? '4H'
                    : '2H',

        trendBias:
            trend.direction,

        structure15m:
            structure,

        rsi:
            Number(
                currentRSI.toFixed(1)
            ),

        breakoutTime:
            pending.breakoutTime,

        retestTime:
            n(
                retest.candle[0]
            ),

        fiveMinConfirmed:
            confirmation.confirmed,

        breakoutVolumeRatio:
            Number(
                pending
                    .breakoutVolumeRatio
                    .toFixed(2)
            ),

        entryLow:
            trade.entryLow,

        entryHigh:
            trade.entryHigh,

        entry:
            trade.entry,

        giris:
            trade.entry,

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
            trade.rr,

        riskReward:
            trade.riskReward,

        reason:
            scored.reasons.join(
                ' + '
            ),

        reasons:
            scored.reasons,

        status:
            'GİRİŞ BEKLENİYOR',

        entryReady:
            false,

        livePrice:
            fmtPrice(
                current
            ),

        volume24h:
            coin.quoteVolume,

        timestamp:
            Date.now(),

        signalAt:
            Date.now(),

        ccxt_symbol:
            pending.symbol,

        cooldownKey,

        source:
            '4H+2H → 15M BREAKOUT → RETEST → 5M'
    };

    STATE.pendingBreakouts.delete(
        pending.key
    );

    return signal;
}

/* =========================================================
   40 DEEP WATCH
========================================================= */

async function buildDeepWatch() {
    const results =
        await mapLimit(
            STATE.candidates,
            CFG.CONCURRENCY,
            async coin => {
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
                    n(coin.last);

                const levels = [
                    ...getLevels(
                        h4
                    ),
                    ...getLevels(
                        h2
                    )
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
                            x =>
                                x.distance <=
                                1.5
                        )
                        .sort(
                            (a, b) =>
                                a.distance -
                                b.distance
                        );

                let deepScore =
                    coin.radarScore;

                if (
                    nearby.length
                ) {
                    deepScore += 10;
                }

                if (
                    nearby.length >= 2
                ) {
                    deepScore += 8;
                }

                return {
                    ...coin,

                    deepScore:
                        Math.min(
                            100,
                            Math.round(
                                deepScore
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
        );

    STATE.deepWatch =
        results
            .filter(Boolean)
            .sort(
                (a, b) =>
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

    let green = 0;
    let red = 0;

    let total = 0;

    for (
        const row
        of rows
    ) {
        const change =
            n(row.percentage);

        total += change;

        if (
            change > 0.20
        ) {
            green++;
        }

        if (
            change < -0.20
        ) {
            red++;
        }
    }

    const counted =
        green + red;

    const breadth =
        counted
            ? green /
              counted *
              100
            : 50;

    const average =
        rows.length
            ? total /
              rows.length
            : 0;

    let direction =
        'NEUTRAL';

    let label =
        'KARIŞIK';

    /*
     * Sadece ortalamaya bakmıyoruz.
     *
     * Breadth + ortalama beraber
     * aynı yönde değilse piyasaya
     * LONG/SHORT demiyoruz.
     */

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

    } else if (
        breadth >= 55
    ) {
        label =
            'POZİTİF';

    } else if (
        breadth <= 45
    ) {
        label =
            'NEGATİF';
    }

    STATE.market = {
        label,

        direction,

        breadth:
            Number(
                breadth.toFixed(0)
            ),

        average:
            Number(
                average.toFixed(2)
            ),

        reason:
            'Yeşil ' +
            green +
            ' • Kırmızı ' +
            red +
            ' • Ortalama ' +
            average.toFixed(2) +
            '%'
    };
}

/* =========================================================
   LIVE SIGNAL
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
                signal.ccxt_symbol
            );

        if (
            ticker &&
            ticker.last
        ) {
            const price =
                ticker.last;

            signal.livePrice =
                fmtPrice(
                    price
                );

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

            const tp1 =
                n(
                    signal.tp1
                );

            const tp2 =
                n(
                    signal.tp2
                );

            const tp3 =
                n(
                    signal.tp3
                );

            const long =
                signal.direction ===
                'LONG';

            if (
                long &&
                price <= stop
            ) {
                signal.status =
                    'STOP';

            } else if (
                !long &&
                price >= stop
            ) {
                signal.status =
                    'STOP';

            } else if (
                long &&
                price >= tp3
            ) {
                signal.status =
                    'TP3';

            } else if (
                !long &&
                price <= tp3
            ) {
                signal.status =
                    'TP3';

            } else if (
                long &&
                price >= tp2
            ) {
                signal.status =
                    'TP2';

            } else if (
                !long &&
                price <= tp2
            ) {
                signal.status =
                    'TP2';

            } else if (
                long &&
                price >= tp1
            ) {
                signal.status =
                    'TP1';

            } else if (
                !long &&
                price <= tp1
            ) {
                signal.status =
                    'TP1';

            } else if (
                price >= entryLow &&
                price <= entryHigh
            ) {
                signal.status =
                    'GİRİŞ ALANI';

                signal.entryReady =
                    true;

            } else {
                signal.status =
                    'GİRİŞ BEKLENİYOR';

                signal.entryReady =
                    false;
            }

            signal.ageSeconds =
                Math.floor(
                    (
                        now -
                        signal.signalAt
                    ) / 1000
                );
        }

        const expired =
            now -
            signal.signalAt >
            CFG.SIGNAL_TTL_MS;

        if (
            signal.status ===
                'STOP'
        ) {
            STATE.stoppedLevels.set(
                signal.cooldownKey,
                now
            );
        }

        if (
            expired ||
            signal.status ===
                'STOP' ||
            signal.status ===
                'TP3'
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

    const pendingTTL =
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
            pendingTTL
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
   MAIN SCAN
========================================================= */

async function runScan() {
    if (
        STATE.scanning
    ) {
        return;
    }

    STATE.scanning =
        true;

    const started =
        Date.now();

    STATE.stats.analyzed =
        0;

    try {
        console.log('');
        console.log(
            '=============================================='
        );
        console.log(
            'SONNY AI TRADER V5.2 RADAR'
        );
        console.log(
            '=============================================='
        );

        const universe =
            await discoverUniverse();

        buildCandidates(
            universe
        );

        calculateMarket();

        await buildDeepWatch();

        const results =
            await mapLimit(
                STATE.deepWatch,
                CFG.CONCURRENCY,
                async coin => {
                    const [
                        h4,
                        h2,
                        m15,
                        m5
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
                            ),

                            getCandles(
                                coin.symbol,
                                '15m',
                                CFG.M15_LIMIT
                            ),

                            getCandles(
                                coin.symbol,
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
                        return null;
                    }

                    STATE.stats.analyzed++;

                    const levels = [
                        ...getLevels(
                            h4
                        ).map(
                            x => ({
                                ...x,
                                tf: '4H'
                            })
                        ),

                        ...getLevels(
                            h2
                        ).map(
                            x => ({
                                ...x,
                                tf: '2H'
                            })
                        )
                    ];

                    /*
                     * Son kapanmış 15M mumlarında
                     * yeni breakout arıyoruz.
                     */

                    const breakouts =
                        detectBreakouts(
                            m15,
                            levels
                        );

                    saveBreakouts(
                        coin.symbol,
                        breakouts
                    );

                    /*
                     * Bu coin için bekleyen
                     * breakout'ları tekrar değerlendir.
                     */

                    const pending =
                        [
                            ...STATE
                                .pendingBreakouts
                                .values()
                        ]
                        .filter(
                            x =>
                                x.symbol ===
                                coin.symbol
                        );

                    const signals = [];

                    for (
                        const p
                        of pending
                    ) {
                        const signal =
                            await analyzePending(
                                coin,
                                p,
                                h4,
                                h2,
                                m15,
                                m5
                            );

                        if (
                            signal
                        ) {
                            signals.push(
                                signal
                            );
                        }
                    }

                    return {
                        coin,
                        signals
                    };
                }
            );

        const found =
            results
                .filter(Boolean)
                .flatMap(
                    x =>
                        x.signals ||
                        []
                )
                .sort(
                    (a, b) =>
                        b.score -
                        a.score
                );

        for (
            const signal
            of found
        ) {
            const duplicate =
                [
                    ...STATE
                        .signals
                        .values()
                ].some(
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

            console.log(
                'SIGNAL | ' +
                signal.coin +
                ' | ' +
                signal.direction +
                ' | SCORE ' +
                signal.score +
                ' | ' +
                signal.riskReward
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
                ).toFixed(1)
            );

        console.log(
            'RADAR tamamlandı | ' +
            'Universe=' +
            STATE.stats.universe +
            ' | Candidates=' +
            STATE.stats.candidates +
            ' | Deep=' +
            STATE.stats.deepWatch +
            ' | Analiz=' +
            STATE.stats.analyzed +
            ' | Pending=' +
            STATE.pendingBreakouts.size +
            ' | SIGNAL=' +
            STATE.signals.size
        );

        broadcast();

    } catch (error) {
        STATE.lastError =
            error.message;

        console.error(
            'RADAR ERROR:',
            error.message
        );

        broadcast();

    } finally {
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
    const copy = {
        ...signal
    };

    delete copy.cooldownKey;

    return copy;
}

/* =========================================================
   STATUS
========================================================= */

function getStatus() {
    return {
        success:
            true,

        engine:
            'Sonny AI Trader FINAL v5.2',

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

            pending:
                STATE.pendingBreakouts.size,

            pendingBreakouts:
                STATE.pendingBreakouts.size,

            activeSignalsCount:
                STATE.signals.size,

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
                (a, b) =>
                    b.score -
                    a.score
            )
            .map(
                publicSignal
            ),

        pending:
            [
                ...STATE
                    .pendingBreakouts
                    .values()
            ]
            .map(
                p => ({
                    symbol:
                        cleanSymbol(
                            p.symbol
                        ),

                    direction:
                        p.direction,

                    level:
                        fmtPrice(
                            p.level.price
                        ),

                    breakoutTime:
                        p.breakoutTime,

                    breakoutVolume:
                        Number(
                            p.breakoutVolumeRatio
                                .toFixed(2)
                        ),

                    status:
                        p.status
                })
            ),

        watchlist:
            STATE.deepWatch.map(
                x => ({
                    symbol:
                        cleanSymbol(
                            x.symbol
                        ),

                    score:
                        x.deepScore,

                    radarScore:
                        x.radarScore,

                    price:
                        x.price,

                    change24h:
                        x.percentage,

                    volume24h:
                        x.quoteVolume,

                    trend:
                        x.h4Trend,

                    nearby:
                        x.nearby
                })
            )
    };
}

/* =========================================================
   BROADCAST
========================================================= */

function broadcast() {
    const payload =
        JSON.stringify(
            getStatus()
        );

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
            } catch (_) {}
        }
    }
}

wss.on(
    'connection',
    ws => {
        ws.send(
            JSON.stringify(
                getStatus()
            )
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
                'Sonny AI Trader FINAL v5.2',

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

            analyzed:
                STATE.stats.analyzed,

            pending:
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
                );

            const timeframe =
                allowed.includes(
                    requested
                )
                    ? requested
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
                [
                    ...STATE
                        .signals
                        .values()
                ]
                .filter(
                    item =>
                        item.ccxt_symbol ===
                        symbol
                )
                .sort(
                    (a, b) =>
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
                        ticker &&
                        ticker.last
                            ? ticker.last
                            : candles[
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

        } catch (error) {
            console.error(
                'CHART:',
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
   HTML AYRI DOSYA DEĞİL.
   TEMPLATE-LITERAL ÇAKIŞMASI YOK.
========================================================= */

const HTML = [
'<!doctype html>',
'<html lang="tr">',
'<head>',
'<meta charset="utf-8">',
'<meta name="viewport" content="width=device-width,initial-scale=1">',
'<title>Sonny AI Trader FINAL</title>',

'<style>',
'*{box-sizing:border-box}',
'html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#070a0f;color:#eef3f8;font-family:Arial,Helvetica,sans-serif}',
'button{font-family:inherit}',
'.app{width:100%;height:100vh;display:grid;grid-template-columns:285px 1fr}',
'.side{background:#0b0f16;border-right:1px solid #202936;overflow:auto;padding:14px}',
'.brand{font-size:18px;font-weight:900}',
'.brand small{display:block;color:#718096;font-size:10px;margin-top:5px}',
'.cards{margin-top:18px;display:grid;gap:9px}',
'.card{background:#0f151e;border:1px solid #202b39;border-radius:14px;padding:12px;cursor:pointer}',
'.card:hover{border-color:#4776ff}',
'.card.active{border-color:#4776ff;box-shadow:0 0 0 1px #244a9c}',
'.top{display:flex;justify-content:space-between;gap:8px}',
'.coin{font-weight:900}',
'.badge{font-size:10px;font-weight:900;padding:4px 7px;border-radius:6px}',
'.long{color:#2be19b;background:#103425}',
'.short{color:#ff5d6d;background:#35131b}',
'.price{font-size:18px;font-weight:900;margin-top:8px}',
'.meta{font-size:10px;color:#778397;margin-top:6px}',
'.ready{font-size:10px;color:#2be19b;margin-top:7px}',
'.main{min-width:0;display:flex;flex-direction:column}',
'.head{padding:14px 18px;border-bottom:1px solid #202936;display:flex;justify-content:space-between;gap:15px}',
'.title{font-size:18px;font-weight:900}',
'.sub{font-size:10px;color:#718096;margin-top:5px}',
'.stats{display:flex;gap:12px;align-items:center;font-size:10px;color:#718096;flex-wrap:wrap;justify-content:flex-end}',
'.stats b{color:#fff}',
'.work{min-width:0;flex:1;display:grid;grid-template-columns:minmax(0,1fr) 285px}',
'.chartBox{min-width:0;position:relative;background:#070a0f}',
'.chartHead{height:44px;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #17202c}',
'.chartTitle{font-size:13px;font-weight:900}',
'.tf{display:flex;gap:5px}',
'.tf button{border:1px solid #273448;background:#0e151f;color:#8290a4;border-radius:6px;padding:5px 8px;font-size:10px;cursor:pointer}',
'.tf button.active{color:#fff;border-color:#4776ff;background:#152442}',
'#chart{width:100%;height:calc(100% - 44px);display:block}',
'.right{border-left:1px solid #202936;background:#0b0f16;padding:14px;overflow:auto}',
'.panel{background:#0f151e;border:1px solid #202b39;border-radius:12px;padding:12px;margin-bottom:10px}',
'.panelTitle{font-size:10px;color:#718096;font-weight:900;margin-bottom:9px}',
'.big{font-size:20px;font-weight:900}',
'.green{color:#2be19b}',
'.red{color:#ff5d6d}',
'.yellow{color:#e2b95e}',
'.blue{color:#55a6ff}',
'.row{display:flex;justify-content:space-between;gap:8px;font-size:10px;margin:7px 0}',
'.row span:first-child{color:#718096}',
'.scan{width:100%;border:0;background:#17233b;color:#fff;padding:9px;border-radius:8px;cursor:pointer;margin-top:8px}',
'.scan:hover{background:#213455}',
'.empty{color:#69778a;font-size:11px;line-height:1.5}',
'.pending{border-left:3px solid #e2a83d}',
'.marketLong{color:#2be19b}',
'.marketShort{color:#ff5d6d}',
'.marketNeutral{color:#e2b95e}',
'.signalTitle{font-size:14px;font-weight:900}',
'.detailGrid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:10px}',
'.detail{background:#0a1017;padding:8px;border-radius:7px}',
'.detail span{display:block;color:#69778a;font-size:9px}',
'.detail b{display:block;margin-top:3px;font-size:12px}',
'.footer{font-size:9px;color:#59677a;line-height:1.5;margin-top:10px}',
'@media(max-width:900px){',
'.app{display:block;height:100vh}',
'.side{display:none}',
'.main{height:100vh}',
'.head{padding:10px 12px}',
'.title{font-size:15px}',
'.sub{font-size:8px}',
'.stats{font-size:8px;gap:6px}',
'.work{display:block;height:calc(100vh - 62px)}',
'.chartBox{height:62%;min-height:300px}',
'.right{height:38%;border-left:0;border-top:1px solid #202936;padding:9px}',
'.panel{margin-bottom:7px;padding:9px}',
'.chartHead{height:40px;padding:8px 10px}',
'#chart{height:calc(100% - 40px)}',
'}',
'@media(max-width:520px){',
'.head{display:block}',
'.stats{margin-top:6px;justify-content:flex-start}',
'.chartBox{height:57%;min-height:280px}',
'.right{height:43%}',
'.detailGrid{grid-template-columns:1fr 1fr}',
'}',
'</style>',
'</head>',

'<body>',

'<div class="app">',

'<aside class="side">',
'<div class="brand">⚡ SONNY AI TRADER',
'<small>FINAL v5.2 • BITGET FUTURES SCALP ENGINE</small>',
'</div>',
'<div id="cards" class="cards">',
'<div class="empty">Sinyaller bekleniyor...</div>',
'</div>',
'<button class="scan" onclick="manualScan()">RADARI YENİLE</button>',
'<div class="footer">500 Coin → 150 Aday → 40 Deep Watch → Breakout → Retest → Scalp</div>',
'</aside>',

'<main class="main">',

'<header class="head">',

'<div>',
'<div class="title">SONNY AI TRADER V5.2</div>',
'<div class="sub">500 → 150 → 40 • 4H + 2H → 15M BREAKOUT → RETEST → 5M SCALP</div>',
'</div>',

'<div class="stats">',
'<span>RADAR <b id="radar">0</b></span>',
'<span>ADAY <b id="candidate">0</b></span>',
'<span>DEEP <b id="deep">0</b></span>',
'<span>ANALİZ <b id="analyzed">0</b></span>',
'<span>PENDING <b id="pending">0</b></span>',
'<span>SİNYAL <b id="signalCount">0</b></span>',
'</div>',

'</header>',

'<section class="work">',

'<div class="chartBox">',

'<div class="chartHead">',
'<div id="chartTitle" class="chartTitle">SİNYAL GRAFİĞİ</div>',
'<div class="tf">',
'<button data-tf="5m" onclick="setTF("5m")">5M</button>',
'<button data-tf="15m" class="active" onclick="setTF("15m")">15M</button>',
'<button data-tf="1h" onclick="setTF("1h")">1H</button>',
'<button data-tf="2h" onclick="setTF("2h")">2H</button>',
'<button data-tf="4h" onclick="setTF("4h")">4H</button>',
'</div>',
'</div>',

'<canvas id="chart"></canvas>',

'</div>',

'<aside class="right">',

'<div class="panel">',
'<div class="panelTitle">GENEL PİYASA DURUMU</div>',
'<div id="market" class="big yellow">VERİ BEKLENİYOR</div>',
'<div id="marketReason" class="meta">Veri bekleniyor...</div>',
'<div class="row"><span>BREADTH</span><b id="breadth">50%</b></div>',
'<div class="row"><span>ORTALAMA</span><b id="average">0%</b></div>',
'</div>',

'<div id="detail" class="panel">',
'<div class="panelTitle">SİNYAL SEÇİN</div>',
'<div class="empty">Soldaki sinyallerden birine tıklayın.</div>',
'</div>',

'<div id="pendingPanel" class="panel">',
'<div class="panelTitle">BEKLEYEN BREAKOUTLAR</div>',
'<div id="pendingList" class="empty">Bekleyen breakout yok.</div>',
'</div>',

'</aside>',

'</section>',

'</main>',

'</div>',

'<script>',

'var state={signals:[],pending:[],market:{},stats:{}};',
'var ws=null;',
'var selected=null;',
'var timeframe="15m";',
'var chartSymbol=null;',

'function $(id){return document.getElementById(id);}',

'function esc(value){',
'return String(value==null?"":value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");',
'}',

'function connect(){',
'var protocol=location.protocol==="https:"?"wss:":"ws:";',
'ws=new WebSocket(protocol+"//"+location.host);',
'ws.onopen=function(){',
'if($("marketReason"))$("marketReason").textContent="Bağlantı aktif.";};',
'ws.onmessage=function(event){',
'try{',
'var data=JSON.parse(event.data);',
'applyState(data);',
'}catch(e){console.error(e);}',
'};',
'ws.onclose=function(){setTimeout(connect,3000);};',
'}',

'function applyState(data){',
'if(data.data){data=data.data;}',
'state=data;',
'if(!state.stats)state.stats={};',
'if(!state.signals)state.signals=[];',
'if(!state.pending)state.pending=[];',
'if(!state.market)state.market={};',
'$("radar").textContent=state.stats.universe||0;',
'$("candidate").textContent=state.stats.candidates||0;',
'$("deep").textContent=state.stats.deepWatch||0;',
'$("analyzed").textContent=state.stats.analyzed||0;',
'$("pending").textContent=state.stats.pending||state.pending.length||0;',
'$("signalCount").textContent=state.stats.activeSignalsCount||state.signals.length||0;',
'renderMarket();',
'renderCards();',
'renderPending();',
'if(selected){',
'var fresh=state.signals.find(function(x){return x.id===selected.id;});',
'if(fresh){selected=fresh;renderDetail();}',
'}',
'if(!selected&&state.signals.length){selected=state.signals[0];renderDetail();}',
'}',

'function renderMarket(){',
'var m=state.market||{};',
'var label=m.label||"VERİ BEKLENİYOR";',
'$("market").textContent=label;',
'$("marketReason").textContent=m.reason||"Piyasa verisi bekleniyor.";',
'$("breadth").textContent=String(m.breadth==null?50:m.breadth)+"%";',
'$("average").textContent=String(m.average==null?0:m.average)+"%";',
'$("market").className="big "+(m.direction==="LONG"?"marketLong":m.direction==="SHORT"?"marketShort":"marketNeutral");',
'}',

'function renderCards(){',
'var container=$("cards");',
'if(!state.signals.length){',
'container.innerHTML="<div class=\\"empty\\">Henüz aktif scalp sinyali yok.<br>Breakout + retest bekleniyor.</div>";',
'return;',
'}',
'container.innerHTML="";',
'state.signals.forEach(function(sig){',
'var div=document.createElement("div");',
'div.className="card "+(sig.direction==="LONG"?"long":"short")+(selected&&selected.id===sig.id?" active":"");',
'div.onclick=function(){selected=sig;chartSymbol=sig.symbol;renderDetail();loadChart();};',
'var status=sig.status||"GİRİŞ BEKLENİYOR";',
'div.innerHTML=',
'<div class="top">'+
'<div class="coin">'+esc(sig.coin)+'</div>'+
'<div class="badge">'+esc(sig.direction)+' • '+esc(sig.score)+'</div>'+
'</div>'+
'<div class="price">'+esc(sig.livePrice||sig.entry)+'</div>'+
'<div class="meta">'+esc(status)+'</div>'+
'<div class="meta">Giriş '+esc(sig.entryLow)+' - '+esc(sig.entryHigh)+'</div>'+
'<div class="ready">TP1 '+esc(sig.tp1)+' • TP2 '+esc(sig.tp2)+'</div>'+
'<div class="meta">STOP '+esc(sig.stop)+' • R:R '+esc(sig.riskReward)+'</div>'+
'<div class="meta">'+esc(sig.timeframeLevel||"LEVEL")+' • RSI '+esc(sig.rsi)+'</div>';',
'container.appendChild(div);',
'});',
'}',

'function renderDetail(){',
'var box=$("detail");',
'if(!selected){',
'box.innerHTML="<div class=\\"panelTitle\\">SİNYAL SEÇİN</div><div class=\\"empty\\">Sinyal bekleniyor.</div>";',
'return;',
'}',
'var color=selected.direction==="LONG"?"green":"red";',
'box.innerHTML=',
'<div class="panelTitle">AKTİF SCALP SİNYALİ</div>'+
'<div class="signalTitle">'+esc(selected.coin)+' <span class="'+color+'">'+esc(selected.direction)+'</span></div>'+
'<div class="meta">'+esc(selected.status)+'</div>'+
'<div class="detailGrid">'+
'<div class="detail"><span>GİRİŞ</span><b class="green">'+esc(selected.entry)+'</b></div>'+
'<div class="detail"><span>SKOR</span><b>'+esc(selected.score)+'/100</b></div>'+
'<div class="detail"><span>STOP</span><b class="red">'+esc(selected.stop)+'</b></div>'+
'<div class="detail"><span>TP1</span><b class="green">'+esc(selected.tp1)+'</b></div>'+
'<div class="detail"><span>TP2</span><b class="green">'+esc(selected.tp2)+'</b></div>'+
'<div class="detail"><span>TP3</span><b class="green">'+esc(selected.tp3)+'</b></div>'+
'<div class="detail"><span>R:R</span><b>'+esc(selected.riskReward)+'</b></div>'+
'<div class="detail"><span>RSI</span><b>'+esc(selected.rsi)+'</b></div>'+
'</div>'+
'<div class="meta" style="margin-top:10px">'+esc(selected.reason||"")+'</div>'+
'<button class="scan" onclick="loadChart()">GRAFİĞİ YENİLE</button>';',
'}',

'function renderPending(){',
'var box=$("pendingList");',
'if(!state.pending.length){',
'box.textContent="Bekleyen breakout yok.";return;',
'}',
'box.innerHTML=state.pending.slice(0,20).map(function(p){',
'return "<div class=\\"pending\\" style=\\"padding:7px;margin:5px 0\\">"+
"<b>"+esc(p.symbol)+"</b> "+
"<span>"+esc(p.direction)+"</span><br>"+
"<small>Level "+esc(p.level)+" • VOL "+esc(p.breakoutVolume)+"x • "+esc(p.status)+"</small>"+
"</div>";',
'}).join("");',
'}',

'function manualScan(){',
'fetch("/api/scan").catch(function(e){console.error(e);});',
'}',

'function setTF(tf){',
'timeframe=tf;',
'document.querySelectorAll("[data-tf]").forEach(function(btn){',
'btn.classList.toggle("active",btn.getAttribute("data-tf")===tf);',
'});',
'loadChart();',
'}',

'async function loadChart(){',
'var symbol=chartSymbol||(selected&&selected.symbol);',
'if(!symbol)return;',
'try{',
'var response=await fetch("/api/chart?symbol="+encodeURIComponent(symbol)+"&timeframe="+encodeURIComponent(timeframe));',
'var data=await response.json();',
'if(!data.success)return;',
'$("chartTitle").textContent=esc(data.symbol)+" • "+timeframe.toUpperCase();',
'drawChart(data.candles,data.signal);',
'}catch(e){console.error("chart",e);}',
'}',

'function drawChart(candles,signal){',
'var canvas=$("chart");',
'var rect=canvas.getBoundingClientRect();',
'var dpr=window.devicePixelRatio||1;',
'canvas.width=Math.max(1,Math.floor(rect.width*dpr));',
'canvas.height=Math.max(1,Math.floor(rect.height*dpr));',
'var ctx=canvas.getContext("2d");',
'ctx.scale(dpr,dpr);',
'var w=rect.width;',
'var h=rect.height;',
'ctx.fillStyle="#070a0f";',
'ctx.fillRect(0,0,w,h);',
'if(!candles||candles.length<2)return;',
'var view=candles.slice(-100);',
'var min=Math.min.apply(null,view.map(function(x){return x.low;}));',
'var max=Math.max.apply(null,view.map(function(x){return x.high;}));',
'var pad=(max-min)*0.08;',
'min-=pad;max+=pad;',
'var left=10,right=70,top=20,bottom=30;',
'var cw=(w-left-right)/view.length;',
'function y(v){return top+(max-v)/(max-min)*(h-top-bottom);}',
'ctx.strokeStyle="#17202c";',
'ctx.lineWidth=1;',
'for(var i=0;i<5;i++){',
'var gy=top+i*(h-top-bottom)/4;',
'ctx.beginPath();ctx.moveTo(left,gy);ctx.lineTo(w-right,gy);ctx.stroke();',
'var price=max-i*(max-min)/4;',
'ctx.fillStyle="#617084";ctx.font="10px Arial";',
'ctx.fillText(String(price.toFixed(price<1?5:2)),w-right+5,gy+3);',
'}',
'for(var j=0;j<view.length;j++){',
'var c=view[j];',
'var x=left+j*cw+cw/2;',
'var yo=y(c.open);',
'var yc=y(c.close);',
'var yh=y(c.high);',
'var yl=y(c.low);',
'var up=c.close>=c.open;',
'ctx.strokeStyle=up?"#2be19b":"#ff5d6d";',
'ctx.fillStyle=up?"#2be19b":"#ff5d6d";',
'ctx.beginPath();ctx.moveTo(x,yh);ctx.lineTo(x,yl);ctx.stroke();',
'var body=Math.max(1,Math.abs(yc-yo));',
'ctx.fillRect(x-cw*0.32,Math.min(yo,yc),cw*0.64,body);',
'}',
'if(signal){',
'var entry=Number(signal.entry);',
'var stop=Number(signal.stop);',
'var tp1=Number(signal.tp1);',
'var tp2=Number(signal.tp2);',
'var tp3=Number(signal.tp3);',
'function line(value,label,textColor){',
'if(!Number.isFinite(value))return;',
'var ly=y(value);',
'ctx.strokeStyle=textColor;',
'ctx.setLineDash([6,5]);',
'ctx.beginPath();ctx.moveTo(left,ly);ctx.lineTo(w-right,ly);ctx.stroke();',
'ctx.setLineDash([]);',
'ctx.fillStyle=textColor;',
'ctx.font="10px Arial";',
'ctx.fillText(label+" "+String(value),w-right+4,ly-3);',
'}',
'line(entry,"GİRİŞ","#55a6ff");',
'line(stop,"STOP","#ff5d6d");',
'line(tp1,"TP1","#2be19b");',
'line(tp2,"TP2","#2be19b");',
'line(tp3,"TP3","#2be19b");',
'}',
'}',

'window.addEventListener("resize",function(){',
'if(chartSymbol||selected)loadChart();',
'});',

'connect();',

'fetch("/api/status")',
'.then(function(r){return r.json();})',
'.then(applyState)',
'.catch(function(e){console.error(e);});',

'setInterval(function(){',
'if(!ws||ws.readyState!==1){return;}',
'fetch("/api/status")',
'.then(function(r){return r.json();})',
'.then(applyState)',
'.catch(function(){});',
'},15000);',

'</script>',
'</body>',
'</html>'
].join('\n');

/* =========================================================
   ROOT
========================================================= */

app.get(
    '/',
    (req, res) => {
        res
            .type('html')
            .send(HTML);
    }
);

/* =========================================================
   SERVER START
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
            '🚀 SONNY AI TRADER FINAL v5.2'
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
            '🔬 40 Deep Watch'
        );

        console.log(
            '📊 4H + 2H → 15M Breakout → Retest → 5M'
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
            '⏱️ Scan: ' +
            CFG.SCAN_MS /
            1000 +
            ' sec'
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
            await exchange.loadMarkets(
                true
            );

            await runScan();

        } catch (error) {
            STATE.lastError =
                error.message;

            console.error(
                'START:',
                error.message
            );
        }

        setInterval(
            function() {
                runScan()
                    .catch(
                        error => {
                            STATE.lastError =
                                error.message;
                        }
                    );
            },
            CFG.SCAN_MS
        );

        setInterval(
            function() {
                updateLiveSignals()
                    .then(
                        function() {
                            cleanup();
                            broadcast();
                        }
                    )
                    .catch(
                        function(error) {
                            console.error(
                                'LIVE:',
                                error.message
                            );
                        }
                    );
            },
            CFG.LIVE_MS
        );

        setInterval(
            function() {
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
            error &&
            error.message
                ? error.message
                : String(error);
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
            error &&
            error.message
                ? error.message
                : String(error);
    }
);
