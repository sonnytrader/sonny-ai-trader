/**
 * ============================================================
 * SONNY AI SIGNAL SCANNER
 * V9.1 - STABLE RENDER EDITION
 * ============================================================
 *
 * DATA:
 *   BITGET
 *
 * STRATEGY:
 *   4H SUPPORT / RESISTANCE
 *   2H CONFIRMATION
 *   15M STRUCTURE
 *   LIVE PRICE
 *
 * UI:
 *   Signal list left
 *   Selected signal / chart right
 *   TradingView -> BINANCE
 *
 * IMPORTANT:
 *   dotenv KULLANILMIYOR.
 *   Render environment variables doğrudan process.env üzerinden okunur.
 * ============================================================
 */

const express = require("express");
const http = require("http");
const ccxt = require("ccxt");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());

const PORT = process.env.PORT || 10000;

const BITGET_API_KEY = process.env.BITGET_API_KEY || "";
const BITGET_SECRET = process.env.BITGET_SECRET || "";
const BITGET_PASSPHRASE = process.env.BITGET_PASSPHRASE || "";

/* ============================================================
   CONFIG
============================================================ */

const CONFIG = {

    MARKET_LIMIT: 300,

    MIN_VOLUME_USD: 300000,

    REFRESH_MS: 60 * 1000,

    PRICE_REFRESH_MS: 5000,

    SIGNAL_MAX_AGE_MS: 60 * 60 * 1000,

    MAX_SIGNALS: 10,

    FOUR_HOUR_LIMIT: 120,

    TWO_HOUR_LIMIT: 120,

    FIFTEEN_MIN_LIMIT: 100,

    SR_LOOKBACK_4H: 40,

    SR_LOOKBACK_2H: 40,

    SR_NEAR_PERCENT: 1.20,

    SR_CLUSTER_PERCENT: 0.80,

    MIN_TOUCHES: 2,

    ENTRY_ZONE_PERCENT: 0.30,

    STOP_PERCENT: 2.0,

    TP1_R: 1.0,

    TP2_R: 2.0,

    TP3_R: 3.0

};

/* ============================================================
   GLOBAL STATE
============================================================ */

let exchange = null;

let market = [];

let signals = new Map();

let resultCache = null;

let scanning = false;

let lastScan = null;

let lastError = null;

let lastScanDuration = 0;

const priceCache = new Map();

const candleCache = new Map();

/* ============================================================
   HELPERS
============================================================ */

function sleep(ms) {

    return new Promise(resolve => setTimeout(resolve, ms));

}

function log(message) {

    console.log(
        `[${new Date().toISOString()}] ${message}`
    );

}

function roundPrice(price) {

    if (!Number.isFinite(price)) {
        return 0;
    }

    if (price < 0.00001) {
        return Number(price.toFixed(8));
    }

    if (price < 0.001) {
        return Number(price.toFixed(7));
    }

    if (price < 1) {
        return Number(price.toFixed(5));
    }

    if (price < 10) {
        return Number(price.toFixed(4));
    }

    if (price < 1000) {
        return Number(price.toFixed(2));
    }

    return Number(price.toFixed(1));

}

function percentDistance(price, level) {

    if (!price || !level) {
        return 999;
    }

    return Math.abs(price - level) / level * 100;

}

function cleanSymbol(symbol) {

    if (!symbol) {
        return "";
    }

    return symbol
        .replace(":USDT", "")
        .replace("/USDT", "")
        .replace("USDT", "") + "USDT";

}

function binanceTradingView(symbol) {

    return (
        "https://www.tradingview.com/chart/?symbol=BINANCE%3A" +
        encodeURIComponent(cleanSymbol(symbol))
    );

}

/* ============================================================
   EXCHANGE
============================================================ */

function createExchange() {

    return new ccxt.bitget({

        apiKey: BITGET_API_KEY,

        secret: BITGET_SECRET,

        password: BITGET_PASSPHRASE,

        enableRateLimit: true,

        timeout: 30000,

        options: {

            defaultType: "swap"

        }

    });

}

/* ============================================================
   MARKET DISCOVERY
============================================================ */

async function discoverMarket() {

    try {

        await exchange.loadMarkets();

        const tickers = await exchange.fetchTickers();

        const rows = [];

        for (const symbol of Object.keys(exchange.markets)) {

            const m = exchange.markets[symbol];

            if (!m) {
                continue;
            }

            if (!m.active) {
                continue;
            }

            if (!m.swap) {
                continue;
            }

            if (m.quote !== "USDT") {
                continue;
            }

            const ticker = tickers[symbol];

            if (!ticker) {
                continue;
            }

            const volume = Number(ticker.quoteVolume || 0);

            if (volume < CONFIG.MIN_VOLUME_USD) {
                continue;
            }

            const price = Number(ticker.last || 0);

            if (!price) {
                continue;
            }

            rows.push({

                symbol,

                price,

                change24h: Number(ticker.percentage || 0),

                quoteVolume: volume

            });

        }

        rows.sort(
            (a, b) =>
                b.quoteVolume - a.quoteVolume
        );

        market = rows.slice(
            0,
            CONFIG.MARKET_LIMIT
        );

        log(
            `Discovery tamamlandı. ${market.length} uygun coin bulundu.`
        );

        return market;

    } catch (error) {

        lastError = error.message;

        log(
            "Discovery hatası: " +
            error.message
        );

        return market;

    }

}

/* ============================================================
   OHLCV
============================================================ */

