'use strict';

const express = require('express');
const cors = require('cors');
const ccxt = require('ccxt');
const http = require('http');
const WebSocket = require('ws');

// ============================================================
// SONNY AI TRADER
// 2H BREAKOUT + 2H SUPPORT / RESISTANCE + TRIANGLE COMPRESSION
//
// TEK STRATEJİ:
// 2H gerçek breakout
//
// 4H:
// Sadece market regime filtresi.
//
// BREAKOUT:
// Sadece TAMAMLANMIŞ 2H mum kapanışıyla onaylanır.
//
// GRAFİK:
// Son 50 tamamlanmış 2H mum
// Swing High -> direnç trend çizgisi
// Swing Low  -> destek trend çizgisi
// Yakınsama -> üçgen / sıkışma
// ============================================================

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = Number(process.env.PORT || 3000);

app.use(cors());
app.use(express.json());

// ============================================================
// CONFIG
// ============================================================

const CONFIG = {

    // ------------------------------
    // ANA STRATEJİ
    // ------------------------------

    BREAKOUT_TIMEFRAME: '2h',

    LOOKBACK: 50,

    FETCH_LIMIT: 80,

    // %0.10
    BREAKOUT_BUFFER: 0.001,

    // WATCH mesafesi
    WATCH_DISTANCE_PERCENT: 0.60,

    // ------------------------------
    // HACİM
    // ------------------------------

    MIN_VOLUME_RATIO: 1.20,

    MIN_24H_VOLUME_USDT: 500000,

    MAX_TARGETS: 180,

    // ------------------------------
    // ATR
    // ------------------------------

    ATR_PERIOD: 14,

    SL_ATR_MULTIPLIER: 1.20,

    MIN_RR: 1.50,

    TARGET_SPACE_MIN_PERCENT: 0.80,

    // ------------------------------
    // RETEST
    // ------------------------------

    RETEST_REQUIRED: true,

    RETEST_ZONE_ATR: 0.30,

    RETEST_INVALID_ATR: 0.60,

    RETEST_TIMEOUT_MS:
        90 * 60 * 1000,

    // ------------------------------
    // SETUP
    // ------------------------------

    SETUP_EXPIRY_MS:
        14 * 60 * 60 * 1000,

    SIGNAL_KEEP_MS:
        12 * 60 * 60 * 1000,

    MAX_ACTIVE_SETUPS: 80,

    // ------------------------------
    // TARAMA
    // ------------------------------

    SCAN_INTERVAL_MS:
        5 * 60 * 1000,

    LIVE_INTERVAL_MS:
        5000,

    PRESCAN_INTERVAL_MS:
        5 * 60 * 1000,

    API_DELAY_MS:
        120,

    // ------------------------------
    // OI
    // ------------------------------

    OI_ENABLED: true,

    OI_SUPPORTIVE_PCT: 0.10,

    OI_STRONG_PCT: 0.25,

    // ------------------------------
    // COMPRESSION
    // ------------------------------

    COMPRESSION_ENABLED: true,

    COMPRESSION_LOOKBACK: 16,

    COMPRESSION_MAX_ATR_RATIO: 0.72,

    // ------------------------------
    // 4H REGIME
    // ------------------------------

    REGIME_FILTER_ENABLED: true,

    REGIME_TIMEFRAME: '4h',

    REGIME_EMA: 200,

    // ------------------------------
    // RSI
    // ------------------------------

    RSI_CONTEXT_ENABLED: true,

    RSI_PERIOD: 14,

    RSI_LONG_WEAK: 42,

    RSI_SHORT_WEAK: 58,

    // ------------------------------
    // SWING / TRENDLINE
    // ------------------------------

    SWING_LEFT: 2,

    SWING_RIGHT: 2,

    TRIANGLE_MAX_AGE: 28,

    TRIANGLE_MIN_CONVERGENCE_PCT: 0.35,

    DEBUG: true
};

// ============================================================
// BITGET
// ============================================================

const exchange = new ccxt.bitget({

    enableRateLimit: true,

    rateLimit: 250,

    options: {
        defaultType: 'swap'
    }

});

// ============================================================
// GLOBAL STATE
// ============================================================

let targets = [];

let setups = [];

let scanRunning = false;

let isShuttingDown = false;

let lastPrescanAt = 0;

let lastScanAt = 0;

const oiHistory = new Map();

const lastClosed2H = new Map();

const APP_STATE = {

    signals: [],

    scanStatus: {

        message:
            'Sunucu başlatılıyor...',

        isScanning: false

    },

    updatedAt: Date.now()

};

// ============================================================
// DEBUG
// ============================================================

const DEBUG = {

    scanned: 0,

    watchCreated: 0,

    breakouts: 0,

    retests: 0,

    signals: 0,

    noData: 0,

    tooFar: 0,

    lowVolume: 0,

    duplicate: 0,

    invalid: 0,

    expired: 0,

    targetTooClose: 0,

    rejectionReasons: {}

};

// ============================================================
// HELPERS
// ============================================================

function sleep(ms) {

    return new Promise(resolve =>
        setTimeout(resolve, ms)
    );

}

function num(value, decimals = 8) {

    const n = Number(value);

    if (!Number.isFinite(n))
        return null;

    return Number(
        n.toFixed(decimals)
    );

}

function pct(a, b) {

    if (!b)
        return 0;

    return (a / b) * 100;

}

function clamp(value, min, max) {

    return Math.max(
        min,
        Math.min(max, value)
    );

}

function logReject(symbol, reason) {

    DEBUG.rejectionReasons[reason] =
        (DEBUG.rejectionReasons[reason] || 0) + 1;

    if (CONFIG.DEBUG) {

        console.log(
            `[REJECT] ${symbol} -> ${reason}`
        );

    }

}

// ============================================================
// SADECE TAMAMLANMIŞ MUM
// ============================================================

function closedCandles(ohlcv) {

    if (
        !Array.isArray(ohlcv) ||
        ohlcv.length < 2
    ) {

        return [];

    }

    // Son mum açık olabilir.
    // Mutlaka çıkarıyoruz.

    return ohlcv
        .slice(0, -1)
        .filter(
            candle =>
                Array.isArray(candle) &&
                candle.length >= 6
        );

}

// ============================================================
// SMA
// ============================================================

function sma(values, period) {

    if (
        !values ||
        values.length < period
    ) {

        return null;

    }

    const arr =
        values
            .slice(-period)
            .map(Number)
            .filter(Number.isFinite);

    if (arr.length !== period)
        return null;

    return (
        arr.reduce(
            (a, b) => a + b,
            0
        ) / period
    );

}

// ============================================================
// EMA
// ============================================================

function ema(values, period) {

    if (
        !values ||
        values.length < period
    ) {

        return null;

    }

    const arr =
        values.map(Number);

    if (
        arr.some(
            v => !Number.isFinite(v)
        )
    ) {

        return null;

    }

    let result =
        sma(
            arr.slice(0, period),
            period
        );

    if (result == null)
        return null;

    const k =
        2 / (period + 1);

    for (
        let i = period;
        i < arr.length;
        i++
    ) {

        result =
            arr[i] * k +
            result * (1 - k);

    }

    return result;

}

// ============================================================
// ATR
// ============================================================

function atr(candles, period = 14) {

    if (
        !candles ||
        candles.length < period + 1
    ) {

        return null;

    }

    const trueRanges = [];

    for (
        let i = 1;
        i < candles.length;
        i++
    ) {

        const high =
            Number(candles[i][2]);

        const low =
            Number(candles[i][3]);

        const previousClose =
            Number(candles[i - 1][4]);

        if (
            ![
                high,
                low,
                previousClose
            ].every(Number.isFinite)
        ) {

            continue;

        }

        const tr1 =
            high - low;

        const tr2 =
            Math.abs(
                high - previousClose
            );

        const tr3 =
            Math.abs(
                low - previousClose
            );

        trueRanges.push(
            Math.max(
                tr1,
                tr2,
                tr3
            )
        );

    }

    return sma(
        trueRanges,
        period
    );

}

// ============================================================
// RSI
// ============================================================

function rsi(
    closes,
    period = 14
) {

    if (
        !closes ||
        closes.length < period + 1
    ) {

        return null;

    }

    let gain = 0;

    let loss = 0;

    for (
        let i = 1;
        i <= period;
        i++
    ) {

        const diff =
            closes[i] -
            closes[i - 1];

        if (diff >= 0)
            gain += diff;
        else
            loss -= diff;

    }

    gain /= period;

    loss /= period;

    for (
        let i = period + 1;
        i < closes.length;
        i++
    ) {

        const diff =
            closes[i] -
            closes[i - 1];

        const currentGain =
            Math.max(0, diff);

        const currentLoss =
            Math.max(0, -diff);

        gain =
            (
                gain * (period - 1) +
                currentGain
            ) / period;

        loss =
            (
                loss * (period - 1) +
                currentLoss
            ) / period;

    }

    if (loss === 0)
        return 100;

    return (
        100 -
        100 /
        (
            1 +
            gain / loss
        )
    );

}

