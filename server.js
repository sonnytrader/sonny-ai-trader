'use strict';

/*
===============================================================
 SONNY AI TRADER V5
 SCALP RADAR ENGINE

 500 COIN
    ↓
 150 CANDIDATE
    ↓
 40 DEEP WATCH
    ↓
 15M STRUCTURE
    ↓
 3M BREAKOUT
    ↓
 3M RETEST
    ↓
 1M CONFIRM BONUS
    ↓
 SCALP SIGNAL

 LONG:
 Resistance BREAK → Retest → LONG

 SHORT:
 Support BREAK → Retest → SHORT

 AUTO TRADE: OFF
===============================================================
*/

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const path = require('path');

// ===============================================================
// APP
// ===============================================================

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PORT || 10000);

// ===============================================================
// EXCHANGE
// ===============================================================

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

// ===============================================================
// CONFIG
// ===============================================================

const CFG = {

    // -----------------------------------------------------------
    // RADAR
    // -----------------------------------------------------------

    MAX_UNIVERSE: 500,

    CANDIDATES: 150,

    DEEP_WATCH: 40,

    MAX_SIGNALS: 15,

    // -----------------------------------------------------------
    // SCAN
    // -----------------------------------------------------------

    FULL_RADAR_MS: 60 * 1000,

    DEEP_SCAN_MS: 20 * 1000,

    RETEST_CHECK_MS: 10 * 1000,

    CLEANUP_MS: 5 * 1000,

    // Her deep scan'de farklı 40 coin.
    ROTATION_SIZE: 40,

    // -----------------------------------------------------------
    // MINIMUM MARKET QUALITY
    // -----------------------------------------------------------

    MIN_24H_VOLUME: 2_000_000,

    MIN_PRICE: 0.0000001,

    // Çok geniş spread scalp için anlamsız.
    MAX_SPREAD_PERCENT: 0.45,

    // -----------------------------------------------------------
    // TIMEFRAMES
    // -----------------------------------------------------------

    TF_1H: '1h',

    TF_15M: '15m',

    TF_3M: '3m',

    TF_1M: '1m',

    // -----------------------------------------------------------
    // CANDLE LIMITS
    // -----------------------------------------------------------

    LIMIT_1H: 120,

    LIMIT_15M: 100,

    LIMIT_3M: 100,

    LIMIT_1M: 50,

    // -----------------------------------------------------------
    // STRUCTURE
    // -----------------------------------------------------------

    PIVOT_LEFT: 2,

    PIVOT_RIGHT: 2,

    STRUCTURE_LOOKBACK: 60,

    LEVEL_CLUSTER_PERCENT: 0.20,

    // Fiyat seviyeye bu kadar yakındaysa aday.
    LEVEL_PROXIMITY_PERCENT: 1.20,

    // -----------------------------------------------------------
    // BREAKOUT
    // -----------------------------------------------------------

    BREAKOUT_LOOKBACK: 20,

    BREAKOUT_BUFFER_PERCENT: 0.05,

    BREAKOUT_VOLUME_RATIO: 1.20,

    // -----------------------------------------------------------
    // RETEST
    // -----------------------------------------------------------

    RETEST_WINDOW_MINUTES: 15,

    RETEST_TOLERANCE_PERCENT: 0.22,

    RETEST_INVALIDATION_PERCENT: 0.35,

    // -----------------------------------------------------------
    // 1M
    // -----------------------------------------------------------

    REQUIRE_1M: false,

    ONE_M_VOLUME_RATIO: 1.10,

    ONE_M_MOMENTUM_PERCENT: 0.04,

    // -----------------------------------------------------------
    // SCORE
    // -----------------------------------------------------------

    MIN_SCORE: 67,

    GOOD_SCORE: 78,

    ELITE_SCORE: 88,

    // -----------------------------------------------------------
    // SCALP RISK
    // -----------------------------------------------------------

    MIN_STOP_PERCENT: 0.18,

    MAX_STOP_PERCENT: 0.80,

    MIN_RR: 1.20,

    // -----------------------------------------------------------
    // SIGNAL LIFE
    // -----------------------------------------------------------

    SIGNAL_TTL_MINUTES: 30,

    COOLDOWN_MINUTES: 20,

    // -----------------------------------------------------------
    // MARKET
    // -----------------------------------------------------------

    BULL_BREADTH: 62,

    BEAR_BREADTH: 38,

    // -----------------------------------------------------------
    // AUTO TRADE
    // -----------------------------------------------------------

    AUTO_TRADE: false
};

// ===============================================================
// STATE
// ===============================================================

const STATE = {

    universe: [],

    candidates: [],

    deepWatch: [],

    rotationIndex: 0,

    pendingBreakouts: new Map(),

    signals: new Map(),

    cooldowns: new Map(),

    candlesCache: new Map(),

    tickerCache: new Map(),

    market: {

        label: 'ANALİZ EDİLİYOR',

        direction: 'NEUTRAL',

        breadthPct: 50,

        green: 0,

        red: 0,

        neutral: 0,

        averageMove: 0,

        btcTrend: 'NEUTRAL',

        ethTrend: 'NEUTRAL',

        reason: ''
    },

    stats: {

        universe: 0,

        candidates: 0,

        deepWatch: 0,

        analyzed: 0,

        pending: 0,

        signals: 0,

        lastScan: 0,

        lastRadar: 0,

        scanSeconds: 0
    },

    scanning: false,

    radarRunning: false,

    lastError: null
};

// ===============================================================
// UTILITY
// ===============================================================

