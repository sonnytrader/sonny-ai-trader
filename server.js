'use strict';

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
    apiKey: process.env.BITGET_API_KEY || '',
    secret: process.env.BITGET_SECRET || '',
    password: process.env.BITGET_PASSPHRASE || '',
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

    MIN_VOLUME_USD: 1000000,
    MIN_24H_MOVE: 1.0,

    SCAN_MS: 60000,
    LIVE_MS: 10000,

    CONCURRENCY: 6,

    H4_LIMIT: 120,
    H2_LIMIT: 120,
    M15_LIMIT: 160,
    M5_LIMIT: 100,

    PIVOT_LOOKBACK: 3,
    LEVEL_TOLERANCE: 0.012,
    CLUSTER_TOLERANCE: 0.004,

    BREAKOUT_LOOKBACK: 10,
    MIN_BREAKOUT_VOLUME_RATIO: 1.10,
    MIN_BREAKOUT_BODY_ATR: 0.30,

    RETEST_WINDOW_MINUTES: 90,
    RETEST_TOLERANCE: 0.005,
    BREAKOUT_INVALIDATION: 0.002,

    FIVE_MIN_VOLUME_RATIO: 1.02,
    REQUIRE_5M: true,

    MIN_SCORE: 65,

    ATR_STOP_MULTIPLIER: 0.85,
    MIN_RR: 1.35,

    SIGNAL_TTL_MS: 45 * 60 * 1000,
    LEVEL_COOLDOWN_MS: 4 * 60 * 60 * 1000,

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

function num(v, fallback = 0) {
    const x = Number(v);
    return Number.isFinite(x) ? x : fallback;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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

    if (!Number.isFinite(x)) return null;

    if (x >= 1000) return Number(x.toFixed(2));
    if (x >= 100) return Number(x.toFixed(3));
    if (x >= 1) return Number(x.toFixed(5));
    if (x >= 0.01) return Number(x.toFixed(7));

    return Number(x.toFixed(10));
}

function distancePct(a, b) {
    if (!b) return 999;
    return Math.abs(a - b) / b * 100;
}

function closedCandles(candles) {
    if (!Array.isArray(candles) || candles.length < 3) {
        return [];
    }

    return candles.slice(0, -1);
}

async function mapLimit(items, limit, worker) {
    const result = new Array(items.length);
    let cursor = 0;

    async function runner() {
        while (true) {
            const index = cursor++;

            if (index >= items.length) return;

            try {
                result[index] = await worker(items[index]);
            } catch (error) {
                result[index] = null;
            }
        }
    }

    await Promise.all(
        Array.from(
            { length: Math.min(limit, items.length) },
            runner
        )
    );

    return result;
}

/* =========================================================
   TICKERS
========================================================= */

async function getTickers(force = false) {
    if (
        !force &&
        tickerCache.data.size &&
        Date.now() - tickerCache.time < 8000
    ) {
        return tickerCache.data;
    }

    try {
        const tickers = await exchange.fetchTickers();
        const map = new Map();

        for (const ticker of Object.values(tickers || {})) {
            if (!ticker || !ticker.symbol) continue;

            const market = exchange.markets[ticker.symbol];

            if (
                !market ||
                market.swap !== true ||
                market.quote !== 'USDT' ||
                market.settle !== 'USDT'
            ) {
                continue;
            }

            const last = num(ticker.last);
            const volume = num(ticker.quoteVolume);
            const change = num(ticker.percentage);

            if (!last || !volume) continue;

            map.set(ticker.symbol, {
                symbol: ticker.symbol,
                last,
                volume,
                change,
                high: num(ticker.high),
                low: num(ticker.low),
                bid: num(ticker.bid),
                ask: num(ticker.ask)
            });
        }

        tickerCache = {
            time: Date.now(),
            data: map
        };

        return map;

    } catch (error) {
        STATE.lastError = error.message;
        console.error('Ticker hatası:', error.message);
        return tickerCache.data;
    }
}

/* =========================================================
   CANDLES
========================================================= */

