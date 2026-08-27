// ================================================================
// SONNY AI TRADER — SCALP ENGINE V5
// 500 COIN RADAR -> 150 CANDIDATE -> 40 WATCH -> 3M BREAKOUT
// -> 3M RETEST -> 1M CONFIRM BONUS -> SCALP SIGNAL
//
// STRATEJİ:
// 1H trend context
// 15M structure / liquidity zone
// 3M breakout
// 3M retest
// 1M confirmation (BONUS, ZORUNLU DEĞİL)
//
// LONG:
// Resistance yukarı kırılır -> retest -> LONG
//
// SHORT:
// Support aşağı kırılır -> retest -> SHORT
//
// OTOMATİK EMİR: KAPALI
// ================================================================

require('dotenv').config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const path = require('path');

const {
    EMA,
    RSI,
    ATR,
    ADX,
    SMA
} = require('technicalindicators');

// ================================================================
// BOOT
// ================================================================

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 10000;

// ================================================================
// CONFIG
// ================================================================

const CFG = {

    // ------------------------------------------------------------
    // RADAR
    // ------------------------------------------------------------

    MAX_UNIVERSE: 500,
    CANDIDATE_COUNT: 150,
    WATCHLIST_COUNT: 40,
    MAX_SIGNALS: 15,

    SCAN_INTERVAL_MS: 60 * 1000,

    // İlk 500 için minimum güvenlik filtresi.
    // Aşırı sert tutulmadı.
    MIN_24H_VOLUME_USD: 2_000_000,

    // Çok düşük fiyatlı / anlamsız marketleri ele.
    MIN_PRICE: 0.00001,

    // ------------------------------------------------------------
    // TIMEFRAMES
    // ------------------------------------------------------------

    TF_CONTEXT: '1h',
    TF_STRUCTURE: '15m',
    TF_BREAKOUT: '3m',
    TF_ENTRY: '1m',

    // ------------------------------------------------------------
    // RADAR SCORE
    // ------------------------------------------------------------

    RADAR_VOLUME_WEIGHT: 25,
    RADAR_MOMENTUM_WEIGHT: 25,
    RADAR_VOLATILITY_WEIGHT: 20,
    RADAR_LIQUIDITY_WEIGHT: 20,
    RADAR_ACTIVITY_WEIGHT: 10,

    // ------------------------------------------------------------
    // 15M STRUCTURE
    // ------------------------------------------------------------

    STRUCTURE_LOOKBACK: 40,
    PIVOT_LEFT: 2,
    PIVOT_RIGHT: 2,

    // Level yakınlığı.
    // %2.5 gibi aşırı geniş değil.
    LEVEL_NEAR_PERCENT: 0.90,

    // ------------------------------------------------------------
    // 3M BREAKOUT
    // ------------------------------------------------------------

    BREAKOUT_LOOKBACK: 20,

    // Breakout kapanışı levelden minimum bu kadar uzak.
    BREAKOUT_BUFFER_PERCENT: 0.08,

    // 3M breakout volume.
    // 1.15 fazla sert değil.
    BREAKOUT_VOLUME_RATIO: 1.15,

    // ------------------------------------------------------------
    // RETEST
    // ------------------------------------------------------------

    RETEST_WINDOW_MINUTES: 15,

    RETEST_TOLERANCE_PERCENT: 0.18,

    // Retest sırasında levelin arkasına bu kadar fazla geçerse
    // setup bozulmuş sayılır.
    RETEST_INVALIDATION_PERCENT: 0.30,

    // ------------------------------------------------------------
    // 1M CONFIRMATION
    // ------------------------------------------------------------

    ENTRY_VOLUME_RATIO: 1.15,

    ENTRY_MOMENTUM_PERCENT: 0.05,

    // 1M teyit zorunlu değil.
    REQUIRE_1M_CONFIRMATION: false,

    // ------------------------------------------------------------
    // SCALP TP / SL
    // ------------------------------------------------------------

    MIN_STOP_PERCENT: 0.18,
    MAX_STOP_PERCENT: 0.75,

    TARGET_TP1_PERCENT: 0.85,
    TARGET_TP2_PERCENT: 1.45,
    TARGET_TP3_PERCENT: 2.20,

    MIN_RR_TP1: 1.25,
    GOOD_RR_TP1: 1.50,

    // ------------------------------------------------------------
    // SIGNAL
    // ------------------------------------------------------------

    MIN_SIGNAL_SCORE: 68,
    GOOD_SIGNAL_SCORE: 78,
    ELITE_SIGNAL_SCORE: 88,

    SIGNAL_TTL_MINUTES: 30,

    // Aynı coin + yön için cooldown.
    COOLDOWN_MINUTES: 20,

    // ------------------------------------------------------------
    // API
    // ------------------------------------------------------------

    REQUEST_CONCURRENCY: 8,

    // Cache kısa tutuluyor.
    CACHE_MS_1H: 90_000,
    CACHE_MS_15M: 30_000,
    CACHE_MS_3M: 15_000,
    CACHE_MS_1M: 5_000,

    // ------------------------------------------------------------
    // MARKET
    // ------------------------------------------------------------

    MARKET_BREADTH_BULL: 62,
    MARKET_BREADTH_BEAR: 38,

    MARKET_STRONG_MOVE: 0.80,

    // ------------------------------------------------------------
    // AUTO TRADE
    // ------------------------------------------------------------

    AUTO_TRADE: false
};

// ================================================================
// STATE
// ================================================================

const STATE = {

    universe: [],

    candidates: [],

    watchlist: [],

    pendingBreakouts: new Map(),

    signals: new Map(),

    cooldowns: new Map(),

    ohlcvCache: new Map(),

    tickerCache: new Map(),

    lastScan: 0,

    scanning: false,

    stats: {
        universe: 0,
        candidates: 0,
        watchlist: 0,
        pending: 0,
        signals: 0,
        analyzed: 0,
        seconds: 0
    },

    market: {
        label: 'ANALİZ EDİLİYOR',
        direction: 'NEUTRAL',
        breadthPct: 50,
        avgMove24h: 0,
        btcTrend: 'NEUTRAL',
        ethTrend: 'NEUTRAL',
        reason: ''
    },

    lastError: null
};

// ================================================================
// EXCHANGE
// ================================================================

const exchange = new ccxt.bitget({
    apiKey: process.env.BITGET_API_KEY || '',
    secret: process.env.BITGET_SECRET || '',
    password: process.env.BITGET_PASSPHRASE || '',
    enableRateLimit: true,
    timeout: 20_000,
    options: {
        defaultType: 'swap'
    }
});

// ================================================================
// REQUEST QUEUE
// ================================================================

const requestQueue = {

    queue: [],

    running: 0,

    concurrency: CFG.REQUEST_CONCURRENCY,

    push(fn, priority = 0) {

        return new Promise((resolve, reject) => {

            this.queue.push({
                fn,
                resolve,
                reject,
                priority
            });

            this.queue.sort(
                (a, b) => b.priority - a.priority
            );

            this.next();
        });
    },

    next() {

        while (
            this.running < this.concurrency &&
            this.queue.length
        ) {

            const job = this.queue.shift();

            this.running++;

            Promise.resolve()
                .then(job.fn)
                .then(job.resolve)
                .catch(job.reject)
                .finally(() => {

                    this.running--;

                    this.next();

                });
        }
    }
};

// ================================================================
// HELPERS
// ================================================================

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanSymbol(symbol) {

    if (!symbol) return '';

    return String(symbol)
        .replace(':USDT', '')
        .replace('/USDT', '')
        .replace('/USDT:USDT', '')
        .replace('USDT', '')
        .toUpperCase();
}

function publicSymbol(symbol) {
    return cleanSymbol(symbol) + 'USDT';
}

function pct(a, b) {

    if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) {
        return 0;
    }

    return ((a - b) / b) * 100;
}

function absPct(a, b) {
    return Math.abs(pct(a, b));
}

function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}

function avg(arr) {

    const valid = arr
        .map(Number)
        .filter(Number.isFinite);

    if (!valid.length) return 0;

    return valid.reduce((a, b) => a + b, 0) / valid.length;
}

function lastClosed(candles) {

    if (!Array.isArray(candles) || candles.length < 3) {
        return null;
    }

    // Son mum henüz açık olabilir.
    return candles[candles.length - 2];
}

function previousClosed(candles) {

    if (!Array.isArray(candles) || candles.length < 4) {
        return null;
    }

    return candles[candles.length - 3];
}

function candleVolumeRatio(candles, index, period = 20) {

    if (!candles || index < period) return 1;

    const start = Math.max(0, index - period);

    const volumes = candles
        .slice(start, index)
        .map(c => Number(c[5]))
        .filter(Number.isFinite);

    if (!volumes.length) return 1;

    const average = avg(volumes);

    if (!average) return 1;

    return Number(candles[index][5]) / average;
}