// ============================================================
// SWING HIGH
// ============================================================

function findSwingHighs(candles) {

    const result = [];

    const left =
        CONFIG.SWING_LEFT;

    const right =
        CONFIG.SWING_RIGHT;

    for (
        let i = left;
        i < candles.length - right;
        i++
    ) {

        const high =
            Number(candles[i][2]);

        if (!Number.isFinite(high))
            continue;

        let valid = true;

        for (
            let j = i - left;
            j <= i + right;
            j++
        ) {

            if (j === i)
                continue;

            if (
                Number(candles[j][2]) >=
                high
            ) {

                valid = false;

                break;

            }

        }

        if (valid) {

            result.push({

                index: i,

                time:
                    candles[i][0],

                price:
                    high

            });

        }

    }

    return result;

}

// ============================================================
// SWING LOW
// ============================================================

function findSwingLows(candles) {

    const result = [];

    const left =
        CONFIG.SWING_LEFT;

    const right =
        CONFIG.SWING_RIGHT;

    for (
        let i = left;
        i < candles.length - right;
        i++
    ) {

        const low =
            Number(candles[i][3]);

        if (!Number.isFinite(low))
            continue;

        let valid = true;

        for (
            let j = i - left;
            j <= i + right;
            j++
        ) {

            if (j === i)
                continue;

            if (
                Number(candles[j][3]) <=
                low
            ) {

                valid = false;

                break;

            }

        }

        if (valid) {

            result.push({

                index: i,

                time:
                    candles[i][0],

                price:
                    low

            });

        }

    }

    return result;

}

// ============================================================
// TRENDLINE
// ============================================================

function lineFromPoints(
    p1,
    p2
) {

    if (
        !p1 ||
        !p2 ||
        p1.index === p2.index
    ) {

        return null;

    }

    const slope =
        (
            p2.price -
            p1.price
        ) /
        (
            p2.index -
            p1.index
        );

    const intercept =
        p1.price -
        slope * p1.index;

    return {

        p1,

        p2,

        slope,

        intercept

    };

}

// ============================================================
// LINE VALUE
// ============================================================

function valueAt(
    line,
    index
) {

    if (!line)
        return null;

    return (
        line.slope *
        index +
        line.intercept
    );

}

// ============================================================
// TRENDLINE SEÇ
// ============================================================

function selectTrendline(
    points,
    type,
    lastIndex
) {

    if (
        points.length < 2
    ) {

        return null;

    }

    const recent =
        points.filter(
            point =>
                lastIndex -
                point.index <=
                CONFIG.TRIANGLE_MAX_AGE
        );

    const pool =
        recent.length >= 2
            ? recent
            : points.slice(-6);

    if (pool.length < 2)
        return null;

    const p2 =
        pool[pool.length - 1];

    const p1 =
        pool[pool.length - 2];

    const line =
        lineFromPoints(
            p1,
            p2
        );

    if (!line)
        return null;

    let contacts = 0;

    for (const point of pool) {

        const projected =
            valueAt(
                line,
                point.index
            );

        if (!projected)
            continue;

        const distance =
            Math.abs(
                point.price -
                projected
            ) /
            point.price;

        if (distance < 0.004)
            contacts++;

    }

    line.contacts = contacts;

    line.type = type;

    line.current =
        valueAt(
            line,
            lastIndex
        );

    line.projected =
        valueAt(
            line,
            lastIndex + 12
        );

    return line;

}

// ============================================================
// ANA STRUCTURE
// ============================================================

function buildStructure(candles) {

    const swingHighs =
        findSwingHighs(candles);

    const swingLows =
        findSwingLows(candles);

    const lastIndex =
        candles.length - 1;

    const resistanceLine =
        selectTrendline(
            swingHighs,
            'RESISTANCE',
            lastIndex
        );

    const supportLine =
        selectTrendline(
            swingLows,
            'SUPPORT',
            lastIndex
        );

    const resistance =
        Math.max(
            ...candles.map(
                c => Number(c[2])
            )
        );

    const support =
        Math.min(
            ...candles.map(
                c => Number(c[3])
            )
        );

    let triangle = null;

    if (
        resistanceLine &&
        supportLine
    ) {

        const resistanceNow =
            valueAt(
                resistanceLine,
                lastIndex
            );

        const supportNow =
            valueAt(
                supportLine,
                lastIndex
            );

        const resistanceFuture =
            valueAt(
                resistanceLine,
                lastIndex + 12
            );

        const supportFuture =
            valueAt(
                supportLine,
                lastIndex + 12
            );

        const currentGap =
            Math.abs(
                resistanceNow -
                supportNow
            );

        const futureGap =
            Math.abs(
                resistanceFuture -
                supportFuture
            );

        const convergencePct =
            currentGap > 0
                ? (
                    1 -
                    futureGap /
                    currentGap
                ) * 100
                : 0;

        const resistanceDown =
            resistanceLine.slope < 0;

        const supportUp =
            supportLine.slope > 0;

        const converging =
            futureGap <
            currentGap;

        if (
            converging &&
            convergencePct >=
                CONFIG.TRIANGLE_MIN_CONVERGENCE_PCT &&
            (
                resistanceDown ||
                supportUp
            )
        ) {

            const denominator =
                resistanceLine.slope -
                supportLine.slope;

            let apexIndex = null;

            if (
                Math.abs(
                    denominator
                ) > 1e-12
            ) {

                apexIndex =
                    (
                        supportLine.intercept -
                        resistanceLine.intercept
                    ) /
                    denominator;

            }

            triangle = {

                type:
                    'CONVERGING',

                convergencePct:
                    num(
                        convergencePct,
                        2
                    ),

                apexIndex:
                    Number.isFinite(
                        apexIndex
                    )
                        ? num(
                            apexIndex,
                            2
                        )
                        : null,

                resistance: {

                    current:
                        num(
                            resistanceNow
                        ),

                    future:
                        num(
                            resistanceFuture
                        ),

                    slope:
                        resistanceLine.slope

                },

                support: {

                    current:
                        num(
                            supportNow
                        ),

                    future:
                        num(
                            supportFuture
                        ),

                    slope:
                        supportLine.slope

                }

            };

        }

    }

    return {

        resistance:
            num(resistance),

        support:
            num(support),

        resistanceLine,

        supportLine,

        swingHighs,

        swingLows,

        triangle,

        lastIndex

    };

}

// ============================================================
// COMPRESSION
// ============================================================

function compressionInfo(candles) {

    if (
        !CONFIG.COMPRESSION_ENABLED
    ) {

        return null;

    }

    const lookback =
        CONFIG.COMPRESSION_LOOKBACK;

    if (
        candles.length <
        lookback +
        CONFIG.ATR_PERIOD +
        2
    ) {

        return null;

    }

    const recent =
        candles.slice(-lookback);

    const previous =
        candles.slice(
            -lookback * 2,
            -lookback
        );

    const recentAtr =
        atr(
            recent,
            Math.min(
                CONFIG.ATR_PERIOD,
                recent.length - 1
            )
        );

    const previousAtr =
        atr(
            previous,
            Math.min(
                CONFIG.ATR_PERIOD,
                previous.length - 1
            )
        );

    if (
        !recentAtr ||
        !previousAtr
    ) {

        return null;

    }

    const ratio =
        recentAtr /
        previousAtr;

    const ranges =
        recent
            .map(
                c =>
                    Number(c[2]) -
                    Number(c[3])
            )
            .filter(Number.isFinite);

    const avgRange =
        sma(
            ranges,
            ranges.length
        );

    const averagePrice =
        sma(
            recent.map(
                c => Number(c[4])
            ),
            recent.length
        );

    const rangePct =
        averagePrice
            ? (
                avgRange /
                averagePrice
            ) * 100
            : null;

    return {

        ratio:
            num(ratio, 3),

        rangePct:
            num(rangePct, 3),

        good:
            ratio <=
            CONFIG.COMPRESSION_MAX_ATR_RATIO

    };

}

// ============================================================
// OI
// ============================================================

async function getOI(symbol) {

    if (
        !CONFIG.OI_ENABLED
    ) {

        return null;

    }

    try {

        if (
            typeof exchange.fetchOpenInterest !==
            'function'
        ) {

            return null;

        }

        const data =
            await exchange.fetchOpenInterest(
                symbol
            );

        const value =
            Number(
                data &&
                (
                    data.openInterestValue ??
                    data.openInterestAmount ??
                    data.baseVolume
                )
            );

        if (
            Number.isFinite(value) &&
            value > 0
        ) {

            return value;

        }

        return null;

    } catch (error) {

        if (CONFIG.DEBUG) {

            console.log(
                `[OI] ${symbol}: ${error.message}`
            );

        }

        return null;

    }

}

// ============================================================
// OI CONTEXT
// ============================================================