async function getCandles(
    symbol,
    timeframe,
    limit
) {

    const key =
        `${symbol}_${timeframe}_${limit}`;

    const cached =
        candleCache.get(key);

    if (
        cached &&
        Date.now() - cached.time < 45000
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

        if (data && data.length) {

            candleCache.set(
                key,
                {
                    time: Date.now(),
                    data
                }
            );

        }

        return data || [];

    } catch (error) {

        log(
            `OHLCV hatası ${symbol} ${timeframe}: ${error.message}`
        );

        return [];

    }

}

/* ============================================================
   LIVE PRICE
============================================================ */

async function getLivePrice(symbol) {

    const cached =
        priceCache.get(symbol);

    if (
        cached &&
        Date.now() - cached.time < 3000
    ) {

        return cached.price;

    }

    try {

        const ticker =
            await exchange.fetchTicker(symbol);

        const price =
            Number(ticker.last || 0);

        if (price) {

            priceCache.set(
                symbol,
                {
                    price,
                    time: Date.now()
                }
            );

        }

        return price;

    } catch {

        return cached?.price || 0;

    }

}

/* ============================================================
   SWING LEVELS
============================================================ */

function findSwingLevels(
    candles,
    lookback
) {

    if (
        !candles ||
        candles.length < 15
    ) {

        return {
            supports: [],
            resistances: []
        };

    }

    const data =
        candles.slice(-lookback);

    const supports = [];

    const resistances = [];

    for (
        let i = 2;
        i < data.length - 2;
        i++
    ) {

        const current =
            data[i];

        const prev1 =
            data[i - 1];

        const prev2 =
            data[i - 2];

        const next1 =
            data[i + 1];

        const next2 =
            data[i + 2];

        const low =
            current[3];

        const high =
            current[2];

        if (
            low <= prev1[3] &&
            low <= prev2[3] &&
            low <= next1[3] &&
            low <= next2[3]
        ) {

            supports.push({

                level: low,

                index: i

            });

        }

        if (
            high >= prev1[2] &&
            high >= prev2[2] &&
            high >= next1[2] &&
            high >= next2[2]
        ) {

            resistances.push({

                level: high,

                index: i

            });

        }

    }

    return {

        supports,

        resistances

    };

}

/* ============================================================
   CLUSTER LEVELS
============================================================ */

function clusterLevels(
    levels,
    tolerancePercent
) {

    if (!levels.length) {

        return [];

    }

    const sorted =
        [...levels].sort(
            (a, b) =>
                a.level - b.level
        );

    const clusters = [];

    for (const item of sorted) {

        let cluster =
            clusters.find(
                c =>
                    Math.abs(
                        item.level - c.level
                    ) /
                    c.level *
                    100
                    <= tolerancePercent
            );

        if (!cluster) {

            cluster = {

                levels: [],

                level: item.level

            };

            clusters.push(cluster);

        }

        cluster.levels.push(item);

        cluster.level =
            cluster.levels.reduce(
                (sum, x) =>
                    sum + x.level,
                0
            ) /
            cluster.levels.length;

    }

    return clusters
        .map(c => ({

            level: c.level,

            touches:
                c.levels.length

        }))
        .sort(
            (a, b) =>
                b.touches - a.touches
        );

}

/* ============================================================
   SUPPORT / RESISTANCE
============================================================ */

function getLevels(
    candles
) {

    const swing =
        findSwingLevels(
            candles,
            CONFIG.SR_LOOKBACK_4H
        );

    const supports =
        clusterLevels(
            swing.supports,
            CONFIG.SR_CLUSTER_PERCENT
        );

    const resistances =
        clusterLevels(
            swing.resistances,
            CONFIG.SR_CLUSTER_PERCENT
        );

    return {

        supports,

        resistances

    };

}

/* ============================================================
   2H CONFIRMATION
============================================================ */

function get2HConfirmation(
    candles,
    direction,
    level
) {

    if (
        !candles ||
        candles.length < 10
    ) {

        return false;

    }

    const recent =
        candles.slice(-8);

    let touches = 0;

    for (const c of recent) {

        const high = c[2];

        const low = c[3];

        if (
            direction === "LONG"
        ) {

            if (
                percentDistance(
                    low,
                    level
                ) <= CONFIG.SR_NEAR_PERCENT
            ) {

                touches++;

            }

        } else {

            if (
                percentDistance(
                    high,
                    level
                ) <= CONFIG.SR_NEAR_PERCENT
            ) {

                touches++;

            }

        }

    }

    return touches > 0;

}

/* ============================================================
   15M STRUCTURE
============================================================ */

function get15MStructure(
    candles
) {

    if (
        !candles ||
        candles.length < 20
    ) {

        return "NEUTRAL";

    }

    const data =
        candles.slice(-20);

    const closes =
        data.map(c => c[4]);

    const highs =
        data.map(c => c[2]);

    const lows =
        data.map(c => c[3]);

    const last =
        closes[closes.length - 1];

    const previous =
        closes[closes.length - 6];

    const recentHigh =
        Math.max(
            ...highs.slice(-8)
        );

    const previousHigh =
        Math.max(
            ...highs.slice(-16, -8)
        );

    const recentLow =
        Math.min(
            ...lows.slice(-8)
        );

    const previousLow =
        Math.min(
            ...lows.slice(-16, -8)
        );

    if (
        last > previous &&
        recentHigh >= previousHigh &&
        recentLow >= previousLow
    ) {

        return "LONG";

    }

    if (
        last < previous &&
        recentHigh <= previousHigh &&
        recentLow <= previousLow
    ) {

        return "SHORT";

    }

    return "NEUTRAL";

}

/* ============================================================
   SIGNAL QUALITY
============================================================ */