function bodyPercent(candle) {

    if (!candle) return 0;

    const open = Number(candle[1]);
    const close = Number(candle[4]);

    if (!open) return 0;

    return Math.abs(close - open) / open * 100;
}

function isBullish(candle) {
    return candle && Number(candle[4]) > Number(candle[1]);
}

function isBearish(candle) {
    return candle && Number(candle[4]) < Number(candle[1]);
}

// ================================================================
// MARKET PRECISION
// ================================================================

function roundPrice(symbol, price) {

    try {

        const market = exchange.markets?.[symbol];

        if (
            market &&
            market.precision &&
            Number.isInteger(market.precision.price)
        ) {

            return Number(
                Number(price).toFixed(
                    market.precision.price
                )
            );
        }

    } catch (_) {}

    if (price < 0.001) return Number(price.toFixed(8));
    if (price < 0.01) return Number(price.toFixed(7));
    if (price < 1) return Number(price.toFixed(6));
    if (price < 10) return Number(price.toFixed(4));

    return Number(price.toFixed(2));
}

// ================================================================
// CACHE
// ================================================================

function cacheTTL(timeframe) {

    if (timeframe === '1h') return CFG.CACHE_MS_1H;
    if (timeframe === '15m') return CFG.CACHE_MS_15M;
    if (timeframe === '3m') return CFG.CACHE_MS_3M;
    if (timeframe === '1m') return CFG.CACHE_MS_1M;

    return 10_000;
}

async function fetchOHLCV(symbol, timeframe, limit = 100) {

    const key = `${symbol}:${timeframe}:${limit}`;

    const cached = STATE.ohlcvCache.get(key);

    if (
        cached &&
        Date.now() - cached.ts < cacheTTL(timeframe)
    ) {
        return cached.data;
    }

    const data = await requestQueue.push(
        () => exchange.fetchOHLCV(
            symbol,
            timeframe,
            undefined,
            limit
        )
    );

    if (Array.isArray(data) && data.length) {

        STATE.ohlcvCache.set(
            key,
            {
                ts: Date.now(),
                data
            }
        );
    }

    return data;
}

async function fetchTicker(symbol) {

    const cached = STATE.tickerCache.get(symbol);

    if (
        cached &&
        Date.now() - cached.ts < 10_000
    ) {
        return cached.data;
    }

    const ticker = await requestQueue.push(
        () => exchange.fetchTicker(symbol)
    );

    if (ticker) {

        STATE.tickerCache.set(
            symbol,
            {
                ts: Date.now(),
                data: ticker
            }
        );
    }

    return ticker;
}

// ================================================================
// EMA / RSI / ATR / ADX
// ================================================================

function technical(candles) {

    if (!candles || candles.length < 60) {
        return null;
    }

    const closes = candles.map(c => Number(c[4]));
    const highs = candles.map(c => Number(c[2]));
    const lows = candles.map(c => Number(c[3]));
    const volumes = candles.map(c => Number(c[5]));

    const ema20 = EMA.calculate({
        period: 20,
        values: closes
    });

    const ema50 = EMA.calculate({
        period: 50,
        values: closes
    });

    const rsi = RSI.calculate({
        period: 14,
        values: closes
    });

    const atr = ATR.calculate({
        period: 14,
        high: highs,
        low: lows,
        close: closes
    });

    const adx = ADX.calculate({
        period: 14,
        high: highs,
        low: lows,
        close: closes
    });

    const e20 = ema20[ema20.length - 1];
    const e50 = ema50[ema50.length - 1];

    const currentRSI = rsi[rsi.length - 1];

    const currentATR = atr[atr.length - 1];

    const currentADX = adx[adx.length - 1]?.adx || 0;

    const price = closes[closes.length - 1];

    let trend = 'NEUTRAL';

    if (
        e20 > e50 &&
        price > e20
    ) {
        trend = 'LONG';
    }
    else if (
        e20 < e50 &&
        price < e20
    ) {
        trend = 'SHORT';
    }

    const atrPercent =
        price > 0
            ? currentATR / price * 100
            : 0;

    const volumeRatio =
        candleVolumeRatio(
            candles,
            candles.length - 1,
            20
        );

    return {

        price,

        ema20: e20,

        ema50: e50,

        rsi: currentRSI || 50,

        atr: currentATR || 0,

        atrPercent,

        adx: currentADX,

        trend,

        volumeRatio
    };
}

// ================================================================
// RADAR METRICS
// ================================================================

function radarScore(ticker, candles1h) {

    if (!ticker || !candles1h || candles1h.length < 30) {
        return {
            score: 0
        };
    }

    const quoteVolume =
        Number(
            ticker.quoteVolume ||
            ticker.info?.quoteVolume ||
            ticker.info?.quoteVol ||
            0
        ) || 0;

    const change24 =
        Number(
            ticker.percentage ||
            ticker.changePercentage ||
            0
        ) || 0;

    const closes =
        candles1h.map(c => Number(c[4]));

    const highs =
        candles1h.map(c => Number(c[2]));

    const lows =
        candles1h.map(c => Number(c[3]));

    const current =
        closes[closes.length - 1];

    // ------------------------------------------------------------
    // VOLUME SCORE
    // ------------------------------------------------------------

    let volumeScore = 0;

    if (quoteVolume >= 100_000_000) {
        volumeScore = 100;
    }
    else if (quoteVolume >= 50_000_000) {
        volumeScore = 90;
    }
    else if (quoteVolume >= 20_000_000) {
        volumeScore = 80;
    }
    else if (quoteVolume >= 10_000_000) {
        volumeScore = 70;
    }
    else if (quoteVolume >= 5_000_000) {
        volumeScore = 60;
    }
    else {
        volumeScore = 45;
    }

    // ------------------------------------------------------------
    // MOMENTUM
    // ------------------------------------------------------------

    const lookback =
        closes[Math.max(0, closes.length - 4)];

    const momentum1h =
        lookback > 0
            ? Math.abs(
                (current - lookback) /
                lookback *
                100
            )
            : 0;

    let momentumScore =
        clamp(
            momentum1h * 25,
            0,
            100
        );

    const moveBoost =
        Math.abs(change24) >= 3
            ? 20
            : Math.abs(change24) >= 1.5
                ? 10
                : 0;

    momentumScore =
        clamp(
            momentumScore + moveBoost,
            0,
            100
        );

    // ------------------------------------------------------------
    // VOLATILITY
    // ------------------------------------------------------------

    const ranges = candles1h
        .slice(-20)
        .map(c =>
            Math.abs(
                Number(c[2]) -
                Number(c[3])
            ) /
            Number(c[4]) *
            100
        )
        .filter(Number.isFinite);

    const volatility =
        avg(ranges);

    const volatilityScore =
        clamp(
            volatility * 30,
            0,
            100
        );

    // ------------------------------------------------------------
    // ACTIVITY
    // ------------------------------------------------------------

    const recentRanges =
        candles1h
            .slice(-6)
            .map(c =>
                Math.abs(
                    Number(c[4]) -
                    Number(c[1])
                ) /
                Number(c[1]) *
                100
            );

    const activityScore =
        clamp(
            avg(recentRanges) * 50,
            0,
            100
        );

    // ------------------------------------------------------------
    // FINAL
    // ------------------------------------------------------------

    const score =
        volumeScore * 0.25 +
        momentumScore * 0.30 +
        volatilityScore * 0.20 +
        activityScore * 0.25;

    return {

        score: Math.round(
            clamp(score, 0, 100)
        ),

        quoteVolume,

        change24,

        momentum1h,

        volatility,

        volumeScore,

        momentumScore,

        volatilityScore,

        activityScore
    };
}

// ================================================================
// 15M PIVOTS
// ================================================================

function findPivots(candles) {

    const highs = [];
    const lows = [];

    if (!candles || candles.length < 20) {
        return {
            highs,
            lows
        };
    }

    const left = CFG.PIVOT_LEFT;
    const right = CFG.PIVOT_RIGHT;

    for (
        let i = left;
        i < candles.length - right;
        i++
    ) {

        const high =
            Number(candles[i][2]);

        const low =
            Number(candles[i][3]);

        let highPivot = true;
        let lowPivot = true;

        for (
            let j = i - left;
            j <= i + right;
            j++
        ) {

            if (j === i) continue;

            if (
                Number(candles[j][2]) >= high
            ) {
                highPivot = false;
            }

            if (
                Number(candles[j][3]) <= low
            ) {
                lowPivot = false;
            }
        }

        if (highPivot) {

            highs.push({
                index: i,
                price: high,
                time: candles[i][0]
            });
        }

        if (lowPivot) {

            lows.push({
                index: i,
                price: low,
                time: candles[i][0]
            });
        }
    }

    return {
        highs,
        lows
    };
}

// ================================================================
// CLUSTER LEVELS
// ================================================================