function oiContext(
    symbol,
    value,
    direction
) {

    if (!value) {

        return {

            changePct:
                null,

            status:
                'NOT_AVAILABLE'

        };

    }

    const history =
        oiHistory.get(symbol) ||
        [];

    history.push({

        t:
            Date.now(),

        v:
            value

    });

    while (
        history.length > 30
    ) {

        history.shift();

    }

    oiHistory.set(
        symbol,
        history
    );

    if (
        history.length < 2
    ) {

        return {

            changePct:
                null,

            status:
                'NOT_AVAILABLE'

        };

    }

    const previous =
        history[
            history.length - 2
        ].v;

    const change =
        pct(
            value -
            previous,
            previous
        );

    let status =
        'NEUTRAL';

    if (
        direction === 'LONG' &&
        change >=
            CONFIG.OI_SUPPORTIVE_PCT
    ) {

        status =
            'SUPPORTIVE';

    }

    if (
        direction === 'SHORT' &&
        change <=
            -CONFIG.OI_SUPPORTIVE_PCT
    ) {

        status =
            'SUPPORTIVE';

    }

    if (
        direction === 'LONG' &&
        change <=
            -CONFIG.OI_SUPPORTIVE_PCT
    ) {

        status =
            'NOT_SUPPORTIVE';

    }

    if (
        direction === 'SHORT' &&
        change >=
            CONFIG.OI_SUPPORTIVE_PCT
    ) {

        status =
            'NOT_SUPPORTIVE';

    }

    return {

        changePct:
            num(change, 3),

        status

    };

}

// ============================================================
// 4H REGIME
// ============================================================

async function marketRegime(symbol) {

    if (
        !CONFIG.REGIME_FILTER_ENABLED
    ) {

        return 'UNKNOWN';

    }

    try {

        const raw =
            await exchange.fetchOHLCV(
                symbol,
                CONFIG.REGIME_TIMEFRAME,
                undefined,
                CONFIG.REGIME_EMA + 30
            );

        const candles =
            closedCandles(raw);

        const closes =
            candles.map(
                c => Number(c[4])
            );

        if (
            closes.length <
            CONFIG.REGIME_EMA
        ) {

            return 'UNKNOWN';

        }

        const ema200 =
            ema(
                closes,
                CONFIG.REGIME_EMA
            );

        const last =
            closes[
                closes.length - 1
            ];

        if (
            last > ema200
        ) {

            return 'BULLISH';

        }

        if (
            last < ema200
        ) {

            return 'BEARISH';

        }

        return 'SIDEWAYS';

    } catch {

        return 'UNKNOWN';

    }

}

// ============================================================
// NEXT MEANINGFUL LEVEL
// ============================================================

function meaningfulNextLevel(
    candles,
    direction,
    entry
) {

    const highs =
        findSwingHighs(candles)
            .map(
                x => x.price
            )
            .filter(
                price =>
                    price >
                    entry * 1.001
            )
            .sort(
                (a, b) =>
                    a - b
            );

    const lows =
        findSwingLows(candles)
            .map(
                x => x.price
            )
            .filter(
                price =>
                    price <
                    entry * 0.999
            )
            .sort(
                (a, b) =>
                    b - a
            );

    if (
        direction === 'LONG'
    ) {

        return highs[0] || null;

    }

    return lows[0] || null;

}

// ============================================================
// RISK
// ============================================================

function buildRisk(
    candles,
    direction,
    entry,
    structure
) {

    const currentATR =
        atr(
            candles,
            CONFIG.ATR_PERIOD
        );

    if (
        !currentATR ||
        currentATR <= 0
    ) {

        return null;

    }

    let stop;

    if (
        direction === 'LONG'
    ) {

        stop =
            structure.support -
            currentATR *
            CONFIG.SL_ATR_MULTIPLIER;

    } else {

        stop =
            structure.resistance +
            currentATR *
            CONFIG.SL_ATR_MULTIPLIER;

    }

    const risk =
        Math.abs(
            entry -
            stop
        );

    if (
        !Number.isFinite(risk) ||
        risk <= 0
    ) {

        return null;

    }

    const nextLevel =
        meaningfulNextLevel(
            candles,
            direction,
            entry
        );

    const minimumTarget =
        direction === 'LONG'
            ? entry +
              risk *
              CONFIG.MIN_RR
            : entry -
              risk *
              CONFIG.MIN_RR;

    let tp1 =
        minimumTarget;

    if (nextLevel) {

        if (
            direction === 'LONG' &&
            nextLevel > entry
        ) {

            tp1 =
                Math.min(
                    nextLevel * 0.997,
                    minimumTarget
                );

        }

        if (
            direction === 'SHORT' &&
            nextLevel < entry
        ) {

            tp1 =
                Math.max(
                    nextLevel * 1.003,
                    minimumTarget
                );

        }

    }

    const reward =
        Math.abs(
            tp1 -
            entry
        );

    const rr =
        reward /
        risk;

    return {

        atr:
            currentATR,

        stop,

        risk,

        tp1,

        tp2:
            direction === 'LONG'
                ? entry +
                  risk * 2.2
                : entry -
                  risk * 2.2,

        rr,

        nextLevel

    };

}

// ============================================================
// QUALITY SCORE
// ============================================================

function qualityScore(data) {

    let score = 50;

    if (
        data.volumeRatio >= 2
    ) {

        score += 18;

    } else if (
        data.volumeRatio >= 1.5
    ) {

        score += 12;

    } else if (
        data.volumeRatio >=
        CONFIG.MIN_VOLUME_RATIO
    ) {

        score += 6;

    }

    if (
        data.compression &&
        data.compression.good
    ) {

        score += 10;

    }

    if (
        data.triangle
    ) {

        score += 8;

    }

    if (
        data.oiStatus ===
        'SUPPORTIVE'
    ) {

        score += 8;

    }

    if (
        data.oiStatus ===
        'NOT_SUPPORTIVE'
    ) {

        score -= 8;

    }

    if (
        (
            data.direction === 'LONG' &&
            data.regime === 'BULLISH'
        ) ||
        (
            data.direction === 'SHORT' &&
            data.regime === 'BEARISH'
        )
    ) {

        score += 8;

    }

    if (
        (
            data.direction === 'LONG' &&
            data.regime === 'BEARISH'
        ) ||
        (
            data.direction === 'SHORT' &&
            data.regime === 'BULLISH'
        )
    ) {

        score -= 6;

    }

    if (
        data.rr >= 2
    ) {

        score += 5;

    }

    if (
        CONFIG.RSI_CONTEXT_ENABLED &&
        data.rsiValue != null
    ) {

        if (
            data.direction === 'LONG' &&
            data.rsiValue <
                CONFIG.RSI_LONG_WEAK
        ) {

            score -= 5;

        }

        if (
            data.direction === 'SHORT' &&
            data.rsiValue >
                CONFIG.RSI_SHORT_WEAK
        ) {

            score -= 5;

        }

    }

    return Math.round(
        clamp(
            score,
            0,
            100
        )
    );

}

// ============================================================
// ACTIVE SETUP
// ============================================================

function activeFor(symbol) {

    return setups.find(
        setup =>
            setup.symbol === symbol &&
            [
                'WATCH',
                'BREAKOUT_CONFIRMED',
                'RETEST_PENDING',
                'RETEST_CONFIRMED'
            ].includes(
                setup.state
            )
    );

}

// ============================================================
// SERIALIZE LINE
// ============================================================

function serializeLine(line) {

    if (!line)
        return null;

    return {

        p1: {

            index:
                line.p1.index,

            time:
                line.p1.time,

            price:
                num(line.p1.price)

        },

        p2: {

            index:
                line.p2.index,

            time:
                line.p2.time,

            price:
                num(line.p2.price)

        },

        slope:
            line.slope,

        intercept:
            line.intercept,

        current:
            num(line.current),

        projected:
            num(line.projected),

        contacts:
            line.contacts,

        type:
            line.type

    };

}

// ============================================================
// CREATE SETUP
// ============================================================

function makeSetup(
    symbol,
    direction,
    data
) {

    const now =
        Date.now();

    return {

        id:
            `${symbol.replace(
                /[^A-Z0-9]/gi,
                ''
            )}-${direction}-${data.breakoutLevel}-${now}`,

        symbol,

        timeframe:
            '2H',

        direction,

        signalType:
            '2H_BREAKOUT',

        state:
            'WATCH',

        currentPrice:
            num(
                data.currentPrice
            ),

        trigger:
            num(
                data.trigger
            ),

        breakoutLevel:
            num(
                data.breakoutLevel
            ),

        resistance:
            num(
                data.structure.resistance
            ),

        support:
            num(
                data.structure.support
            ),

        resistanceLine:
            serializeLine(
                data.structure.resistanceLine
            ),

        supportLine:
            serializeLine(
                data.structure.supportLine
            ),

        triangle:
            data.structure.triangle,

        swingHighs:
            data.structure.swingHighs,

        swingLows:
            data.structure.swingLows,

        compression:
            data.compression,

        compressionRatio:
            data.compression
                ? data.compression.ratio
                : null,

        volumeRatio:
            num(
                data.volumeRatio,
                3
            ),

        oiChangePct:
            data.oi.changePct,

        oiStatus:
            data.oi.status,

        regime:
            data.regime,

        rsi:
            data.rsi,

        atr:
            num(
                data.risk.atr
            ),

        stop:
            num(
                data.risk.stop
            ),

        tp1:
            num(
                data.risk.tp1
            ),

        tp2:
            num(
                data.risk.tp2
            ),

        rr:
            num(
                data.risk.rr,
                2
            ),

        risk:
            data.risk.risk,

        score:
            data.score,

        retestStatus:
            'PENDING',

        retestTouched:
            false,

        breakoutCandleTime:
            null,

        breakoutClose:
            null,

        breakoutHigh:
            null,

        breakoutLow:
            null,

        createdAt:
            now,

        updatedAt:
            now,

        expiresAt:
            now +
            CONFIG.SETUP_EXPIRY_MS,

        retestPendingSince:
            null,

        retestTouchAt:
            null,

        invalidReason:
            null,

        reason:
            `${direction} 2H WATCH | ` +
            `R:${num(data.structure.resistance)} ` +
            `S:${num(data.structure.support)} | ` +
            `ÜÇGEN:${data.structure.triangle ? 'EVET' : 'HAYIR'}`

    };

}