function calculateSignalQuality({
    touches4H,
    touches2H,
    distance,
    structure,
    direction
}) {

    let score = 55;

    if (touches4H >= 2) {
        score += 10;
    }

    if (touches4H >= 4) {
        score += 10;
    }

    if (touches2H) {
        score += 10;
    }

    if (distance <= 0.25) {
        score += 10;
    }

    if (
        structure === direction
    ) {

        score += 10;

    }

    return Math.min(
        100,
        score
    );

}

/* ============================================================
   TRADE PLAN
============================================================ */

function createTradePlan({
    symbol,
    direction,
    price,
    level,
    score,
    touches4H,
    touches2H,
    structure
}) {

    const zone =
        level *
        CONFIG.ENTRY_ZONE_PERCENT /
        100;

    let entryLow;

    let entryHigh;

    let stop;

    if (
        direction === "LONG"
    ) {

        entryLow =
            level - zone;

        entryHigh =
            level + zone;

        stop =
            level *
            (1 - CONFIG.STOP_PERCENT / 100);

    } else {

        entryLow =
            level - zone;

        entryHigh =
            level + zone;

        stop =
            level *
            (1 + CONFIG.STOP_PERCENT / 100);

    }

    const risk =
        Math.abs(
            level - stop
        );

    let tp1;

    let tp2;

    let tp3;

    if (
        direction === "LONG"
    ) {

        tp1 =
            level + risk * CONFIG.TP1_R;

        tp2 =
            level + risk * CONFIG.TP2_R;

        tp3 =
            level + risk * CONFIG.TP3_R;

    } else {

        tp1 =
            level - risk * CONFIG.TP1_R;

        tp2 =
            level - risk * CONFIG.TP2_R;

        tp3 =
            level - risk * CONFIG.TP3_R;

    }

    return {

        id:
            `${cleanSymbol(symbol)}_${direction}_${Math.round(Date.now() / 1000)}`,

        symbol:
            cleanSymbol(symbol),

        rawSymbol:
            symbol,

        direction,

        score,

        price:
            roundPrice(price),

        level:
            roundPrice(level),

        levelType:
            direction === "LONG"
                ? "DESTEK"
                : "DİRENÇ",

        touches4H,

        confirmed2H:
            touches2H,

        structure,

        distance:
            Number(
                percentDistance(
                    price,
                    level
                ).toFixed(2)
            ),

        entryLow:
            roundPrice(entryLow),

        entryHigh:
            roundPrice(entryHigh),

        stop:
            roundPrice(stop),

        tp1:
            roundPrice(tp1),

        tp2:
            roundPrice(tp2),

        tp3:
            roundPrice(tp3),

        createdAt:
            Date.now(),

        lastPrice:
            roundPrice(price),

        status:
            "ENTRY_WAITING",

        tradingView:
            binanceTradingView(symbol),

        reason:
            `${touches2H ? "4H + 2H aynı bölge" : "4H kritik seviye"} + ${touches4H} temas` +
            (
                structure === direction
                    ? " + 15M yapı onayı"
                    : ""
            )

    };

}

/* ============================================================
   ANALYZE COIN
============================================================ */

async function analyzeCoin(
    coin
) {

    try {

        const symbol =
            coin.symbol;

        const price =
            await getLivePrice(
                symbol
            );

        if (!price) {
            return null;
        }

        const [
            candles4H,
            candles2H,
            candles15M
        ] = await Promise.all([

            getCandles(
                symbol,
                "4h",
                CONFIG.FOUR_HOUR_LIMIT
            ),

            getCandles(
                symbol,
                "2h",
                CONFIG.TWO_HOUR_LIMIT
            ),

            getCandles(
                symbol,
                "15m",
                CONFIG.FIFTEEN_MIN_LIMIT
            )

        ]);

        if (
            candles4H.length < 20 ||
            candles2H.length < 20 ||
            candles15M.length < 20
        ) {

            return null;

        }

        const levels4H =
            getLevels(
                candles4H
            );

        let bestSignal = null;

        /* ====================================================
           LONG = FİYAT DESTEĞE YAKIN
        ==================================================== */

        for (
            const support
            of levels4H.supports
        ) {

            const distance =
                percentDistance(
                    price,
                    support.level
                );

            if (
                distance >
                CONFIG.SR_NEAR_PERCENT
            ) {

                continue;

            }

            const confirmed2H =
                get2HConfirmation(
                    candles2H,
                    "LONG",
                    support.level
                );

            if (!confirmed2H) {
                continue;
            }

            const structure =
                get15MStructure(
                    candles15M
                );

            const score =
                calculateSignalQuality({

                    touches4H:
                        support.touches,

                    touches2H:
                        true,

                    distance,

                    structure,

                    direction:
                        "LONG"

                });

            const signal =
                createTradePlan({

                    symbol,

                    direction:
                        "LONG",

                    price,

                    level:
                        support.level,

                    score,

                    touches4H:
                        support.touches,

                    touches2H:
                        true,

                    structure

                });

            if (
                !bestSignal ||
                signal.score >
                    bestSignal.score
            ) {

                bestSignal =
                    signal;

            }

        }

        /* ====================================================
           SHORT = FİYAT DİRENCE YAKIN
        ==================================================== */

        for (
            const resistance
            of levels4H.resistances
        ) {

            const distance =
                percentDistance(
                    price,
                    resistance.level
                );

            if (
                distance >
                CONFIG.SR_NEAR_PERCENT
            ) {

                continue;

            }

            const confirmed2H =
                get2HConfirmation(
                    candles2H,
                    "SHORT",
                    resistance.level
                );

            if (!confirmed2H) {
                continue;
            }

            const structure =
                get15MStructure(
                    candles15M
                );

            const score =
                calculateSignalQuality({

                    touches4H:
                        resistance.touches,

                    touches2H:
                        true,

                    distance,

                    structure,

                    direction:
                        "SHORT"

                });

            const signal =
                createTradePlan({

                    symbol,

                    direction:
                        "SHORT",

                    price,

                    level:
                        resistance.level,

                    score,

                    touches4H:
                        resistance.touches,

                    touches2H:
                        true,

                    structure

                });

            if (
                !bestSignal ||
                signal.score >
                    bestSignal.score
            ) {

                bestSignal =
                    signal;

            }

        }

        return bestSignal;

    } catch (error) {

        log(
            `Analiz hatası ${coin.symbol}: ${error.message}`
        );

        return null;

    }

}