function now() {
    return Date.now();
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function average(arr) {

    const values = arr
        .map(Number)
        .filter(Number.isFinite);

    if (!values.length) return 0;

    return values.reduce(
        (a, b) => a + b,
        0
    ) / values.length;
}

function percentChange(a, b) {

    if (
        !Number.isFinite(a) ||
        !Number.isFinite(b) ||
        b === 0
    ) {
        return 0;
    }

    return (
        (a - b) /
        b *
        100
    );
}

function absPercent(a, b) {
    return Math.abs(
        percentChange(a, b)
    );
}

function normalizeSymbol(symbol) {

    return String(symbol || '')
        .replace(':USDT', '')
        .replace('/USDT', '')
        .replace('USDT', '')
        .toUpperCase();
}

function displaySymbol(symbol) {
    return `${normalizeSymbol(symbol)}USDT`;
}

function lastClosed(candles) {

    if (
        !Array.isArray(candles) ||
        candles.length < 3
    ) {
        return null;
    }

    return candles[candles.length - 2];
}

function previousClosed(candles) {

    if (
        !Array.isArray(candles) ||
        candles.length < 4
    ) {
        return null;
    }

    return candles[candles.length - 3];
}

function roundPrice(symbol, value) {

    if (!Number.isFinite(value)) {
        return 0;
    }

    try {

        const market =
            exchange.markets?.[symbol];

        if (
            market?.precision?.price !== undefined
        ) {

            const precision =
                market.precision.price;

            if (
                Number.isInteger(
                    precision
                )
            ) {

                return Number(
                    value.toFixed(
                        precision
                    )
                );
            }
        }

    }
    catch (_) {}

    if (value < 0.001) {
        return Number(
            value.toFixed(8)
        );
    }

    if (value < 0.01) {
        return Number(
            value.toFixed(7)
        );
    }

    if (value < 1) {
        return Number(
            value.toFixed(6)
        );
    }

    if (value < 10) {
        return Number(
            value.toFixed(4)
        );
    }

    return Number(
        value.toFixed(2)
    );
}

// ===============================================================
// INDICATORS
// ===============================================================

function calculateEMA(values, period) {

    if (
        !values ||
        values.length < period
    ) {
        return null;
    }

    const k =
        2 /
        (period + 1);

    let ema =
        average(
            values.slice(
                0,
                period
            )
        );

    for (
        let i = period;
        i < values.length;
        i++
    ) {

        ema =
            values[i] * k +
            ema * (1 - k);
    }

    return ema;
}

function calculateRSI(
    closes,
    period = 14
) {

    if (
        !closes ||
        closes.length <
        period + 2
    ) {
        return 50;
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

        if (diff >= 0) {
            gain += diff;
        }
        else {
            loss += Math.abs(diff);
        }
    }

    let avgGain =
        gain / period;

    let avgLoss =
        loss / period;

    for (
        let i = period + 1;
        i < closes.length;
        i++
    ) {

        const diff =
            closes[i] -
            closes[i - 1];

        if (diff >= 0) {

            avgGain =
                (
                    avgGain *
                    (period - 1) +
                    diff
                ) /
                period;

            avgLoss =
                (
                    avgLoss *
                    (period - 1)
                ) /
                period;

        }
        else {

            avgGain =
                (
                    avgGain *
                    (period - 1)
                ) /
                period;

            avgLoss =
                (
                    avgLoss *
                    (period - 1) +
                    Math.abs(diff)
                ) /
                period;
        }
    }

    if (avgLoss === 0) {
        return 100;
    }

    const rs =
        avgGain /
        avgLoss;

    return (
        100 -
        100 /
        (1 + rs)
    );
}

function calculateATR(
    candles,
    period = 14
) {

    if (
        !candles ||
        candles.length <
        period + 2
    ) {
        return 0;
    }

    const tr = [];

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
            Number(
                candles[i - 1][4]
            );

        tr.push(
            Math.max(
                high - low,
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

    let atr =
        average(
            tr.slice(
                0,
                period
            )
        );

    for (
        let i = period;
        i < tr.length;
        i++
    ) {

        atr =
            (
                atr *
                (period - 1) +
                tr[i]
            ) /
            period;
    }

    return atr;
}

function calculateADX(
    candles,
    period = 14
) {

    if (
        !candles ||
        candles.length <
        period * 2 + 5
    ) {
        return 0;
    }

    const trs = [];
    const plusDM = [];
    const minusDM = [];

    for (
        let i = 1;
        i < candles.length;
        i++
    ) {

        const high =
            Number(candles[i][2]);

        const low =
            Number(candles[i][3]);

        const prevHigh =
            Number(
                candles[i - 1][2]
            );

        const prevLow =
            Number(
                candles[i - 1][3]
            );

        const prevClose =
            Number(
                candles[i - 1][4]
            );

        const tr =
            Math.max(
                high - low,
                Math.abs(
                    high -
                    prevClose
                ),
                Math.abs(
                    low -
                    prevClose
                )
            );

        const up =
            high -
            prevHigh;

        const down =
            prevLow -
            low;

        trs.push(tr);

        plusDM.push(
            up > down && up > 0
                ? up
                : 0
        );

        minusDM.push(
            down > up && down > 0
                ? down
                : 0
        );
    }

    if (trs.length < period * 2) {
        return 0;
    }

    let trSmooth =
        trs
            .slice(0, period)
            .reduce(
                (a, b) => a + b,
                0
            );

    let plusSmooth =
        plusDM
            .slice(0, period)
            .reduce(
                (a, b) => a + b,
                0
            );

    let minusSmooth =
        minusDM
            .slice(0, period)
            .reduce(
                (a, b) => a + b,
                0
            );

    const dx = [];

    for (
        let i = period;
        i < trs.length;
        i++
    ) {

        trSmooth =
            trSmooth -
            trSmooth / period +
            trs[i];

        plusSmooth =
            plusSmooth -
            plusSmooth / period +
            plusDM[i];

        minusSmooth =
            minusSmooth -
            minusSmooth / period +
            minusDM[i];

        const plusDI =
            trSmooth
                ? 100 *
                  plusSmooth /
                  trSmooth
                : 0;

        const minusDI =
            trSmooth
                ? 100 *
                  minusSmooth /
                  trSmooth
                : 0;

        const denominator =
            plusDI +
            minusDI;

        const currentDX =
            denominator
                ? 100 *
                  Math.abs(
                      plusDI -
                      minusDI
                  ) /
                  denominator
                : 0;

        dx.push(currentDX);
    }

    if (dx.length < period) {
        return 0;
    }

    let adx =
        average(
            dx.slice(
                0,
                period
            )
        );

    for (
        let i = period;
        i < dx.length;
        i++
    ) {

        adx =
            (
                adx *
                (period - 1) +
                dx[i]
            ) /
            period;
    }

    return adx;
}

// ===============================================================
// CANDLE HELPERS
// ===============================================================

function volumeRatio(
    candles,
    index,
    period = 20
) {

    if (
        !candles ||
        index < period
    ) {
        return 1;
    }

    const volumes =
        candles
            .slice(
                index - period,
                index
            )
            .map(
                c => Number(c[5])
            )
            .filter(
                Number.isFinite
            );

    const avgVolume =
        average(volumes);

    if (!avgVolume) {
        return 1;
    }

    return (
        Number(
            candles[index][5]
        ) /
        avgVolume
    );
}

function candleBodyPercent(candle) {

    if (!candle) return 0;

    const open =
        Number(candle[1]);

    const close =
        Number(candle[4]);

    if (!open) return 0;

    return (
        Math.abs(
            close - open
        ) /
        open *
        100
    );
}

// ===============================================================
// TECHNICAL SNAPSHOT
// ===============================================================

function technicalSnapshot(candles) {

    if (
        !candles ||
        candles.length < 60
    ) {
        return null;
    }

    const closes =
        candles.map(
            c => Number(c[4])
        );

    const ema20 =
        calculateEMA(
            closes,
            20
        );

    const ema50 =
        calculateEMA(
            closes,
            50
        );

    const rsi =
        calculateRSI(
            closes,
            14
        );

    const atr =
        calculateATR(
            candles,
            14
        );

    const adx =
        calculateADX(
            candles,
            14
        );

    const price =
        closes[
            closes.length - 1
        ];

    let trend =
        'NEUTRAL';

    if (
        ema20 &&
        ema50 &&
        price > ema20 &&
        ema20 > ema50
    ) {

        trend = 'LONG';

    }
    else if (
        ema20 &&
        ema50 &&
        price < ema20 &&
        ema20 < ema50
    ) {

        trend = 'SHORT';
    }

    return {

        price,

        ema20,

        ema50,

        rsi,

        atr,

        atrPercent:
            price
                ? atr /
                  price *
                  100
                : 0,

        adx,

        trend
    };
}

// ===============================================================
// CACHE
// ===============================================================

function getCacheKey(
    symbol,
    timeframe,
    limit
) {

    return (
        `${symbol}|${timeframe}|${limit}`
    );
}

function cacheTTL(timeframe) {

    if (timeframe === '1h') {
        return 50_000;
    }

    if (timeframe === '15m') {
        return 25_000;
    }

    if (timeframe === '3m') {
        return 8_000;
    }

    if (timeframe === '1m') {
        return 3_000;
    }

    return 5_000;
}

async function fetchCandles(
    symbol,
    timeframe,
    limit
) {

    const key =
        getCacheKey(
            symbol,
            timeframe,
            limit
        );

    const cached =
        STATE.candlesCache.get(key);

    if (
        cached &&
        now() -
        cached.time <
        cacheTTL(timeframe)
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

        if (
            Array.isArray(data) &&
            data.length
        ) {

            STATE.candlesCache.set(
                key,
                {
                    time: now(),
                    data
                }
            );

            return data;
        }

    }
    catch (error) {

        if (
            process.env.DEBUG === 'true'
        ) {

            console.log(
                'CANDLE ERROR',
                symbol,
                timeframe,
                error.message
            );
        }
    }

    return null;
}

async function fetchTicker(symbol) {

    const cached =
        STATE.tickerCache.get(
            symbol
        );

    if (
        cached &&
        now() -
        cached.time <
        10_000
    ) {

        return cached.data;
    }

    try {

        const ticker =
            await exchange.fetchTicker(
                symbol
            );

        if (ticker) {

            STATE.tickerCache.set(
                symbol,
                {
                    time: now(),
                    data: ticker
                }
            );

            return ticker;
        }

    }
    catch (_) {}

    return null;
}

// ===============================================================
// UNIVERSE
// ===============================================================

async function loadUniverse() {

    await exchange.loadMarkets(
        true
    );

    const markets =
        Object.values(
            exchange.markets
        );

    const futures =
        markets.filter(
            market => {

                return (
                    market &&
                    market.active !== false &&
                    market.swap === true &&
                    market.quote === 'USDT' &&
                    (
                        !market.settle ||
                        market.settle ===
                        'USDT'
                    )
                );
            }
        );

    let tickers = {};

    try {

        tickers =
            await exchange.fetchTickers();

    }
    catch (error) {

        console.log(
            'Toplu ticker alınamadı:',
            error.message
        );
    }

    const rows = [];

    for (
        const market of futures
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

        const volume =
            Number(
                ticker.quoteVolume ||
                ticker.info?.quoteVolume ||
                ticker.info?.usdtVolume ||
                0
            );

        const change =
            Number(
                ticker.percentage ||
                0
            );

        const bid =
            Number(
                ticker.bid || 0
            );

        const ask =
            Number(
                ticker.ask || 0
            );

        if (
            !Number.isFinite(last) ||
            last < CFG.MIN_PRICE
        ) {
            continue;
        }

        if (
            !Number.isFinite(volume) ||
            volume <
            CFG.MIN_24H_VOLUME
        ) {
            continue;
        }

        const spread =
            bid > 0 &&
            ask > 0
                ? (
                    (
                        ask -
                        bid
                    ) /
                    (
                        (
                            ask +
                            bid
                        ) /
                        2
                    )
                ) *
                100
                : 999;

        if (
            spread >
            CFG.MAX_SPREAD_PERCENT
        ) {
            continue;
        }

        rows.push({

            symbol:
                market.symbol,

            base:
                market.base,

            last,

            volume24h:
                volume,

            change24h:
                change,

            bid,

            ask,

            spread
        });
    }

    rows.sort(
        (a, b) =>
            b.volume24h -
            a.volume24h
    );

    STATE.universe =
        rows.slice(
            0,
            CFG.MAX_UNIVERSE
        );

    STATE.stats.universe =
        STATE.universe.length;
}

// ===============================================================
// 500 -> 150
// ===============================================================

async function buildCandidates() {

    const results = [];

    /*
       Burada sadece 15M kullanıyoruz.
       Böylece 500 coinin tamamına pahalı
       1H + 3M + 1M istekleri göndermiyoruz.
    */

    const universe =
        STATE.universe;

    // 500 coin üzerinde hafif 15M momentum
    // analizi yapılır.
    for (
        const row of universe
    ) {

        try {

            const candles =
                await fetchCandles(
                    row.symbol,
                    CFG.TF_15M,
                    35
                );

            if (
                !candles ||
                candles.length < 25
            ) {
                continue;
            }

            const closed =
                lastClosed(
                    candles
                );

            if (!closed) continue;

            const closes =
                candles.map(
                    c => Number(c[4])
                );

            const price =
                Number(
                    closed[4]
                );

            const recentIndex =
                candles.length - 2;

            const recentVolumeRatio =
                volumeRatio(
                    candles,
                    recentIndex,
                    15
                );

            const lookbackClose =
                closes[
                    Math.max(
                        0,
                        closes.length - 9
                    )
                ];

            const momentum15 =
                lookbackClose
                    ? percentChange(
                        price,
                        lookbackClose
                    )
                    : 0;

            const range =
                candles
                    .slice(-12, -1)
                    .map(
                        c =>
                            Math.abs(
                                Number(c[2]) -
                                Number(c[3])
                            ) /
                            Number(c[4]) *
                            100
                    );

            const volatility =
                average(range);

            const activityScore =
                clamp(
                    recentVolumeRatio *
                    20,
                    0,
                    100
                );

            const momentumScore =
                clamp(
                    Math.abs(
                        momentum15
                    ) *
                    18,
                    0,
                    100
                );

            const volatilityScore =
                clamp(
                    volatility *
                    25,
                    0,
                    100
                );

            const volumeScore =
                clamp(
                    Math.log10(
                        Math.max(
                            row.volume24h,
                            1
                        )
                    ) *
                    8,
                    0,
                    100
                );

            let score =
                volumeScore * 0.30 +
                momentumScore * 0.30 +
                volatilityScore * 0.20 +
                activityScore * 0.20;

            // Hacim patlamasına küçük bonus.
            if (
                recentVolumeRatio >= 1.5
            ) {
                score += 8;
            }

            // Günlük hareket canlıysa bonus.
            if (
                Math.abs(
                    row.change24h
                ) >= 2
            ) {
                score += 5;
            }

            results.push({

                ...row,

                radarScore:
                    Math.round(
                        clamp(
                            score,
                            0,
                            100
                        )
                    ),

                momentum15,

                volatility,

                recentVolumeRatio
            });

        }
        catch (_) {}
    }

    results.sort(
        (a, b) =>
            b.radarScore -
            a.radarScore
    );

    STATE.candidates =
        results.slice(
            0,
            CFG.CANDIDATES
        );

    STATE.stats.candidates =
        STATE.candidates.length;
}

// ===============================================================
// MARKET BREADTH
// ===============================================================

async function calculateMarketState() {

    let green = 0;
    let red = 0;
    let neutral = 0;

    let moveSum = 0;

    for (
        const coin
        of STATE.universe
    ) {

        const move =
            Number(
                coin.change24h
            );

        if (
            !Number.isFinite(move)
        ) {
            continue;
        }

        moveSum += move;

        if (move > 0.20) {
            green++;
        }
        else if (move < -0.20) {
            red++;
        }
        else {
            neutral++;
        }
    }

    const total =
        green +
        red +
        neutral;

    const breadthPct =
        total
            ? green /
              total *
              100
            : 50;

    const averageMove =
        total
            ? moveSum /
              total
            : 0;

    let btcTrend =
        'NEUTRAL';

    let ethTrend =
        'NEUTRAL';

    try {

        const btc =
            await fetchCandles(
                'BTC/USDT:USDT',
                CFG.TF_1H,
                100
            );

        const btcTech =
            technicalSnapshot(
                btc
            );

        if (btcTech) {
            btcTrend =
                btcTech.trend;
        }

    }
    catch (_) {}

    try {

        const eth =
            await fetchCandles(
                'ETH/USDT:USDT',
                CFG.TF_1H,
                100
            );

        const ethTech =
            technicalSnapshot(
                eth
            );

        if (ethTech) {
            ethTrend =
                ethTech.trend;
        }

    }
    catch (_) {}

    let direction =
        'NEUTRAL';

    /*
       Piyasa yönünü sadece breadth ile
       değiştirmiyoruz.

       Breadth + BTC/ETH trend birlikte.
    */

    if (
        breadthPct >=
        CFG.BULL_BREADTH &&
        (
            btcTrend === 'LONG' ||
            ethTrend === 'LONG'
        )
    ) {

        direction =
            'LONG';

    }
    else if (
        breadthPct <=
        CFG.BEAR_BREADTH &&
        (
            btcTrend === 'SHORT' ||
            ethTrend === 'SHORT'
        )
    ) {

        direction =
            'SHORT';
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

        /*
           Burada "YATAY/KARIŞIK"
           her durumda çıkmıyor.
        */

        if (
            Math.abs(
                averageMove
            ) >= 1.0 &&
            breadthPct > 55
        ) {

            label =
                'POZİTİF KARARSIZ';

        }
        else if (
            Math.abs(
                averageMove
            ) >= 1.0 &&
            breadthPct < 45
        ) {

            label =
                'NEGATİF KARARSIZ';

        }
        else {

            label =
                'NÖTR';
        }
    }

    STATE.market = {

        label,

        direction,

        breadthPct:
            Number(
                breadthPct.toFixed(1)
            ),

        green,

        red,

        neutral,

        averageMove:
            Number(
                averageMove.toFixed(2)
            ),

        btcTrend,

        ethTrend,

        reason:
            `${green} yeşil / ` +
            `${red} kırmızı / ` +
            `${neutral} nötr | ` +
            `BTC ${btcTrend} | ` +
            `ETH ${ethTrend}`
    };
}

// ===============================================================
// PIVOTS
// ===============================================================

function findPivotLevels(
    candles
) {

    const highs = [];
    const lows = [];

    const left =
        CFG.PIVOT_LEFT;

    const right =
        CFG.PIVOT_RIGHT;

    const start =
        Math.max(
            left,
            candles.length -
            CFG.STRUCTURE_LOOKBACK
        );

    const end =
        candles.length -
        right;

    for (
        let i = start;
        i < end;
        i++
    ) {

        const high =
            Number(
                candles[i][2]
            );

        const low =
            Number(
                candles[i][3]
            );

        let pivotHigh =
            true;

        let pivotLow =
            true;

        for (
            let j =
                i - left;
            j <=
                i + right;
            j++
        ) {

            if (j === i) {
                continue;
            }

            if (
                Number(
                    candles[j][2]
                ) >= high
            ) {

                pivotHigh =
                    false;
            }

            if (
                Number(
                    candles[j][3]
                ) <= low
            ) {

                pivotLow =
                    false;
            }
        }

        if (pivotHigh) {

            highs.push({
                price: high,
                index: i,
                time:
                    candles[i][0]
            });
        }

        if (pivotLow) {

            lows.push({
                price: low,
                index: i,
                time:
                    candles[i][0]
            });
        }
    }

    return {
        highs,
        lows
    };
}

// ===============================================================
// LEVEL CLUSTER
// ===============================================================

function clusterLevels(
    levels
) {

    const sorted =
        [...levels].sort(
            (a, b) =>
                a.price -
                b.price
        );

    const clusters = [];

    for (
        const level
        of sorted
    ) {

        let found = null;

        for (
            const cluster
            of clusters
        ) {

            if (
                absPercent(
                    level.price,
                    cluster.price
                ) <=
                CFG.LEVEL_CLUSTER_PERCENT
            ) {

                found =
                    cluster;

                break;
            }
        }

        if (found) {

            found.prices.push(
                level.price
            );

            found.points++;

            found.price =
                average(
                    found.prices
                );

        }
        else {

            clusters.push({

                price:
                    level.price,

                prices:
                    [level.price],

                points:
                    1
            });
        }
    }

    return clusters;
}

// ===============================================================
// STRUCTURE
// ===============================================================

function buildStructure(
    candles,
    price
) {

    const pivots =
        findPivotLevels(
            candles
        );

    const resistance =
        clusterLevels(
            pivots.highs
        )
            .filter(
                x =>
                    x.price >
                    price
            )
            .sort(
                (a, b) =>
                    a.price -
                    b.price
            );

    const support =
        clusterLevels(
            pivots.lows
        )
            .filter(
                x =>
                    x.price <
                    price
            )
            .sort(
                (a, b) =>
                    b.price -
                    a.price
            );

    return {

        support:
            support[0] ||
            null,

        resistance:
            resistance[0] ||
            null,

        supports:
            support,

        resistances:
            resistance
    };
}

// ===============================================================
// BREAKOUT
// ===============================================================

function detectBreakout(
    symbol,
    candles,
    structure
) {

    if (
        !candles ||
        candles.length < 30
    ) {
        return null;
    }

    /*
       SADECE KAPANMIŞ MUM.
    */

    const index =
        candles.length - 2;

    const candle =
        candles[index];

    const previous =
        candles[index - 1];

    const close =
        Number(
            candle[4]
        );

    const previousClose =
        Number(
            previous[4]
        );

    const body =
        candleBodyPercent(
            candle
        );

    const volRatio =
        volumeRatio(
            candles,
            index,
            20
        );

    // -----------------------------------------------------------
    // LONG
    // -----------------------------------------------------------

    if (
        structure.resistance
    ) {

        const level =
            structure.resistance.price;

        const crossed =
            previousClose <=
            level &&
            close >
            level *
            (
                1 +
                CFG.BREAKOUT_BUFFER_PERCENT /
                100
            );

        if (
            crossed &&
            volRatio >=
            CFG.BREAKOUT_VOLUME_RATIO &&
            body >= 0.03
        ) {

            return {

                symbol,

                direction:
                    'LONG',

                level,

                breakoutPrice:
                    close,

                breakoutTime:
                    candle[0],

                breakoutIndex:
                    index,

                volumeRatio:
                    volRatio,

                bodyPercent:
                    body,

                type:
                    'RESISTANCE_BREAK'
            };
        }
    }

    // -----------------------------------------------------------
    // SHORT
    // -----------------------------------------------------------

    if (
        structure.support
    ) {

        const level =
            structure.support.price;

        const crossed =
            previousClose >=
            level &&
            close <
            level *
            (
                1 -
                CFG.BREAKOUT_BUFFER_PERCENT /
                100
            );

        if (
            crossed &&
            volRatio >=
            CFG.BREAKOUT_VOLUME_RATIO &&
            body >= 0.03
        ) {

            return {

                symbol,

                direction:
                    'SHORT',

                level,

                breakoutPrice:
                    close,

                breakoutTime:
                    candle[0],

                breakoutIndex:
                    index,

                volumeRatio:
                    volRatio,

                bodyPercent:
                    body,

                type:
                    'SUPPORT_BREAK'
            };
        }
    }

    return null;
}

// ===============================================================
// RETEST
// ===============================================================

function detectRetest(
    pending,
    candles
) {

    if (
        !pending ||
        !candles
    ) {
        return null;
    }

    const age =
        now() -
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

    /*
       KRİTİK DÜZELTME:

       Breakout'tan ÖNCEKİ mumlar
       kesinlikle retest olarak sayılmıyor.
    */

    const after =
        candles.filter(
            c =>
                Number(c[0]) >
                Number(
                    pending.breakoutTime
                )
        );

    if (!after.length) {
        return null;
    }

    const level =
        pending.level;

    for (
        const candle
        of after
    ) {

        const high =
            Number(
                candle[2]
            );

        const low =
            Number(
                candle[3]
            );

        const close =
            Number(
                candle[4]
            );

        // -------------------------------------------------------
        // LONG RETEST
        // -------------------------------------------------------

        if (
            pending.direction ===
            'LONG'
        ) {

            const tolerance =
                level *
                CFG.RETEST_TOLERANCE_PERCENT /
                100;

            const invalidation =
                level *
                CFG.RETEST_INVALIDATION_PERCENT /
                100;

            const touched =
                low <=
                level +
                tolerance &&
                high >=
                level -
                tolerance;

            const invalid =
                close <
                level -
                invalidation;

            if (invalid) {

                return {
                    invalidated:
                        true
                };
            }

            if (
                touched &&
                close >= level
            ) {

                return {

                    valid:
                        true,

                    direction:
                        'LONG',

                    retestPrice:
                        close,

                    retestTime:
                        candle[0],

                    candle
                };
            }
        }

        // -------------------------------------------------------
        // SHORT RETEST
        // -------------------------------------------------------

        if (
            pending.direction ===
            'SHORT'
        ) {

            const tolerance =
                level *
                CFG.RETEST_TOLERANCE_PERCENT /
                100;

            const invalidation =
                level *
                CFG.RETEST_INVALIDATION_PERCENT /
                100;

            const touched =
                high >=
                level -
                tolerance &&
                low <=
                level +
                tolerance;

            const invalid =
                close >
                level +
                invalidation;

            if (invalid) {

                return {
                    invalidated:
                        true
                };
            }

            if (
                touched &&
                close <= level
            ) {

                return {

                    valid:
                        true,

                    direction:
                        'SHORT',

                    retestPrice:
                        close,

                    retestTime:
                        candle[0],

                    candle
                };
            }
        }
    }

    return null;
}

// ===============================================================
// 1M CONFIRM
// ===============================================================

async function getOneMinuteConfirmation(
    symbol,
    direction
) {

    try {

        const candles =
            await fetchCandles(
                symbol,
                CFG.TF_1M,
                CFG.LIMIT_1M
            );

        if (
            !candles ||
            candles.length < 20
        ) {

            return {

                confirmed:
                    false,

                score:
                    0,

                volumeRatio:
                    1,

                momentum:
                    0
            };
        }

        const index =
            candles.length - 2;

        const candle =
            candles[index];

        const previous =
            candles[index - 1];

        const close =
            Number(
                candle[4]
            );

        const previousClose =
            Number(
                previous[4]
            );

        const momentum =
            percentChange(
                close,
                previousClose
            );

        const volRatio =
            volumeRatio(
                candles,
                index,
                15
            );

        let score = 0;

        if (
            direction === 'LONG'
        ) {

            if (
                close >
                Number(candle[1])
            ) {
                score += 12;
            }

            if (
                momentum >=
                CFG.ONE_M_MOMENTUM_PERCENT
            ) {
                score += 8;
            }

        }
        else {

            if (
                close <
                Number(candle[1])
            ) {
                score += 12;
            }

            if (
                momentum <=
                -CFG.ONE_M_MOMENTUM_PERCENT
            ) {
                score += 8;
            }
        }

        if (
            volRatio >=
            CFG.ONE_M_VOLUME_RATIO
        ) {

            score += 8;
        }

        return {

            confirmed:
                score >= 12,

            score,

            volumeRatio:
                Number(
                    volRatio.toFixed(2)
                ),

            momentum:
                Number(
                    momentum.toFixed(3)
                )
        };

    }
    catch (_) {

        return {

            confirmed:
                false,

            score:
                0,

            volumeRatio:
                1,

            momentum:
                0
        };
    }
}

// ===============================================================
// SCALP PLAN
// ===============================================================

function buildTradePlan(
    symbol,
    direction,
    entry,
    candles3m,
    structure
) {

    const tech =
        technicalSnapshot(
            candles3m
        );

    if (!tech) {
        return null;
    }

    if (
        !Number.isFinite(
            tech.atr
        ) ||
        tech.atr <= 0
    ) {
        return null;
    }

    const recent =
        candles3m.slice(
            -12,
            -1
        );

    let swingLow =
        Math.min(
            ...recent.map(
                c =>
                    Number(c[3])
            )
        );

    let swingHigh =
        Math.max(
            ...recent.map(
                c =>
                    Number(c[2])
            )
        );

    let stop;

    if (
        direction === 'LONG'
    ) {

        stop =
            Math.min(
                swingLow,
                entry -
                tech.atr *
                0.55
            );

        stop -=
            tech.atr *
            0.05;

    }
    else {

        stop =
            Math.max(
                swingHigh,
                entry +
                tech.atr *
                0.55
            );

        stop +=
            tech.atr *
            0.05;
    }

    let risk =
        Math.abs(
            entry -
            stop
        );

    let riskPercent =
        risk /
        entry *
        100;

    // -----------------------------------------------------------
    // Çok dar stop → biraz genişlet.
    // -----------------------------------------------------------

    if (
        riskPercent <
        CFG.MIN_STOP_PERCENT
    ) {

        risk =
            entry *
            CFG.MIN_STOP_PERCENT /
            100;

        if (
            direction === 'LONG'
        ) {

            stop =
                entry -
                risk;

        }
        else {

            stop =
                entry +
                risk;
        }

        riskPercent =
            CFG.MIN_STOP_PERCENT;
    }

    // -----------------------------------------------------------
    // Çok geniş stop → setup yok.
    // -----------------------------------------------------------

    if (
        riskPercent >
        CFG.MAX_STOP_PERCENT
    ) {

        return null;
    }

    // -----------------------------------------------------------
    // TP
    // -----------------------------------------------------------

    let tp1 =
        direction === 'LONG'
            ? entry +
              risk *
              1.35
            : entry -
              risk *
              1.35;

    let tp2 =
        direction === 'LONG'
            ? entry +
              risk *
              2.10
            : entry -
              risk *
              2.10;

    let tp3 =
        direction === 'LONG'
            ? entry +
              risk *
              2.80
            : entry -
              risk *
              2.80;

    // -----------------------------------------------------------
    // Karşıdaki structure seviyesini hesaba kat.
    // -----------------------------------------------------------

    if (
        direction === 'LONG' &&
        structure.resistance &&
        structure.resistance.price >
        entry
    ) {

        const target =
            structure.resistance.price;

        tp1 =
            Math.min(
                tp1,
                target *
                0.65 +
                entry *
                0.35
            );

        tp2 =
            Math.min(
                tp2,
                target *
                0.84 +
                entry *
                0.16
            );

        tp3 =
            Math.min(
                tp3,
                target *
                0.995
            );
    }

    if (
        direction === 'SHORT' &&
        structure.support &&
        structure.support.price <
        entry
    ) {

        const target =
            structure.support.price;

        tp1 =
            Math.max(
                tp1,
                target *
                0.65 +
                entry *
                0.35
            );

        tp2 =
            Math.max(
                tp2,
                target *
                0.84 +
                entry *
                0.16
            );

        tp3 =
            Math.max(
                tp3,
                target *
                1.005
            );
    }

    // -----------------------------------------------------------
    // Sıralamayı garanti et.
    // -----------------------------------------------------------

    if (
        direction === 'LONG'
    ) {

        tp1 =
            Math.max(
                tp1,
                entry +
                risk *
                CFG.MIN_RR
            );

        tp2 =
            Math.max(
                tp2,
                tp1 +
                risk *
                0.35
            );

        tp3 =
            Math.max(
                tp3,
                tp2 +
                risk *
                0.35
            );

    }
    else {

        tp1 =
            Math.min(
                tp1,
                entry -
                risk *
                CFG.MIN_RR
            );

        tp2 =
            Math.min(
                tp2,
                tp1 -
                risk *
                0.35
            );

        tp3 =
            Math.min(
                tp3,
                tp2 -
                risk *
                0.35
            );
    }

    const rr =
        direction === 'LONG'
            ? (
                tp1 -
                entry
            ) /
            risk
            : (
                entry -
                tp1
            ) /
            risk;

    if (
        !Number.isFinite(rr) ||
        rr <
        CFG.MIN_RR
    ) {

        return null;
    }

    return {

        entry:
            roundPrice(
                symbol,
                entry
            ),

        stop:
            roundPrice(
                symbol,
                stop
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
                riskPercent.toFixed(3)
            ),

        rr:
            Number(
                rr.toFixed(2)
            ),

        tp1Percent:
            Number(
                (
                    Math.abs(
                        tp1 -
                        entry
                    ) /
                    entry *
                    100
                ).toFixed(3)
            ),

        tp2Percent:
            Number(
                (
                    Math.abs(
                        tp2 -
                        entry
                    ) /
                    entry *
                    100
                ).toFixed(3)
            ),

        tp3Percent:
            Number(
                (
                    Math.abs(
                        tp3 -
                        entry
                    ) /
                    entry *
                    100
                ).toFixed(3)
            ),

        atrPercent:
            Number(
                tech.atrPercent.toFixed(3)
            )
    };
}

// ===============================================================
// SIGNAL SCORE
// ===============================================================

function calculateSignalScore(
    params
) {

    const {

        direction,

        tech1h,

        tech3m,

        breakout,

        retest,

        oneM,

        radar,

        plan

    } = params;

    let score = 50;

    const reasons = [];

    // -----------------------------------------------------------
    // 1H
    // -----------------------------------------------------------

    if (
        tech1h.trend ===
        direction
    ) {

        score += 12;

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
            '1H nötr'
        );

    }
    else {

        /*
           Ters trendi tamamen yasaklamıyoruz.
           Çünkü scalp'ta altcoin momentumları
           bazen BTC trendinden bağımsız çalışabilir.
        */

        score -= 6;

        reasons.push(
            '1H trend ters'
        );
    }

    // -----------------------------------------------------------
    // 3M EMA
    // -----------------------------------------------------------

    if (
        direction === 'LONG' &&
        tech3m.ema20 >
        tech3m.ema50
    ) {

        score += 8;

        reasons.push(
            '3M momentum LONG'
        );

    }
    else if (
        direction === 'SHORT' &&
        tech3m.ema20 <
        tech3m.ema50
    ) {

        score += 8;

        reasons.push(
            '3M momentum SHORT'
        );
    }

    // -----------------------------------------------------------
    // BREAKOUT VOLUME
    // -----------------------------------------------------------

    if (
        breakout.volumeRatio >= 2
    ) {

        score += 10;

        reasons.push(
            `Breakout hacmi ${breakout.volumeRatio.toFixed(2)}x`
        );

    }
    else if (
        breakout.volumeRatio >= 1.5
    ) {

        score += 7;

        reasons.push(
            `Breakout hacmi ${breakout.volumeRatio.toFixed(2)}x`
        );

    }
    else {

        score += 3;
    }

    // -----------------------------------------------------------
    // RETEST
    // -----------------------------------------------------------

    if (
        retest.valid
    ) {

        score += 12;

        reasons.push(
            '3M retest başarılı'
        );
    }

    // -----------------------------------------------------------
    // 1M
    // -----------------------------------------------------------

    if (
        oneM.confirmed
    ) {

        score +=
            oneM.score;

        reasons.push(
            '1M giriş teyidi'
        );

    }
    else {

        /*
           1M zorunlu değil.
           Güçlü altcoin setup'ı burada
           çöpe atılmıyor.
        */

        reasons.push(
            '1M teyit yok — bonus alınmadı'
        );
    }

    // -----------------------------------------------------------
    // RADAR
    // -----------------------------------------------------------

    if (
        radar >= 82
    ) {

        score += 7;

        reasons.push(
            'Radar çok güçlü'
        );

    }
    else if (
        radar >= 72
    ) {

        score += 5;

        reasons.push(
            'Radar güçlü'
        );

    }
    else if (
        radar >= 62
    ) {

        score += 2;
    }

    // -----------------------------------------------------------
    // RSI
    // -----------------------------------------------------------

    if (
        direction === 'LONG'
    ) {

        if (
            tech3m.rsi >= 48 &&
            tech3m.rsi <= 70
        ) {

            score += 4;

            reasons.push(
                'RSI uygun'
            );
        }

        if (
            tech3m.rsi > 82
        ) {

            score -= 5;

            reasons.push(
                'RSI aşırı yüksek'
            );
        }

    }
    else {

        if (
            tech3m.rsi >= 30 &&
            tech3m.rsi <= 52
        ) {

            score += 4;

            reasons.push(
                'RSI uygun'
            );
        }

        if (
            tech3m.rsi < 18
        ) {

            score -= 5;

            reasons.push(
                'RSI aşırı düşük'
            );
        }
    }

    // -----------------------------------------------------------
    // ADX
    // -----------------------------------------------------------

    if (
        tech3m.adx >= 25
    ) {

        score += 5;

        reasons.push(
            'ADX güçlü'
        );

    }
    else if (
        tech3m.adx < 15
    ) {

        score -= 4;

        reasons.push(
            'ADX zayıf'
        );
    }

    // -----------------------------------------------------------
    // R:R
    // -----------------------------------------------------------

    if (
        plan.rr >= 2
    ) {

        score += 6;

        reasons.push(
            `R:R ${plan.rr}`
        );

    }
    else if (
        plan.rr >= 1.5
    ) {

        score += 4;

        reasons.push(
            `R:R ${plan.rr}`
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

// ===============================================================
// DEEP WATCH
// ===============================================================

async function buildDeepWatch() {

    const result = [];

    for (
        const coin
        of STATE.candidates
    ) {

        try {

            const candles15 =
                await fetchCandles(
                    coin.symbol,
                    CFG.TF_15M,
                    CFG.LIMIT_15M
                );

            if (
                !candles15 ||
                candles15.length < 50
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

            let score =
                coin.radarScore;

            let nearSupport =
                false;

            let nearResistance =
                false;

            if (
                structure.support
            ) {

                nearSupport =
                    absPercent(
                        price,
                        structure.support.price
                    ) <=
                    CFG.LEVEL_PROXIMITY_PERCENT;

                if (
                    nearSupport
                ) {
                    score += 10;
                }
            }

            if (
                structure.resistance
            ) {

                nearResistance =
                    absPercent(
                        price,
                        structure.resistance.price
                    ) <=
                    CFG.LEVEL_PROXIMITY_PERCENT;

                if (
                    nearResistance
                ) {
                    score += 10;
                }
            }

            /*
               Yakın level yoksa ama momentum
               çok kuvvetliyse yine watchlist'te tut.
            */

            if (
                Math.abs(
                    coin.momentum15
                ) >= 1.0
            ) {

                score += 6;
            }

            result.push({

                ...coin,

                deepScore:
                    Math.round(
                        clamp(
                            score,
                            0,
                            100
                        )
                    ),

                price,

                structure,

                nearSupport,

                nearResistance
            });

        }
        catch (_) {}
    }

    result.sort(
        (a, b) =>
            b.deepScore -
            a.deepScore
    );

    STATE.deepWatch =
        result.slice(
            0,
            CFG.DEEP_WATCH
        );

    STATE.stats.deepWatch =
        STATE.deepWatch.length;
}

// ===============================================================
// ROTATING DEEP SCAN
// ===============================================================

function getRotationBatch() {

    if (
        STATE.deepWatch.length === 0
    ) {
        return [];
    }

    const total =
        STATE.deepWatch.length;

    const size =
        Math.min(
            CFG.ROTATION_SIZE,
            total
        );

    const start =
        STATE.rotationIndex %
        total;

    const batch = [];

    for (
        let i = 0;
        i < size;
        i++
    ) {

        batch.push(
            STATE.deepWatch[
                (start + i) %
                total
            ]
        );
    }

    STATE.rotationIndex =
        (
            start +
            size
        ) %
        total;

    return batch;
}

// ===============================================================
// 3M BREAKOUT SCAN
// ===============================================================

async function scanBreakouts(
    batch
) {

    for (
        const coin
        of batch
    ) {

        try {

            const candles15 =
                await fetchCandles(
                    coin.symbol,
                    CFG.TF_15M,
                    CFG.LIMIT_15M
                );

            const closed15 =
                lastClosed(
                    candles15
                );

            if (!closed15) continue;

            const price =
                Number(
                    closed15[4]
                );

            const structure =
                buildStructure(
                    candles15,
                    price
                );

            const candles3 =
                await fetchCandles(
                    coin.symbol,
                    CFG.TF_3M,
                    CFG.LIMIT_3M
                );

            if (
                !candles3 ||
                candles3.length < 40
            ) {
                continue;
            }

            STATE.stats.analyzed++;

            const breakout =
                detectBreakout(
                    coin.symbol,
                    candles3,
                    structure
                );

            if (!breakout) {
                continue;
            }

            const key =
                `${coin.symbol}|${breakout.direction}|${breakout.level}`;

            const cooldown =
                STATE.cooldowns.get(
                    key
                );

            if (
                cooldown &&
                cooldown > now()
            ) {
                continue;
            }

            /*
               BREAKOUT STATE HAFIZAYA ALINIYOR.
            */

            STATE.pendingBreakouts.set(
                key,
                {

                    ...breakout,

                    key,

                    createdAt:
                        now(),

                    status:
                        'WAIT_RETEST',

                    radarScore:
                        coin.radarScore,

                    deepScore:
                        coin.deepScore
                }
            );

            console.log(
                `⚡ BREAKOUT | ` +
                `${displaySymbol(coin.symbol)} | ` +
                `${breakout.direction} | ` +
                `Level ${breakout.level} | ` +
                `Volume ${breakout.volumeRatio.toFixed(2)}x`
            );

        }
        catch (error) {

            if (
                process.env.DEBUG === 'true'
            ) {

                console.log(
                    'BREAKOUT ERROR',
                    coin.symbol,
                    error.message
                );
            }
        }
    }
}

// ===============================================================
// RETEST + SIGNAL
// ===============================================================

async function processPendingBreakouts() {

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
                await fetchCandles(
                    pending.symbol,
                    CFG.TF_3M,
                    CFG.LIMIT_3M
                );

            const retest =
                detectRetest(
                    pending,
                    candles3
                );

            if (!retest) {
                continue;
            }

            if (
                retest.expired ||
                retest.invalidated
            ) {

                STATE.pendingBreakouts.delete(
                    key
                );

                STATE.cooldowns.set(
                    key,
                    now() +
                    10 *
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

            // ---------------------------------------------------
            // 1H
            // ---------------------------------------------------

            const candles1h =
                await fetchCandles(
                    pending.symbol,
                    CFG.TF_1H,
                    CFG.LIMIT_1H
                );

            const tech1h =
                technicalSnapshot(
                    candles1h
                );

            // ---------------------------------------------------
            // 3M
            // ---------------------------------------------------

            const tech3m =
                technicalSnapshot(
                    candles3
                );

            if (
                !tech1h ||
                !tech3m
            ) {
                continue;
            }

            const currentPrice =
                Number(
                    lastClosed(
                        candles3
                    )[4]
                );

            // ---------------------------------------------------
            // 15M
            // ---------------------------------------------------

            const candles15 =
                await fetchCandles(
                    pending.symbol,
                    CFG.TF_15M,
                    CFG.LIMIT_15M
                );

            const structure =
                buildStructure(
                    candles15,
                    currentPrice
                );

            // ---------------------------------------------------
            // 1M
            // ---------------------------------------------------

            const oneM =
                await getOneMinuteConfirmation(
                    pending.symbol,
                    pending.direction
                );

            if (
                CFG.REQUIRE_1M &&
                !oneM.confirmed
            ) {

                continue;
            }

            // ---------------------------------------------------
            // PLAN
            // ---------------------------------------------------

            const plan =
                buildTradePlan(
                    pending.symbol,
                    pending.direction,
                    currentPrice,
                    candles3,
                    structure
                );

            if (!plan) {

                STATE.pendingBreakouts.delete(
                    key
                );

                continue;
            }

            // ---------------------------------------------------
            // SCORE
            // ---------------------------------------------------

            const scoring =
                calculateSignalScore({

                    direction:
                        pending.direction,

                    tech1h,

                    tech3m,

                    breakout:
                        pending,

                    retest,

                    oneM,

                    radar:
                        pending.radarScore,

                    plan
                });

            if (
                scoring.score <
                CFG.MIN_SCORE
            ) {

                /*
                   Çok düşük score setup'ı
                   sonsuza kadar pending bırakma.
                */

                STATE.pendingBreakouts.delete(
                    key
                );

                continue;
            }

            // ---------------------------------------------------
            // Duplicate
            // ---------------------------------------------------

            const duplicate =
                Array.from(
                    STATE.signals.values()
                ).find(
                    signal =>
                        signal.symbol ===
                        pending.symbol &&
                        signal.direction ===
                        pending.direction &&
                        signal.status ===
                        'ACTIVE'
                );

            if (duplicate) {

                STATE.pendingBreakouts.delete(
                    key
                );

                continue;
            }

            // ---------------------------------------------------
            // SIGNAL
            // ---------------------------------------------------

            const signalId =
                `${pending.symbol}-${pending.direction}-${now()}`;

            const category =
                scoring.score >=
                CFG.ELITE_SCORE
                    ? 'ELITE SCALP'
                    : scoring.score >=
                      CFG.GOOD_SCORE
                        ? 'GÜÇLÜ SCALP'
                        : 'SCALP';

            const signal = {

                id:
                    signalId,

                symbol:
                    pending.symbol,

                coin:
                    displaySymbol(
                        pending.symbol
                    ),

                type:
                    pending.direction,

                direction:
                    pending.direction,

                score:
                    scoring.score,

                confidence:
                    scoring.score,

                category,

                status:
                    'ACTIVE',

                // ------------------------------------------------
                // ENTRY
                // ------------------------------------------------

                entry:
                    plan.entry,

                entryZone:
                    `${roundPrice(
                        pending.symbol,
                        pending.level * 0.999
                    )} - ${roundPrice(
                        pending.symbol,
                        pending.level * 1.002
                    )}`,

                // ------------------------------------------------
                // SL
                // ------------------------------------------------

                stopLoss:
                    plan.stop,

                sl:
                    plan.stop,

                // ------------------------------------------------
                // TP
                // ------------------------------------------------

                tp1:
                    plan.tp1,

                tp2:
                    plan.tp2,

                tp3:
                    plan.tp3,

                // ------------------------------------------------
                // METRICS
                // ------------------------------------------------

                rr:
                    plan.rr,

                riskReward:
                    plan.rr,

                riskPercent:
                    plan.riskPercent,

                tp1Percent:
                    plan.tp1Percent,

                tp2Percent:
                    plan.tp2Percent,

                tp3Percent:
                    plan.tp3Percent,

                atrPercent:
                    plan.atrPercent,

                currentPrice,

                breakoutLevel:
                    pending.level,

                breakoutVolume:
                    pending.volumeRatio,

                retestPrice:
                    retest.retestPrice,

                oneMinuteConfirmed:
                    oneM.confirmed,

                oneMinuteScore:
                    oneM.score,

                oneMinuteVolume:
                    oneM.volumeRatio,

                oneMinuteMomentum:
                    oneM.momentum,

                trend1h:
                    tech1h.trend,

                trend3m:
                    tech3m.trend,

                rsi3m:
                    Number(
                        tech3m.rsi.toFixed(1)
                    ),

                adx3m:
                    Number(
                        tech3m.adx.toFixed(1)
                    ),

                market:
                    {
                        ...STATE.market
                    },

                reasons:
                    scoring.reasons,

                analysis:
                    scoring.reasons.join(
                        ' • '
                    ),

                timeframe:
                    '1H / 15M / 3M / 1M',

                strategy:
                    'SCALP_V5',

                timestamp:
                    now(),

                createdAt:
                    now(),

                expiresAt:
                    now() +
                    CFG.SIGNAL_TTL_MINUTES *
                    60 *
                    1000,

                ttlMinutes:
                    CFG.SIGNAL_TTL_MINUTES,

                tvSymbol:
                    `BITGET:${displaySymbol(
                        pending.symbol
                    )}`
            };

            STATE.signals.set(
                signalId,
                signal
            );

            STATE.pendingBreakouts.delete(
                key
            );

            const cooldownKey =
                `${pending.symbol}|${pending.direction}`;

            STATE.cooldowns.set(
                cooldownKey,
                now() +
                CFG.COOLDOWN_MINUTES *
                60 *
                1000
            );

            console.log(
                `🚨 SIGNAL | ` +
                `${signal.coin} | ` +
                `${signal.direction} | ` +
                `Score ${signal.score} | ` +
                `RR ${signal.rr}`
            );

            broadcast({
                type:
                    'signal',

                signal
            });

            broadcastStatus();

        }
        catch (error) {

            if (
                process.env.DEBUG === 'true'
            ) {

                console.log(
                    'PENDING ERROR',
                    pending.symbol,
                    error.message
                );
            }
        }
    }
}

// ===============================================================
// CLEANUP
// ===============================================================

function cleanup() {

    const current =
        now();

    // -----------------------------------------------------------
    // SIGNALS
    // -----------------------------------------------------------

    for (
        const [id, signal]
        of STATE.signals.entries()
    ) {

        if (
            current >
            signal.expiresAt
        ) {

            signal.status =
                'MISSED';

            STATE.signals.delete(
                id
            );
        }
    }

    // -----------------------------------------------------------
    // PENDING
    // -----------------------------------------------------------

    for (
        const [key, pending]
        of STATE.pendingBreakouts.entries()
    ) {

        if (
            current -
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

    // -----------------------------------------------------------
    // COOLDOWN
    // -----------------------------------------------------------

    for (
        const [key, expiry]
        of STATE.cooldowns.entries()
    ) {

        if (
            current >
            expiry
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

// ===============================================================
// STATUS
// ===============================================================

function getStatus() {

    const signals =
        Array.from(
            STATE.signals.values()
        )
            .sort(
                (a, b) =>
                    b.score -
                    a.score
            )
            .slice(
                0,
                CFG.MAX_SIGNALS
            );

    return {

        success:
            true,

        engine:
            'SONNY AI TRADER SCALP V5',

        strategy:
            '500 → 150 → 40 → 15M → 3M BREAKOUT → RETEST → 1M BONUS',

        autoTrade:
            CFG.AUTO_TRADE,

        stats: {

            scanned:
                STATE.stats.universe,

            universe:
                STATE.stats.universe,

            candidates:
                STATE.stats.candidates,

            deepWatch:
                STATE.stats.deepWatch,

            watchlist:
                STATE.stats.deepWatch,

            analyzed:
                STATE.stats.analyzed,

            pending:
                STATE.stats.pending,

            activeSignalsCount:
                STATE.stats.signals,

            signals:
                STATE.stats.signals,

            lastScan:
                STATE.stats.lastScan,

            scanSeconds:
                STATE.stats.scanSeconds
        },

        market:
            STATE.market,

        signals,

        pending:
            Array.from(
                STATE.pendingBreakouts.values()
            ).map(
                p => ({

                    symbol:
                        displaySymbol(
                            p.symbol
                        ),

                    type:
                        p.direction,

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

                    ageSeconds:
                        Math.round(
                            (
                                now() -
                                p.createdAt
                            ) /
                            1000
                        )
                })
            ),

        watchlist:
            STATE.deepWatch.map(
                coin => ({

                    symbol:
                        displaySymbol(
                            coin.symbol
                        ),

                    score:
                        coin.deepScore,

                    radarScore:
                        coin.radarScore,

                    change24h:
                        coin.change24h,

                    momentum15:
                        coin.momentum15,

                    volume24h:
                        coin.volume24h,

                    spread:
                        coin.spread,

                    nearSupport:
                        coin.nearSupport,

                    nearResistance:
                        coin.nearResistance,

                    support:
                        coin.structure
                            ?.support
                            ?.price ||
                        null,

                    resistance:
                        coin.structure
                            ?.resistance
                            ?.price ||
                        null
                })
            ),

        lastError:
            STATE.lastError
    };
}

// ===============================================================
// BROADCAST
// ===============================================================

function broadcast(payload) {

    const message =
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
                client.send(
                    message
                );
            }
            catch (_) {}
        }
    }
}

function broadcastStatus() {

    broadcast({

        type:
            'status',

        stats:
            getStatus().stats,

        market:
            STATE.market,

        signals:
            getStatus().signals,

        pending:
            getStatus().pending,

        watchlist:
            getStatus().watchlist
    });
}

// ===============================================================
// WEBSOCKET
// ===============================================================

wss.on(
    'connection',
    socket => {

        socket.send(
            JSON.stringify({

                type:
                    'status',

                stats:
                    getStatus().stats,

                market:
                    STATE.market,

                signals:
                    getStatus().signals,

                pending:
                    getStatus().pending,

                watchlist:
                    getStatus().watchlist
            })
        );

    }
);

// ===============================================================
// API STATUS
// ===============================================================

app.get(
    '/api/status',
    (req, res) => {

        res.json(
            getStatus()
        );
    }
);

// ===============================================================
// API SIGNALS
// ===============================================================

app.get(
    '/api/signals',
    (req, res) => {

        res.json({

            success:
                true,

            stats:
                getStatus().stats,

            market:
                STATE.market,

            signals:
                getStatus().signals
        });
    }
);

// ===============================================================
// API RADAR
// ===============================================================

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

// ===============================================================
// API CONFIG
// ===============================================================

app.get(
    '/api/config',
    (req, res) => {

        res.json({

            engine:
                'SCALP_V5',

            autoTrade:
                CFG.AUTO_TRADE,

            radar:
                {
                    universe:
                        CFG.MAX_UNIVERSE,

                    candidates:
                        CFG.CANDIDATES,

                    deepWatch:
                        CFG.DEEP_WATCH
                },

            timeframe:
                {
                    trend:
                        CFG.TF_1H,

                    structure:
                        CFG.TF_15M,

                    breakout:
                        CFG.TF_3M,

                    entry:
                        CFG.TF_1M
                },

            breakout:
                {
                    volumeRatio:
                        CFG.BREAKOUT_VOLUME_RATIO,

                    bufferPercent:
                        CFG.BREAKOUT_BUFFER_PERCENT
                },

            retest:
                {
                    minutes:
                        CFG.RETEST_WINDOW_MINUTES,

                    tolerance:
                        CFG.RETEST_TOLERANCE_PERCENT
                },

            risk:
                {
                    minStop:
                        CFG.MIN_STOP_PERCENT,

                    maxStop:
                        CFG.MAX_STOP_PERCENT,

                    minRR:
                        CFG.MIN_RR
                }
        });
    }
);

// ===============================================================
// API CHART
// ===============================================================

function resolveSymbol(
    input
) {

    const clean =
        String(
            input || ''
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
                'USDT',
                ''
            );

    if (!clean) {
        return null;
    }

    const futures =
        `${clean}/USDT:USDT`;

    if (
        exchange.markets?.[futures]
    ) {

        return futures;
    }

    const spot =
        `${clean}/USDT`;

    if (
        exchange.markets?.[spot]
    ) {

        return spot;
    }

    return null;
}

app.get(
    '/api/chart',
    async (req, res) => {

        try {

            const symbol =
                resolveSymbol(
                    req.query.symbol
                );

            if (!symbol) {

                return res
                    .status(404)
                    .json({

                        success:
                            false,

                        error:
                            'Market bulunamadı.'
                    });
            }

            const allowed = [
                '1m',
                '3m',
                '5m',
                '15m',
                '1h',
                '4h'
            ];

            const timeframe =
                allowed.includes(
                    req.query.timeframe
                )
                    ? req.query.timeframe
                    : '3m';

            const limit =
                clamp(
                    Number(
                        req.query.limit
                    ) || 100,
                    50,
                    200
                );

            const candles =
                await fetchCandles(
                    symbol,
                    timeframe,
                    limit
                );

            if (
                !candles ||
                !candles.length
            ) {

                return res
                    .status(503)
                    .json({

                        success:
                            false,

                        error:
                            'Grafik verisi alınamadı.'
                    });
            }

            const ticker =
                await fetchTicker(
                    symbol
                );

            res.json({

                success:
                    true,

                symbol:
                    displaySymbol(
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
                                Number(
                                    c[0]
                                ),

                            open:
                                Number(
                                    c[1]
                                ),

                            high:
                                Number(
                                    c[2]
                                ),

                            low:
                                Number(
                                    c[3]
                                ),

                            close:
                                Number(
                                    c[4]
                                ),

                            volume:
                                Number(
                                    c[5]
                                )
                        })
                    )
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

// ===============================================================
// MANUAL COIN ANALYSIS
// ===============================================================

app.get(
    '/api/analyze',
    async (req, res) => {

        try {

            const symbol =
                resolveSymbol(
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

            const [
                candles1h,
                candles15,
                candles3,
                candles1
            ] =
                await Promise.all([

                    fetchCandles(
                        symbol,
                        CFG.TF_1H,
                        CFG.LIMIT_1H
                    ),

                    fetchCandles(
                        symbol,
                        CFG.TF_15M,
                        CFG.LIMIT_15M
                    ),

                    fetchCandles(
                        symbol,
                        CFG.TF_3M,
                        CFG.LIMIT_3M
                    ),

                    fetchCandles(
                        symbol,
                        CFG.TF_1M,
                        CFG.LIMIT_1M
                    )
                ]);

            const price =
                Number(
                    lastClosed(
                        candles3
                    )[4]
                );

            const tech1h =
                technicalSnapshot(
                    candles1h
                );

            const tech3 =
                technicalSnapshot(
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
                await getOneMinuteConfirmation(
                    symbol,
                    breakout?.direction ||
                    tech3?.trend ||
                    'LONG'
                );

            res.json({

                success:
                    true,

                symbol:
                    displaySymbol(
                        symbol
                    ),

                price,

                trend1h:
                    tech1h?.trend ||
                    'NEUTRAL',

                trend3m:
                    tech3?.trend ||
                    'NEUTRAL',

                rsi3m:
                    tech3?.rsi ||
                    50,

                adx3m:
                    tech3?.adx ||
                    0,

                structure,

                breakout,

                oneMinute:
                    oneM,

                market:
                    STATE.market
            });

        }
        catch (error) {

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

// ===============================================================
// FORCE SCAN
// ===============================================================

app.post(
    '/api/scan',
    async (req, res) => {

        if (
            STATE.scanning
        ) {

            return res.json({

                success:
                    false,

                message:
                    'Tarama devam ediyor.'
            });
        }

        runFullRadar();

        res.json({

            success:
                true,

            message:
                'Radar başlatıldı.'
        });
    }
);

// ===============================================================
// ROOT
// ===============================================================

app.get(
    '/',
    (req, res) => {

        res.sendFile(
            path.join(
                __dirname,
                'public',
                'index.html'
            )
        );
    }
);

// ===============================================================
// FULL RADAR
// ===============================================================

async function runFullRadar() {

    if (
        STATE.radarRunning
    ) {
        return;
    }

    STATE.radarRunning =
        true;

    const started =
        now();

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

        // -------------------------------------------------------
        // 500
        // -------------------------------------------------------

        await loadUniverse();

        // -------------------------------------------------------
        // 500 -> 150
        // -------------------------------------------------------

        await buildCandidates();

        // -------------------------------------------------------
        // Market
        // -------------------------------------------------------

        await calculateMarketState();

        // -------------------------------------------------------
        // 150 -> 40
        // -------------------------------------------------------

        await buildDeepWatch();

        STATE.stats.lastRadar =
            now();

        console.log(
            `RADAR | ` +
            `Universe=${STATE.stats.universe} | ` +
            `Candidates=${STATE.stats.candidates} | ` +
            `DeepWatch=${STATE.stats.deepWatch}`
        );

        broadcastStatus();

    }
    catch (error) {

        STATE.lastError =
            error.message;

        console.error(
            'RADAR ERROR:',
            error
        );

    }
    finally {

        STATE.radarRunning =
            false;

        STATE.stats.scanSeconds =
            Number(
                (
                    (
                        now() -
                        started
                    ) /
                    1000
                ).toFixed(1)
            );

        STATE.stats.lastScan =
            now();
    }
}

// ===============================================================
// DEEP LOOP
// ===============================================================

async function runDeepScan() {

    if (
        STATE.scanning ||
        STATE.deepWatch.length === 0
    ) {
        return;
    }

    STATE.scanning =
        true;

    try {

        const batch =
            getRotationBatch();

        await scanBreakouts(
            batch
        );

        await processPendingBreakouts();

        cleanup();

        STATE.stats.pending =
            STATE.pendingBreakouts.size;

        STATE.stats.signals =
            STATE.signals.size;

        STATE.stats.lastScan =
            now();

        broadcastStatus();

        console.log(
            `DEEP | ` +
            `Batch=${batch.length} | ` +
            `Analyzed=${STATE.stats.analyzed} | ` +
            `Pending=${STATE.stats.pending} | ` +
            `Signals=${STATE.stats.signals}`
        );

    }
    catch (error) {

        STATE.lastError =
            error.message;

        console.error(
            'DEEP SCAN ERROR:',
            error.message
        );

    }
    finally {

        STATE.scanning =
            false;
    }
}

// ===============================================================
// PERIODIC JOBS
// ===============================================================

setInterval(
    () => {

        runFullRadar();

    },
    CFG.FULL_RADAR_MS
);

setInterval(
    () => {

        runDeepScan();

    },
    CFG.DEEP_SCAN_MS
);

setInterval(
    () => {

        processPendingBreakouts()
            .catch(() => {});

    },
    CFG.RETEST_CHECK_MS
);

setInterval(
    () => {

        cleanup();

    },
    CFG.CLEANUP_MS
);

// ===============================================================
// START
// ===============================================================

server.listen(
    PORT,
    async () => {

        console.log(
            '\n================================================='
        );

        console.log(
            '🚀 SONNY AI TRADER — SCALP ENGINE V5'
        );

        console.log(
            '📡 Bitget USDT Futures'
        );

        console.log(
            '🔭 500 Coin Radar'
        );

        console.log(
            '🎯 150 Candidate'
        );

        console.log(
            '👁️ 40 Deep Watch'
        );

        console.log(
            '📊 1H Trend'
        );

        console.log(
            '📐 15M Structure'
        );

        console.log(
            '⚡ 3M Breakout'
        );

        console.log(
            '🔄 3M Retest'
        );

        console.log(
            '🔥 1M Confirmation Bonus'
        );

        console.log(
            '🎯 Minimum R:R:',
            CFG.MIN_RR
        );

        console.log(
            '🛑 Auto Trade: OFF'
        );

        console.log(
            `🌐 Port: ${PORT}`
        );

        console.log(
            '=================================================\n'
        );

        try {

            await exchange.loadMarkets(
                true
            );

            await runFullRadar();

            await runDeepScan();

        }
        catch (error) {

            STATE.lastError =
                error.message;

            console.error(
                'STARTUP ERROR:',
                error
            );
        }
    }
);

// ===============================================================
// SAFETY
// ===============================================================

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