// ============================================================
// 2H ANALYSIS
// ============================================================

async function analyze2H(symbol) {

    DEBUG.scanned++;

    try {

        const raw =
            await exchange.fetchOHLCV(
                symbol,
                '2h',
                undefined,
                CONFIG.FETCH_LIMIT
            );

        const candles =
            closedCandles(raw);

        if (
            candles.length <
            CONFIG.LOOKBACK + 2
        ) {

            DEBUG.noData++;

            logReject(
                symbol,
                'NO_2H_DATA'
            );

            return null;

        }

        // Son 50 tamamlanmış 2H mum.

        const lookback =
            candles.slice(
                -CONFIG.LOOKBACK
            );

        const structure =
            buildStructure(
                lookback
            );

        const currentPrice =
            Number(
                candles[
                    candles.length - 1
                ][4]
            );

        const longTrigger =
            structure.resistance *
            (
                1 +
                CONFIG.BREAKOUT_BUFFER
            );

        const shortTrigger =
            structure.support *
            (
                1 -
                CONFIG.BREAKOUT_BUFFER
            );

        const longDistance =
            pct(
                longTrigger -
                currentPrice,
                currentPrice
            );

        const shortDistance =
            pct(
                currentPrice -
                shortTrigger,
                currentPrice
            );

        let direction = null;

        let trigger = null;

        let breakoutLevel = null;

        if (
            longDistance >= 0 &&
            longDistance <=
                CONFIG.WATCH_DISTANCE_PERCENT
        ) {

            direction =
                'LONG';

            trigger =
                longTrigger;

            breakoutLevel =
                structure.resistance;

        } else if (
            shortDistance >= 0 &&
            shortDistance <=
                CONFIG.WATCH_DISTANCE_PERCENT
        ) {

            direction =
                'SHORT';

            trigger =
                shortTrigger;

            breakoutLevel =
                structure.support;

        }

        if (!direction) {

            DEBUG.tooFar++;

            logReject(
                symbol,
                'TOO_FAR_FROM_LEVEL'
            );

            return null;

        }

        const risk =
            buildRisk(
                candles,
                direction,
                trigger,
                structure
            );

        if (!risk) {

            logReject(
                symbol,
                'NO_RISK'
            );

            return null;

        }

        const volumes =
            lookback
                .slice(0, -1)
                .map(
                    candle =>
                        Number(candle[5])
                )
                .filter(
                    Number.isFinite
                );

        const averageVolume =
            sma(
                volumes,
                Math.min(
                    30,
                    volumes.length
                )
            );

        const latestVolume =
            Number(
                candles[
                    candles.length - 1
                ][5]
            );

        const volumeRatio =
            averageVolume
                ? latestVolume /
                  averageVolume
                : 0;

        const compression =
            compressionInfo(
                candles
            );

        const regime =
            await marketRegime(
                symbol
            );

        const oiValue =
            await getOI(
                symbol
            );

        const oi =
            oiContext(
                symbol,
                oiValue,
                direction
            );

        const rsiValue =
            rsi(
                candles.map(
                    c => Number(c[4])
                ),
                CONFIG.RSI_PERIOD
            );

        const score =
            qualityScore({

                volumeRatio,

                compression,

                oiStatus:
                    oi.status,

                regime,

                direction,

                rr:
                    risk.rr,

                triangle:
                    structure.triangle,

                rsiValue

            });

        const existing =
            activeFor(symbol);

        if (existing) {

            DEBUG.duplicate++;

            // Aktif setup'ın state'ini
            // kesinlikle resetlemiyoruz.

            existing.currentPrice =
                num(currentPrice);

            existing.resistance =
                structure.resistance;

            existing.support =
                structure.support;

            existing.resistanceLine =
                serializeLine(
                    structure.resistanceLine
                );

            existing.supportLine =
                serializeLine(
                    structure.supportLine
                );

            existing.triangle =
                structure.triangle;

            existing.compression =
                compression;

            existing.compressionRatio =
                compression
                    ? compression.ratio
                    : null;

            existing.volumeRatio =
                num(
                    volumeRatio,
                    3
                );

            existing.updatedAt =
                Date.now();

            return existing;

        }

        const activeCount =
            setups.filter(
                setup =>
                    ![
                        'SIGNAL_READY',
                        'EXPIRED',
                        'CANCELED',
                        'BREAKOUT_INVALID'
                    ].includes(
                        setup.state
                    )
            ).length;

        if (
            activeCount >=
            CONFIG.MAX_ACTIVE_SETUPS
        ) {

            return null;

        }

        const setup =
            makeSetup(
                symbol,
                direction,
                {

                    currentPrice,

                    trigger,

                    breakoutLevel,

                    structure,

                    compression,

                    volumeRatio,

                    oi,

                    regime,

                    rsi:
                        rsiValue,

                    risk,

                    score

                }
            );

        setups.unshift(
            setup
        );

        DEBUG.watchCreated++;

        return setup;

    } catch (error) {

        logReject(
            symbol,
            'INTERNAL_ERROR'
        );

        console.error(
            `[analyze2H] ${symbol}: ${error.message}`
        );

        return null;

    }

}

// ============================================================
// GERÇEK 2H BREAKOUT
//
// ÇOK ÖNEMLİ:
//
// Burada canlı fiyat kullanılmaz.
//
// Sadece son TAMAMLANMIŞ 2H mum.
//
// LONG:
// close > resistance * 1.001
//
// SHORT:
// close < support * 0.999
// ============================================================