function clusterLevels(levels) {

    if (!levels.length) return [];

    const sorted =
        [...levels]
            .sort(
                (a, b) =>
                    a.price - b.price
            );

    const clusters = [];

    for (const level of sorted) {

        const existing =
            clusters.find(c => {

                return (
                    Math.abs(
                        c.price -
                        level.price
                    ) /
                    level.price *
                    100
                    <= 0.15
                );
            });

        if (existing) {

            existing.points++;
            existing.price =
                (
                    existing.price *
                    (existing.points - 1) +
                    level.price
                ) /
                existing.points;

        }
        else {

            clusters.push({
                price: level.price,
                points: 1
            });
        }
    }

    return clusters
        .sort(
            (a, b) =>
                b.points - a.points
        );
}

// ================================================================
// STRUCTURE
// ================================================================

function buildStructure(candles, currentPrice) {

    const pivots =
        findPivots(candles);

    const resistanceLevels =
        clusterLevels(
            pivots.highs
        );

    const supportLevels =
        clusterLevels(
            pivots.lows
        );

    let resistance =
        null;

    let support =
        null;

    for (const r of resistanceLevels) {

        if (r.price > currentPrice) {

            resistance = r;
            break;
        }
    }

    for (const s of supportLevels.reverse()) {

        if (s.price < currentPrice) {

            support = s;
            break;
        }
    }

    return {

        support,

        resistance,

        allSupports:
            supportLevels,

        allResistances:
            resistanceLevels
    };
}

// ================================================================
// LEVEL PROXIMITY
// ================================================================

function nearLevel(price, level) {

    if (!level || !Number.isFinite(price)) {
        return false;
    }

    return (
        absPct(price, level.price) <=
        CFG.LEVEL_NEAR_PERCENT
    );
}

// ================================================================
// BREAKOUT DETECTOR
// ================================================================

function detectBreakout(
    symbol,
    candles,
    structure
) {

    if (
        !candles ||
        candles.length < 25
    ) {
        return null;
    }

    const index =
        candles.length - 2;

    const candle =
        candles[index];

    const previous =
        candles[index - 1];

    const close =
        Number(candle[4]);

    const prevClose =
        Number(previous[4]);

    const volumeRatio =
        candleVolumeRatio(
            candles,
            index,
            20
        );

    // ------------------------------------------------------------
    // LONG
    // Resistance yukarı kırıldı.
    // ------------------------------------------------------------

    if (
        structure.resistance
    ) {

        const level =
            structure.resistance.price;

        const breakout =
            close >
            level *
            (
                1 +
                CFG.BREAKOUT_BUFFER_PERCENT /
                100
            );

        const previousBelow =
            prevClose <= level;

        const volumeOk =
            volumeRatio >=
            CFG.BREAKOUT_VOLUME_RATIO;

        if (
            breakout &&
            previousBelow &&
            volumeOk
        ) {

            return {

                symbol,

                direction: 'LONG',

                level,

                breakoutPrice: close,

                breakoutIndex: index,

                breakoutTime: candle[0],

                volumeRatio,

                candle,

                type: 'RESISTANCE_BREAK'
            };
        }
    }

    // ------------------------------------------------------------
    // SHORT
    // Support aşağı kırıldı.
    // ------------------------------------------------------------

    if (
        structure.support
    ) {

        const level =
            structure.support.price;

        const breakout =
            close <
            level *
            (
                1 -
                CFG.BREAKOUT_BUFFER_PERCENT /
                100
            );

        const previousAbove =
            prevClose >= level;

        const volumeOk =
            volumeRatio >=
            CFG.BREAKOUT_VOLUME_RATIO;

        if (
            breakout &&
            previousAbove &&
            volumeOk
        ) {

            return {

                symbol,

                direction: 'SHORT',

                level,

                breakoutPrice: close,

                breakoutIndex: index,

                breakoutTime: candle[0],

                volumeRatio,

                candle,

                type: 'SUPPORT_BREAK'
            };
        }
    }

    return null;
}

// ================================================================
// RETEST DETECTOR
// ================================================================

function detectRetest(
    pending,
    candles
) {

    if (
        !pending ||
        !candles ||
        candles.length < 5
    ) {
        return null;
    }

    const now =
        Date.now();

    const age =
        now -
        pending.createdAt;

    if (
        age >
        CFG.RETEST_WINDOW_MINUTES *
        60 *
        1000
    ) {

        return {
            expired: true
        };
    }

    // ------------------------------------------------------------
    // Sadece BREAKOUT'TAN SONRAKİ mumlar.
    // Eski mumları kesinlikle retest saymıyoruz.
    // ------------------------------------------------------------

    const candlesAfter =
        candles.filter(
            c =>
                Number(c[0]) >
                Number(pending.breakoutTime)
        );

    if (!candlesAfter.length) {
        return null;
    }

    const level =
        pending.level;

    for (const candle of candlesAfter) {

        const high =
            Number(candle[2]);

        const low =
            Number(candle[3]);

        const close =
            Number(candle[4]);

        // --------------------------------------------------------
        // LONG RETEST
        //
        // Direnç kırıldı.
        // Fiyat tekrar dirence geliyor.
        // Level destek olarak tutuluyor.
        // --------------------------------------------------------

        if (
            pending.direction === 'LONG'
        ) {

            const touched =
                low <=
                level *
                (
                    1 +
                    CFG.RETEST_TOLERANCE_PERCENT /
                    100
                ) &&
                high >=
                level *
                (
                    1 -
                    CFG.RETEST_TOLERANCE_PERCENT /
                    100
                );

            const invalidated =
                close <
                level *
                (
                    1 -
                    CFG.RETEST_INVALIDATION_PERCENT /
                    100
                );

            if (invalidated) {

                return {
                    invalidated: true
                };
            }

            if (
                touched &&
                close >= level
            ) {

                return {

                    valid: true,

                    direction: 'LONG',

                    retestPrice: close,

                    retestTime: candle[0],

                    candle
                };
            }
        }

        // --------------------------------------------------------
        // SHORT RETEST
        //
        // Destek kırıldı.
        // Fiyat tekrar desteğe geliyor.
        // Level direnç olarak tutuluyor.
        // --------------------------------------------------------

        if (
            pending.direction === 'SHORT'
        ) {

            const touched =
                high >=
                level *
                (
                    1 -
                    CFG.RETEST_TOLERANCE_PERCENT /
                    100
                ) &&
                low <=
                level *
                (
                    1 +
                    CFG.RETEST_TOLERANCE_PERCENT /
                    100
                );

            const invalidated =
                close >
                level *
                (
                    1 +
                    CFG.RETEST_INVALIDATION_PERCENT /
                    100
                );

            if (invalidated) {

                return {
                    invalidated: true
                };
            }

            if (
                touched &&
                close <= level
            ) {

                return {

                    valid: true,

                    direction: 'SHORT',

                    retestPrice: close,

                    retestTime: candle[0],

                    candle
                };
            }
        }
    }

    return null;
}

// ================================================================
// 1M CONFIRMATION
// ================================================================

async function confirm1M(
    symbol,
    direction
) {

    try {

        const candles =
            await fetchOHLCV(
                symbol,
                CFG.TF_ENTRY,
                30
            );

        if (
            !candles ||
            candles.length < 15
        ) {

            return {
                confirmed: false,
                score: 0,
                reason: '1M veri yetersiz'
            };
        }

        const closed =
            lastClosed(candles);

        const previous =
            previousClosed(candles);

        if (!closed || !previous) {

            return {
                confirmed: false,
                score: 0
            };
        }

        const volumeRatio =
            candleVolumeRatio(
                candles,
                candles.length - 2,
                15
            );

        const close =
            Number(closed[4]);

        const previousClose =
            Number(previous[4]);

        const move =
            pct(
                close,
                previousClose
            );

        let score = 0;

        if (
            direction === 'LONG'
        ) {

            if (isBullish(closed)) {
                score += 15;
            }

            if (move >= CFG.ENTRY_MOMENTUM_PERCENT) {
                score += 10;
            }
        }
        else {

            if (isBearish(closed)) {
                score += 15;
            }

            if (move <= -CFG.ENTRY_MOMENTUM_PERCENT) {
                score += 10;
            }
        }

        if (
            volumeRatio >=
            CFG.ENTRY_VOLUME_RATIO
        ) {
            score += 10;
        }

        return {

            confirmed:
                score >= 15,

            score:

                clamp(
                    score,
                    0,
                    35
                ),

            volumeRatio,

            move
        };

    }
    catch (error) {

        return {
            confirmed: false,
            score: 0,
            reason: error.message
        };
    }
}

// ================================================================
// SWING STOP
// ================================================================

function findSwingStop(
    candles,
    direction,
    entry
) {

    if (
        !candles ||
        candles.length < 10
    ) {
        return null;
    }

    const recent =
        candles.slice(-10, -1);

    if (
        direction === 'LONG'
    ) {

        const swingLow =
            Math.min(
                ...recent.map(
                    c => Number(c[3])
                )
            );

        return swingLow;
    }

    const swingHigh =
        Math.max(
            ...recent.map(
                c => Number(c[2])
            )
        );

    return swingHigh;
}