function candleTTL(timeframe) {
    if (timeframe === '5m') return 5000;
    if (timeframe === '15m') return 10000;
    return 30000;
}

async function getCandles(symbol, timeframe, limit) {
    const key = symbol + '|' + timeframe + '|' + limit;

    const cached = candleCache.get(key);

    if (
        cached &&
        Date.now() - cached.time < candleTTL(timeframe)
    ) {
        return cached.data;
    }

    try {
        const data = await exchange.fetchOHLCV(
            symbol,
            timeframe,
            undefined,
            limit
        );

        const cleaned = (data || [])
            .filter(x => Array.isArray(x) && x.length >= 6)
            .sort((a, b) => Number(a[0]) - Number(b[0]));

        candleCache.set(key, {
            time: Date.now(),
            data: cleaned
        });

        return cleaned;

    } catch (error) {
        if (process.env.DEBUG === 'true') {
            console.log(
                'Candle hatası:',
                symbol,
                timeframe,
                error.message
            );
        }

        return [];
    }
}

/* =========================================================
   500 COIN RADAR
========================================================= */

async function discoverUniverse() {
    const tickers = await getTickers();

    const rows = [];

    for (const ticker of tickers.values()) {
        if (ticker.volume < CFG.MIN_VOLUME_USD) continue;

        const range =
            ticker.low > 0
                ? ((ticker.high - ticker.low) / ticker.low) * 100
                : 0;

        if (
            range < CFG.MIN_24H_MOVE &&
            Math.abs(ticker.change) < CFG.MIN_24H_MOVE
        ) {
            continue;
        }

        const volumeScore = Math.min(
            35,
            Math.log10(Math.max(ticker.volume, 1)) * 4
        );

        const rangeScore = Math.min(
            25,
            range * 5
        );

        const momentumScore = Math.min(
            25,
            Math.abs(ticker.change) * 5
        );

        const activityScore =
            Math.abs(ticker.change) >= 2 ? 15 : 7;

        const radarScore = Math.round(
            Math.min(
                100,
                volumeScore +
                rangeScore +
                momentumScore +
                activityScore
            )
        );

        rows.push({
            symbol: ticker.symbol,
            coin: cleanSymbol(ticker.symbol),
            last: ticker.last,
            quoteVolume: ticker.volume,
            percentage: ticker.change,
            range,
            radarScore
        });
    }

    rows.sort((a, b) => b.radarScore - a.radarScore);

    STATE.marketRows = rows.slice(0, CFG.MAX_COINS);
    STATE.stats.universe = STATE.marketRows.length;

    return STATE.marketRows;
}

/* =========================================================
   500 -> 150
========================================================= */

function buildCandidates(rows) {
    STATE.candidates = rows
        .slice()
        .sort((a, b) => b.radarScore - a.radarScore)
        .slice(0, CFG.CANDIDATE_LIMIT);

    STATE.stats.candidates = STATE.candidates.length;

    return STATE.candidates;
}

/* =========================================================
   EMA
========================================================= */

function ema(candles, period) {
    const c = closedCandles(candles);

    if (c.length < period) return null;

    const k = 2 / (period + 1);

    let value =
        c
            .slice(0, period)
            .reduce((sum, x) => sum + num(x[4]), 0) /
        period;

    for (let i = period; i < c.length; i++) {
        value =
            num(c[i][4]) * k +
            value * (1 - k);
    }

    return value;
}

/* =========================================================
   RSI
========================================================= */

function rsi(candles, period = 14) {
    const c = closedCandles(candles);

    if (c.length < period + 1) return 50;

    let gains = 0;
    let losses = 0;

    const start = c.length - period;

    for (let i = start; i < c.length; i++) {
        const diff =
            num(c[i][4]) -
            num(c[i - 1][4]);

        if (diff > 0) {
            gains += diff;
        } else {
            losses += Math.abs(diff);
        }
    }

    if (losses === 0) return 100;

    const rs =
        (gains / period) /
        (losses / period);

    return 100 - 100 / (1 + rs);
}

/* =========================================================
   ATR
========================================================= */