/* ============================================================
   SIGNAL LIFECYCLE
============================================================ */

function signalIsStillValid(
    signal,
    price
) {

    if (!price) {
        return false;
    }

    signal.lastPrice =
        roundPrice(price);

    const age =
        Date.now() -
        signal.createdAt;

    if (
        age >
        CONFIG.SIGNAL_MAX_AGE_MS
    ) {

        return false;

    }

    /*
     * LONG:
     * Fiyat giriş bölgesini yukarı doğru
     * tamamen geçtiyse fırsat kaçmıştır.
     */

    if (
        signal.direction === "LONG"
    ) {

        if (
            price >
            signal.entryHigh
        ) {

            return false;

        }

        /*
         * Çok aşağı kaçtıysa artık
         * aynı giriş fırsatı değildir.
         */

        if (
            price <
            signal.stop
        ) {

            return false;

        }

    }

    /*
     * SHORT:
     * Fiyat giriş bölgesini aşağı doğru
     * tamamen geçtiyse fırsat kaçmıştır.
     */

    if (
        signal.direction === "SHORT"
    ) {

        if (
            price <
            signal.entryLow
        ) {

            return false;

        }

        if (
            price >
            signal.stop
        ) {

            return false;

        }

    }

    return true;

}

/* ============================================================
   LIVE SIGNAL UPDATE
============================================================ */

async function updateLiveSignals() {

    const entries =
        Array.from(
            signals.values()
        );

    for (
        const signal
        of entries
    ) {

        const price =
            await getLivePrice(
                signal.rawSymbol
            );

        if (
            !signalIsStillValid(
                signal,
                price
            )
        ) {

            signals.delete(
                signal.id
            );

            log(
                `SİNYAL KALDIRILDI | ${signal.symbol} | ${signal.direction}`
            );

            continue;

        }

        if (
            signal.direction === "LONG"
        ) {

            if (
                price >=
                signal.entryLow &&
                price <=
                signal.entryHigh
            ) {

                signal.status =
                    "ENTRY_ACTIVE";

            } else {

                signal.status =
                    "ENTRY_WAITING";

            }

        } else {

            if (
                price >=
                signal.entryLow &&
                price <=
                signal.entryHigh
            ) {

                signal.status =
                    "ENTRY_ACTIVE";

            } else {

                signal.status =
                    "ENTRY_WAITING";

            }

        }

        signal.lastUpdate =
            Date.now();

    }

}

/* ============================================================
   REGISTER SIGNAL
============================================================ */

function registerSignal(
    signal
) {

    if (!signal) {
        return;
    }

    /*
     * Aynı coin + aynı yön tekrar eklenmesin.
     */

    for (
        const existing
        of signals.values()
    ) {

        if (
            existing.symbol ===
                signal.symbol &&
            existing.direction ===
                signal.direction
        ) {

            return;

        }

    }

    /*
     * Maksimum aktif sinyal.
     */

    if (
        signals.size >=
        CONFIG.MAX_SIGNALS
    ) {

        const weakest =
            Array.from(
                signals.values()
            )
            .sort(
                (a, b) =>
                    a.score -
                    b.score
            )[0];

        if (
            weakest &&
            weakest.score <
                signal.score
        ) {

            signals.delete(
                weakest.id
            );

        } else {

            return;

        }

    }

    signals.set(
        signal.id,
        signal
    );

    log(
        `YENİ SİNYAL | ${signal.symbol} | ${signal.direction} | Güç=${signal.score} | Seviye=${signal.level}`
    );

}

/* ============================================================
   MARKET DIRECTION
============================================================ */

function marketDirection() {

    const btc =
        market.find(
            x =>
                cleanSymbol(x.symbol) ===
                "BTCUSDT"
        );

    const eth =
        market.find(
            x =>
                cleanSymbol(x.symbol) ===
                "ETHUSDT"
        );

    const list =
        [btc, eth]
        .filter(Boolean);

    if (!list.length) {

        return {

            direction:
                "YATAY",

            label:
                "PİYASA VERİSİ BEKLENİYOR"

        };

    }

    let long = 0;

    let short = 0;

    for (
        const item
        of list
    ) {

        if (
            item.change24h > 0.5
        ) {

            long++;

        }

        if (
            item.change24h < -0.5
        ) {

            short++;

        }

    }

    if (
        long > short
    ) {

        return {

            direction:
                "LONG",

            label:
                "PİYASA YUKARI",

            reason:
                "BTC / ETH yükseliş ağırlıklı."

        };

    }

    if (
        short > long
    ) {

        return {

            direction:
                "SHORT",

            label:
                "PİYASA AŞAĞI",

            reason:
                "BTC / ETH düşüş ağırlıklı."

        };

    }

    return {

        direction:
            "YATAY",

        label:
            "PİYASA YATAY",

        reason:
            "BTC / ETH karışık."

    };

}