// ================================================================
// TP / SL ENGINE
// ================================================================

function buildScalpPlan(
    symbol,
    direction,
    entry,
    breakoutLevel,
    candles3m,
    structure
) {

    const tech =
        technical(candles3m);

    if (!tech) return null;

    const atr =
        tech.atr;

    if (
        !Number.isFinite(atr) ||
        atr <= 0
    ) {
        return null;
    }

    const swing =
        findSwingStop(
            candles3m,
            direction,
            entry
        );

    if (!Number.isFinite(swing)) {
        return null;
    }

    let sl;

    if (
        direction === 'LONG'
    ) {

        sl =
            Math.min(
                swing,
                entry -
                atr * 0.65
            );

    }
    else {

        sl =
            Math.max(
                swing,
                entry +
                atr * 0.65
            );
    }

    // ------------------------------------------------------------
    // Stop buffer.
    // ------------------------------------------------------------

    const buffer =
        atr * 0.08;

    if (
        direction === 'LONG'
    ) {
        sl -= buffer;
    }
    else {
        sl += buffer;
    }

    const risk =
        Math.abs(
            entry - sl
        );

    if (!risk) return null;

    const riskPct =
        risk /
        entry *
        100;

    // ------------------------------------------------------------
    // Scalp stop range.
    // ------------------------------------------------------------

    if (
        riskPct <
        CFG.MIN_STOP_PERCENT
    ) {

        const wanted =
            entry *
            CFG.MIN_STOP_PERCENT /
            100;

        if (
            direction === 'LONG'
        ) {
            sl =
                entry -
                wanted;
        }
        else {
            sl =
                entry +
                wanted;
        }
    }

    if (
        riskPct >
        CFG.MAX_STOP_PERCENT
    ) {
        return null;
    }

    const realRisk =
        Math.abs(
            entry - sl
        );

    // ------------------------------------------------------------
    // TP targets
    // ------------------------------------------------------------

    let tp1 =
        direction === 'LONG'
            ? entry +
              realRisk *
              1.35
            : entry -
              realRisk *
              1.35;

    let tp2 =
        direction === 'LONG'
            ? entry +
              realRisk *
              2.10
            : entry -
              realRisk *
              2.10;

    let tp3 =
        direction === 'LONG'
            ? entry +
              realRisk *
              3.00
            : entry -
              realRisk *
              3.00;

    // ------------------------------------------------------------
    // Karşı seviye varsa TP'yi onunla mantıklı şekilde sıkıştır.
    // ------------------------------------------------------------

    if (
        direction === 'LONG' &&
        structure.resistance
    ) {

        const resistance =
            structure.resistance.price;

        if (
            resistance > entry
        ) {

            tp1 =
                Math.min(
                    tp1,
                    entry +
                    (
                        resistance -
                        entry
                    ) *
                    0.55
                );

            tp2 =
                Math.min(
                    tp2,
                    entry +
                    (
                        resistance -
                        entry
                    ) *
                    0.82
                );

            tp3 =
                Math.min(
                    tp3,
                    resistance *
                    0.995
                );
        }
    }

    if (
        direction === 'SHORT' &&
        structure.support
    ) {

        const support =
            structure.support.price;

        if (
            support < entry
        ) {

            tp1 =
                Math.max(
                    tp1,
                    entry -
                    (
                        entry -
                        support
                    ) *
                    0.55
                );

            tp2 =
                Math.max(
                    tp2,
                    entry -
                    (
                        entry -
                        support
                    ) *
                    0.82
                );

            tp3 =
                Math.max(
                    tp3,
                    support *
                    1.005
                );
        }
    }

    // ------------------------------------------------------------
    // Sıralama
    // ------------------------------------------------------------

    if (
        direction === 'LONG'
    ) {

        tp1 = Math.max(
            tp1,
            entry + realRisk * 1.25
        );

        tp2 = Math.max(
            tp2,
            tp1 + realRisk * 0.40
        );

        tp3 = Math.max(
            tp3,
            tp2 + realRisk * 0.40
        );

    }
    else {

        tp1 = Math.min(
            tp1,
            entry - realRisk * 1.25
        );

        tp2 = Math.min(
            tp2,
            tp1 - realRisk * 0.40
        );

        tp3 = Math.min(
            tp3,
            tp2 - realRisk * 0.40
        );
    }

    // ------------------------------------------------------------
    // Gerçek R:R
    // ------------------------------------------------------------

    const rr =
        direction === 'LONG'
            ? (tp1 - entry) / realRisk
            : (entry - tp1) / realRisk;

    if (
        rr <
        CFG.MIN_RR_TP1
    ) {
        return null;
    }

    return {

        entry:
            roundPrice(
                symbol,
                entry
            ),

        sl:
            roundPrice(
                symbol,
                sl
            ),

        tp1:
            roundPrice(
                symbol,
                tp1
            ),

        tp2:
            roundPrice(
                symbol,
                tp2
            ),

        tp3:
            roundPrice(
                symbol,
                tp3
            ),

        riskPercent:
            Number(
                (
                    realRisk /
                    entry *
                    100
                ).toFixed(3)
            ),

        tp1Percent:
            Number(
                (
                    Math.abs(
                        tp1 - entry
                    ) /
                    entry *
                    100
                ).toFixed(3)
            ),

        tp2Percent:
            Number(
                (
                    Math.abs(
                        tp2 - entry
                    ) /
                    entry *
                    100
                ).toFixed(3)
            ),

        tp3Percent:
            Number(
                (
                    Math.abs(
                        tp3 - entry
                    ) /
                    entry *
                    100
                ).toFixed(3)
            ),

        rr:
            Number(
                rr.toFixed(2)
            ),

        atrPercent:
            Number(
                (
                    atr /
                    entry *
                    100
                ).toFixed(3)
            )
    };
}

// ================================================================
// SIGNAL SCORE
// ================================================================

function scoreSignal({
    direction,
    tech1h,
    tech3m,
    breakout,
    retest,
    confirm,
    radar,
    plan,
    market
}) {

    let score = 50;

    const reasons = [];

    // ------------------------------------------------------------
    // 1H TREND
    // ------------------------------------------------------------

    if (
        tech1h.trend ===
        direction
    ) {

        score += 10;

        reasons.push(
            '1H trend uyumlu'
        );

    }
    else if (
        tech1h.trend ===
        'NEUTRAL'
    ) {

        score += 2;

        reasons.push(
            '1H trend nötr'
        );

    }
    else {

        // Ters trend tamamen yasaklanmıyor.
        // Altcoin fırsatlarını kaçırmamak için
        // sadece puan kırılıyor.

        score -= 6;

        reasons.push(
            '1H trend ters'
        );
    }

    // ------------------------------------------------------------
    // 3M MOMENTUM
    // ------------------------------------------------------------

    if (
        direction === 'LONG' &&
        tech3m.ema20 > tech3m.ema50
    ) {

        score += 7;

        reasons.push(
            '3M momentum LONG'
        );

    }
    else if (
        direction === 'SHORT' &&
        tech3m.ema20 < tech3m.ema50
    ) {

        score += 7;

        reasons.push(
            '3M momentum SHORT'
        );
    }

    // ------------------------------------------------------------
    // BREAKOUT
    // ------------------------------------------------------------

    if (
        breakout.volumeRatio >= 2
    ) {

        score += 8;

        reasons.push(
            'Hacim patlaması'
        );

    }
    else if (
        breakout.volumeRatio >= 1.4
    ) {

        score += 5;

        reasons.push(
            'Hacim güçlü'
        );

    }
    else {

        score += 2;
    }

    // ------------------------------------------------------------
    // RETEST
    // ------------------------------------------------------------

    if (
        retest.valid
    ) {

        score += 12;

        reasons.push(
            '3M retest başarılı'
        );
    }

    // ------------------------------------------------------------
    // 1M
    // ------------------------------------------------------------

    if (
        confirm.confirmed
    ) {

        score +=
            confirm.score;

        reasons.push(
            '1M giriş teyidi'
        );

    }
    else {

        // Zorunlu değil.
        reasons.push(
            '1M teyit yok'
        );
    }

    // ------------------------------------------------------------
    // RADAR
    // ------------------------------------------------------------

    if (
        radar.score >= 80
    ) {

        score += 6;

        reasons.push(
            'Radar güçlü'
        );

    }
    else if (
        radar.score >= 65
    ) {

        score += 3;
    }

    // ------------------------------------------------------------
    // MARKET
    // ------------------------------------------------------------

    if (
        market.direction ===
        direction
    ) {

        score += 5;

        reasons.push(
            'Piyasa yönü uyumlu'
        );

    }
    else if (
        market.direction ===
        'NEUTRAL'
    ) {

        score += 1;

    }
    else {

        score -= 3;

        reasons.push(
            'Piyasa yönü ters'
        );
    }

    // ------------------------------------------------------------
    // RSI
    // ------------------------------------------------------------

    if (
        direction === 'LONG'
    ) {

        if (
            tech3m.rsi >= 48 &&
            tech3m.rsi <= 68
        ) {

            score += 4;

            reasons.push(
                'RSI uygun'
            );
        }

        if (
            tech3m.rsi > 78
        ) {

            score -= 5;

            reasons.push(
                'RSI aşırı yüksek'
            );
        }
    }
    else {

        if (
            tech3m.rsi >= 32 &&
            tech3m.rsi <= 52
        ) {

            score += 4;

            reasons.push(
                'RSI uygun'
            );
        }

        if (
            tech3m.rsi < 22
        ) {

            score -= 5;

            reasons.push(
                'RSI aşırı düşük'
            );
        }
    }

    // ------------------------------------------------------------
    // ADX
    // ------------------------------------------------------------

    if (
        tech3m.adx >= 25
    ) {

        score += 5;

        reasons.push(
            'ADX momentum güçlü'
        );

    }
    else if (
        tech3m.adx < 16
    ) {

        score -= 5;

        reasons.push(
            'ADX zayıf'
        );
    }

    // ------------------------------------------------------------
    // R:R
    // ------------------------------------------------------------

    if (
        plan.rr >= 2
    ) {

        score += 6;

        reasons.push(
            'R:R çok iyi'
        );

    }
    else if (
        plan.rr >= CFG.GOOD_RR_TP1
    ) {

        score += 4;

        reasons.push(
            'R:R iyi'
        );

    }
    else {

        score += 1;
    }

    return {

        score:
            Math.round(
                clamp(
                    score,
                    0,
                    100
                )
            ),

        reasons
    };
}