function atr(candles, period = 14) {
    const c = closedCandles(candles);

    if (c.length < period + 1) return 0;

    const tr = [];

    for (let i = 1; i < c.length; i++) {
        const high = num(c[i][2]);
        const low = num(c[i][3]);
        const previousClose = num(c[i - 1][4]);

        tr.push(
            Math.max(
                high - low,
                Math.abs(high - previousClose),
                Math.abs(low - previousClose)
            )
        );
    }

    const recent = tr.slice(-period);

    return (
        recent.reduce(
            (sum, x) => sum + x,
            0
        ) / recent.length
    );
}

/* =========================================================
   4H TREND
========================================================= */

function trend4H(candles) {
    const fast = ema(candles, 21);
    const slow = ema(candles, 50);

    if (!fast || !slow) {
        return {
            direction: 'NEUTRAL',
            diff: 0
        };
    }

    const diff =
        ((fast - slow) / slow) * 100;

    if (diff > 0.15) {
        return {
            direction: 'LONG',
            diff
        };
    }

    if (diff < -0.15) {
        return {
            direction: 'SHORT',
            diff
        };
    }

    return {
        direction: 'NEUTRAL',
        diff
    };
}

/* =========================================================
   PIVOTS
========================================================= */

function pivots(candles) {
    const c = closedCandles(candles);
    const result = [];
    const lb = CFG.PIVOT_LOOKBACK;

    for (
        let i = lb;
        i < c.length - lb;
        i++
    ) {
        const high = num(c[i][2]);
        const low = num(c[i][3]);

        let isHigh = true;
        let isLow = true;

        for (
            let j = 1;
            j <= lb;
            j++
        ) {
            if (
                high <= num(c[i - j][2]) ||
                high <= num(c[i + j][2])
            ) {
                isHigh = false;
            }

            if (
                low >= num(c[i - j][3]) ||
                low >= num(c[i + j][3])
            ) {
                isLow = false;
            }
        }

        if (isHigh) {
            result.push({
                price: high,
                type: 'resistance',
                time: num(c[i][0])
            });
        }

        if (isLow) {
            result.push({
                price: low,
                type: 'support',
                time: num(c[i][0])
            });
        }
    }

    return result;
}

/* =========================================================
   LEVEL CLUSTER
========================================================= */

function clusterLevels(levels) {
    const sorted = levels
        .slice()
        .sort((a, b) => a.price - b.price);

    const groups = [];

    for (const level of sorted) {
        const existing = groups.find(group =>
            group.type === level.type &&
            Math.abs(level.price - group.price) /
            group.price <=
            CFG.CLUSTER_TOLERANCE
        );

        if (existing) {
            existing.items.push(level);

            existing.price =
                existing.items.reduce(
                    (sum, x) => sum + x.price,
                    0
                ) /
                existing.items.length;

        } else {
            groups.push({
                type: level.type,
                price: level.price,
                items: [level]
            });
        }
    }

    return groups.map(group => ({
        type: group.type,
        price: group.price,
        touches: group.items.length,
        lastTouch: Math.max(
            ...group.items.map(x => x.time)
        )
    }));
}

function getLevels(candles) {
    return clusterLevels(
        pivots(candles)
    );
}

/* =========================================================
   BREAKOUT VOLUME
========================================================= */