async function checkClosed2HBreakouts() {

    const watchSetups =
        setups.filter(
            setup =>
                setup.state === 'WATCH'
        );

    for (
        const setup of watchSetups
    ) {

        try {

            const raw =
                await exchange.fetchOHLCV(
                    setup.symbol,
                    '2h',
                    undefined,
                    CONFIG.FETCH_LIMIT
                );

            const candles =
                closedCandles(raw);

            if (
                candles.length <
                CONFIG.LOOKBACK + 1
            ) {

                continue;

            }

            const last =
                candles[
                    candles.length - 1
                ];

            const timestamp =
                Number(last[0]);

            // Aynı kapanmış mumu
            // ikinci kez işleme.

            if (
                lastClosed2H.get(
                    setup.symbol
                ) === timestamp
            ) {

                continue;

            }

            lastClosed2H.set(
                setup.symbol,
                timestamp
            );

            // BREAKOUT LEVEL,
            // breakout mumundan ÖNCEKİ
            // 50 tamamlanmış mumdan hesaplanır.

            const previousLookback =
                candles.slice(
                    -CONFIG.LOOKBACK - 1,
                    -1
                );

            const structure =
                buildStructure(
                    previousLookback
                );

            const resistance =
                structure.resistance;

            const support =
                structure.support;

            const longTrigger =
                resistance *
                (
                    1 +
                    CONFIG.BREAKOUT_BUFFER
                );

            const shortTrigger =
                support *
                (
                    1 -
                    CONFIG.BREAKOUT_BUFFER
                );

            const close =
                Number(last[4]);

            const high =
                Number(last[2]);

            const low =
                Number(last[3]);

            const volume =
                Number(last[5]);

            const averageVolume =
                sma(
                    previousLookback
                        .map(
                            c => Number(c[5])
                        )
                        .filter(
                            Number.isFinite
                        ),
                    Math.min(
                        30,
                        previousLookback.length
                    )
                );

            const volumeRatio =
                averageVolume
                    ? volume /
                      averageVolume
                    : 0;

            let breakoutConfirmed =
                false;

            // --------------------------------
            // LONG
            // --------------------------------

            if (
                setup.direction === 'LONG'
            ) {

                breakoutConfirmed =
                    close >
                    longTrigger;

                // Wick geçip kapanış
                // altında kaldıysa FALSE BREAKOUT.

                if (
                    !breakoutConfirmed &&
                    high >
                        longTrigger
                ) {

                    setup.invalidReason =
                        'FALSE_BREAKOUT_WICK';

                    logReject(
                        setup.symbol,
                        'FALSE_BREAKOUT_WICK'
                    );

                }

            }

            // --------------------------------
            // SHORT
            // --------------------------------

            else {

                breakoutConfirmed =
                    close <
                    shortTrigger;

                if (
                    !breakoutConfirmed &&
                    low <
                        shortTrigger
                ) {

                    setup.invalidReason =
                        'FALSE_BREAKOUT_WICK';

                    logReject(
                        setup.symbol,
                        'FALSE_BREAKOUT_WICK'
                    );

                }

            }

            if (!breakoutConfirmed) {

                continue;

            }

            // --------------------------------
            // HACİM
            // --------------------------------

            if (
                volumeRatio <
                CONFIG.MIN_VOLUME_RATIO
            ) {

                setup.invalidReason =
                    'LOW_VOLUME';

                DEBUG.lowVolume++;

                logReject(
                    setup.symbol,
                    'LOW_VOLUME'
                );

                continue;

            }

            // --------------------------------
            // BREAKOUT ONAYLANDI
            // --------------------------------

            setup.state =
                CONFIG.RETEST_REQUIRED
                    ? 'RETEST_PENDING'
                    : 'BREAKOUT_CONFIRMED';

            setup.retestPendingSince =
                Date.now();

            setup.breakoutCandleTime =
                timestamp;

            setup.breakoutClose =
                num(close);

            setup.breakoutHigh =
                num(high);

            setup.breakoutLow =
                num(low);

            setup.breakoutLevel =
                num(
                    setup.direction === 'LONG'
                        ? resistance
                        : support
                );

            setup.trigger =
                num(
                    setup.direction === 'LONG'
                        ? longTrigger
                        : shortTrigger
                );

            setup.volumeRatio =
                num(
                    volumeRatio,
                    3
                );

            setup.retestStatus =
                CONFIG.RETEST_REQUIRED
                    ? 'PENDING'
                    : 'NOT_REQUIRED';

            setup.retestTouched =
                false;

            setup.updatedAt =
                Date.now();

            setup.reason =
                `${setup.direction} GERÇEK 2H KAPANIŞ BREAKOUT | ` +
                `close=${num(close)} | ` +
                `level=${num(setup.breakoutLevel)} | ` +
                `volume=${num(volumeRatio, 3)}x`;

            DEBUG.breakouts++;

            console.log(
                `\x1b[33m` +
                `[2H BREAKOUT CONFIRMED] ` +
                `${setup.symbol} ` +
                `${setup.direction} ` +
                `close=${close}` +
                `\x1b[0m`
            );

            if (
                !CONFIG.RETEST_REQUIRED
            ) {

                await finalizeSignal(
                    setup
                );

            }

        } catch (error) {

            console.error(
                `[2H BREAKOUT] ` +
                `${setup.symbol}: ` +
                `${error.message}`
            );

        }

    }

}

// ============================================================
// LIVE PRICE + RETEST
//
// Canlı fiyat burada SADECE RETEST içindir.
//
// Canlı fiyat breakout üretemez.
// ============================================================

async function updateLivePricesAndRetests() {

    let tickers = {};

    try {

        tickers =
            await exchange.fetchTickers();

    } catch (error) {

        console.error(
            `[TICKER] ${error.message}`
        );

        return;

    }

    const now =
        Date.now();

    for (
        const setup of setups
    ) {

        const ticker =
            tickers[
                setup.symbol
            ];

        if (
            ticker &&
            Number(ticker.last) > 0
        ) {

            setup.currentPrice =
                num(ticker.last);

            setup.updatedAt =
                now;

        }

        if (
            [
                'SIGNAL_READY',
                'EXPIRED',
                'CANCELED',
                'BREAKOUT_INVALID'
            ].includes(
                setup.state
            )
        ) {

            continue;

        }

        if (
            now >
            setup.expiresAt
        ) {

            setup.state =
                'EXPIRED';

            setup.invalidReason =
                'EXPIRED';

            setup.finishedAt =
                now;

            DEBUG.expired++;

            continue;

        }

        if (
            ![
                'BREAKOUT_CONFIRMED',
                'RETEST_PENDING'
            ].includes(
                setup.state
            )
        ) {

            continue;

        }

        if (
            !setup.currentPrice ||
            !setup.breakoutLevel
        ) {

            continue;

        }

        if (
            !setup.retestPendingSince
        ) {

            setup.retestPendingSince =
                now;

        }

        if (
            now -
            setup.retestPendingSince >
            CONFIG.RETEST_TIMEOUT_MS
        ) {

            setup.state =
                'EXPIRED';

            setup.invalidReason =
                'RETEST_TIMEOUT';

            setup.finishedAt =
                now;

            DEBUG.expired++;

            continue;

        }

        const price =
            Number(
                setup.currentPrice
            );

        const currentATR =
            Number(
                setup.atr
            ) || 0;

        const zone =
            currentATR *
            CONFIG.RETEST_ZONE_ATR;

        const invalidDistance =
            currentATR *
            CONFIG.RETEST_INVALID_ATR;

        // ========================================
        // LONG RETEST
        // ========================================

        if (
            setup.direction === 'LONG'
        ) {

            // Önce fiyat eski dirence geri dönmeli.

            if (
                price >=
                    setup.breakoutLevel -
                    zone &&
                price <=
                    setup.breakoutLevel +
                    zone
            ) {

                if (
                    price <=
                    setup.breakoutLevel
                ) {

                    setup.retestTouched =
                        true;

                    setup.retestTouchAt =
                        setup.retestTouchAt ||
                        now;

                    setup.retestStatus =
                        'TOUCHING';

                }

            }

            // Dokunduktan sonra tekrar
            // yukarı çıkarsa retest başarılı.

            if (
                setup.retestTouched &&
                price >
                    setup.breakoutLevel +
                    zone * 0.35
            ) {

                setup.state =
                    'RETEST_CONFIRMED';

                setup.retestStatus =
                    'CONFIRMED';

                DEBUG.retests++;

                await finalizeSignal(
                    setup
                );

            }

            // Seviyenin ciddi şekilde
            // altına dönüyorsa breakout bozuldu.

            if (
                price <
                setup.breakoutLevel -
                invalidDistance
            ) {

                invalidateSetup(
                    setup,
                    'BREAKOUT_INVALID_RETEST'
                );

            }

        }

        // ========================================
        // SHORT RETEST
        // ========================================

        else {

            if (
                price >=
                    setup.breakoutLevel -
                    zone &&
                price <=
                    setup.breakoutLevel +
                    zone
            ) {

                if (
                    price >=
                    setup.breakoutLevel
                ) {

                    setup.retestTouched =
                        true;

                    setup.retestTouchAt =
                        setup.retestTouchAt ||
                        now;

                    setup.retestStatus =
                        'TOUCHING';

                }

            }

            // Dokunduktan sonra tekrar
            // aşağı dönüyorsa retest başarılı.

            if (
                setup.retestTouched &&
                price <
                    setup.breakoutLevel -
                    zone * 0.35
            ) {

                setup.state =
                    'RETEST_CONFIRMED';

                setup.retestStatus =
                    'CONFIRMED';

                DEBUG.retests++;

                await finalizeSignal(
                    setup
                );

            }

            if (
                price >
                setup.breakoutLevel +
                invalidDistance
            ) {

                invalidateSetup(
                    setup,
                    'BREAKOUT_INVALID_RETEST'
                );

            }

        }

    }

    cleanSetups();

    broadcast();

}

// ============================================================
// INVALIDATE
// ============================================================

function invalidateSetup(
    setup,
    reason
) {

    setup.state =
        'BREAKOUT_INVALID';

    setup.invalidReason =
        reason;

    setup.finishedAt =
        Date.now();

    DEBUG.invalid++;

}

// ============================================================
// FINAL SIGNAL
// ============================================================