// ================================================================
// MARKET SENTIMENT
// ================================================================

async function calculateMarketState() {

    try {

        const symbols = [
            'BTC/USDT:USDT',
            'ETH/USDT:USDT'
        ];

        const results = [];

        for (
            const symbol of symbols
        ) {

            try {

                const candles =
                    await fetchOHLCV(
                        symbol,
                        '1h',
                        100
                    );

                const tech =
                    technical(
                        candles
                    );

                if (tech) {

                    results.push({
                        symbol,
                        trend: tech.trend,
                        change:
                            pct(
                                tech.price,
                                candles[
                                    candles.length - 25
                                ][4]
                            )
                    });
                }

            }
            catch (_) {}
        }

        // --------------------------------------------------------
        // Breadth
        // --------------------------------------------------------

        let green = 0;
        let red = 0;
        let total = 0;
        let moveSum = 0;

        for (
            const item of STATE.candidates
        ) {

            const change =
                Number(
                    item.change24
                );

            if (!Number.isFinite(change)) {
                continue;
            }

            total++;

            moveSum += change;

            if (change > 0) {
                green++;
            }
            else if (change < 0) {
                red++;
            }
        }

        const breadthPct =
            total
                ? green / total * 100
                : 50;

        const avgMove =
            total
                ? moveSum / total
                : 0;

        const btc =
            results.find(
                x =>
                    x.symbol
                    .startsWith('BTC')
            );

        const eth =
            results.find(
                x =>
                    x.symbol
                    .startsWith('ETH')
            );

        const btcTrend =
            btc?.trend || 'NEUTRAL';

        const ethTrend =
            eth?.trend || 'NEUTRAL';

        let direction = 'NEUTRAL';

        if (
            breadthPct >=
            CFG.MARKET_BREADTH_BULL &&
            (
                btcTrend === 'LONG' ||
                ethTrend === 'LONG'
            ) &&
            avgMove >
            0.20
        ) {

            direction = 'LONG';
        }
        else if (
            breadthPct <=
            CFG.MARKET_BREADTH_BEAR &&
            (
                btcTrend === 'SHORT' ||
                ethTrend === 'SHORT'
            ) &&
            avgMove <
            -0.20
        ) {

            direction = 'SHORT';
        }

        let label;

        if (
            direction === 'LONG'
        ) {

            label =
                breadthPct >= 72
                    ? 'GÜÇLÜ YÜKSELİŞ'
                    : 'YÜKSELİŞ';

        }
        else if (
            direction === 'SHORT'
        ) {

            label =
                breadthPct <= 28
                    ? 'GÜÇLÜ DÜŞÜŞ'
                    : 'DÜŞÜŞ';

        }
        else {

            // Sadece gerçekten kararsızsa.
            label =
                'KARARSIZ';
        }

        STATE.market = {

            label,

            direction,

            breadthPct:
                Number(
                    breadthPct.toFixed(1)
                ),

            avgMove24h:
                Number(
                    avgMove.toFixed(2)
                ),

            btcTrend,

            ethTrend,

            reason:
                `${green}/${red} yeşil/kırmızı | ` +
                `BTC ${btcTrend} | ` +
                `ETH ${ethTrend} | ` +
                `Ort. ${avgMove.toFixed(2)}%`
        };

    }
    catch (error) {

        console.error(
            'Market state error:',
            error.message
        );
    }
}

// ================================================================
// UNIVERSE DISCOVERY
// ================================================================

async function discoverUniverse() {

    await requestQueue.push(
        () =>
            exchange.loadMarkets(true),
        100
    );

    const markets =
        Object.values(
            exchange.markets || {}
        );

    const swapMarkets =
        markets.filter(m => {

            if (!m) return false;

            if (
                m.active === false
            ) {
                return false;
            }

            if (
                m.quote !== 'USDT'
            ) {
                return false;
            }

            if (
                !m.swap
            ) {
                return false;
            }

            if (
                m.settle &&
                m.settle !== 'USDT'
            ) {
                return false;
            }

            return true;
        });

    // ------------------------------------------------------------
    // Tickerleri mümkün olduğunca tek seferde al.
    // ------------------------------------------------------------

    let tickers = {};

    try {

        tickers =
            await requestQueue.push(
                () =>
                    exchange.fetchTickers(
                        swapMarkets.map(
                            m => m.symbol
                        )
                    ),
                100
            );

    }
    catch (error) {

        console.error(
            'fetchTickers failed:',
            error.message
        );

        // Fallback: parça parça.
        tickers = {};

        const chunkSize = 50;

        for (
            let i = 0;
            i < swapMarkets.length;
            i += chunkSize
        ) {

            const chunk =
                swapMarkets.slice(
                    i,
                    i + chunkSize
                );

            try {

                const data =
                    await requestQueue.push(
                        () =>
                            exchange.fetchTickers(
                                chunk.map(
                                    m => m.symbol
                                )
                            )
                    );

                Object.assign(
                    tickers,
                    data
                );

            }
            catch (_) {}

            await sleep(100);
        }
    }

    const rows = [];

    for (
        const market of swapMarkets
    ) {

        const ticker =
            tickers[
                market.symbol
            ];

        if (!ticker) continue;

        const last =
            Number(
                ticker.last
            );

        const quoteVolume =
            Number(
                ticker.quoteVolume ||
                ticker.info?.quoteVolume ||
                ticker.info?.quoteVol ||
                0
            );

        if (
            !Number.isFinite(last) ||
            last < CFG.MIN_PRICE
        ) {
            continue;
        }

        if (
            quoteVolume <
            CFG.MIN_24H_VOLUME_USD
        ) {
            continue;
        }

        rows.push({

            symbol:
                market.symbol,

            base:
                market.base,

            last,

            quoteVolume,

            change24:
                Number(
                    ticker.percentage || 0
                ),

            bid:
                Number(
                    ticker.bid || 0
                ),

            ask:
                Number(
                    ticker.ask || 0
                ),

            spread:
                (
                    ticker.bid &&
                    ticker.ask
                )
                    ? (
                        (
                            ticker.ask -
                            ticker.bid
                        ) /
                        (
                            (
                                ticker.ask +
                                ticker.bid
                            ) /
                            2
                        )
                    ) *
                    100
                    : 999
        });
    }

    rows.sort(
        (a, b) =>
            b.quoteVolume -
            a.quoteVolume
    );

    STATE.universe =
        rows.slice(
            0,
            CFG.MAX_UNIVERSE
        );

    STATE.stats.universe =
        STATE.universe.length;

    return STATE.universe;
}

// ================================================================
// STAGE 1 -> 500 TO 150
// ================================================================