function volumeRatioAt(candles, index) {
    const c = closedCandles(candles);

    if (
        index < 20 ||
        index >= c.length
    ) {
        return 1;
    }

    const current = num(c[index][5]);

    const previous = c.slice(
        index - 20,
        index
    );

    const average =
        previous.reduce(
            (sum, x) => sum + num(x[5]),
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

function detectBreakouts(candles, levels) {
    const c = closedCandles(candles);

    if (c.length < 30) return [];

    const found = [];

    const start = Math.max(
        1,
        c.length - CFG.BREAKOUT_LOOKBACK
    );

    for (let i = start; i < c.length; i++) {
        const current = c[i];
        const previous = c[i - 1];

        const close = num(current[4]);
        const previousClose = num(previous[4]);

        const currentATR =
            atr(candles, 14) ||
            close * 0.003;

        const body =
            Math.abs(
                close -
                num(current[1])
            );

        const bodyAtr =
            body /
            currentATR;

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
            const level of levels
        ) {
            if (
                level.type ===
                'resistance' &&
                previousClose <= level.price &&
                close > level.price
            ) {
                found.push({
                    direction: 'LONG',
                    level,
                    breakoutCandle: current,
                    breakoutTime: num(current[0]),
                    breakoutVolumeRatio: volumeRatio,
                    breakoutBodyAtr: bodyAtr
                });
            }

            if (
                level.type ===
                'support' &&
                previousClose >= level.price &&
                close < level.price
            ) {
                found.push({
                    direction: 'SHORT',
                    level,
                    breakoutCandle: current,
                    breakoutTime: num(current[0]),
                    breakoutVolumeRatio: volumeRatio,
                    breakoutBodyAtr: bodyAtr
                });
            }
        }
    }

    return found;
}

/* =========================================================
   PENDING BREAKOUT
========================================================= */

function breakoutKey(symbol, breakout) {
    return [
        symbol,
        breakout.direction,
        fmtPrice(breakout.level.price),
        breakout.breakoutTime
    ].join('|');
}

function saveBreakouts(symbol, breakouts) {
    for (const breakout of breakouts) {
        const key = breakoutKey(
            symbol,
            breakout
        );

        if (
            STATE.pendingBreakouts.has(key)
        ) {
            continue;
        }

        STATE.pendingBreakouts.set(
            key,
            {
                ...breakout,
                key,
                symbol,
                createdAt: Date.now(),
                status: 'WAITING_RETEST'
            }
        );

        console.log(
            'BREAKOUT | ' +
            cleanSymbol(symbol) +
            ' | ' +
            breakout.direction +
            ' | ' +
            fmtPrice(breakout.level.price) +
            ' | VOL ' +
            breakout.breakoutVolumeRatio.toFixed(2) +
            'x'
        );
    }
}

/* =========================================================
   RETEST
========================================================= */

function detectRetest(candles, pending) {
    const c = closedCandles(candles);

    const index = c.findIndex(
        candle =>
            num(candle[0]) ===
            pending.breakoutTime
    );

    if (index < 0) {
        return {
            status: 'WAITING_RETEST'
        };
    }

    const maxCandles =
        Math.ceil(
            CFG.RETEST_WINDOW_MINUTES / 15
        );

    const end = Math.min(
        c.length,
        index + 1 + maxCandles
    );

    let movedAway = false;

    const level =
        pending.level.price;

    for (
        let i = index + 1;
        i < end;
        i++
    ) {
        const candle = c[i];

        const high = num(candle[2]);
        const low = num(candle[3]);
        const close = num(candle[4]);

        if (
            pending.direction ===
            'LONG'
        ) {
            if (
                close <
                level *
                (1 - CFG.BREAKOUT_INVALIDATION)
            ) {
                return {
                    status: 'INVALIDATED'
                };
            }

            if (
                close >
                level *
                (1 + 0.0015)
            ) {
                movedAway = true;
            }

            const touched =
                low <=
                level *
                (1 + CFG.RETEST_TOLERANCE);

            const held =
                close >=
                level *
                (1 - CFG.RETEST_TOLERANCE);

            if (
                movedAway &&
                touched &&
                held
            ) {
                return {
                    status: 'RETESTED',
                    candle,
                    candleIndex: i
                };
            }

        } else {

            if (
                close >
                level *
                (1 + CFG.BREAKOUT_INVALIDATION)
            ) {
                return {
                    status: 'INVALIDATED'
                };
            }

            if (
                close <
                level *
                (1 - 0.0015)
            ) {
                movedAway = true;
            }

            const touched =
                high >=
                level *
                (1 - CFG.RETEST_TOLERANCE);

            const held =
                close <=
                level *
                (1 + CFG.RETEST_TOLERANCE);

            if (
                movedAway &&
                touched &&
                held
            ) {
                return {
                    status: 'RETESTED',
                    candle,
                    candleIndex: i
                };
            }
        }
    }

    if (
        c.length - 1 >=
        index + maxCandles
    ) {
        return {
            status: 'EXPIRED'
        };
    }

    return {
        status: 'WAITING_RETEST'
    };
}

/* =========================================================
   5M CONFIRM
========================================================= */

function confirm5M(
    candles,
    retest,
    direction,
    level
) {
    const c = closedCandles(candles);

    if (
        c.length < 10 ||
        !retest ||
        !retest.candle
    ) {
        return {
            confirmed: false
        };
    }

    const after = c.filter(
        candle =>
            num(candle[0]) >
            num(retest.candle[0])
    );

    if (after.length < 2) {
        return {
            confirmed: false
        };
    }

    const recent =
        after.slice(-12);

    for (
        let i = 1;
        i < recent.length;
        i++
    ) {
        const previous = recent[i - 1];
        const current = recent[i];

        const open = num(current[1]);
        const close = num(current[4]);
        const high = num(current[2]);
        const low = num(current[3]);

        const prevHigh = num(previous[2]);
        const prevLow = num(previous[3]);

        const index = c.indexOf(current);

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
                low >= prevLow &&
                close > prevHigh &&
                close > level &&
                volumeRatio >=
                    CFG.FIVE_MIN_VOLUME_RATIO
            ) {
                return {
                    confirmed: true,
                    candle: current,
                    volumeRatio
                };
            }
        } else {
            if (
                close < open &&
                high <= prevHigh &&
                close < prevLow &&
                close < level &&
                volumeRatio >=
                    CFG.FIVE_MIN_VOLUME_RATIO
            ) {
                return {
                    confirmed: true,
                    candle: current,
                    volumeRatio
                };
            }
        }
    }

    return {
        confirmed: false
    };
}