async function finalizeSignal(setup) {

    if (
        setup.state ===
        'SIGNAL_READY'
    ) {

        return;

    }

    const entry =
        Number(
            setup.currentPrice ||
            setup.trigger
        );

    const stop =
        Number(
            setup.stop
        );

    const risk =
        Math.abs(
            entry -
            stop
        );

    if (
        !Number.isFinite(entry) ||
        !Number.isFinite(risk) ||
        risk <= 0
    ) {

        invalidateSetup(
            setup,
            'NO_RISK'
        );

        return;

    }

    const reward =
        Math.abs(
            Number(setup.tp1) -
            entry
        );

    const rr =
        reward /
        risk;

    if (
        rr <
        CONFIG.MIN_RR
    ) {

        setup.invalidReason =
            'RR_TOO_LOW';

        logReject(
            setup.symbol,
            'RR_TOO_LOW'
        );

        return;

    }

    const targetPercent =
        pct(
            reward,
            entry
        );

    if (
        targetPercent <
        CONFIG.TARGET_SPACE_MIN_PERCENT
    ) {

        setup.invalidReason =
            'TARGET_TOO_CLOSE';

        DEBUG.targetTooClose++;

        logReject(
            setup.symbol,
            'TARGET_TOO_CLOSE'
        );

        return;

    }

    setup.state =
        'SIGNAL_READY';

    setup.finishedAt =
        Date.now();

    setup.retestStatus =
        CONFIG.RETEST_REQUIRED
            ? 'CONFIRMED'
            : 'NOT_REQUIRED';

    const signal = {

        id:
            setup.id,

        symbol:
            setup.symbol,

        timeframe:
            '2H',

        direction:
            setup.direction,

        signalType:
            '2H_BREAKOUT',

        entry:
            num(entry),

        stop:
            num(setup.stop),

        tp1:
            num(setup.tp1),

        tp2:
            num(setup.tp2),

        rr:
            num(rr, 2),

        score:
            setup.score,

        breakoutLevel:
            num(
                setup.breakoutLevel
            ),

        breakoutClose:
            setup.breakoutClose,

        volumeRatio:
            setup.volumeRatio,

        oiStatus:
            setup.oiStatus,

        retestStatus:
            setup.retestStatus,

        regime:
            setup.regime,

        compression:
            setup.compression,

        triangle:
            setup.triangle,

        timestamp:
            Date.now()

    };

    APP_STATE.signals.unshift(
        signal
    );

    APP_STATE.signals =
        APP_STATE.signals.slice(
            0,
            50
        );

    DEBUG.signals++;

    console.log(
        `\x1b[32m` +
        `>>> 2H BREAKOUT SİNYALİ ` +
        `${setup.symbol} ` +
        `${setup.direction} ` +
        `@ ${signal.entry} ` +
        `SCORE=${signal.score}` +
        `\x1b[0m`
    );

    broadcast();

}

// ============================================================
// CLEAN
// ============================================================

function cleanSetups() {

    const now =
        Date.now();

    setups =
        setups.filter(
            setup => {

                if (
                    setup.state ===
                    'SIGNAL_READY'
                ) {

                    return (
                        now -
                        (
                            setup.finishedAt ||
                            now
                        )
                    ) <
                    CONFIG.SIGNAL_KEEP_MS;

                }

                if (
                    [
                        'EXPIRED',
                        'CANCELED',
                        'BREAKOUT_INVALID'
                    ].includes(
                        setup.state
                    )
                ) {

                    return (
                        now -
                        (
                            setup.finishedAt ||
                            now
                        )
                    ) <
                    2 * 60 * 60 * 1000;

                }

                return true;

            }
        );

}

// ============================================================
// PRESCAN
// ============================================================

async function runPreScan() {

    try {

        if (
            !exchange.markets ||
            !Object.keys(
                exchange.markets
            ).length
        ) {

            await exchange.loadMarkets(
                true
            );

        }

        const tickers =
            await exchange.fetchTickers(
                undefined,
                {
                    type: 'swap'
                }
            );

        const list = [];

        for (
            const ticker of
            Object.values(
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
                !market.active ||
                !market.swap ||
                market.quote !==
                    'USDT'
            ) {

                continue;

            }

            const volume =
                Number(
                    ticker.quoteVolume
                );

            if (
                Number.isFinite(volume) &&
                volume >=
                    CONFIG.MIN_24H_VOLUME_USDT
            ) {

                list.push({

                    symbol:
                        ticker.symbol,

                    volume

                });

            }

        }

        list.sort(
            (a, b) =>
                b.volume -
                a.volume
        );

        targets =
            list
                .slice(
                    0,
                    CONFIG.MAX_TARGETS
                )
                .map(
                    item =>
                        item.symbol
                );

        lastPrescanAt =
            Date.now();

        console.log(
            `RADAR | ` +
            `${targets.length} coin | ` +
            `2H STRUCTURE`
        );

    } catch (error) {

        console.error(
            `[runPreScan] ${error.message}`
        );

    }

}

// ============================================================
// 2H SCAN
// ============================================================

async function run2HScan() {

    if (scanRunning)
        return;

    scanRunning = true;

    APP_STATE.scanStatus = {

        message:
            `2H yapı taraması: ` +
            `${targets.length} coin`,

        isScanning:
            true

    };

    broadcast();

    try {

        for (
            const symbol of
            targets
        ) {

            if (
                isShuttingDown
            ) {

                break;

            }

            await analyze2H(
                symbol
            );

            await sleep(
                CONFIG.API_DELAY_MS
            );

        }

        // En önemli kısım:
        // KAPANMIŞ 2H mum ile breakout.

        await checkClosed2HBreakouts();

        lastScanAt =
            Date.now();

    } catch (error) {

        console.error(
            `[run2HScan] ${error.message}`
        );

    }

    scanRunning = false;

    APP_STATE.scanStatus = {

        message:
            `2H tarama tamamlandı | ` +
            `${setups.length} setup`,

        isScanning:
            false

    };

    broadcast();

}

// ============================================================
// FULL SCAN
// ============================================================

async function runAll() {

    if (
        Date.now() -
        lastPrescanAt >
        CONFIG.PRESCAN_INTERVAL_MS ||
        !targets.length
    ) {

        await runPreScan();

    }

    await run2HScan();

}

// ============================================================
// SYMBOL NORMALIZE
// ============================================================

function normalizeSymbol(
    input
) {

    let symbol =
        String(
            input || ''
        )
            .trim()
            .toUpperCase();

    if (
        !symbol.includes('/')
    ) {

        if (
            symbol.endsWith(
                'USDT'
            )
        ) {

            symbol =
                symbol.slice(
                    0,
                    -4
                ) +
                '/USDT:USDT';

        }

    }

    return symbol;

}

// ============================================================
// CHART DATA
//
// BURASI GRAFİĞİN TEMELİ.
//
// Frontend'e:
// - 2H mum
// - destek
// - direnç
// - destek trend çizgisi
// - direnç trend çizgisi
// - swing noktaları
// - triangle
//
// gönderiyoruz.
// ============================================================

async function chartData(
    symbol,
    timeframe
) {

    const allowed = [
        '2h',
        '4h',
        '1h',
        '15m',
        '5m'
    ];

    const tf =
        allowed.includes(
            timeframe
        )
            ? timeframe
            : '2h';

    const raw =
        await exchange.fetchOHLCV(
            symbol,
            tf,
            undefined,
            tf === '2h'
                ? 80
                : 100
        );

    const candles =
        closedCandles(raw);

    let structure = null;

    if (
        tf === '2h' &&
        candles.length >=
            CONFIG.LOOKBACK
    ) {

        structure =
            buildStructure(
                candles.slice(
                    -CONFIG.LOOKBACK
                )
            );

    }

    return {

        success:
            true,

        symbol,

        timeframe:
            tf,

        candles:
            candles.slice(-80),

        structure:
            structure
                ? {

                    resistance:
                        structure.resistance,

                    support:
                        structure.support,

                    resistanceLine:
                        serializeLine(
                            structure.resistanceLine
                        ),

                    supportLine:
                        serializeLine(
                            structure.supportLine
                        ),

                    triangle:
                        structure.triangle,

                    swingHighs:
                        structure.swingHighs,

                    swingLows:
                        structure.swingLows

                }
                : null

    };

}

// ============================================================
// API
// ============================================================

app.get(
    '/api/setups',
    (req, res) => {

        res.json(
            snapshot()
        );

    }
);

app.get(
    '/api/debug',
    (req, res) => {

        res.json({

            success:
                true,

            debug:
                DEBUG,

            config:
                CONFIG,

            rejectionReasons:
                DEBUG.rejectionReasons

        });

    }
);

app.get(
    '/api/health',
    (req, res) => {

        res.json({

            ok:
                true,

            time:
                Date.now(),

            targets:
                targets.length,

            setups:
                setups.length

        });

    }
);

app.get(
    '/api/chart',
    async (req, res) => {

        try {

            const symbol =
                normalizeSymbol(
                    req.query.symbol
                );

            const data =
                await chartData(
                    symbol,
                    req.query.timeframe
                );

            res.json(data);

        } catch (error) {

            res.status(500)
                .json({

                    success:
                        false,

                    error:
                        error.message

                });

        }

    }
);

app.post(
    '/api/analyze-coin',
    async (req, res) => {

        try {

            const symbol =
                normalizeSymbol(
                    req.body.symbol
                );

            if (!symbol) {

                return res
                    .status(400)
                    .json({

                        success:
                            false,

                        error:
                            'Sembol eksik'

                    });

            }

            const setup =
                await analyze2H(
                    symbol
                );

            res.json({

                success:
                    true,

                setup,

                message:
                    setup
                        ? '2H WATCH oluşturuldu / güncellendi'
                        : 'Bu seviyede WATCH oluşmadı'

            });

        } catch (error) {

            res.status(500)
                .json({

                    success:
                        false,

                    error:
                        error.message

                });

        }

    }
);

// ============================================================
// SNAPSHOT
// ============================================================

