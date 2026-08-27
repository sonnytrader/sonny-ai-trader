'use strict';

/*
===============================================================
 SONNY AI TRADER V5.2
 BITGET FUTURES SCALP RADAR

 500 COIN
   ↓
 150 ADAY
   ↓
 40 DEEP
   ↓
 4H + 2H SEVİYE
   ↓
 15M BREAKOUT
   ↓
 15M RETEST
   ↓
 5M TEYİT
   ↓
 SCALP SIGNAL

 ANA SAYFA SERVER.JS İÇİNDE
 AUTO TRADE KAPALI
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
    REQUIRE_5M: false,

    MIN_SCORE: 58,
    MIN_RR: 1.20,

    ATR_STOP_MULTIPLIER: 0.65,

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

function cleanSymbol(symbol) {
    return String(symbol || '')
        .replace('/USDT:USDT', '')
        .replace('/USDT', '')
        .replace(':USDT', '')
        .replace('USDT', '')
        .replace(/[^A-Z0-9]/gi, '')
        .toUpperCase() + 'USDT';
}

function formatPrice(v) {
    const x = Number(v);

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
   MARKET
========================================================= */

function resolveMarket(input) {
    if (!input) return null;

    const wanted =
        String(input)
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, '')
            .replace('USDT', '') + 'USDT';

    for (const market of Object.values(exchange.markets || {})) {
        if (
            market.swap === true &&
            market.active !== false &&
            market.quote === 'USDT' &&
            market.settle === 'USDT'
        ) {
            const base =
                String(market.base || '').toUpperCase();

            if (base + 'USDT' === wanted) {
                return market.symbol;
            }
        }
    }

    return null;
}

async function getTickers(force = false) {
    if (
        !force &&
        tickerCache.data.size &&
        Date.now() - tickerCache.time < 10000
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
                market.settle !== 'USDT' ||
                market.active === false
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
        console.error('TICKER:', error.message);
        return tickerCache.data;
    }
}

/* =========================================================
   CANDLES
========================================================= */

function candleTTL(tf) {
    if (tf === '5m') return 5000;
    if (tf === '15m') return 10000;
    return 30000;
}

async function getCandles(symbol, timeframe, limit) {
    const key = `${symbol}|${timeframe}|${limit}`;
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
    } catch (_) {
        return [];
    }
}

/* =========================================================
   RADAR
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

        const rangeScore = Math.min(25, range * 5);
        const momentumScore =
            Math.min(25, Math.abs(ticker.change) * 5);

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

function buildCandidates(rows) {
    STATE.candidates = rows
        .slice()
        .sort((a, b) => b.radarScore - a.radarScore)
        .slice(0, CFG.CANDIDATE_LIMIT);

    STATE.stats.candidates = STATE.candidates.length;

    return STATE.candidates;
}

/* =========================================================
   INDICATORS
========================================================= */

function ema(candles, period) {
    const c = closedCandles(candles);

    if (c.length < period) return null;

    const k = 2 / (period + 1);

    let value =
        c.slice(0, period)
            .reduce((sum, x) => sum + num(x[4]), 0) /
        period;

    for (let i = period; i < c.length; i++) {
        value =
            num(c[i][4]) * k +
            value * (1 - k);
    }

    return value;
}

function rsi(candles, period = 14) {
    const c = closedCandles(candles);

    if (c.length < period + 1) return 50;

    let gains = 0;
    let losses = 0;

    for (let i = c.length - period; i < c.length; i++) {
        const diff =
            num(c[i][4]) -
            num(c[i - 1][4]);

        if (diff > 0) gains += diff;
        else losses += Math.abs(diff);
    }

    if (!losses) return 100;

    const rs =
        (gains / period) /
        (losses / period);

    return 100 - 100 / (1 + rs);
}

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
        recent.reduce((sum, x) => sum + x, 0) /
        recent.length
    );
}