/* =========================================================
   15M STRUCTURE
========================================================= */

function structure15M(candles) {
    const c = closedCandles(candles);

    if (c.length < 24) {
        return 'NEUTRAL';
    }

    const recent = c.slice(-12);
    const previous = c.slice(-24, -12);

    const recentHigh =
        Math.max(
            ...recent.map(x => num(x[2]))
        );

    const previousHigh =
        Math.max(
            ...previous.map(x => num(x[2]))
        );

    const recentLow =
        Math.min(
            ...recent.map(x => num(x[3]))
        );

    const previousLow =
        Math.min(
            ...previous.map(x => num(x[3]))
        );

    const first = recent[0];
    const last = recent[recent.length - 1];

    if (
        recentHigh > previousHigh &&
        recentLow > previousLow &&
        num(last[4]) > num(first[4])
    ) {
        return 'LONG';
    }

    if (
        recentHigh < previousHigh &&
        recentLow < previousLow &&
        num(last[4]) < num(first[4])
    ) {
        return 'SHORT';
    }

    return 'NEUTRAL';
}

/* =========================================================
   SCORE
========================================================= */

function scoreSetup(data) {
    let score = 25;
    const reasons = [];

    if (
        data.trend.direction ===
        data.direction
    ) {
        score += 18;
        reasons.push('4H trend uyumlu');

    } else if (
        data.trend.direction ===
        'NEUTRAL'
    ) {
        score += 8;
        reasons.push('4H trend nötr');

    } else {
        score -= 15;
        reasons.push('4H trend ters');
    }

    if (data.confluence) {
        score += 18;
        reasons.push('4H + 2H seviye');

    } else {
        score += 7;
        reasons.push(data.levelTf + ' seviye');
    }

    if (data.touches >= 4) {
        score += 9;
        reasons.push('Güçlü seviye');

    } else if (data.touches >= 2) {
        score += 5;
        reasons.push('Seviye teyitli');
    }

    if (data.breakoutVolume >= 2) {
        score += 14;
        reasons.push('Yüksek breakout hacmi');

    } else if (
        data.breakoutVolume >=
        CFG.MIN_BREAKOUT_VOLUME_RATIO
    ) {
        score += 7;
        reasons.push('Breakout hacmi uygun');
    }

    if (data.breakoutBodyAtr >= 0.7) {
        score += 8;
        reasons.push('Güçlü breakout');
    } else {
        score += 3;
    }

    if (
        data.structure ===
        data.direction
    ) {
        score += 10;
        reasons.push('15M yapı uyumlu');

    } else if (
        data.structure ===
        'NEUTRAL'
    ) {
        score += 3;
        reasons.push('15M nötr');

    } else {
        score -= 8;
        reasons.push('15M yapı ters');
    }

    if (data.confirm5M) {
        score += 8;
        reasons.push('5M giriş teyidi');
    }

    if (
        data.direction ===
        'LONG'
    ) {
        if (
            data.rsi >= 45 &&
            data.rsi <= 72
        ) {
            score += 4;
            reasons.push('RSI uygun');
        }

        if (data.rsi > 85) {
            score -= 6;
            reasons.push('RSI aşırı yüksek');
        }

    } else {

        if (
            data.rsi >= 28 &&
            data.rsi <= 55
        ) {
            score += 4;
            reasons.push('RSI uygun');
        }

        if (data.rsi < 15) {
            score -= 6;
            reasons.push('RSI aşırı düşük');
        }
    }

    score = Math.round(
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
    const c = closedCandles(candles);

    if (!c.length) return null;

    const current =
        num(
            c[c.length - 1][4]
        );

    const currentATR =
        atr(candles, 14) ||
        current * 0.004;

    const zone =
        Math.max(
            currentATR * 0.18,
            level.price * 0.0007
        );

    const risk =
        Math.max(
            currentATR *
            CFG.ATR_STOP_MULTIPLIER,
            current * 0.0018
        );

    let entry;
    let stop;

    if (
        direction ===
        'LONG'
    ) {
        entry =
            level.price;

        stop =
            level.price -
            risk;

    } else {
        entry =
            level.price;

        stop =
            level.price +
            risk;
    }

    const realRisk =
        Math.abs(
            entry -
            stop
        );

    const possibleTargets =
        [1.5, 2.25, 3];

    const validOpposite =
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

    const targets = [];

    for (
        const multiplier
        of possibleTargets
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
                x => {

                    const rr =
                        Math.abs(
                            x.price -
                            entry
                        ) /
                        realRisk;

                    return (
                        rr >=
                        CFG.MIN_RR &&
                        rr <=
                        multiplier +
                        0.75
                    );
                }
            );

        if (nearby) {
            target =
                nearby.price;
        }

        targets.push(target);
    }

    const tp1 = targets[0];
    const tp2 = targets[1];
    const tp3 = targets[2];

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
            tp1 < tp2 &&
            tp2 < tp3
        )
    ) {
        return null;
    }

    if (
        direction ===
        'SHORT' &&
        !(
            tp1 > tp2 &&
            tp2 > tp3
        )
    ) {
        return null;
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
            fmtPrice(entry),

        stop:
            fmtPrice(stop),

        tp1:
            fmtPrice(tp1),

        tp2:
            fmtPrice(tp2),

        tp3:
            fmtPrice(tp3),

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
   PENDING ANALYSIS
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
        trend4H(h4);

    /*
       Ters 4H trendi tamamen kilitlemiyoruz.
       Sadece skorunu düşürüyoruz.
       Böylece altcoin fırsatları kaçmıyor.
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

    const current =
        num(coin.last);

    if (!current) return null;

    if (
        distancePct(
            current,
            pending.level.price
        ) >
        0.8
    ) {
        pending.status =
            'MISSED_ENTRY';

        return null;
    }

    const structure =
        structure15M(m15);

    const currentRSI =
        rsi(m15);

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

    const has4 =
        levels4.some(
            x =>
                x.type ===
                    pending.level.type &&
                distancePct(
                    x.price,
                    pending.level.price
                ) <=
                    CFG.CLUSTER_TOLERANCE *
                    100
        );

    const has2 =
        levels2.some(
            x =>
                x.type ===
                    pending.level.type &&
                distancePct(
                    x.price,
                    pending.level.price
                ) <=
                    CFG.CLUSTER_TOLERANCE *
                    100
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
            'REJECTED_RR';

        return null;
    }

    const scored =
        scoreSetup({
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

        coin:
            cleanSymbol(
                pending.symbol
            ),

        symbol:
            pending.symbol,

        ccxt_symbol:
            pending.symbol,

        direction:
            pending.direction,

        taraf:
            pending.direction,

        score:
            scored.score,

        confidence:
            scored.score,

        livePrice:
            fmtPrice(current),

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
            has4 && has2
                ? '4H + 2H'
                : has4
                    ? '4H'
                    : '2H',

        confluence:
            has4 && has2,

        touches:
            pending.level.touches,

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
            num(
                retest.candle[0]
            ),

        confirmation5mTime:
            confirm.candle
                ? num(
                    confirm.candle[0]
                )
                : 0,

        breakoutVolumeRatio:
            Number(
                pending.breakoutVolumeRatio.toFixed(2)
            ),

        breakoutBodyAtr:
            Number(
                pending.breakoutBodyAtr.toFixed(2)
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

        volume24h:
            coin.quoteVolume,

        signalAt:
            Date.now(),

        timestamp:
            Date.now(),

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

        cooldownKey
    };

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
                    num(coin.last);

                const levels =
                    [
                        ...getLevels(h4),
                        ...getLevels(h2)
                    ];

                const nearby =
                    levels
                        .map(level => ({
                            ...level,
                            distance:
                                distancePct(
                                    price,
                                    level.price
                                )
                        }))
                        .filter(
                            x =>
                                x.distance <=
                                CFG.LEVEL_TOLERANCE *
                                100
                        )
                        .sort(
                            (a, b) =>
                                a.distance -
                                b.distance
                        );

                let deepScore =
                    coin.radarScore;

                if (nearby.length) {
                    deepScore += 12;
                }

                if (nearby.length >= 2) {
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
   MARKET
========================================================= */

function calculateMarket() {
    const rows =
        STATE.marketRows;

    if (!rows.length) return;

    let green = 0;
    let red = 0;
    let total = 0;

    for (const row of rows) {
        const change =
            num(row.percentage);

        total += change;

        if (change > 0.20) {
            green++;
        } else if (change < -0.20) {
            red++;
        }
    }

    const counted =
        green + red;

    const breadth =
        counted
            ? green / counted * 100
            : 50;

    const average =
        rows.length
            ? total / rows.length
            : 0;

    let direction = 'NEUTRAL';
    let label = 'KARIŞIK';

    if (
        breadth >= 62 &&
        average >= 0.35
    ) {
        direction = 'LONG';
        label = 'YÜKSELİŞ';

    } else if (
        breadth <= 38 &&
        average <= -0.35
    ) {
        direction = 'SHORT';
        label = 'DÜŞÜŞ';

    } else if (
        breadth >= 55
    ) {
        label = 'POZİTİF';

    } else if (
        breadth <= 45
    ) {
        label = 'NEGATİF';
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
   LIVE SIGNALS
========================================================= */

async function updateLiveSignals() {
    if (!STATE.signals.size) return;

    const tickers =
        await getTickers(true);

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

        if (ticker?.last) {
            const price =
                ticker.last;

            signal.livePrice =
                fmtPrice(price);

            signal.ageSeconds =
                Math.floor(
                    (
                        now -
                        signal.signalAt
                    ) / 1000
                );

            signal.signalAge =
                signal.ageSeconds;

            const isLong =
                signal.direction ===
                'LONG';

            const stop =
                num(
                    signal.stop
                );

            const tp1 =
                num(
                    signal.tp1
                );

            const tp3 =
                num(
                    signal.tp3
                );

            const entryLow =
                num(
                    signal.entryLow
                );

            const entryHigh =
                num(
                    signal.entryHigh
                );

            if (
                isLong &&
                price <= stop
            ) {
                signal.status =
                    'STOP';

            } else if (
                !isLong &&
                price >= stop
            ) {
                signal.status =
                    'STOP';

            } else if (
                isLong &&
                price >= tp3
            ) {
                signal.status =
                    'TP3';

            } else if (
                !isLong &&
                price <= tp3
            ) {
                signal.status =
                    'TP3';

            } else if (
                price >= entryLow &&
                price <= entryHigh
            ) {
                signal.status =
                    'GİRİŞ ALANI';

                signal.entryReady =
                    true;

            } else if (
                isLong &&
                price >= tp1
            ) {
                signal.status =
                    'TP1';

            } else if (
                !isLong &&
                price <= tp1
            ) {
                signal.status =
                    'TP1';

            } else {
                signal.status =
                    'GİRİŞ BEKLENİYOR';
            }
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

        if (
            expired ||
            signal.status === 'STOP' ||
            signal.status === 'TP3'
        ) {
            STATE.signals.delete(id);
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
   SCAN
========================================================= */

async function runScan() {
    if (STATE.scanning) return;

    STATE.scanning = true;

    const started =
        Date.now();

    STATE.stats.analyzed = 0;

    try {
        console.log('');
        console.log(
            '=============================================='
        );
        console.log(
            'SONNY AI TRADER V5.1 RADAR'
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

                    const levels =
                        [
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

                    const breakouts =
                        detectBreakouts(
                            m15,
                            levels
                        );

                    saveBreakouts(
                        coin.symbol,
                        breakouts
                    );

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

                        if (signal) {
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
                    ...STATE.signals.values()
                ].some(
                    existing =>
                        existing.symbol ===
                            signal.symbol &&
                        existing.direction ===
                            signal.direction
                );

            if (duplicate) continue;

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
            error
        );

        broadcast();

    } finally {
        STATE.scanning = false;
    }
}

/* =========================================================
   STATUS
========================================================= */

function publicSignal(signal) {
    const copy = {
        ...signal
    };

    delete copy.cooldownKey;

    return copy;
}

function getStatus() {
    return {
        success: true,

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
                ...STATE.pendingBreakouts.values()
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
                            p.breakoutVolumeRatio.toFixed(
                                2
                            )
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

                    level:
                        x.nearbyLevel ||
                        null,

                    trend:
                        x.h4Trend ||
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
   API
========================================================= */

app.get(
    '/api/status',
    (req, res) => {
        res.json(
            getStatus()
        );
    }
);

app.get(
    '/api/signals',
    (req, res) => {
        const status =
            getStatus();

        res.json({
            success: true,
            signals:
                status.signals,
            stats:
                status.stats,
            market:
                status.market
        });
    }
);

app.get(
    '/api/scalp-radar',
    (req, res) => {
        const status =
            getStatus();

        res.json({
            success: true,
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

app.get(
    '/api/scan',
    (req, res) => {

        if (
            STATE.scanning
        ) {
            return res.json({
                success: false,
                message:
                    'Tarama zaten devam ediyor.'
            });
        }

        runScan();

        res.json({
            success: true,
            message:
                'Tarama başlatıldı.'
        });
    }
);

app.get(
    '/health',
    (req, res) => {
        res.json({
            ok: true,
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
            'SONNY AI TRADER FINAL v5.1'
        );
        console.log(
            'Bitget USDT Futures'
        );
        console.log(
            '500 Coin Radar -> 150 Candidate -> 40 Deep Watch'
        );
        console.log(
            '4H + 2H -> 15M Breakout -> Retest -> 5M'
        );
        console.log(
            'Auto Trade: KAPALI'
        );
        console.log(
            'Port: ' + PORT
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
                'İlk başlatma hatası:',
                error.message
            );
        }

        setInterval(
            () => {
                runScan().catch(
                    error => {
                        STATE.lastError =
                            error.message;
                    }
                );
            },
            CFG.SCAN_MS
        );

        setInterval(
            () => {
                updateLiveSignals()
                    .then(
                        () => {
                            cleanup();
                            broadcast();
                        }
                    )
                    .catch(
                        error => {
                            console.error(
                                'LIVE ERROR:',
                                error.message
                            );
                        }
                    );
            },
            CFG.LIVE_MS
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