async function buildCandidates() {

    const candidates = [];

    for (
        const row of STATE.universe
    ) {

        try {

            const candles =
                await fetchOHLCV(
                    row.symbol,
                    '1h',
                    60
                );

            if (
                !candles ||
                candles.length < 40
            ) {
                continue;
            }

            const radar =
                radarScore(
                    {
                        quoteVolume:
                            row.quoteVolume,

                        percentage:
                            row.change24
                    },
                    candles
                );

            if (
                radar.score <= 0
            ) {
                continue;
            }

            candidates.push({

                ...row,

                radarScore:
                    radar.score,

                momentum1h:
                    radar.momentum1h,

                volatility:
                    radar.volatility,

                volumeScore:
                    radar.volumeScore,

                momentumScore:
                    radar.momentumScore,

                activityScore:
                    radar.activityScore,

                volatilityScore:
                    radar.volatilityScore
            });

        }
        catch (_) {}
    }

    candidates.sort(
        (a, b) =>
            b.radarScore -
            a.radarScore
    );

    STATE.candidates =
        candidates.slice(
            0,
            CFG.CANDIDATE_COUNT
        );

    STATE.stats.candidates =
        STATE.candidates.length;
}

// ================================================================
// STAGE 2 -> 150 TO 40
// ================================================================

async function buildWatchlist() {

    const watch = [];

    for (
        const item of STATE.candidates
    ) {

        try {

            const candles15 =
                await fetchOHLCV(
                    item.symbol,
                    CFG.TF_STRUCTURE,
                    80
                );

            if (
                !candles15 ||
                candles15.length < 40
            ) {
                continue;
            }

            const closed =
                lastClosed(
                    candles15
                );

            if (!closed) continue;

            const price =
                Number(
                    closed[4]
                );

            const structure =
                buildStructure(
                    candles15,
                    price
                );

            const nearSupport =
                nearLevel(
                    price,
                    structure.support
                );

            const nearResistance =
                nearLevel(
                    price,
                    structure.resistance
                );

            const breakoutPotential =
                nearSupport ||
                nearResistance;

            // ----------------------------------------------------
            // 15M seviyeye yakın değilse tamamen öldürmüyoruz.
            // Momentum yüksekse watchlist'e bırak.
            // ----------------------------------------------------

            const highMomentum =
                item.radarScore >= 72 ||
                Math.abs(
                    item.change24
                ) >= 3;

            if (
                !breakoutPotential &&
                !highMomentum
            ) {
                continue;
            }

            let score =
                item.radarScore;

            if (
                breakoutPotential
            ) {
                score += 10;
            }

            if (
                highMomentum
            ) {
                score += 8;
            }

            watch.push({

                ...item,

                score:
                    Math.min(
                        100,
                        score
                    ),

                price,

                structure,

                nearSupport,

                nearResistance,

                updatedAt:
                    Date.now()
            });

        }
        catch (_) {}
    }

    watch.sort(
        (a, b) =>
            b.score -
            a.score
    );

    STATE.watchlist =
        watch.slice(
            0,
            CFG.WATCHLIST_COUNT
        );

    STATE.stats.watchlist =
        STATE.watchlist.length;
}

// ================================================================
// STAGE 3 -> 3M BREAKOUT
// ================================================================

async function scan3MBreakouts() {

    STATE.stats.analyzed = 0;

    for (
        const item of STATE.watchlist
    ) {

        try {

            const candles3 =
                await fetchOHLCV(
                    item.symbol,
                    CFG.TF_BREAKOUT,
                    80
                );

            if (
                !candles3 ||
                candles3.length < 30
            ) {
                continue;
            }

            STATE.stats.analyzed++;

            const closed =
                lastClosed(
                    candles3
                );

            if (!closed) continue;

            const currentPrice =
                Number(
                    closed[4]
                );

            const structure =
                buildStructure(
                    await fetchOHLCV(
                        item.symbol,
                        CFG.TF_STRUCTURE,
                        80
                    ),
                    currentPrice
                );

            const breakout =
                detectBreakout(
                    item.symbol,
                    candles3,
                    structure
                );

            if (!breakout) continue;

            const key =
                `${item.symbol}:${breakout.direction}:${breakout.level.toFixed(10)}`;

            if (
                STATE.cooldowns.has(key) &&
                STATE.cooldowns.get(key) >
                    Date.now()
            ) {
                continue;
            }

            // ----------------------------------------------------
            // Pending breakout hafızaya alınır.
            // ----------------------------------------------------

            STATE.pendingBreakouts.set(
                key,
                {

                    ...breakout,

                    key,

                    createdAt:
                        Date.now(),

                    status:
                        'WAIT_RETEST'
                }
            );

            console.log(
                `⚡ BREAKOUT ${publicSymbol(item.symbol)} ` +
                `${breakout.direction} ` +
                `level=${breakout.level} ` +
                `vol=${breakout.volumeRatio.toFixed(2)}x`
            );

        }
        catch (error) {

            if (
                process.env.DEBUG === 'true'
            ) {
                console.log(
                    '3M scan error',
                    item.symbol,
                    error.message
                );
            }
        }
    }
}

// ================================================================
// STAGE 4 -> RETEST
// ================================================================

async function scanRetests() {

    const entries =
        Array.from(
            STATE.pendingBreakouts.entries()
        );

    for (
        const [key, pending]
        of entries
    ) {

        try {

            const candles3 =
                await fetchOHLCV(
                    pending.symbol,
                    CFG.TF_BREAKOUT,
                    100
                );

            const retest =
                detectRetest(
                    pending,
                    candles3
                );

            if (!retest) continue;

            if (
                retest.expired ||
                retest.invalidated
            ) {

                STATE.pendingBreakouts.delete(
                    key
                );

                STATE.cooldowns.set(
                    key,
                    Date.now() +
                    CFG.COOLDOWN_MINUTES *
                    60 *
                    1000
                );

                continue;
            }

            if (
                !retest.valid
            ) {
                continue;
            }

            const candles1h =
                await fetchOHLCV(
                    pending.symbol,
                    CFG.TF_CONTEXT,
                    80
                );

            const candles15 =
                await fetchOHLCV(
                    pending.symbol,
                    CFG.TF_STRUCTURE,
                    80
                );

            const current =
                Number(
                    candles3[
                        candles3.length - 2
                    ][4]
                );

            const tech1h =
                technical(
                    candles1h
                );

            const tech3m =
                technical(
                    candles3
                );

            if (
                !tech1h ||
                !tech3m
            ) {
                continue;
            }

            const structure =
                buildStructure(
                    candles15,
                    current
                );

            // ----------------------------------------------------
            // 1M confirmation
            // ----------------------------------------------------

            const confirm =
                await confirm1M(
                    pending.symbol,
                    pending.direction
                );

            if (
                CFG.REQUIRE_1M_CONFIRMATION &&
                !confirm.confirmed
            ) {
                continue;
            }

            // ----------------------------------------------------
            // Plan
            // ----------------------------------------------------

            const plan =
                buildScalpPlan(
                    pending.symbol,
                    pending.direction,
                    current,
                    pending.level,
                    candles3,
                    structure
                );

            if (!plan) {

                STATE.pendingBreakouts.delete(
                    key
                );

                continue;
            }

            // ----------------------------------------------------
            // Score
            // ----------------------------------------------------

            const item =
                STATE.watchlist.find(
                    x =>
                        x.symbol ===
                        pending.symbol
                );

            const radar = {

                score:
                    item?.radarScore || 60
            };

            const scoring =
                scoreSignal({

                    direction:
                        pending.direction,

                    tech1h,

                    tech3m,

                    breakout:
                        pending,

                    retest,

                    confirm,

                    radar,

                    plan,

                    market:
                        STATE.market
                });

            if (
                scoring.score <
                CFG.MIN_SIGNAL_SCORE
            ) {

                STATE.pendingBreakouts.delete(
                    key
                );

                STATE.cooldowns.set(
                    key,
                    Date.now() +
                    10 *
                    60 *
                    1000
                );

                continue;
            }

            // ----------------------------------------------------
            // Signal
            // ----------------------------------------------------

            const signalKey =
                `${pending.symbol}:${pending.direction}`;

            const signal = {

                id:
                    `${signalKey}:${Date.now()}`,

                symbol:
                    pending.symbol,

                coin:
                    publicSymbol(
                        pending.symbol
                    ),

                direction:
                    pending.direction,

                taraf:
                    pending.direction,

                strategy:
                    'SCALP_V5',

                timeframe:
                    '1m / 3m / 15m / 1h',

                entry:
                    plan.entry,

                giris:
                    plan.entry,

                sl:
                    plan.sl,

                tp1:
                    plan.tp1,

                tp2:
                    plan.tp2,

                tp3:
                    plan.tp3,

                riskPercent:
                    plan.riskPercent,

                tp1Percent:
                    plan.tp1Percent,

                tp2Percent:
                    plan.tp2Percent,

                tp3Percent:
                    plan.tp3Percent,

                riskReward:
                    plan.rr,

                rr:
                    plan.rr,

                confidence:
                    scoring.score,

                ai_score:
                    scoring.score,

                category:
                    scoring.score >= CFG.ELITE_SIGNAL_SCORE
                        ? 'ELITE SCALP'
                        : scoring.score >= CFG.GOOD_SIGNAL_SCORE
                            ? 'GÜÇLÜ SCALP'
                            : 'NORMAL SCALP',

                breakoutLevel:
                    pending.level,

                breakoutVolume:
                    pending.volumeRatio,

                retestPrice:
                    retest.retestPrice,

                oneMinuteConfirmed:
                    confirm.confirmed,

                oneMinuteScore:
                    confirm.score,

                oneMinuteVolume:
                    confirm.volumeRatio,

                oneMinuteMove:
                    confirm.move,

                market:
                    {
                        ...STATE.market
                    },

                reasons:
                    scoring.reasons,

                status:
                    'ACTIVE',

                createdAt:
                    Date.now(),

                timestamp:
                    Date.now(),

                expiresAt:
                    Date.now() +
                    CFG.SIGNAL_TTL_MINUTES *
                    60 *
                    1000,

                // UI compatibility
                zaman_araligi:
                    'SCALP',

                sinyal_kategorisi:
                    scoring.score >= 88
                        ? 'ELITE SCALP'
                        : scoring.score >= 78
                            ? 'GÜÇLÜ SCALP'
                            : 'NORMAL SCALP',

                analiz_notu:
                    scoring.reasons.join(' • '),

                tv_link:
                    `https://www.tradingview.com/chart/?symbol=BITGET%3A${publicSymbol(pending.symbol)}`
            };

            // ----------------------------------------------------
            // Aynı coin/yön aktifse yenisini alma.
            // ----------------------------------------------------

            const existing =
                Array.from(
                    STATE.signals.values()
                ).find(
                    s =>
                        s.symbol ===
                        signal.symbol &&
                        s.direction ===
                        signal.direction &&
                        s.status ===
                        'ACTIVE'
                );

            if (existing) {
                STATE.pendingBreakouts.delete(
                    key
                );
                continue;
            }

            STATE.signals.set(
                signal.id,
                signal
            );

            STATE.pendingBreakouts.delete(
                key
            );

            STATE.cooldowns.set(
                signalKey,
                Date.now() +
                CFG.COOLDOWN_MINUTES *
                60 *
                1000
            );

            console.log(
                `🚨 SCALP SIGNAL ` +
                `${signal.coin} ` +
                `${signal.direction} ` +
                `score=${signal.confidence} ` +
                `RR=${signal.rr}`
            );

            broadcast({
                type:
                    'scalp_signal',

                signal
            });

        }
        catch (error) {

            console.error(
                'Retest error:',
                pending.symbol,
                error.message
            );
        }
    }
}