function snapshot() {

    APP_STATE.updatedAt =
        Date.now();

    return {

        success:
            true,

        setups:
            setups.slice(
                0,
                100
            ),

        signals:
            APP_STATE.signals,

        scanStatus:
            APP_STATE.scanStatus,

        stats: {

            total:
                setups.length,

            watch:
                setups.filter(
                    x =>
                        x.state ===
                        'WATCH'
                ).length,

            breakout:
                setups.filter(
                    x =>
                        [
                            'BREAKOUT_CONFIRMED',
                            'RETEST_PENDING'
                        ].includes(
                            x.state
                        )
                ).length,

            signal:
                setups.filter(
                    x =>
                        x.state ===
                        'SIGNAL_READY'
                ).length,

            triangle:
                setups.filter(
                    x =>
                        !!x.triangle
                ).length

        },

        updatedAt:
            APP_STATE.updatedAt

    };

}

// ============================================================
// BROADCAST
// ============================================================

function broadcast() {

    const message =
        JSON.stringify({

            type:
                'update',

            data:
                snapshot()

        });

    wss.clients.forEach(
        client => {

            if (
                client.readyState ===
                WebSocket.OPEN
            ) {

                client.send(
                    message
                );

            }

        }
    );

}

// ============================================================
// WEBSOCKET
// ============================================================

wss.on(
    'connection',
    socket => {

        socket.send(
            JSON.stringify({

                type:
                    'snapshot',

                data:
                    snapshot()

            })
        );

    }
);

// ============================================================
// FRONTEND
// ============================================================

const HTML = `

<!doctype html>

<html lang="tr">

<head>

<meta charset="utf-8">

<meta
name="viewport"
content="width=device-width,initial-scale=1"
>

<title>
SONNY AI TRADER — 2H BREAKOUT
</title>

<style>

*{
box-sizing:border-box
}

body{

margin:0;

background:#070b11;

color:#e9eef5;

font-family:Arial,sans-serif

}

.wrap{

max-width:1500px;

margin:auto;

padding:12px

}

.top{

display:flex;

justify-content:space-between;

align-items:center;

border-bottom:1px solid #17202b;

padding-bottom:10px

}

.brand{

font-size:18px;

font-weight:800

}

.status{

font-size:11px;

color:#9aa7b5

}

.grid{

display:grid;

grid-template-columns:330px 1fr;

gap:12px;

margin-top:12px

}

@media(max-width:900px){

.grid{

grid-template-columns:1fr

}

}

.panel{

background:#0b1119;

border:1px solid #17212d;

border-radius:10px;

overflow:hidden

}

.list{

max-height:78vh;

overflow:auto

}

.card{

padding:12px;

border-bottom:1px solid #17212d;

cursor:pointer

}

.card:hover,
.card.sel{

background:#101923

}

.row{

display:flex;

justify-content:space-between;

gap:8px

}

.coin{

font-weight:800

}

.long{

color:#17d7a0

}

.short{

color:#ff5c77

}

.state{

font-size:10px;

color:#9aa7b5

}

.meta{

font-size:10px;

color:#7f8b98;

margin-top:7px;

display:flex;

gap:8px;

flex-wrap:wrap

}

.main{

padding:10px

}

.chartHead{

display:flex;

justify-content:space-between;

align-items:center;

margin-bottom:7px

}

.chart{

height:65vh;

min-height:420px

}

canvas{

width:100%;

height:100%;

display:block;

background:#070b11

}

.details{

border-top:1px solid #17212d;

margin-top:10px;

padding-top:10px;

display:grid;

grid-template-columns:
repeat(4,1fr);

gap:7px

}

@media(max-width:800px){

.details{

grid-template-columns:
repeat(2,1fr)

}

}

.d{

background:#0e151e;

border-radius:7px;

padding:8px

}

.d span{

display:block;

font-size:9px;

color:#7f8b98

}

.d b{

font-size:12px

}

.legend{

font-size:10px;

color:#8d9aa8

}

.badge{

padding:4px 7px;

border-radius:5px;

font-size:10px;

font-weight:700

}

.tri{

color:#f6c453

}

</style>

</head>

<body>

<div class="wrap">

<div class="top">

<div class="brand">

SONNY AI TRADER — 2H BREAKOUT

</div>

<div
id="status"
class="status"
>
Bağlanıyor...
</div>

</div>

<div class="grid">

<div class="panel">

<div
class="list"
id="list"
>
</div>

</div>

<div class="panel main">

<div class="chartHead">

<b id="title">
2H YAPI
</b>

<span class="legend">

YEŞİL DESTEK
•
KIRMIZI DİRENÇ
•
SARI ÜÇGEN / SIKIŞMA

</span>

</div>

<div class="chart">

<canvas id="cv"></canvas>

</div>

<div
id="details"
class="details"
>
</div>

</div>

</div>

</div>

<script>

let setups=[];

let selected=null;

let chart=null;

let ws=null;


// ==========================================
// FORMAT
// ==========================================

function fmt(v){

v=Number(v);

if(!Number.isFinite(v))
return '-';

if(v>=1000)
return v.toFixed(2);

if(v>=100)
return v.toFixed(3);

if(v>=1)
return v.toFixed(5);

return v.toFixed(8);

}


// ==========================================
// ESCAPE
// ==========================================

function esc(v){

return String(
v??''
).replace(
/[&<>"']/g,
c=>({

'&':'&amp;',
'<':'&lt;',
'>':'&gt;',
'"':'&quot;',
"'":'&#39;'

}[c])
);

}


// ==========================================
// RENDER LIST
// ==========================================

function render(){

const list=
document.getElementById(
'list'
);

if(!setups.length){

list.innerHTML=
'<div style="padding:20px;color:#7f8b98">Şu an WATCH / BREAKOUT setup yok.</div>';

return;

}

list.innerHTML=
setups.map(
s=>`

<div
class="card
${selected &&
selected.id===s.id
?'sel':''}"
data-id="${esc(s.id)}"
>

<div class="row">

<span class="coin">

${esc(
s.symbol.replace(
':USDT',
''
)
)}

</span>

<b
class="${
s.direction==='LONG'
?'long'
:'short'
}"
>

${s.direction}

</b>

</div>

<div
style="margin-top:5px"
>

<span class="badge">

${esc(
s.state
)}

</span>

${
s.triangle
?
'<span class="badge tri">▲ ÜÇGEN / SIKIŞMA</span>'
:''
}

</div>

<div class="meta">

<span>
Skor ${esc(s.score)}
</span>

<span>
Vol ${esc(s.volumeRatio)}x
</span>

<span>
R ${fmt(s.resistance)}
</span>

<span>
S ${fmt(s.support)}
</span>

</div>

</div>