function trend4H(candles) {
    const fast = ema(candles, 21);
    const slow = ema(candles, 50);

    if (!fast || !slow) {
        return {
            direction: 'NEUTRAL',
            diff: 0
        };
    }

    const diff = ((fast - slow) / slow) * 100;

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
   LEVELS
========================================================= */

function findPivots(candles) {
    const c = closedCandles(candles);
    const result = [];
    const lb = CFG.PIVOT_LOOKBACK;

    for (let i = lb; i < c.length - lb; i++) {
        const high = num(c[i][2]);
        const low = num(c[i][3]);

        let isHigh = true;
        let isLow = true;

        for (let j = 1; j <= lb; j++) {
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
        findPivots(candles)
    );
}

/* =========================================================
   BREAKOUT
========================================================= */

function volumeRatioAt(candles, index) {
    const c = closedCandles(candles);

    if (index < 20 || index >= c.length) return 1;

    const current = num(c[index][5]);

    const previous = c.slice(index - 20, index);

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

function detectBreakouts(candles, levels) {
    const c = closedCandles(candles);

    if (c.length < 30) return [];

    const result = [];

    const start = Math.max(
        1,
        c.length - CFG.BREAKOUT_LOOKBACK
    );

    const atrValue =
        atr(candles, 14);

    for (let i = start; i < c.length; i++) {
        const current = c[i];
        const previous = c[i - 1];

        const close = num(current[4]);
        const previousClose = num(previous[4]);

        const atrNow =
            atrValue ||
            close * 0.003;

        const body =
            Math.abs(
                close -
                num(current[1])
            );

        const bodyAtr =
            body / atrNow;

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

        for (const level of levels) {
            if (
                level.type === 'resistance' &&
                previousClose <= level.price &&
                close > level.price
            ) {
                result.push({
                    direction: 'LONG',
                    level,
                    breakoutCandle: current,
                    breakoutTime: num(current[0]),
                    breakoutVolumeRatio: volumeRatio,
                    breakoutBodyAtr: bodyAtr
                });
            }

            if (
                level.type === 'support' &&
                previousClose >= level.price &&
                close < level.price
            ) {
                result.push({
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

    return result;
}

/* =========================================================
   BREAKOUT STATE
========================================================= */

function breakoutKey(symbol, breakout) {
    return [
        symbol,
        breakout.direction,
        formatPrice(breakout.level.price),
        breakout.breakoutTime
    ].join('|');
}

function saveBreakouts(symbol, breakouts) {
    for (const breakout of breakouts) {
        const key =
            breakoutKey(
                symbol,
                breakout
            );

        if (
            STATE.pendingBreakouts.has(key)
        ) {
            continue;
        }

        const duplicate =
            [...STATE.pendingBreakouts.values()]
                .some(p =>
                    p.symbol === symbol &&
                    p.direction === breakout.direction &&
                    distancePct(
                        p.level.price,
                        breakout.level.price
                    ) < 0.10
                );

        if (duplicate) continue;

        STATE.pendingBreakouts.set(key, {
            ...breakout,
            key,
            symbol,
            createdAt: Date.now(),
            status: 'WAITING_RETEST'
        });

        console.log(
            'BREAKOUT | ' +
            cleanSymbol(symbol) +
            ' | ' +
            breakout.direction +
            ' | ' +
            formatPrice(
                breakout.level.price
            ) +
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

    const maxCandles = Math.ceil(
        CFG.RETEST_WINDOW_MINUTES / 15
    );

    const end = Math.min(
        c.length,
        index + 1 + maxCandles
    );

    const level =
        pending.level.price;

    let movedAway = false;

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
            pending.direction === 'LONG'
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
                level * 1.0015
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
                level * 0.9985
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
   5M CONFIRMATION
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

    const after =
        c.filter(
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

        const prevHigh = num(previous[2]);
        const prevLow = num(previous[3]);

        const index = c.indexOf(current);

        const volume =
            volumeRatioAt(
                candles,
                index
            );

        if (
            direction === 'LONG' &&
            close > open &&
            close > prevHigh &&
            close > level &&
            volume >= CFG.FIVE_MIN_VOLUME_RATIO
        ) {
            return {
                confirmed: true,
                candle: current,
                volumeRatio: volume
            };
        }

        if (
            direction === 'SHORT' &&
            close < open &&
            close < prevLow &&
            close < level &&
            volume >= CFG.FIVE_MIN_VOLUME_RATIO
        ) {
            return {
                confirmed: true,
                candle: current,
                volumeRatio: volume
            };
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

    if (c.length < 24) return 'NEUTRAL';

    const recent = c.slice(-12);
    const previous = c.slice(-24, -12);

    const recentHigh =
        Math.max(...recent.map(x => num(x[2])));

    const previousHigh =
        Math.max(...previous.map(x => num(x[2])));

    const recentLow =
        Math.min(...recent.map(x => num(x[3])));

    const previousLow =
        Math.min(...previous.map(x => num(x[3])));

    const first =
        num(recent[0][4]);

    const last =
        num(
            recent[
                recent.length - 1
            ][4]
        );

    if (
        recentHigh > previousHigh &&
        recentLow > previousLow &&
        last > first
    ) {
        return 'LONG';
    }

    if (
        recentHigh < previousHigh &&
        recentLow < previousLow &&
        last < first
    ) {
        return 'SHORT';
    }

    return 'NEUTRAL';
}

/* =========================================================
   SCORE
========================================================= */

function scoreSetup(data) {
    let score = 30;
    const reasons = [];

    if (
        data.trend ===
        data.direction
    ) {
        score += 15;
        reasons.push('4H yön uyumlu');
    } else if (
        data.trend ===
        'NEUTRAL'
    ) {
        score += 6;
        reasons.push('4H nötr');
    } else {
        score -= 10;
        reasons.push('4H ters');
    }

    if (data.confluence) {
        score += 12;
        reasons.push('4H+2H seviye');
    } else {
        score += 6;
        reasons.push(data.levelTF + ' seviye');
    }

    if (data.touches >= 4) {
        score += 8;
        reasons.push('güçlü seviye');
    } else if (data.touches >= 2) {
        score += 4;
        reasons.push('seviye teyitli');
    }

    if (data.breakoutVolume >= 2) {
        score += 12;
        reasons.push('yüksek breakout hacmi');
    } else if (
        data.breakoutVolume >= 1.05
    ) {
        score += 6;
        reasons.push('breakout hacmi');
    }

    if (data.breakoutBodyAtr >= 0.7) {
        score += 7;
        reasons.push('güçlü breakout');
    }

    if (
        data.structure ===
        data.direction
    ) {
        score += 8;
        reasons.push('15M yapı uyumlu');
    } else if (
        data.structure ===
        'NEUTRAL'
    ) {
        score += 2;
        reasons.push('15M nötr');
    } else {
        score -= 5;
        reasons.push('15M ters');
    }

    if (data.confirm5M) {
        score += 8;
        reasons.push('5M teyit');
    }

    if (data.direction === 'LONG') {
        if (
            data.rsi >= 42 &&
            data.rsi <= 75
        ) {
            score += 3;
            reasons.push('RSI uygun');
        }

        if (data.rsi > 88) {
            score -= 7;
            reasons.push('RSI aşırı yüksek');
        }
    } else {
        if (
            data.rsi >= 25 &&
            data.rsi <= 58
        ) {
            score += 3;
            reasons.push('RSI uygun');
        }

        if (data.rsi < 12) {
            score -= 7;
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

    const stop =
        direction === 'LONG'
            ? entry - risk
            : entry + risk;

    const realRisk =
        Math.abs(
            entry - stop
        );

    const minimumTP =
        direction === 'LONG'
            ? entry +
              realRisk *
              CFG.MIN_RR
            : entry -
              realRisk *
              CFG.MIN_RR;

    let tp1 =
        direction === 'LONG'
            ? entry + realRisk * 1.25
            : entry - realRisk * 1.25;

    let tp2 =
        direction === 'LONG'
            ? entry + realRisk * 2
            : entry - realRisk * 2;

    let tp3 =
        direction === 'LONG'
            ? entry + realRisk * 2.75
            : entry - realRisk * 2.75;

    const valid =
        oppositeLevels
            .filter(
                x =>
                    direction === 'LONG'
                        ? x.price > entry
                        : x.price < entry
            )
            .sort(
                (a, b) =>
                    Math.abs(a.price - entry) -
                    Math.abs(b.price - entry)
            );

    for (const target of valid) {
        if (
            direction === 'LONG' &&
            target.price >= minimumTP &&
            target.price < tp1
        ) {
            tp1 = target.price;
            break;
        }

        if (
            direction === 'SHORT' &&
            target.price <= minimumTP &&
            target.price > tp1
        ) {
            tp1 = target.price;
            break;
        }
    }

    for (const target of valid) {
        if (
            direction === 'LONG' &&
            target.price > tp1 &&
            target.price < tp2
        ) {
            tp2 = target.price;
            break;
        }

        if (
            direction === 'SHORT' &&
            target.price < tp1 &&
            target.price > tp2
        ) {
            tp2 = target.price;
            break;
        }
    }

    for (const target of valid) {
        if (
            direction === 'LONG' &&
            target.price > tp2 &&
            target.price < tp3
        ) {
            tp3 = target.price;
            break;
        }

        if (
            direction === 'SHORT' &&
            target.price < tp2 &&
            target.price > tp3
        ) {
            tp3 = target.price;
            break;
        }
    }

    const rr =
        Math.abs(tp1 - entry) /
        realRisk;

    if (rr < CFG.MIN_RR) {
        return null;
    }

    if (
        direction === 'LONG' &&
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

    if (
        direction === 'SHORT' &&
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

    return {
        entryLow:
            formatPrice(
                entry - zone
            ),

        entryHigh:
            formatPrice(
                entry + zone
            ),

        entry:
            formatPrice(
                entry
            ),

        stop:
            formatPrice(
                stop
            ),

        tp1:
            formatPrice(
                tp1
            ),

        tp2:
            formatPrice(
                tp2
            ),

        tp3:
            formatPrice(
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
   ANALYZE
========================================================= */

async function analyzePending(
    coin,
    pending,
    h4,
    h2,
    m15,
    m5
) {
    if (
        Date.now() -
        pending.breakoutTime >
        CFG.RETEST_WINDOW_MINUTES *
        60 *
        1000
    ) {
        pending.status = 'EXPIRED';
        return null;
    }

    const retest =
        detectRetest(
            m15,
            pending
        );

    if (
        retest.status === 'INVALIDATED' ||
        retest.status === 'EXPIRED'
    ) {
        pending.status =
            retest.status;

        return null;
    }

    if (
        retest.status !== 'RETESTED'
    ) {
        pending.status =
            retest.status;

        return null;
    }

    const trend =
        trend4H(h4);

    const confirmation =
        confirm5M(
            m5,
            retest,
            pending.direction,
            pending.level.price
        );

    const structure =
        structure15M(m15);

    if (
        CFG.REQUIRE_5M &&
        !confirmation.confirmed
    ) {
        pending.status =
            'WAITING_5M';

        return null;
    }

    if (
        structure !== 'NEUTRAL' &&
        structure !== pending.direction &&
        trend.direction !== pending.direction
    ) {
        pending.status =
            'WEAK_STRUCTURE';

        return null;
    }

    const current =
        num(coin.last);

    if (!current) return null;

    if (
        distancePct(
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
        pending.direction === 'LONG'
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
                distancePct(
                    x.price,
                    pending.level.price
                ) <= 0.45
        );

    const near2 =
        levels2.some(
            x =>
                x.type ===
                    pending.level.type &&
                distancePct(
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
        rsi(m15);

    const scored =
        scoreSetup({
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
        formatPrice(
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
            formatPrice(
                pending.level.price
            ),

        levelType:
            pending.direction === 'LONG'
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
            num(
                retest.candle[0]
            ),

        fiveMinConfirmed:
            confirmation.confirmed,

        breakoutVolumeRatio:
            Number(
                pending.breakoutVolumeRatio.toFixed(2)
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
            formatPrice(
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

                const levels = [
                    ...getLevels(h4),
                    ...getLevels(h2)
                ];

                const nearby =
                    levels
                        .map(
                            level => ({
                                ...level,
                                distance:
                                    distancePct(
                                        price,
                                        level.price
                                    )
                            })
                        )
                        .filter(
                            x =>
                                x.distance <= 1.5
                        )
                        .sort(
                            (a, b) =>
                                a.distance -
                                b.distance
                        );

                let deepScore =
                    coin.radarScore;

                if (nearby.length) {
                    deepScore += 10;
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
   MARKET STATUS
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

        if (change > 0.20) green++;
        if (change < -0.20) red++;
    }

    const counted =
        green + red;

    const breadth =
        counted
            ? green / counted * 100
            : 50;

    const average =
        total /
        rows.length;

    let direction =
        'NEUTRAL';

    let label =
        'KARIŞIK';

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

        if (
            ticker &&
            ticker.last
        ) {
            const price =
                ticker.last;

            signal.livePrice =
                formatPrice(
                    price
                );

            const entryLow =
                num(
                    signal.entryLow
                );

            const entryHigh =
                num(
                    signal.entryHigh
                );

            const stop =
                num(
                    signal.stop
                );

            const tp1 =
                num(
                    signal.tp1
                );

            const tp2 =
                num(
                    signal.tp2
                );

            const tp3 =
                num(
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
            now -
            signal.signalAt >
            CFG.SIGNAL_TTL_MS ||
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
                        ...getLevels(h4),

                        ...getLevels(h2)
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
                    ...STATE
                        .signals
                        .values()
                ]
                .some(
                    existing =>
                        existing.symbol ===
                            signal.symbol &&
                        existing.direction ===
                            signal.direction
                );

            if (duplicate) {
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

function publicSignal(signal) {
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
        success: true,

        engine:
            'Sonny AI Trader V5.2',

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
                        formatPrice(
                            p.level.price
                        ),

                    breakoutTime:
                        p.breakoutTime,

                    breakoutVolume:
                        Number(
                            p.breakoutVolumeRatio.toFixed(2)
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

app.get(
    '/health',
    (req, res) => {
        res.json({
            ok:
                true,

            service:
                'Sonny AI Trader V5.2',

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
   CHART API
========================================================= */

app.get(
    '/api/chart',
    async (req, res) => {
        try {
            const symbol =
                resolveMarket(
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

            if (!candles.length) {
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
                    x =>
                        x.ccxt_symbol ===
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
                    num(
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
                                num(
                                    candle[0]
                                ),

                            open:
                                num(
                                    candle[1]
                                ),

                            high:
                                num(
                                    candle[2]
                                ),

                            low:
                                num(
                                    candle[3]
                                ),

                            close:
                                num(
                                    candle[4]
                                ),

                            volume:
                                num(
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
   GÖMÜLÜ ANA SAYFA
========================================================= */

const HTML = String.raw`<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SONNY AI TRADER V5.2</title>

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
    color:#edf2f7;
    font-family:Arial,Helvetica,sans-serif;
}

button{
    font-family:inherit;
}

.app{
    width:100%;
    height:100vh;
    display:grid;
    grid-template-columns:280px 1fr;
}

.sidebar{
    background:#0b0f16;
    border-right:1px solid #202936;
    padding:14px;
    overflow:auto;
}

.logo{
    font-size:18px;
    font-weight:900;
}

.logo small{
    display:block;
    color:#6f7d91;
    font-size:9px;
    margin-top:5px;
}

.signal-list{
    margin-top:15px;
    display:grid;
    gap:8px;
}

.signal-card{
    background:#101720;
    border:1px solid #202b39;
    border-radius:12px;
    padding:11px;
    cursor:pointer;
}

.signal-card:hover{
    border-color:#4776ff;
}

.signal-card.active{
    border-color:#4776ff;
    box-shadow:0 0 0 1px #4776ff;
}

.signal-card.long{
    border-left:4px solid #20d996;
}

.signal-card.short{
    border-left:4px solid #ff5366;
}

.card-top{
    display:flex;
    justify-content:space-between;
    gap:8px;
}

.coin{
    font-weight:900;
}

.badge{
    font-size:9px;
    font-weight:900;
    padding:4px 6px;
    border-radius:5px;
}

.badge-long{
    color:#20d996;
    background:#103428;
}

.badge-short{
    color:#ff5366;
    background:#35141b;
}

.card-price{
    font-size:17px;
    font-weight:900;
    margin-top:7px;
}

.card-meta{
    color:#748196;
    font-size:9px;
    margin-top:5px;
}

.card-good{
    color:#20d996;
    font-size:9px;
    margin-top:6px;
}

.refresh{
    width:100%;
    border:0;
    background:#182640;
    color:#fff;
    border-radius:8px;
    padding:9px;
    margin-top:12px;
    cursor:pointer;
}

.main{
    min-width:0;
    height:100vh;
    display:flex;
    flex-direction:column;
}

.header{
    min-height:62px;
    padding:11px 16px;
    border-bottom:1px solid #202936;
    display:flex;
    justify-content:space-between;
    gap:15px;
}

.header-title{
    font-size:17px;
    font-weight:900;
}

.header-sub{
    color:#718096;
    font-size:9px;
    margin-top:5px;
}

.stats{
    display:flex;
    align-items:center;
    justify-content:flex-end;
    flex-wrap:wrap;
    gap:10px;
    color:#718096;
    font-size:9px;
}

.stats b{
    color:#fff;
}

.content{
    flex:1;
    min-height:0;
    display:grid;
    grid-template-columns:minmax(0,1fr) 285px;
}

.chart-area{
    min-width:0;
    min-height:0;
    position:relative;
    background:#070a0f;
}

.chart-header{
    height:43px;
    border-bottom:1px solid #17202c;
    display:flex;
    align-items:center;
    justify-content:space-between;
    padding:8px 12px;
}

.chart-title{
    font-size:12px;
    font-weight:900;
}

.timeframes{
    display:flex;
    gap:4px;
}

.timeframes button{
    border:1px solid #273448;
    background:#0d141e;
    color:#758397;
    border-radius:5px;
    padding:5px 7px;
    font-size:9px;
    cursor:pointer;
}

.timeframes button.active{
    background:#182746;
    color:#fff;
    border-color:#4776ff;
}

#chart{
    display:block;
    width:100%;
    height:calc(100% - 43px);
}

.right{
    min-width:0;
    background:#0b0f16;
    border-left:1px solid #202936;
    padding:10px;
    overflow:auto;
}

.panel{
    background:#101720;
    border:1px solid #202b39;
    border-radius:11px;
    padding:11px;
    margin-bottom:9px;
}

.panel-title{
    color:#718096;
    font-size:9px;
    font-weight:900;
    margin-bottom:8px;
}

.market-value{
    font-size:19px;
    font-weight:900;
}

.market-long{
    color:#20d996;
}

.market-short{
    color:#ff5366;
}

.market-neutral{
    color:#e2b95e;
}

.reason{
    color:#6e7d90;
    font-size:9px;
    margin-top:5px;
    line-height:1.4;
}

.row{
    display:flex;
    justify-content:space-between;
    gap:8px;
    margin-top:7px;
    font-size:9px;
}

.row span{
    color:#718096;
}

.detail-grid{
    display:grid;
    grid-template-columns:1fr 1fr;
    gap:6px;
}

.detail{
    background:#0a1017;
    border-radius:7px;
    padding:7px;
}

.detail span{
    display:block;
    color:#68778a;
    font-size:8px;
}

.detail b{
    display:block;
    margin-top:3px;
    font-size:11px;
}

.green{
    color:#20d996;
}

.red{
    color:#ff5366;
}

.blue{
    color:#55a6ff;
}

.empty{
    color:#69778a;
    font-size:10px;
    line-height:1.5;
}

.pending-item{
    border-left:3px solid #e2b95e;
    background:#0b1118;
    padding:7px;
    margin-top:5px;
    border-radius:5px;
    font-size:9px;
}

@media(max-width:900px){

    .app{
        display:block;
    }

    .sidebar{
        display:none;
    }

    .main{
        height:100vh;
    }

    .header{
        min-height:65px;
        padding:9px 11px;
        display:block;
    }

    .header-title{
        font-size:14px;
    }

    .header-sub{
        font-size:8px;
    }

    .stats{
        margin-top:6px;
        justify-content:flex-start;
        gap:7px;
    }

    .content{
        display:block;
        height:calc(100vh - 65px);
    }

    .chart-area{
        height:58%;
        min-height:280px;
    }

    .right{
        height:42%;
        border-left:0;
        border-top:1px solid #202936;
    }

    .panel{
        padding:9px;
        margin-bottom:6px;
    }
}

@media(max-width:520px){

    .chart-area{
        height:55%;
        min-height:260px;
    }

    .right{
        height:45%;
    }

    .chart-header{
        height:40px;
        padding:7px 8px;
    }

    #chart{
        height:calc(100% - 40px);
    }

    .timeframes button{
        padding:4px 6px;
        font-size:8px;
    }

    .market-value{
        font-size:16px;
    }
}
</style>
</head>

<body>

<div class="app">

<aside class="sidebar">

<div class="logo">
⚡ SONNY AI TRADER
<small>V5.2 • BITGET FUTURES SCALP ENGINE</small>
</div>

<div id="signalList" class="signal-list">
<div class="empty">
Sinyaller bekleniyor...
</div>
</div>

<button class="refresh" onclick="manualScan()">
RADARI YENİLE
</button>

</aside>

<main class="main">

<header class="header">

<div>
<div class="header-title">
SONNY AI TRADER V5.2
</div>

<div class="header-sub">
500 COIN → 150 ADAY → 40 DEEP → 4H + 2H → 15M BREAKOUT → RETEST → 5M SCALP
</div>
</div>

<div class="stats">
<span>RADAR <b id="radar">0</b></span>
<span>ADAY <b id="candidate">0</b></span>
<span>DEEP <b id="deep">0</b></span>
<span>ANALİZ <b id="analyzed">0</b></span>
<span>PENDING <b id="pending">0</b></span>
<span>SİNYAL <b id="signals">0</b></span>
</div>

</header>

<section class="content">

<div class="chart-area">

<div class="chart-header">

<div id="chartTitle" class="chart-title">
GRAFİK
</div>

<div class="timeframes">

<button data-tf="5m" onclick="setTF('5m')">
5M
</button>

<button data-tf="15m" class="active" onclick="setTF('15m')">
15M
</button>

<button data-tf="1h" onclick="setTF('1h')">
1H
</button>

<button data-tf="2h" onclick="setTF('2h')">
2H
</button>

<button data-tf="4h" onclick="setTF('4h')">
4H
</button>

</div>

</div>

<canvas id="chart"></canvas>

</div>

<aside class="right">

<div class="panel">

<div class="panel-title">
GENEL PİYASA
</div>

<div id="market" class="market-value market-neutral">
VERİ BEKLENİYOR
</div>

<div id="marketReason" class="reason">
Veri bekleniyor...
</div>

<div class="row">
<span>BREADTH</span>
<b id="breadth">50%</b>
</div>

<div class="row">
<span>ORTALAMA</span>
<b id="average">0%</b>
</div>

</div>

<div id="detail" class="panel">

<div class="panel-title">
AKTİF SİNYAL
</div>

<div class="empty">
Sinyal seçin.
</div>

</div>

<div class="panel">

<div class="panel-title">
BEKLEYEN BREAKOUT
</div>

<div id="pendingList" class="empty">
Breakout bekleniyor...
</div>

</div>

</aside>

</section>

</main>

</div>

<script>

let state = {
    signals: [],
    pending: [],
    market: {},
    stats: {}
};

let selected = null;
let timeframe = '15m';
let chartSymbol = null;
let socket = null;

function $(id){
    return document.getElementById(id);
}

function esc(value){
    return String(
        value == null ? '' : value
    )
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

function connect(){

    const protocol =
        location.protocol === 'https:'
            ? 'wss:'
            : 'ws:';

    socket =
        new WebSocket(
            protocol +
            '//' +
            location.host
        );

    socket.onmessage =
        event => {

            try{
                applyState(
                    JSON.parse(
                        event.data
                    )
                );
            }catch(error){
                console.error(
                    error
                );
            }
        };

    socket.onclose =
        () => {
            setTimeout(
                connect,
                3000
            );
        };
}

function applyState(data){

    state = data || state;

    state.stats =
        state.stats || {};

    state.signals =
        state.signals || [];

    state.pending =
        state.pending || [];

    state.market =
        state.market || {};

    $('radar').textContent =
        state.stats.universe || 0;

    $('candidate').textContent =
        state.stats.candidates || 0;

    $('deep').textContent =
        state.stats.deepWatch || 0;

    $('analyzed').textContent =
        state.stats.analyzed || 0;

    $('pending').textContent =
        state.stats.pending ||
        state.pending.length ||
        0;

    $('signals').textContent =
        state.stats.activeSignalsCount ||
        state.signals.length ||
        0;

    renderMarket();
    renderSignals();
    renderPending();

    if(
        selected
    ){

        const fresh =
            state.signals.find(
                x =>
                    x.id ===
                    selected.id
            );

        if(
            fresh
        ){
            selected =
                fresh;

            renderDetail();
        }
    }

    if(
        !selected &&
        state.signals.length
    ){
        selected =
            state.signals[0];

        chartSymbol =
            selected.symbol;

        renderDetail();
        loadChart();
    }
}

function renderMarket(){

    const market =
        state.market || {};

    const label =
        market.label ||
        'VERİ BEKLENİYOR';

    $('market').textContent =
        label;

    $('marketReason').textContent =
        market.reason ||
        '';

    $('breadth').textContent =
        (
            market.breadth == null
                ? 50
                : market.breadth
        ) +
        '%';

    $('average').textContent =
        (
            market.average == null
                ? 0
                : market.average
        ) +
        '%';

    $('market').className =
        'market-value ' +
        (
            market.direction === 'LONG'
                ? 'market-long'
                : market.direction === 'SHORT'
                    ? 'market-short'
                    : 'market-neutral'
        );
}

function renderSignals(){

    const container =
        $('signalList');

    if(
        !state.signals.length
    ){
        container.innerHTML =
            '<div class="empty">' +
            'Aktif scalp sinyali yok.<br>' +
            'Breakout + retest bekleniyor.' +
            '</div>';

        return;
    }

    container.innerHTML = '';

    state.signals.forEach(
        signal => {

            const card =
                document.createElement(
                    'div'
                );

            const directionClass =
                signal.direction === 'LONG'
                    ? 'long'
                    : 'short';

            const badgeClass =
                signal.direction === 'LONG'
                    ? 'badge-long'
                    : 'badge-short';

            card.className =
                'signal-card ' +
                directionClass +
                (
                    selected &&
                    selected.id === signal.id
                        ? ' active'
                        : ''
                );

            card.onclick =
                () => {

                    selected =
                        signal;

                    chartSymbol =
                        signal.symbol;

                    renderSignals();
                    renderDetail();
                    loadChart();
                };

            card.innerHTML =

                '<div class="card-top">' +

                '<div class="coin">' +
                esc(signal.coin) +
                '</div>' +

                '<div class="badge ' +
                badgeClass +
                '">' +
                esc(signal.direction) +
                ' • ' +
                esc(signal.score) +
                '</div>' +

                '</div>' +

                '<div class="card-price">' +
                esc(
                    signal.livePrice ||
                    signal.entry
                ) +
                '</div>' +

                '<div class="card-meta">' +
                esc(
                    signal.status ||
                    'GİRİŞ BEKLENİYOR'
                ) +
                '</div>' +

                '<div class="card-meta">' +
                'Giriş ' +
                esc(signal.entryLow) +
                ' - ' +
                esc(signal.entryHigh) +
                '</div>' +

                '<div class="card-good">' +
                'TP1 ' +
                esc(signal.tp1) +
                ' • TP2 ' +
                esc(signal.tp2) +
                '</div>' +

                '<div class="card-meta">' +
                'STOP ' +
                esc(signal.stop) +
                ' • R:R ' +
                esc(signal.riskReward) +
                '</div>';

            container.appendChild(
                card
            );
        }
    );
}

function renderDetail(){

    const box =
        $('detail');

    if(
        !selected
    ){
        box.innerHTML =
            '<div class="panel-title">' +
            'AKTİF SİNYAL' +
            '</div>' +
            '<div class="empty">' +
            'Sinyal seçin.' +
            '</div>';

        return;
    }

    const directionClass =
        selected.direction === 'LONG'
            ? 'green'
            : 'red';

    box.innerHTML =

        '<div class="panel-title">' +
        'AKTİF SCALP SİNYALİ' +
        '</div>' +

        '<div style="font-size:14px;font-weight:900">' +
        esc(selected.coin) +
        ' <span class="' +
        directionClass +
        '">' +
        esc(selected.direction) +
        '</span>' +
        '</div>' +

        '<div class="reason">' +
        esc(selected.status) +
        '</div>' +

        '<div class="detail-grid" style="margin-top:9px">' +

        '<div class="detail">' +
        '<span>GİRİŞ</span>' +
        '<b class="green">' +
        esc(selected.entry) +
        '</b>' +
        '</div>' +

        '<div class="detail">' +
        '<span>SKOR</span>' +
        '<b>' +
        esc(selected.score) +
        '/100</b>' +
        '</div>' +

        '<div class="detail">' +
        '<span>STOP</span>' +
        '<b class="red">' +
        esc(selected.stop) +
        '</b>' +
        '</div>' +

        '<div class="detail">' +
        '<span>TP1</span>' +
        '<b class="green">' +
        esc(selected.tp1) +
        '</b>' +
        '</div>' +

        '<div class="detail">' +
        '<span>TP2</span>' +
        '<b class="green">' +
        esc(selected.tp2) +
        '</b>' +
        '</div>' +

        '<div class="detail">' +
        '<span>TP3</span>' +
        '<b class="green">' +
        esc(selected.tp3) +
        '</b>' +
        '</div>' +

        '<div class="detail">' +
        '<span>R:R</span>' +
        '<b>' +
        esc(selected.riskReward) +
        '</b>' +
        '</div>' +

        '<div class="detail">' +
        '<span>RSI</span>' +
        '<b>' +
        esc(selected.rsi) +
        '</b>' +
        '</div>' +

        '</div>' +

        '<div class="reason" style="margin-top:9px">' +
        esc(
            selected.reason ||
            ''
        ) +
        '</div>';
}

function renderPending(){

    const box =
        $('pendingList');

    if(
        !state.pending.length
    ){
        box.textContent =
            'Bekleyen breakout yok.';

        return;
    }

    box.innerHTML =
        state.pending
            .slice(0,20)
            .map(
                item =>
                    '<div class="pending-item">' +
                    '<b>' +
                    esc(item.symbol) +
                    '</b> ' +
                    esc(item.direction) +
                    '<br>' +
                    '<span style="color:#69778a">' +
                    'Level ' +
                    esc(item.level) +
                    ' • VOL ' +
                    esc(item.breakoutVolume) +
                    'x • ' +
                    esc(item.status) +
                    '</span>' +
                    '</div>'
            )
            .join('');
}

function manualScan(){

    fetch(
        '/api/scan'
    ).catch(
        console.error
    );
}

function setTF(tf){

    timeframe =
        tf;

    document
        .querySelectorAll(
            '[data-tf]'
        )
        .forEach(
            button => {

                button.classList.toggle(
                    'active',
                    button.getAttribute(
                        'data-tf'
                    ) === tf
                );
            }
        );

    loadChart();
}

async function loadChart(){

    const symbol =
        chartSymbol ||
        (
            selected &&
            selected.symbol
        );

    if(
        !symbol
    ){
        return;
    }

    try{

        const response =
            await fetch(
                '/api/chart?symbol=' +
                encodeURIComponent(symbol) +
                '&timeframe=' +
                encodeURIComponent(timeframe)
            );

        const data =
            await response.json();

        if(
            !data.success
        ){
            return;
        }

        $('chartTitle').textContent =
            data.symbol +
            ' • ' +
            timeframe.toUpperCase();

        drawChart(
            data.candles,
            data.signal
        );

    }catch(error){

        console.error(
            'CHART',
            error
        );
    }
}

function drawChart(
    candles,
    signal
){

    const canvas =
        $('chart');

    const rect =
        canvas.getBoundingClientRect();

    const dpr =
        window.devicePixelRatio ||
        1;

    canvas.width =
        Math.max(
            1,
            Math.floor(
                rect.width *
                dpr
            )
        );

    canvas.height =
        Math.max(
            1,
            Math.floor(
                rect.height *
                dpr
            )
        );

    const ctx =
        canvas.getContext(
            '2d'
        );

    ctx.scale(
        dpr,
        dpr
    );

    const width =
        rect.width;

    const height =
        rect.height;

    ctx.fillStyle =
        '#070a0f';

    ctx.fillRect(
        0,
        0,
        width,
        height
    );

    if(
        !candles ||
        candles.length < 2
    ){
        return;
    }

    const view =
        candles.slice(
            -100
        );

    let min =
        Math.min(
            ...view.map(
                x => x.low
            )
        );

    let max =
        Math.max(
            ...view.map(
                x => x.high
            )
        );

    const padding =
        (max - min) *
        0.08;

    min -= padding;
    max += padding;

    const left = 10;
    const right = 70;
    const top = 15;
    const bottom = 25;

    const candleWidth =
        (
            width -
            left -
            right
        ) /
        view.length;

    function y(value){

        return (
            top +
            (
                max -
                value
            ) /
            (
                max -
                min
            ) *
            (
                height -
                top -
                bottom
            )
        );
    }

    ctx.strokeStyle =
        '#17202c';

    ctx.lineWidth = 1;

    for(
        let i = 0;
        i < 5;
        i++
    ){

        const gy =
            top +
            i *
            (
                height -
                top -
                bottom
            ) /
            4;

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

        const price =
            max -
            i *
            (
                max -
                min
            ) /
            4;

        ctx.fillStyle =
            '#617084';

        ctx.font =
            '10px Arial';

        ctx.fillText(
            price.toFixed(
                price < 1
                    ? 5
                    : 2
            ),
            width -
            right +
            5,
            gy + 3
        );
    }

    view.forEach(
        (candle, index) => {

            const x =
                left +
                index *
                candleWidth +
                candleWidth /
                2;

            const openY =
                y(candle.open);

            const closeY =
                y(candle.close);

            const highY =
                y(candle.high);

            const lowY =
                y(candle.low);

            const up =
                candle.close >=
                candle.open;

            const lineColor =
                up
                    ? '#20d996'
                    : '#ff5366';

            ctx.strokeStyle =
                lineColor;

            ctx.fillStyle =
                lineColor;

            ctx.beginPath();

            ctx.moveTo(
                x,
                highY
            );

            ctx.lineTo(
                x,
                lowY
            );

            ctx.stroke();

            const body =
                Math.max(
                    1,
                    Math.abs(
                        closeY -
                        openY
                    )
                );

            ctx.fillRect(
                x -
                candleWidth *
                0.32,
                Math.min(
                    openY,
                    closeY
                ),
                candleWidth *
                0.64,
                body
            );
        }
    );

    if(
        signal
    ){

        const lines = [
            {
                value:
                    Number(
                        signal.entry
                    ),
                label:
                    'GİRİŞ',
                color:
                    '#55a6ff'
            },
            {
                value:
                    Number(
                        signal.stop
                    ),
                label:
                    'STOP',
                color:
                    '#ff5366'
            },
            {
                value:
                    Number(
                        signal.tp1
                    ),
                label:
                    'TP1',
                color:
                    '#20d996'
            },
            {
                value:
                    Number(
                        signal.tp2
                    ),
                label:
                    'TP2',
                color:
                    '#20d996'
            },
            {
                value:
                    Number(
                        signal.tp3
                    ),
                label:
                    'TP3',
                color:
                    '#20d996'
            }
        ];

        lines.forEach(
            line => {

                if(
                    !Number.isFinite(
                        line.value
                    )
                ){
                    return;
                }

                const ly =
                    y(
                        line.value
                    );

                ctx.strokeStyle =
                    line.color;

                ctx.setLineDash(
                    [6,5]
                );

                ctx.beginPath();

                ctx.moveTo(
                    left,
                    ly
                );

                ctx.lineTo(
                    width -
                    right,
                    ly
                );

                ctx.stroke();

                ctx.setLineDash([]);

                ctx.fillStyle =
                    line.color;

                ctx.font =
                    '10px Arial';

                ctx.fillText(
                    line.label +
                    ' ' +
                    line.value,
                    width -
                    right +
                    4,
                    ly - 3
                );
            }
        );
    }
}

window.addEventListener(
    'resize',
    () => {

        if(
            selected ||
            chartSymbol
        ){
            loadChart();
        }
    }
);

connect();

fetch(
    '/api/status'
)
.then(
    response =>
        response.json()
)
.then(
    applyState
)
.catch(
    console.error
);

setInterval(
    () => {

        fetch(
            '/api/status'
        )
        .then(
            response =>
                response.json()
        )
        .then(
            applyState
        )
        .catch(
            () => {}
        );

    },
    15000
);

</script>

</body>
</html>`;

/* =========================================================
   ROOT
========================================================= */

app.get(
    '/',
    (req, res) => {

        res
            .status(200)
            .set(
                'Content-Type',
                'text/html; charset=utf-8'
            )
            .send(
                HTML
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

        console.log('');
        console.log(
            '=============================================='
        );

        console.log(
            '🚀 SONNY AI TRADER V5.2'
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
            '=============================================='
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
            () => {

                runScan()
                    .catch(
                        error => {

                            STATE.lastError =
                                error.message;

                            console.error(
                                'SCAN:',
                                error.message
                            );
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
                                'LIVE:',
                                error.message
                            );
                        }
                    );

            },
            CFG.LIVE_MS
        );

        setInterval(
            () => {

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
            'UNHANDLED REJECTION:',
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
            'UNCAUGHT EXCEPTION:',
            error
        );

        STATE.lastError =
            error &&
            error.message
                ? error.message
                : String(error);
    }
);