// ================================================================
// CLEANUP
// ================================================================

function cleanupState() {

    const now =
        Date.now();

    // ------------------------------------------------------------
    // Signals
    // ------------------------------------------------------------

    for (
        const [id, signal]
        of STATE.signals.entries()
    ) {

        if (
            signal.expiresAt &&
            now >
            signal.expiresAt
        ) {

            signal.status =
                'EXPIRED';

            STATE.signals.delete(
                id
            );
        }
    }

    // ------------------------------------------------------------
    // Pending breakout
    // ------------------------------------------------------------

    for (
        const [key, pending]
        of STATE.pendingBreakouts.entries()
    ) {

        if (
            now -
            pending.createdAt >
            CFG.RETEST_WINDOW_MINUTES *
            60 *
            1000
        ) {

            STATE.pendingBreakouts.delete(
                key
            );
        }
    }

    // ------------------------------------------------------------
    // Cooldowns
    // ------------------------------------------------------------

    for (
        const [key, expiry]
        of STATE.cooldowns.entries()
    ) {

        if (
            now >= expiry
        ) {

            STATE.cooldowns.delete(
                key
            );
        }
    }

    STATE.stats.pending =
        STATE.pendingBreakouts.size;

    STATE.stats.signals =
        STATE.signals.size;
}

// ================================================================
// MAIN SCAN
// ================================================================

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

    try {

        console.log(
            '\n================================================'
        );

        console.log(
            '🚀 SONNY SCALP V5 RADAR'
        );

        console.log(
            '================================================'
        );

        // --------------------------------------------------------
        // 1. 500 coin universe
        // --------------------------------------------------------

        await discoverUniverse();

        // --------------------------------------------------------
        // 2. 500 -> 150
        // --------------------------------------------------------

        await buildCandidates();

        // --------------------------------------------------------
        // 3. Market state
        // --------------------------------------------------------

        await calculateMarketState();

        // --------------------------------------------------------
        // 4. 150 -> 40
        // --------------------------------------------------------

        await buildWatchlist();

        // --------------------------------------------------------
        // 5. 3M breakout
        // --------------------------------------------------------

        await scan3MBreakouts();

        // --------------------------------------------------------
        // 6. Retest
        // --------------------------------------------------------

        await scanRetests();

        // --------------------------------------------------------
        // 7. Cleanup
        // --------------------------------------------------------

        cleanupState();

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

        STATE.lastScan =
            Date.now();

        console.log(
            `RADAR | ` +
            `Universe=${STATE.stats.universe} | ` +
            `Candidates=${STATE.stats.candidates} | ` +
            `Watch=${STATE.stats.watchlist} | ` +
            `Analyzed=${STATE.stats.analyzed} | ` +
            `Pending=${STATE.stats.pending} | ` +
            `SIGNAL=${STATE.stats.signals} | ` +
            `${STATE.stats.seconds}s`
        );

        console.log(
            `MARKET | ` +
            `${STATE.market.label} | ` +
            `${STATE.market.breadthPct}% breadth | ` +
            `${STATE.market.reason}`
        );

        broadcastStatus();

    }
    catch (error) {

        STATE.lastError =
            error.message;

        console.error(
            'SCAN ERROR:',
            error
        );

    }
    finally {

        STATE.scanning =
            false;
    }
}

// ================================================================
// WEBSOCKET
// ================================================================

function broadcast(payload) {

    const text =
        JSON.stringify(
            payload
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
                client.send(text);
            }
            catch (_) {}
        }
    }
}

function broadcastStatus() {

    broadcast({

        type:
            'status',

        status:
            getStatus()
    });
}

wss.on(
    'connection',
    socket => {

        socket.send(
            JSON.stringify({

                type:
                    'status',

                status:
                    getStatus()
            })
        );
    }
);

// ================================================================
// STATUS OBJECT
// ================================================================

function getStatus() {

    return {

        ok: true,

        engine:
            'SONNY AI TRADER SCALP V5',

        strategy:
            '1H Trend -> 15M Structure -> 3M Breakout -> 3M Retest -> 1M Bonus',

        autoTrade:
            CFG.AUTO_TRADE,

        stats:
            {
                ...STATE.stats,

                lastScan:
                    STATE.lastScan,

                scanning:
                    STATE.scanning
            },

        market:
            STATE.market,

        signals:
            Array.from(
                STATE.signals.values()
            )
                .sort(
                    (a, b) =>
                        b.confidence -
                        a.confidence
                )
                .slice(
                    0,
                    CFG.MAX_SIGNALS
                ),

        pending:
            Array.from(
                STATE.pendingBreakouts.values()
            ).map(
                p => ({
                    symbol:
                        publicSymbol(
                            p.symbol
                        ),

                    direction:
                        p.direction,

                    level:
                        p.level,

                    breakoutPrice:
                        p.breakoutPrice,

                    volumeRatio:
                        p.volumeRatio,

                    status:
                        p.status,

                    createdAt:
                        p.createdAt
                })
            ),

        watchlist:
            STATE.watchlist
                .slice(
                    0,
                    CFG.WATCHLIST_COUNT
                )
                .map(
                    x => ({

                        symbol:
                            publicSymbol(
                                x.symbol
                            ),

                        score:
                            Math.round(
                                x.score
                            ),

                        radarScore:
                            x.radarScore,

                        change24:
                            x.change24,

                        quoteVolume:
                            x.quoteVolume,

                        nearSupport:
                            x.nearSupport,

                        nearResistance:
                            x.nearResistance
                    })
                ),

        lastError:
            STATE.lastError
    };
}

// ================================================================
// API — STATUS
// ================================================================

app.get(
    '/api/status',
    (req, res) => {

        res.json(
            getStatus()
        );
    }
);

// ================================================================
// API — SIGNALS
// ================================================================

app.get(
    '/api/signals',
    (req, res) => {

        const signals =
            Array.from(
                STATE.signals.values()
            )
                .sort(
                    (a, b) =>
                        b.confidence -
                        a.confidence
                )
                .slice(
                    0,
                    CFG.MAX_SIGNALS
                );

        res.json({

            success: true,

            signals,

            count:
                signals.length,

            market:
                STATE.market
        });
    }
);

// ================================================================
// API — SCALP RADAR
// ================================================================

app.get(
    '/api/scalp-radar',
    (req, res) => {

        res.json({

            success: true,

            universe:
                STATE.stats.universe,

            candidates:
                STATE.stats.candidates,

            watchlist:
                STATE.watchlist,

            pending:
                Array.from(
                    STATE.pendingBreakouts.values()
                ),

            signals:
                Array.from(
                    STATE.signals.values()
                ),

            market:
                STATE.market
        });
    }
);