`
).join('');

document
.querySelectorAll(
'.card'
)
.forEach(
card=>{

card.onclick=
()=>{

selected=
setups.find(
s=>
s.id===
card.dataset.id
)||null;

render();

if(selected)
loadChart(
selected.symbol
);

};

}
);

}


// ==========================================
// TREND LINE DRAW
// ==========================================

function drawTrendLine(
ctx,
line,
X,
Y,
visibleCount,
offset,
type
){

if(
!line ||
!line.p1 ||
!line.p2
)
return;

const startIndex=0;

const endIndex=
visibleCount-1;

const startGlobal=
startIndex+
offset;

const endGlobal=
endIndex+
offset;

const y1=
Y(
line.slope*
startGlobal+
line.intercept
);

const y2=
Y(
line.slope*
endGlobal+
line.intercept
);

ctx.save();

ctx.strokeStyle=
type==='RESISTANCE'
?'#ff5c77'
:'#17d7a0';

ctx.lineWidth=2;

ctx.setLineDash(
[8,5]
);

ctx.beginPath();

ctx.moveTo(
X(startIndex),
y1
);

ctx.lineTo(
X(endIndex),
y2
);

ctx.stroke();

ctx.restore();

}


// ==========================================
// DRAW CHART
// ==========================================

function draw(){

const canvas=
document.getElementById(
'cv'
);

if(
!chart ||
!chart.candles ||
!chart.candles.length
)
return;

const parent=
canvas.parentElement;

const width=
parent.clientWidth;

const height=
parent.clientHeight;

const dpr=
window.devicePixelRatio||
1;

canvas.width=
width*dpr;

canvas.height=
height*dpr;

canvas.style.width=
width+'px';

canvas.style.height=
height+'px';

const ctx=
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

ctx.fillStyle=
'#070b11';

ctx.fillRect(
0,
0,
width,
height
);


// ------------------------------------------
// VISIBLE CANDLES
// ------------------------------------------

const visible=
chart.candles.slice(
-60
);

const count=
visible.length;


// ------------------------------------------
// RANGE
// ------------------------------------------

let minPrice=
Math.min(
...visible.map(
c=>Number(c[3])
)
);

let maxPrice=
Math.max(
...visible.map(
c=>Number(c[2])
)
);

const structure=
chart.structure;

if(structure){

[
structure.resistance,
structure.support,
structure.resistanceLine?.current,
structure.supportLine?.current,
structure.resistanceLine?.projected,
structure.supportLine?.projected
]
.forEach(
value=>{

if(
value &&
value<minPrice
)
minPrice=value;

if(
value &&
value>maxPrice
)
maxPrice=value;

}
);

}

const padding=
(
maxPrice-minPrice
)*0.08||
1;

minPrice-=padding;

maxPrice+=padding;


// ------------------------------------------
// AREA
// ------------------------------------------

const LEFT=50;

const RIGHT=115;

const TOP=15;

const BOTTOM=18;

const PW=
width-
LEFT-
RIGHT;

const PH=
height-
TOP-
BOTTOM;

function X(index){

return LEFT+
index*
PW/
(count-1||1);

}

function Y(price){

return TOP+
(
maxPrice-price
)/
(
maxPrice-minPrice
)*
PH;

}


// ------------------------------------------
// GRID
// ------------------------------------------

ctx.font=
'9px Arial';

ctx.fillStyle=
'#607083';

for(
let i=0;
i<=5;
i++
){

const y=
TOP+
PH*i/5;

ctx.strokeStyle=
'#16212c';

ctx.beginPath();

ctx.moveTo(
LEFT,
y
);

ctx.lineTo(
width-RIGHT,
y
);

ctx.stroke();

ctx.fillText(
fmt(
maxPrice-
(
maxPrice-minPrice
)*i/5
),
5,
y+3
);

}


// ------------------------------------------
// CANDLES
// ------------------------------------------

const candleWidth=
Math.max(
2,
Math.min(
9,
PW/count*.65
)
);

visible.forEach(
(candle,index)=>{

const x=
X(index);

const open=
Number(candle[1]);

const close=
Number(candle[4]);

const high=
Number(candle[2]);

const low=
Number(candle[3]);

const bullish=
close>=open;

const color=
bullish
?'#17d7a0'
:'#ff5c77';

ctx.strokeStyle=
color;

ctx.fillStyle=
color;

ctx.beginPath();

ctx.moveTo(
x,
Y(high)
);

ctx.lineTo(
x,
Y(low)
);

ctx.stroke();

const openY=
Y(open);

const closeY=
Y(close);

ctx.fillRect(
x-candleWidth/2,
Math.min(
openY,
closeY
),
candleWidth,
Math.max(
1,
Math.abs(
closeY-openY
)
)
);

});


// ------------------------------------------
// TRENDLINES
// ------------------------------------------

if(structure){

const offset=
chart.candles.length-
count;

drawTrendLine(
ctx,
structure.resistanceLine,
X,
Y,
count,
offset,
'RESISTANCE'
);

drawTrendLine(
ctx,
structure.supportLine,
X,
Y,
count,
offset,
'SUPPORT'
);


// ------------------------------------------
// TRIANGLE
// ------------------------------------------

if(
structure.triangle &&
structure.resistanceLine &&
structure.supportLine
){

ctx.save();

ctx.strokeStyle=
'#f6c453';

ctx.lineWidth=1.5;

ctx.setLineDash(
[4,4]
);

const startGlobal=
offset;

const endGlobal=
offset+
count-1;

ctx.beginPath();

ctx.moveTo(
X(0),
Y(
structure.resistanceLine.slope*
startGlobal+
structure.resistanceLine.intercept
)
);

ctx.lineTo(
X(count-1),
Y(
structure.resistanceLine.slope*
endGlobal+
structure.resistanceLine.intercept
)
);

ctx.stroke();

ctx.beginPath();

ctx.moveTo(
X(0),
Y(
structure.supportLine.slope*
startGlobal+
structure.supportLine.intercept
)
);

ctx.lineTo(
X(count-1),
Y(
structure.supportLine.slope*
endGlobal+
structure.supportLine.intercept
)
);

ctx.stroke();

ctx.restore();


// TRIANGLE LABEL

ctx.save();

ctx.font=
'bold 10px Arial';

ctx.fillStyle=
'#f6c453';

ctx.fillText(
'SIKIŞMA / ÜÇGEN',
LEFT+8,
TOP+15
);

ctx.restore();

}


// ------------------------------------------
// HORIZONTAL EXTREMES
// ------------------------------------------

ctx.save();

ctx.font=
'bold 10px Arial';

ctx.fillStyle=
'#ff5c77';

ctx.fillText(
'DIR '+fmt(
structure.resistance
),
width-RIGHT+5,
Y(
structure.resistance
)+3
);

ctx.fillStyle=
'#17d7a0';

ctx.fillText(
'DES '+fmt(
structure.support
),
width-RIGHT+5,
Y(
structure.support
)+3
);

ctx.restore();

}


// ==========================================
// DETAILS
// ==========================================

if(selected){

const values=[

['DURUM',selected.state],

['YÖN',selected.direction],

['GİRİŞ',fmt(selected.trigger)],

['STOP',fmt(selected.stop)],

['TP1',fmt(selected.tp1)],

['TP2',fmt(selected.tp2)],

['RR',selected.rr],

['SKOR',selected.score],

['VOL',selected.volumeRatio+'x'],

['OI',selected.oiStatus],

['RETEST',selected.retestStatus],

['REGIME',selected.regime]

];

document.getElementById(
'details'
).innerHTML=
values.map(
item=>`

<div class="d">

<span>
${item[0]}
</span>

<b>
${esc(item[1])}
</b>

</div>

`
).join('');

}

}


// ==========================================
// LOAD CHART
// ==========================================

async function loadChart(
symbol
){

try{

const response=
await fetch(
'/api/chart?symbol='+
encodeURIComponent(
symbol
)+
'&timeframe=2h'
);

const data=
await response.json();

if(
data.success
){

chart=data;

document.getElementById(
'title'
).textContent=
symbol.replace(
':USDT',
''
)+
' — 2H DESTEK / DİRENÇ / SIKIŞMA';

draw();

}

}catch(error){

console.error(error);

}

}


// ==========================================
// APPLY DATA
// ==========================================

function apply(data){

setups=
Array.isArray(
data.setups
)
?data.setups
:[];

if(selected){

selected=
setups.find(
s=>
s.id===
selected.id
)||selected;

}

render();

draw();

document.getElementById(
'status'
).textContent=
(
data.scanStatus?.message||
'Hazır'
)+
' | '+
new Date()
.toLocaleTimeString(
'tr-TR'
);

}


// ==========================================
// WEBSOCKET
// ==========================================

function connect(){

const protocol=
location.protocol===
'https:'
?'wss://'
:'ws://';

ws=
new WebSocket(
protocol+
location.host
);

ws.onopen=
()=>{

document.getElementById(
'status'
).textContent=
'CANLI';

};

ws.onmessage=
event=>{

try{

const message=
JSON.parse(
event.data
);

if(
message.type===
'snapshot'
){

apply(
message.data
);

}

if(
message.type===
'update'
){

apply(
message.data
);

}

}catch(error){

console.error(error);

}

};

ws.onclose=
()=>{

document.getElementById(
'status'
).textContent=
'Bağlantı yenileniyor...';

setTimeout(
connect,
3000
);

};

}


// ==========================================
// INITIAL
// ==========================================

fetch(
'/api/setups'
)
.then(
response=>
response.json()
)
.then(
apply
)
.catch(
()=>{}
);

connect();

window.addEventListener(
'resize',
draw
);

</script>

</body>

</html>

`;


// ============================================================
// ROOT
// ============================================================

app.get(
    '/',
    (req, res) => {

        res.type('html')
            .send(HTML);

    }
);

// ============================================================
// START
// ============================================================

async function start() {

    try {

        await exchange.loadMarkets();

        console.log(
            `Bitget marketleri yüklendi | ` +
            `${Object.keys(exchange.markets).length} market`
        );

        await runPreScan();

        await run2HScan();

        setInterval(
            () => {
                void runAll();
            },
            CONFIG.SCAN_INTERVAL_MS
        );

        setInterval(
            () => {
                void updateLivePricesAndRetests();
            },
            CONFIG.LIVE_INTERVAL_MS
        );

        setInterval(
            () => {
                void runPreScan();
            },
            CONFIG.PRESCAN_INTERVAL_MS
        );

        console.log(
            'SONNY 2H döngüleri başlatıldı.'
        );

    } catch (error) {

        console.error(
            `[START] ${error.message}`
        );

        setTimeout(
            start,
            30000
        );

    }

}

// ============================================================
// SHUTDOWN
// ============================================================

async function shutdown(
    signal
) {

    if (
        isShuttingDown
    ) {

        return;

    }

    isShuttingDown =
        true;

    console.log(
        `${signal} alındı; kapanıyor.`
    );

    wss.clients.forEach(
        client =>
            client.close()
    );

    wss.close();

    server.close(
        async () => {

            try {

                await exchange.close();

            } catch {}

            process.exit(0);

        }
    );

    setTimeout(
        () => process.exit(1),
        10000
    ).unref();

}

process.once(
    'SIGINT',
    () =>
        shutdown('SIGINT')
);

process.once(
    'SIGTERM',
    () =>
        shutdown('SIGTERM')
);

// ============================================================
// LISTEN
// ============================================================

server.listen(
    PORT,
    '0.0.0.0',
    () => {

        console.log(
            `SONNY 2H Breakout Engine ` +
            `PORT=${PORT}`
        );

        void start();

    }
);