/* ============================================================
   RADAR
============================================================ */

async function runRadar() {

    if (scanning) {

        return resultCache;

    }

    scanning = true;

    lastError = null;

    const started =
        Date.now();

    try {

        await discoverMarket();

        log(
            `RADAR başladı | Universe=${market.length} | DeepAnalysis=${market.length}`
        );

        const found =
            [];

        /*
         * Kontrollü paralellik.
         * Bitget 429 almaması için bütün 300 coin
         * aynı anda gönderilmiyor.
         */

        const BATCH = 10;

        for (
            let i = 0;
            i < market.length;
            i += BATCH
        ) {

            const batch =
                market.slice(
                    i,
                    i + BATCH
                );

            const rows =
                await Promise.all(
                    batch.map(
                        analyzeCoin
                    )
                );

            for (
                const signal
                of rows
            ) {

                if (signal) {

                    found.push(
                        signal
                    );

                }

            }

            await sleep(100);

        }

        found.sort(
            (a, b) =>
                b.score -
                a.score
        );

        for (
            const signal
            of found
        ) {

            registerSignal(
                signal
            );

        }

        await updateLiveSignals();

        const active =
            Array.from(
                signals.values()
            )
            .sort(
                (a, b) =>
                    b.score -
                    a.score
            )
            .slice(
                0,
                CONFIG.MAX_SIGNALS
            );

        lastScanDuration =
            Date.now() -
            started;

        lastScan =
            new Date()
                .toISOString();

        resultCache = {

            success:
                true,

            system:
                "Sonny AI Signal Scanner V9.1",

            timestamp:
                lastScan,

            market:
                marketDirection(),

            stats: {

                market:
                    market.length,

                analyzed:
                    market.length,

                signals:
                    active.length

            },

            signals:
                active,

            strategy:
                "4H DESTEK/DİRENÇ + 2H ONAY + 15M YAPI",

            refresh:
                "60 SANİYE",

            livePriceRefresh:
                "5 SANİYE",

            scanMs:
                lastScanDuration

        };

        log(
            `RADAR tamamlandı | Universe=${market.length} | Analiz=${market.length} | SIGNAL=${active.length} | ${lastScanDuration}ms`
        );

        broadcast();

        return resultCache;

    } catch (error) {

        lastError =
            error.message;

        log(
            "RADAR ERROR: " +
            error.message
        );

        return resultCache;

    } finally {

        scanning =
            false;

    }

}

/* ============================================================
   BACKGROUND LIVE LOOP
============================================================ */

async function liveLoop() {

    try {

        await updateLiveSignals();

        if (resultCache) {

            resultCache.signals =
                Array.from(
                    signals.values()
                )
                .sort(
                    (a, b) =>
                        b.score -
                        a.score
                )
                .slice(
                    0,
                    CONFIG.MAX_SIGNALS
                );

            resultCache.timestamp =
                new Date()
                    .toISOString();

            broadcast();

        }

    } catch (error) {

        log(
            "LIVE LOOP ERROR: " +
            error.message
        );

    }

}

/* ============================================================
   WEBSOCKET
============================================================ */