// ================================================================
// API — CHART
// ================================================================

function normalizeChartSymbol(input) {

    const raw =
        String(
            input || ''
        )
            .toUpperCase()
            .replace(/\s+/g, '');

    const base =
        raw
            .replace(
                '/USDT:USDT',
                ''
            )
            .replace(
                '/USDT',
                ''
            )
            .replace(
                'USDT',
                ''
            );

    if (!base) {
        return null;
    }

    const futures =
        `${base}/USDT:USDT`;

    if (
        exchange.markets?.[futures]
    ) {
        return futures;
    }

    const spot =
        `${base}/USDT`;

    if (
        exchange.markets?.[spot]
    ) {
        return spot;
    }

    return futures;
}

app.get(
    '/api/chart',
    async (req, res) => {

        try {

            const symbol =
                normalizeChartSymbol(
                    req.query.symbol
                );

            const allowed =
                [
                    '1m',
                    '3m',
                    '5m',
                    '15m',
                    '1h',
                    '4h'
                ];

            const timeframe =
                allowed.includes(
                    String(
                        req.query.timeframe
                    )
                )
                    ? String(
                        req.query.timeframe
                    )
                    : '3m';

            const limit =
                Math.min(
                    200,
                    Math.max(
                        50,
                        Number(
                            req.query.limit
                        ) || 120
                    )
                );

            if (!symbol) {

                return res
                    .status(400)
                    .json({

                        success:
                            false,

                        error:
                            'Geçersiz sembol.'
                    });
            }

            if (
                !exchange.markets ||
                !Object.keys(
                    exchange.markets
                ).length
            ) {

                await exchange.loadMarkets();
            }

            if (
                !exchange.markets?.[symbol]
            ) {

                return res
                    .status(404)
                    .json({

                        success:
                            false,

                        error:
                            'Market bulunamadı.'
                    });
            }

            const candles =
                await fetchOHLCV(
                    symbol,
                    timeframe,
                    limit
                );

            const ticker =
                await fetchTicker(
                    symbol
                );

            res.json({

                success:
                    true,

                symbol:
                    publicSymbol(
                        symbol
                    ),

                timeframe,

                price:
                    Number(
                        ticker?.last ||
                        candles[
                            candles.length - 1
                        ][4]
                    ),

                candles:
                    candles.map(
                        c => ({

                            time:
                                c[0],

                            open:
                                c[1],

                            high:
                                c[2],

                            low:
                                c[3],

                            close:
                                c[4],

                            volume:
                                c[5]
                        })
                    )
            });

        }
        catch (error) {

            console.error(
                '/api/chart:',
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

// ================================================================
// API — MANUAL ANALYZE
// ================================================================

app.post(
    '/api/analyze-coin',
    async (req, res) => {

        try {

            const input =
                String(
                    req.body.symbol ||
                    ''
                )
                    .toUpperCase()
                    .replace(
                        'USDT',
                        ''
                    )
                    .trim();

            if (!input) {

                return res
                    .status(400)
                    .json({

                        success:
                            false,

                        error:
                            'Sembol gönderilmedi.'
                    });
            }

            const market =
                Object.values(
                    exchange.markets || {}
                ).find(
                    m =>
                        m.base === input &&
                        m.quote === 'USDT' &&
                        m.swap &&
                        m.active !== false
                );

            if (!market) {

                return res
                    .status(404)
                    .json({

                        success:
                            false,

                        error:
                            `${input} USDT perpetual marketi bulunamadı.`
                    });
            }

            const symbol =
                market.symbol;

            const candles1h =
                await fetchOHLCV(
                    symbol,
                    '1h',
                    100
                );

            const candles15 =
                await fetchOHLCV(
                    symbol,
                    '15m',
                    100
                );

            const candles3 =
                await fetchOHLCV(
                    symbol,
                    '3m',
                    100
                );

            const ticker =
                await fetchTicker(
                    symbol
                );

            const price =
                Number(
                    ticker.last
                );

            const t1 =
                technical(
                    candles1h
                );

            const t3 =
                technical(
                    candles3
                );

            const structure =
                buildStructure(
                    candles15,
                    price
                );

            const breakout =
                detectBreakout(
                    symbol,
                    candles3,
                    structure
                );

            const oneM =
                await confirm1M(
                    symbol,
                    breakout?.direction ||
                    (
                        t3?.trend ===
                        'SHORT'
                            ? 'SHORT'
                            : 'LONG'
                    )
                );

            res.json({

                success:
                    true,

                symbol:
                    publicSymbol(
                        symbol
                    ),

                price,

                trend1h:
                    t1?.trend ||
                    'NEUTRAL',

                trend3m:
                    t3?.trend ||
                    'NEUTRAL',

                rsi3m:
                    t3?.rsi || 50,

                adx3m:
                    t3?.adx || 0,

                structure,

                breakout,

                oneMinute:
                    oneM,

                market:
                    STATE.market
            });

        }
        catch (error) {

            console.error(
                'Manual analyze:',
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

// ================================================================
// API — CONFIG
// ================================================================

app.get(
    '/api/config/status',
    (req, res) => {

        res.json({

            engine:
                'SCALP_V5',

            autoTrade:
                CFG.AUTO_TRADE,

            universe:
                CFG.MAX_UNIVERSE,

            candidateCount:
                CFG.CANDIDATE_COUNT,

            watchlistCount:
                CFG.WATCHLIST_COUNT,

            timeframes:
                {
                    context:
                        CFG.TF_CONTEXT,

                    structure:
                        CFG.TF_STRUCTURE,

                    breakout:
                        CFG.TF_BREAKOUT,

                    entry:
                        CFG.TF_ENTRY
                },

            retestMinutes:
                CFG.RETEST_WINDOW_MINUTES,

            minScore:
                CFG.MIN_SIGNAL_SCORE,

            minRR:
                CFG.MIN_RR_TP1
        });
    }
);

// ================================================================
// API — FORCE SCAN
// ================================================================

app.post(
    '/api/scan',
    async (req, res) => {

        if (STATE.scanning) {

            return res.json({

                success:
                    false,

                message:
                    'Tarama zaten çalışıyor.'
            });
        }

        runScan();

        res.json({

            success:
                true,

            message:
                'Scalp radar taraması başlatıldı.'
        });
    }
);

// ================================================================
// ROOT
// ================================================================

app.get(
    '/',
    (req, res) => {

        res.sendFile(
            path.join(
                __dirname,
                'index.html'
            )
        );
    }
);

// ================================================================
// START
// ================================================================

server.listen(
    PORT,
    async () => {

        console.log(
            '\n================================================='
        );

        console.log(
            '🚀 Sonny AI Trader — SCALP ENGINE V5'
        );

        console.log(
            '📡 Bitget USDT Futures'
        );

        console.log(
            '🔭 Radar: 500 coin'
        );

        console.log(
            '🎯 Candidate: 150 coin'
        );

        console.log(
            '👁️ Watchlist: 40 coin'
        );

        console.log(
            '📊 1H Trend + 15M Structure'
        );

        console.log(
            '⚡ 3M Breakout + 3M Retest'
        );

        console.log(
            '🔥 1M Entry Confirmation BONUS'
        );

        console.log(
            '🎯 TP1 >= 1.25R'
        );

        console.log(
            '🛑 Scalp Stop: %0.18 - %0.75'
        );

        console.log(
            '⏱️ Retest Window: 15 dakika'
        );

        console.log(
            '🚫 Otomatik Emir: KAPALI'
        );

        console.log(
            `🌐 Port: ${PORT}`
        );

        console.log(
            '=================================================\n'
        );

        try {

            await exchange.loadMarkets();

            await runScan();

        }
        catch (error) {

            console.error(
                'Startup error:',
                error.message
            );

        }

        // --------------------------------------------------------
        // Ana radar
        // --------------------------------------------------------

        setInterval(
            () => {

                if (
                    !STATE.scanning
                ) {

                    runScan();
                }

            },
            CFG.SCAN_INTERVAL_MS
        );

        // --------------------------------------------------------
        // Pending retestleri daha sık kontrol et.
        // --------------------------------------------------------

        setInterval(
            async () => {

                if (
                    STATE.scanning
                ) {
                    return;
                }

                try {

                    await scanRetests();

                    cleanupState();

                    broadcastStatus();

                }
                catch (_) {}

            },
            15 * 1000
        );

        // --------------------------------------------------------
        // Cleanup
        // --------------------------------------------------------

        setInterval(
            () => {

                cleanupState();

            },
            10 * 1000
        );
    }
);

// ================================================================
// PROCESS SAFETY
// ================================================================

process.on(
    'unhandledRejection',
    error => {

        console.error(
            'UNHANDLED REJECTION:',
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
            'UNCAUGHT EXCEPTION:',
            error
        );

        STATE.lastError =
            error?.message ||
            String(error);
    }
);