function broadcast() {

    const payload =
        JSON.stringify({

            type:
                "state",

            result:
                resultCache

        });

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

wss.on(
    "connection",
    ws => {

        if (resultCache) {

            ws.send(
                JSON.stringify({

                    type:
                        "state",

                    result:
                        resultCache

                })
            );

        }

    }
);

/* ============================================================
   API
============================================================ */

app.get(
    "/api/result",
    async (req, res) => {

        if (!resultCache) {

            runRadar()
                .catch(
                    error =>
                        log(
                            "İlk tarama hatası: " +
                            error.message
                        )
                );

            return res.json({

                success:
                    true,

                scanning:
                    true,

                result:
                    null

            });

        }

        res.setHeader(
            "Cache-Control",
            "no-store"
        );

        res.json({

            success:
                true,

            scanning,

            result:
                resultCache

        });

    }
);

app.get(
    "/api/status",
    (req, res) => {

        res.json({

            success:
                true,

            status:
                scanning
                    ? "SCANNING"
                    : "ONLINE",

            system:
                "Sonny AI Signal Scanner V9.1",

            strategy:
                "4H DESTEK/DİRENÇ + 2H ONAY + 15M YAPI",

            market:
                market.length,

            activeSignals:
                signals.size,

            lastScan,

            scanMs:
                lastScanDuration,

            error:
                lastError

        });

    }
);

app.post(
    "/api/scan",
    async (req, res) => {

        if (scanning) {

            return res.json({

                success:
                    true,

                message:
                    "Tarama zaten devam ediyor."

            });

        }

        runRadar();

        res.json({

            success:
                true,

            message:
                "Tarama başlatıldı."

        });

    }
);

/* ============================================================
   HEALTH
============================================================ */

app.get(
    "/health",
    (req, res) => {

        res.json({

            success:
                true,

            status:
                "healthy",

            system:
                "Sonny AI Signal Scanner V9.1"

        });

    }
);

/* ============================================================
   FRONTEND
============================================================ */

const HTML = `
<!DOCTYPE html>

<html lang="tr">

<head>

<meta charset="UTF-8">

<meta
    name="viewport"
    content="width=device-width,initial-scale=1"
>

<title>
Sonny AI Signal Terminal V9.1
</title>

<script
src="https://s3.tradingview.com/tv.js">
</script>

<style>

* {
    box-sizing:
        border-box;
}

html,
body {

    margin:
        0;

    padding:
        0;

    width:
        100%;

    height:
        100%;

    background:
        #070b12;

    color:
        #f4f7fb;

    font-family:
        Inter,
        Arial,
        sans-serif;

}

body {

    overflow:
        hidden;

}

.app {

    display:
        grid;

    grid-template-columns:
        390px 1fr;

    height:
        100vh;

}

/* =========================================================
   LEFT
========================================================= */

.sidebar {

    border-right:
        1px solid #1d2633;

    background:
        #0b1018;

    display:
        flex;

    flex-direction:
        column;

    min-width:
        0;

}

.brand {

    padding:
        20px;

    border-bottom:
        1px solid #1d2633;

}

.brand-title {

    font-size:
        21px;

    font-weight:
        900;

}

.brand-sub {

    margin-top:
        5px;

    color:
        #718096;

    font-size:
        11px;

}

.market {

    padding:
        15px 20px;

    border-bottom:
        1px solid #1d2633;

}

.market-label {

    color:
        #718096;

    font-size:
        10px;

    font-weight:
        800;

}

.market-value {

    margin-top:
        5px;

    font-size:
        18px;

    font-weight:
        900;

}

.signal-header {

    padding:
        15px 20px 8px;

    display:
        flex;

    justify-content:
        space-between;

}

.signal-header span {

    color:
        #718096;

    font-size:
        10px;

    font-weight:
        800;

}

.signal-list {

    flex:
        1;

    overflow-y:
        auto;

    padding:
        8px 12px 20px;

}

.signal-item {

    border:
        1px solid #202b3b;

    background:
        #0f1621;

    border-radius:
        12px;

    padding:
        13px;

    margin-bottom:
        8px;

    cursor:
        pointer;

    transition:
        .15s;

}

.signal-item:hover {

    border-color:
        #52667e;

}

.signal-item.selected {

    border-color:
        #6f7f95;

    background:
        #141d2a;

}

.signal-top {

    display:
        flex;

    justify-content:
        space-between;

    align-items:
        center;

}

.coin {

    font-size:
        16px;

    font-weight:
        900;

}

.long {

    color:
        #32df91;

}

.short {

    color:
        #ff5e70;

}

.badge {

    font-size:
        10px;

    font-weight:
        900;

    padding:
        5px 8px;

    border-radius:
        6px;

    background:
        #1c2635;

}

.signal-price {

    margin-top:
        9px;

    color:
        #b6c0cf;

    font-size:
        12px;

}

.signal-meta {

    margin-top:
        8px;

    display:
        flex;

    justify-content:
        space-between;

    color:
        #748197;

    font-size:
        10px;

}

.signal-status {

    margin-top:
        10px;

    font-size:
        10px;

    font-weight:
        900;

}

/* =========================================================
   MAIN
========================================================= */

.main {

    min-width:
        0;

    display:
        flex;

    flex-direction:
        column;

}

.topbar {

    height:
        66px;

    border-bottom:
        1px solid #1d2633;

    display:
        flex;

    align-items:
        center;

    justify-content:
        space-between;

    padding:
        0 22px;

}

.top-status {

    color:
        #708097;

    font-size:
        11px;

}

.online {

    display:
        inline-flex;

    align-items:
        center;

    gap:
        7px;

}

.dot {

    width:
        7px;

    height:
        7px;

    border-radius:
        50%;

    background:
        #35df8e;

}

.chart {

    flex:
        1;

    min-height:
        0;

    position:
        relative;

    background:
        #090d14;

}

#tv_chart {

    width:
        100%;

    height:
        100%;

}

.details {

    min-height:
        225px;

    border-top:
        1px solid #1d2633;

    background:
        #0b1018;

    padding:
        16px 22px;

    overflow:
        auto;

}

.detail-top {

    display:
        flex;

    justify-content:
        space-between;

    align-items:
        center;

}

.detail-coin {

    font-size:
        22px;

    font-weight:
        900;

}

.detail-direction {

    margin-left:
        10px;

    font-size:
        14px;

    font-weight:
        900;

}

.grid {

    display:
        grid;

    grid-template-columns:
        repeat(6,1fr);

    gap:
        8px;

    margin-top:
        14px;

}

.box {

    background:
        #121a26;

    border:
        1px solid #202b3a;

    border-radius:
        8px;

    padding:
        10px;

}

.box-label {

    color:
        #718096;

    font-size:
        9px;

    font-weight:
        800;

}

.box-value {

    margin-top:
        5px;

    font-size:
        14px;

    font-weight:
        900;

}

.reason {

    margin-top:
        10px;

    color:
        #8793a6;

    font-size:
        11px;

}

.tv-button {

    margin-top:
        12px;

    display:
        inline-block;

    padding:
        9px 13px;

    border:
        1px solid #303c4e;

    border-radius:
        7px;

    color:
        #dce4ef;

    text-decoration:
        none;

    font-size:
        10px;

    font-weight:
        900;

}

.empty {

    height:
        100%;

    display:
        flex;

    justify-content:
        center;

    align-items:
        center;

    color:
        #596579;

    font-size:
        13px;

}

@media(max-width:900px) {

    body {
        overflow:
            auto;
    }

    .app {

        grid-template-columns:
            1fr;

        height:
            auto;

        min-height:
            100vh;

    }

    .sidebar {

        height:
            380px;

        border-right:
            0;

        border-bottom:
            1px solid #1d2633;

    }

    .main {

        height:
            700px;

    }

    .grid {

        grid-template-columns:
            repeat(3,1fr);

    }

}

</style>

</head>

<body>

<div class="app">

    <aside class="sidebar">

        <div class="brand">

            <div class="brand-title">
                🚀 Sonny AI Signal Terminal
            </div>

            <div class="brand-sub">
                4H Destek/Direnç · 2H Onay · 15M Yapı
            </div>

        </div>

        <div class="market">

            <div class="market-label">
                GENEL PİYASA
            </div>

            <div
                id="market"
                class="market-value"
            >
                VERİ BEKLENİYOR
            </div>

        </div>

        <div class="signal-header">

            <span>
                AKTİF SİNYALLER
            </span>

            <span id="count">
                0
            </span>

        </div>

        <div
            id="signalList"
            class="signal-list"
        >

            <div class="empty">
                Sinyal aranıyor...
            </div>

        </div>

    </aside>

    <main class="main">

        <div class="topbar">

            <div id="selectedTitle">
                Sinyal seçilmedi
            </div>

            <div class="top-status">

                <span class="online">

                    <span class="dot"></span>

                    SÜREKLİ AKTİF

                </span>

                &nbsp; · &nbsp;

                <span id="scan">
                    Tarama bekleniyor
                </span>

            </div>

        </div>

        <div class="chart">

            <div
                id="tv_chart"
            ></div>

        </div>

        <div class="details">

            <div
                id="details"
                class="empty"
            >

                Sol taraftan bir sinyal seç.

            </div>

        </div>

    </main>

</div>

<script>

let state = null;

let selectedId = null;

let widget = null;

function esc(value) {

    return String(value ?? "")
        .replaceAll("&","&amp;")
        .replaceAll("<","&lt;")
        .replaceAll(">","&gt;")
        .replaceAll('"',"&quot;");

}

function money(value) {

    if (
        value === null ||
        value === undefined
    ) {

        return "-";

    }

    return Number(value)
        .toLocaleString(
            "en-US",
            {
                maximumFractionDigits: 8
            }
        );

}

function loadChart(symbol) {

    const clean =
        String(symbol)
            .replace(
                /[^A-Z0-9]/g,
                ""
            );

    document.getElementById(
        "tv_chart"
    ).innerHTML = "";

    if (
        !window.TradingView
    ) {

        return;

    }

    widget =
        new TradingView.widget({

            autosize:
                true,

            symbol:
                "BINANCE:" + clean,

            interval:
                "15",

            timezone:
                "Europe/Istanbul",

            theme:
                "dark",

            style:
                "1",

            locale:
                "tr",

            enable_publishing:
                false,

            hide_top_toolbar:
                false,

            hide_legend:
                false,

            save_image:
                false,

            container_id:
                "tv_chart"

        });

}

function renderDetails(signal) {

    const details =
        document.getElementById(
            "details"
        );

    if (!signal) {

        details.innerHTML =
            '<div class="empty">Sinyal seçilmedi.</div>';

        return;

    }

    const directionClass =
        signal.direction === "LONG"
            ? "long"
            : "short";

    const statusText =
        signal.status === "ENTRY_ACTIVE"
            ? "● GİRİŞ BÖLGESİNDE"
            : "○ GİRİŞ BEKLENİYOR";

    details.className =
        "details";

    details.innerHTML = `

        <div class="detail-top">

            <div>

                <span class="detail-coin">
                    ${esc(signal.symbol)}
                </span>

                <span
                    class="detail-direction ${directionClass}"
                >
                    ${esc(signal.direction)}
                </span>

            </div>

            <div>
                GÜÇ ${esc(signal.score)}/100
            </div>

        </div>

        <div class="grid">

            <div class="box">

                <div class="box-label">
                    CANLI FİYAT
                </div>

                <div class="box-value">
                    ${money(signal.lastPrice)}
                </div>

            </div>

            <div class="box">

                <div class="box-label">
                    4H / 2H SEVİYE
                </div>

                <div class="box-value">
                    ${money(signal.level)}
                </div>

            </div>

            <div class="box">

                <div class="box-label">
                    GİRİŞ ALT
                </div>

                <div class="box-value">
                    ${money(signal.entryLow)}
                </div>

            </div>

            <div class="box">

                <div class="box-label">
                    GİRİŞ ÜST
                </div>

                <div class="box-value">
                    ${money(signal.entryHigh)}
                </div>

            </div>

            <div class="box">

                <div class="box-label">
                    STOP
                </div>

                <div class="box-value">
                    ${money(signal.stop)}
                </div>

            </div>

            <div class="box">

                <div class="box-label">
                    UZAKLIK
                </div>

                <div class="box-value">
                    %${esc(signal.distance)}
                </div>

            </div>

        </div>

        <div class="grid">

            <div class="box">

                <div class="box-label">
                    TP1
                </div>

                <div class="box-value">
                    ${money(signal.tp1)}
                </div>

            </div>

            <div class="box">

                <div class="box-label">
                    TP2
                </div>

                <div class="box-value">
                    ${money(signal.tp2)}
                </div>

            </div>

            <div class="box">

                <div class="box-label">
                    TP3
                </div>

                <div class="box-value">
                    ${money(signal.tp3)}
                </div>

            </div>

            <div class="box">

                <div class="box-label">
                    4H TEMAS
                </div>

                <div class="box-value">
                    ${esc(signal.touches4H)}
                </div>

            </div>

            <div class="box">

                <div class="box-label">
                    2H ONAY
                </div>

                <div class="box-value">
                    ${signal.confirmed2H ? "EVET" : "HAYIR"}
                </div>

            </div>

            <div class="box">

                <div class="box-label">
                    15M YAPI
                </div>

                <div class="box-value">
                    ${esc(signal.structure)}
                </div>

            </div>

        </div>

        <div class="reason">

            <b>${esc(statusText)}</b>

            &nbsp; · &nbsp;

            ${esc(signal.reason)}

            <br><br>

            Sinyal zamanı:
            ${new Date(signal.createdAt).toLocaleTimeString("tr-TR")}

        </div>

        <a
            class="tv-button"
            target="_blank"
            href="${esc(signal.tradingView)}"
        >
            📊 BINANCE TRADINGVIEW AÇ
        </a>

    `;

}

function renderSignals(result) {

    state = result;

    const list =
        document.getElementById(
            "signalList"
        );

    const signals =
        result?.signals || [];

    document.getElementById(
        "count"
    ).textContent =
        signals.length;

    document.getElementById(
        "market"
    ).textContent =
        result?.market?.label ||
        "VERİ BEKLENİYOR";

    document.getElementById(
        "scan"
    ).textContent =
        result?.timestamp
            ? new Date(
                result.timestamp
              ).toLocaleTimeString(
                "tr-TR"
              )
            : "-";

    if (!signals.length) {

        list.innerHTML =
            '<div class="empty">Şu anda aktif sinyal yok.</div>';

        renderDetails(null);

        return;

    }

    if (
        !selectedId ||
        !signals.some(
            x =>
                x.id === selectedId
        )
    ) {

        selectedId =
            signals[0].id;

    }

    list.innerHTML =
        signals
            .map(
                signal => {

                    const cls =
                        signal.direction === "LONG"
                            ? "long"
                            : "short";

                    const status =
                        signal.status ===
                        "ENTRY_ACTIVE"
                            ? "● GİRİŞ"
                            : "○ BEKLİYOR";

                    return `

                        <div
                            class="signal-item ${
                                signal.id === selectedId
                                    ? "selected"
                                    : ""
                            }"
                            onclick="selectSignal('${esc(signal.id)}')"
                        >

                            <div class="signal-top">

                                <div
                                    class="coin ${cls}"
                                >
                                    ${esc(signal.symbol)}
                                </div>

                                <div class="badge">
                                    ${esc(signal.direction)}
                                </div>

                            </div>

                            <div class="signal-price">

                                ${money(signal.lastPrice)}

                                &nbsp; · &nbsp;

                                Seviye
                                ${money(signal.level)}

                            </div>

                            <div class="signal-meta">

                                <span>
                                    Güç ${esc(signal.score)}
                                </span>

                                <span>
                                    %${esc(signal.distance)}
                                </span>

                            </div>

                            <div
                                class="signal-status ${cls}"
                            >
                                ${status}
                            </div>

                        </div>

                    `;

                }
            )
            .join("");

    const selected =
        signals.find(
            x =>
                x.id === selectedId
        );

    renderDetails(
        selected
    );

}

function selectSignal(id) {

    selectedId =
        id;

    const signal =
        state?.signals?.find(
            x =>
                x.id === id
        );

    if (!signal) {
        return;
    }

    document.getElementById(
        "selectedTitle"
    ).textContent =
        signal.symbol +
        " · " +
        signal.direction;

    renderSignals(
        state
    );

    loadChart(
        signal.symbol
    );

}

async function load() {

    try {

        const response =
            await fetch(
                "/api/result?_=" +
                Date.now(),
                {
                    cache:
                        "no-store"
                }
            );

        const data =
            await response.json();

        if (
            data.result
        ) {

            renderSignals(
                data.result
            );

            const selected =
                data.result.signals?.find(
                    x =>
                        x.id ===
                        selectedId
                );

            if (
                selected &&
                document.getElementById(
                    "selectedTitle"
                ).textContent ===
                "Sinyal seçilmedi"
            ) {

                selectSignal(
                    selected.id
                );

            }

        }

    } catch (error) {

        document.getElementById(
            "scan"
        ).textContent =
            "Bağlantı hatası";

    }

}

load();

setInterval(
    load,
    5000
);

</script>

</body>

</html>
`;

/* ============================================================
   HTML ROUTE
============================================================ */

app.get(
    "/",
    (req, res) => {

        res.setHeader(
            "Content-Type",
            "text/html; charset=utf-8"
        );

        res.setHeader(
            "Cache-Control",
            "no-store"
        );

        res.send(
            HTML
        );

    }
);

/* ============================================================
   SERVER START
============================================================ */

async function start() {

    try {

        exchange =
            createExchange();

        log(
            "Sonny AI Signal Scanner V9.1 started"
        );

        log(
            "Data source: BITGET"
        );

        log(
            "TradingView: BINANCE"
        );

        log(
            "Strategy: 4H SUPPORT/RESISTANCE + 2H CONFIRMATION + 15M STRUCTURE"
        );

        log(
            "Refresh: Every 60 seconds"
        );

        log(
            "Live prices: Every 5 seconds"
        );

        log(
            "Auto trade: OFF"
        );

        await discoverMarket();

        setTimeout(
            () => {

                runRadar()
                    .catch(
                        error =>
                            log(
                                "İlk radar hatası: " +
                                error.message
                            )
                    );

            },
            1500
        );

        setInterval(
            () => {

                runRadar()
                    .catch(
                        error =>
                            log(
                                "Radar interval hatası: " +
                                error.message
                            )
                    );

            },
            CONFIG.REFRESH_MS
        );

        setInterval(
            () => {

                liveLoop()
                    .catch(
                        error =>
                            log(
                                "Live loop hatası: " +
                                error.message
                            )
                    );

            },
            CONFIG.PRICE_REFRESH_MS
        );

    } catch (error) {

        log(
            "START ERROR: " +
            error.message
        );

    }

}

server.listen(
    PORT,
    "0.0.0.0",
    () => {

        log(
            `Server listening on port ${PORT}`
        );

        start();

    }
);
