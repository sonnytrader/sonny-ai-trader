// ============================================================
// SONNY AI TRADER V10 - SIGNAL TERMINAL
// ============================================================
// 4H DESTEK/DİRENÇ
// 2H DESTEK/DİRENÇ ONAYI
// 15M YAPI
// OTOMATİK LONG / SHORT
// CANLI FİYAT
// SİNYAL YAŞI
// GİRİŞ BÖLGESİ TAKİBİ
// GRAFİK ÜZERİNDE GİRİŞ / STOP / TP
// TRADINGVIEW -> BINANCE
//
// DATA SOURCE: BITGET
// AUTO TRADE: YOK
// ============================================================

require('dotenv').config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 10000;

// ============================================================
// CONFIG
// ============================================================

const CONFIG = {

    // Evren
    MIN_VOLUME_USD: Number(process.env.MIN_VOLUME_USD || 500000),
    MAX_COINS: Number(process.env.MAX_COINS || 260),

    // Aktif sinyal
    MAX_SIGNALS: 12,

    // Tarama
    SCAN_INTERVAL: 60 * 1000,

    // Canlı fiyat
    PRICE_INTERVAL: 5 * 1000,

    // Mumlar
    CANDLE_4H: 100,
    CANDLE_2H: 100,
    CANDLE_15M: 120,

    // Seviye
    LEVEL_LOOKBACK: 80,

    // Fiyatın seviyeye maksimum uzaklığı
    LEVEL_TOLERANCE_PCT: 1.20,

    // Seviye bölgesi
    ZONE_WIDTH_PCT: 0.35,

    // Sinyalin maksimum ekranda kalma süresi
    SIGNAL_MAX_AGE: 45 * 60 * 1000,

    // Debug
    DEBUG: process.env.DEBUG === 'true'
};

// ============================================================
// BITGET
// ============================================================

const exchange = new ccxt.bitget({

    apiKey: process.env.BITGET_API_KEY || '',
    secret: process.env.BITGET_SECRET || '',
    password: process.env.BITGET_PASSPHRASE || '',

    enableRateLimit: true,

    timeout: 20000,

    sandbox: false
});

// ============================================================
// GLOBAL STATE
// ============================================================

let universe = [];

let signals = new Map();

let selectedSignalId = null;

let lastScan = 0;

let scanRunning = false;

let priceRunning = false;

let stats = {

    scanned: 0,

    signals: 0,

    lastDuration: 0,

    errors: 0

};

// ============================================================
// HELPERS
// ============================================================

const sleep = ms =>
    new Promise(resolve => setTimeout(resolve, ms));

const now = () =>
    Date.now();

const clean = symbol =>
    String(symbol || '')
        .replace(/[^A-Za-z0-9]/g, '')
        .toUpperCase();

const base = symbol =>
    clean(symbol).replace(/USDT$/, '');


// ============================================================
// TRADINGVIEW
// ============================================================

function getTradingViewLink(symbol) {

    const coin = base(symbol);

    return (
        'https://www.tradingview.com/chart/?symbol=BINANCE%3A' +
        coin +
        'USDT.P'
    );
}


// ============================================================
// PRICE PRECISION
// ============================================================

function precisionPrice(symbol, price) {

    const market = exchange.markets?.[symbol];

    const precision =
        market?.precision?.price;

    if (Number.isInteger(precision)) {

        return Number(
            Number(price).toFixed(
                Math.min(12, precision)
            )
        );
    }

    if (price >= 1000)
        return Number(price.toFixed(2));

    if (price >= 1)
        return Number(price.toFixed(4));

    if (price >= 0.01)
        return Number(price.toFixed(6));

    return Number(price.toFixed(8));
}


// ============================================================
// DISTANCE
// ============================================================

function pctDistance(price, level) {

    if (!price || !level)
        return 999;

    return (
        Math.abs(price - level) /
        price *
        100
    );
}


// ============================================================
// ATR
// ============================================================

function calculateATR(candles, period = 14) {

    if (
        !candles ||
        candles.length < period + 1
    ) {
        return 0;
    }

    const trs = [];

    for (
        let i = 1;
        i < candles.length;
        i++
    ) {

        const high = candles[i][2];

        const low = candles[i][3];

        const previousClose =
            candles[i - 1][4];

        const tr = Math.max(

            high - low,

            Math.abs(
                high - previousClose
            ),

            Math.abs(
                low - previousClose
            )
        );

        trs.push(tr);
    }

    const recent =
        trs.slice(-period);

    return (
        recent.reduce(
            (a, b) => a + b,
            0
        ) /
        recent.length
    );
}


// ============================================================
// SWING HIGH
// ============================================================

function isSwingHigh(
    candles,
    index,
    radius = 2
) {

    if (
        index < radius ||
        index >= candles.length - radius
    ) {
        return false;
    }

    const high =
        candles[index][2];

    for (
        let i = 1;
        i <= radius;
        i++
    ) {

        if (
            high <= candles[index - i][2] ||
            high < candles[index + i][2]
        ) {
            return false;
        }
    }

    return true;
}


// ============================================================
// SWING LOW
// ============================================================

function isSwingLow(
    candles,
    index,
    radius = 2
) {

    if (
        index < radius ||
        index >= candles.length - radius
    ) {
        return false;
    }

    const low =
        candles[index][3];

    for (
        let i = 1;
        i <= radius;
        i++
    ) {

        if (
            low >= candles[index - i][3] ||
            low > candles[index + i][3]
        ) {
            return false;
        }
    }

    return true;
}


// ============================================================
// 15M MARKET STRUCTURE
// ============================================================

function analyze15MStructure(candles) {

    if (
        !candles ||
        candles.length < 25
    ) {

        return {

            direction: 'NEUTRAL',

            text: 'Yeterli 15M yapı yok',

            score: 0
        };
    }

    const highs = [];

    const lows = [];

    for (
        let i = 2;
        i < candles.length - 2;
        i++
    ) {

        if (
            isSwingHigh(
                candles,
                i,
                2
            )
        ) {

            highs.push({
                price: candles[i][2],
                index: i
            });
        }

        if (
            isSwingLow(
                candles,
                i,
                2
            )
        ) {

            lows.push({
                price: candles[i][3],
                index: i
            });
        }
    }

    const lastHighs =
        highs.slice(-3);

    const lastLows =
        lows.slice(-3);

    if (
        lastHighs.length < 2 ||
        lastLows.length < 2
    ) {

        return {

            direction: 'NEUTRAL',

            text: 'Nötr yapı',

            score: 0
        };
    }

    const h1 =
        lastHighs[lastHighs.length - 2].price;

    const h2 =
        lastHighs[lastHighs.length - 1].price;

    const l1 =
        lastLows[lastLows.length - 2].price;

    const l2 =
        lastLows[lastLows.length - 1].price;


    // Higher High + Higher Low

    if (
        h2 > h1 &&
        l2 > l1
    ) {

        return {

            direction: 'LONG',

            text: 'HH + HL',

            score: 1
        };
    }


    // Lower High + Lower Low

    if (
        h2 < h1 &&
        l2 < l1
    ) {

        return {

            direction: 'SHORT',

            text: 'LH + LL',

            score: 1
        };
    }


    return {

        direction: 'NEUTRAL',

        text: 'Kararsız yapı',

        score: 0
    };
}


// ============================================================
// BUILD SUPPORT / RESISTANCE LEVELS
// ============================================================

function buildLevels(
    candles,
    timeframe
) {

    const raw = [];

    const start =
        Math.max(
            2,
            candles.length -
            CONFIG.LEVEL_LOOKBACK
        );


    for (
        let i = start;
        i < candles.length - 2;
        i++
    ) {

        if (
            isSwingHigh(
                candles,
                i,
                2
            )
        ) {

            raw.push({

                price: candles[i][2],

                type: 'RESISTANCE',

                timeframe,

                index: i
            });
        }


        if (
            isSwingLow(
                candles,
                i,
                2
            )
        ) {

            raw.push({

                price: candles[i][3],

                type: 'SUPPORT',

                timeframe,

                index: i
            });
        }
    }


    raw.sort(
        (a, b) =>
            a.price - b.price
    );


    const zones = [];


    for (const point of raw) {

        const existing =
            zones.find(
                z =>
                    Math.abs(
                        point.price -
                        z.price
                    ) /
                    point.price *
                    100
                    <=
                    CONFIG.ZONE_WIDTH_PCT
            );


        if (existing) {

            existing.prices.push(
                point.price
            );

            existing.types.add(
                point.type
            );

            existing.lastIndex =
                Math.max(
                    existing.lastIndex,
                    point.index
                );

            existing.price =
                existing.prices.reduce(
                    (a, b) => a + b,
                    0
                ) /
                existing.prices.length;

        } else {

            zones.push({

                price: point.price,

                prices: [
                    point.price
                ],

                types: new Set([
                    point.type
                ]),

                lastIndex:
                    point.index
            });
        }
    }


    return zones.map(z => ({

        price: z.price,

        type:
            z.types.has('SUPPORT') &&
            z.types.has('RESISTANCE')

                ? 'BOTH'

                : [...z.types][0],

        timeframe,

        touches:
            z.prices.length,

        lastIndex:
            z.lastIndex
    }));
}


// ============================================================
// MERGE 4H + 2H
// ============================================================

function mergeMultiTimeframeLevels(
    levels4H,
    levels2H,
    currentPrice
) {

    const merged = [];


    // Önce 4H seviyeleri

    for (const level4H of levels4H) {

        if (
            level4H.type === 'BOTH'
        ) {
            continue;
        }


        // Aynı tip 2H seviye ara

        const matching2H =
            levels2H.find(level2H => {

                if (
                    level2H.type !==
                    level4H.type
                ) {
                    return false;
                }

                return (
                    Math.abs(
                        level2H.price -
                        level4H.price
                    ) /
                    level4H.price *
                    100
                    <=
                    CONFIG.ZONE_WIDTH_PCT
                );
            });


        const finalPrice =
            matching2H

                ? (
                    level4H.price +
                    matching2H.price
                ) / 2

                : level4H.price;


        merged.push({

            price: finalPrice,

            type: level4H.type,

            h4: true,

            h2: !!matching2H,

            touches:
                level4H.touches +
                (
                    matching2H
                        ? matching2H.touches
                        : 0
                ),

            strength:
                level4H.touches +
                (
                    matching2H
                        ? matching2H.touches + 3
                        : 0
                ),

            distance:
                pctDistance(
                    currentPrice,
                    finalPrice
                )
        });
    }


    // 2H'de olup 4H'de olmayan seviyeler

    for (const level2H of levels2H) {

        if (
            level2H.type === 'BOTH'
        ) {
            continue;
        }


        const alreadyExists =
            merged.some(level =>

                level.type ===
                level2H.type &&

                Math.abs(
                    level.price -
                    level2H.price
                ) /
                level2H.price *
                100
                <=
                CONFIG.ZONE_WIDTH_PCT
            );


        if (alreadyExists)
            continue;


        merged.push({

            price: level2H.price,

            type: level2H.type,

            h4: false,

            h2: true,

            touches:
                level2H.touches,

            strength:
                level2H.touches,

            distance:
                pctDistance(
                    currentPrice,
                    level2H.price
                )
        });
    }


    return merged

        .filter(
            level =>
                level.distance <=
                CONFIG.LEVEL_TOLERANCE_PCT
        )

        .sort(
            (a, b) =>
                a.distance -
                b.distance
        );
}


// ============================================================
// OHLCV
// ============================================================

async function fetchOHLCV(
    symbol,
    timeframe,
    limit
) {

    try {

        return await exchange.fetchOHLCV(
            symbol,
            timeframe,
            undefined,
            limit
        );

    } catch (error) {

        if (CONFIG.DEBUG) {

            console.log(
                'OHLCV ERROR',
                symbol,
                timeframe,
                error.message
            );
        }

        return [];
    }
}


// ============================================================
// DISCOVERY
// ============================================================

async function fetchUniverse() {

    await exchange.loadMarkets(true);


    const markets =
        Object.values(
            exchange.markets
        ).filter(m =>

            m &&

            m.active !== false &&

            m.quote === 'USDT' &&

            (m.swap || m.contract) &&

            !String(
                m.symbol
            ).includes(':')
        );


    const symbols =
        markets
            .slice(0, 500)
            .map(
                m => m.symbol
            );


    let tickers = {};


    try {

        tickers =
            await exchange.fetchTickers(
                symbols
            );

    } catch (error) {

        console.log(
            'Ticker toplu istek hatası:',
            error.message
        );
    }


    const ranked =
        markets

            .map(m => {

                const ticker =
                    tickers[m.symbol];

                const volume =
                    Number(
                        ticker?.quoteVolume ||
                        ticker?.info?.quoteVol ||
                        0
                    );

                const last =
                    Number(
                        ticker?.last ||
                        0
                    );

                return {

                    symbol: m.symbol,

                    volume,

                    last
                };
            })

            .filter(
                x =>
                    x.last > 0 &&
                    x.volume >=
                    CONFIG.MIN_VOLUME_USD
            )

            .sort(
                (a, b) =>
                    b.volume -
                    a.volume
            );


    universe =
        ranked.slice(
            0,
            CONFIG.MAX_COINS
        );


    console.log(
        `Discovery tamamlandı. ${universe.length} uygun coin bulundu.`
    );
}


// ============================================================
// SIGNAL CREATOR
// ============================================================

function createSignal(
    symbol,
    price,
    levels,
    candles15,
    candles4H,
    candles2H
) {

    if (
        !levels ||
        !levels.length
    ) {

        return null;
    }


    const candidate =
        levels[0];


    const level =
        candidate.price;


    const distance =
        candidate.distance;


    let direction;


    if (
        candidate.type ===
        'SUPPORT'
    ) {

        direction = 'LONG';

    } else if (
        candidate.type ===
        'RESISTANCE'
    ) {

        direction = 'SHORT';

    } else {

        return null;
    }


    // ========================================================
    // 15M STRUCTURE
    // ========================================================

    const structure =
        analyze15MStructure(
            candles15
        );


    // Ters yapı varsa sinyal verme.
    // Nötr yapı kabul edilir.
    if (
        structure.direction !==
        'NEUTRAL' &&

        structure.direction !==
        direction
    ) {

        return null;
    }


    // ========================================================
    // GİRİŞ BÖLGESİ
    // ========================================================

    const currentATR =
        calculateATR(
            candles15,
            14
        );


    const zoneHalf =
        Math.max(

            level *
            CONFIG.ZONE_WIDTH_PCT /
            100,

            currentATR
                ? currentATR * 0.35
                : level * 0.0015
        );


    const entryLow =
        level -
        zoneHalf;


    const entryHigh =
        level +
        zoneHalf;


    // ========================================================
    // STOP
    // ========================================================

    const atrValue =
        currentATR ||

        (
            Math.abs(
                candles4H[
                    candles4H.length - 1
                ][2] -

                candles4H[
                    candles4H.length - 1
                ][3]
            ) * 0.5
        ) ||

        level * 0.01;


    const stopDistance =
        Math.max(

            atrValue * 1.25,

            level * 0.006
        );


    const stop =
        direction === 'LONG'

            ? entryLow -
              stopDistance

            : entryHigh +
              stopDistance;


    // ========================================================
    // RISK
    // ========================================================

    const referenceEntry =
        direction === 'LONG'
            ? entryHigh
            : entryLow;


    const risk =
        Math.abs(
            referenceEntry -
            stop
        );


    // ========================================================
    // TAKE PROFITS
    // ========================================================

    const tp1 =
        direction === 'LONG'

            ? entryHigh +
              risk * 1.4

            : entryLow -
              risk * 1.4;


    const tp2 =
        direction === 'LONG'

            ? entryHigh +
              risk * 2.2

            : entryLow -
              risk * 2.2;


    const tp3 =
        direction === 'LONG'

            ? entryHigh +
              risk * 3.0

            : entryLow -
              risk * 3.0;


    // ========================================================
    // SCORE
    // ========================================================

    let score = 55;


    // 4H seviye
    if (candidate.h4)
        score += 15;


    // 2H seviye
    if (candidate.h2)
        score += 15;


    // Temas
    if (
        candidate.touches >= 3
    )
        score += 5;


    if (
        candidate.touches >= 5
    )
        score += 5;


    // 15M onayı
    if (
        structure.direction ===
        direction
    )
        score += 12;


    // Mesafe
    score -= Math.min(
        12,
        distance * 4
    );


    score =
        Math.max(
            55,
            Math.min(
                99,
                Math.round(score)
            )
        );


    // ========================================================
    // STATUS
    // ========================================================

    let status = 'WAITING';


    if (
        price >= entryLow &&
        price <= entryHigh
    ) {

        status = 'ENTRY';
    }


    // ========================================================
    // ID
    // ========================================================

    const id =

        `${clean(symbol)}-${direction}-${Math.round(level * 100000000)}`;


    // ========================================================
    // SIGNAL
    // ========================================================

    return {

        id,

        symbol,

        ccxtSymbol: symbol,

        direction,

        confidence: score,

        price,

        lastPrice: price,

        level,

        levelType:
            candidate.type,

        distancePct:
            Number(
                distance.toFixed(3)
            ),

        entryLow:
            precisionPrice(
                symbol,
                entryLow
            ),

        entryHigh:
            precisionPrice(
                symbol,
                entryHigh
            ),

        stop:
            precisionPrice(
                symbol,
                stop
            ),

        tp1:
            precisionPrice(
                symbol,
                tp1
            ),

        tp2:
            precisionPrice(
                symbol,
                tp2
            ),

        tp3:
            precisionPrice(
                symbol,
                tp3
            ),

        status,

        createdAt:
            now(),

        updatedAt:
            now(),

        structure:
            structure.direction,

        structureText:
            structure.text,

        touches:
            candidate.touches,

        strong:
            Boolean(
                candidate.h4 &&
                candidate.h2
            ),

        reason:

            `${candidate.h4 ? '4H' : ''}` +

            `${candidate.h4 && candidate.h2 ? ' + ' : ''}` +

            `${candidate.h2 ? '2H' : ''}` +

            ` bölge + ${candidate.touches} temas` +

            `${
                structure.direction === direction
                    ? ' + 15M yapı onayı'
                    : ''
            }`,

        tvLink:
            getTradingViewLink(
                symbol
            ),

        chart: {

            candles15:
                candles15,

            level,

            entryLow,

            entryHigh,

            stop,

            tp1,

            tp2,

            tp3
        }
    };
}


// ============================================================
// SIGNAL AGE
// ============================================================

function signalAge(ms) {

    const seconds =
        Math.max(
            0,
            Math.floor(ms / 1000)
        );


    if (
        seconds < 60
    ) {

        return (
            seconds +
            ' sn'
        );
    }


    const minutes =
        Math.floor(
            seconds / 60
        );


    if (
        minutes < 60
    ) {

        return (
            minutes +
            ' dk'
        );
    }


    return (

        Math.floor(
            minutes / 60
        ) +

        ' sa ' +

        (
            minutes % 60
        ) +

        ' dk'
    );
}


// ============================================================
// SIGNAL PAYLOAD
// ============================================================

function getSignalPayload() {

    return (

        [...signals.values()]

            .sort(
                (a, b) =>
                    b.confidence -
                    a.confidence
            )

            .slice(
                0,
                CONFIG.MAX_SIGNALS
            )

            .map(signal => ({

                ...signal,

                ageMs:
                    now() -
                    signal.createdAt,

                ageText:
                    signalAge(
                        now() -
                        signal.createdAt
                    )
            }))
    );
}


// ============================================================
// BROADCAST
// ============================================================

function broadcast(
    type = 'state'
) {

    const payload = {

        type,

        signals:
            getSignalPayload(),

        selected:

            selectedSignalId
                ? signals.get(
                    selectedSignalId
                  ) || null
                : null,

        stats: {

            ...stats,

            universe:
                universe.length,

            active:
                signals.size
        },

        lastScan,

        market:
            'BITGET',

        tradingView:
            'BINANCE',

        serverTime:
            now()
    };


    const text =
        JSON.stringify(
            payload
        );


    for (
        const client of
        wss.clients
    ) {

        if (
            client.readyState ===
            WebSocket.OPEN
        ) {

            try {

                client.send(
                    text
                );

            } catch {}
        }
    }
}


// ============================================================
// LIVE SIGNAL LIFECYCLE
// ============================================================

function updateSignalLifecycle(
    signal,
    price
) {

    signal.lastPrice =
        price;

    signal.updatedAt =
        now();


    const inside =
        price >=
        signal.entryLow &&

        price <=
        signal.entryHigh;


    if (inside) {

        signal.status =
            'ENTRY';

    } else if (

        signal.direction ===
        'LONG' &&

        price >
        signal.entryHigh

    ) {

        // LONG fiyat giriş bölgesini
        // yukarıdan geçtiyse fırsat kaçtı.

        signal.status =
            'MISSED';

    } else if (

        signal.direction ===
        'SHORT' &&

        price <
        signal.entryLow

    ) {

        // SHORT fiyat giriş bölgesini
        // aşağıdan geçtiyse fırsat kaçtı.

        signal.status =
            'MISSED';

    } else {

        signal.status =
            'WAITING';
    }


    // Kaçan sinyal
    if (
        signal.status ===
        'MISSED'
    ) {

        return false;
    }


    // Çok eski sinyal
    if (
        now() -
        signal.createdAt >
        CONFIG.SIGNAL_MAX_AGE
    ) {

        return false;
    }


    return true;
}


// ============================================================
// LIVE PRICE UPDATE
// ============================================================

async function updateLivePrices() {

    if (
        priceRunning ||
        signals.size === 0
    ) {

        return;
    }


    priceRunning = true;


    try {

        const active =
            [...signals.values()];


        for (
            const signal of
            active
        ) {

            try {

                const ticker =
                    await exchange.fetchTicker(
                        signal.ccxtSymbol
                    );


                const price =
                    Number(
                        ticker?.last ||
                        ticker?.close ||
                        0
                    );


                if (!price)
                    continue;


                const alive =
                    updateSignalLifecycle(
                        signal,
                        price
                    );


                if (!alive) {

                    signals.delete(
                        signal.id
                    );


                    if (
                        selectedSignalId ===
                        signal.id
                    ) {

                        selectedSignalId =
                            null;
                    }
                }

            } catch (error) {

                stats.errors++;
            }
        }


        stats.signals =
            signals.size;


        broadcast(
            'price_update'
        );

    } finally {

        priceRunning =
            false;
    }
}


// ============================================================
// ANALYZE COIN
// ============================================================

async function analyzeCoin(
    item
) {

    const symbol =
        item.symbol;


    const results =
        await Promise.all([

            fetchOHLCV(
                symbol,
                '4h',
                CONFIG.CANDLE_4H
            ),

            fetchOHLCV(
                symbol,
                '2h',
                CONFIG.CANDLE_2H
            ),

            fetchOHLCV(
                symbol,
                '15m',
                CONFIG.CANDLE_15M
            )
        ]);


    const candles4H =
        results[0];

    const candles2H =
        results[1];

    const candles15 =
        results[2];


    if (
        candles4H.length < 30 ||
        candles2H.length < 30 ||
        candles15.length < 30
    ) {

        return null;
    }


    const price =
        Number(
            candles15[
                candles15.length - 1
            ][4]
        );


    const levels4H =
        buildLevels(
            candles4H,
            '4H'
        );


    const levels2H =
        buildLevels(
            candles2H,
            '2H'
        );


    const merged =
        mergeMultiTimeframeLevels(
            levels4H,
            levels2H,
            price
        );


    return createSignal(

        symbol,

        price,

        merged,

        candles15,

        candles4H,

        candles2H
    );
}


// ============================================================
// SHOULD REPLACE SIGNAL?
// ============================================================

function shouldReplace(
    oldSignal,
    newSignal
) {

    if (!oldSignal)
        return true;


    if (
        newSignal.confidence >
        oldSignal.confidence
    ) {

        return true;
    }


    if (
        newSignal.distancePct <
        oldSignal.distancePct
    ) {

        return true;
    }


    return false;
}


// ============================================================
// MAIN SCAN
// ============================================================

async function runScan() {

    if (scanRunning)
        return;


    scanRunning = true;


    const started =
        now();


    try {

        // Evren yoksa doldur
        if (
            universe.length === 0
        ) {

            await fetchUniverse();
        }


        // 10 dakikada bir evreni yenile
        if (
            lastScan &&
            now() - lastScan >
            10 * 60 * 1000
        ) {

            await fetchUniverse();
        }


        const candidates = [];


        for (
            const item of
            universe
        ) {

            try {

                const signal =
                    await analyzeCoin(
                        item
                    );


                if (signal) {

                    candidates.push(
                        signal
                    );
                }

            } catch (error) {

                stats.errors++;


                if (
                    CONFIG.DEBUG
                ) {

                    console.log(
                        'Analyze error:',
                        item.symbol,
                        error.message
                    );
                }
            }


            // Bitget'e yük bindirmemek için
            await sleep(20);
        }


        // ====================================================
        // COIN BAŞINA EN İYİ SİNYAL
        // ====================================================

        const bestByCoin =
            new Map();


        for (
            const signal of
            candidates
        ) {

            const key =
                clean(
                    signal.symbol
                );


            const old =
                bestByCoin.get(
                    key
                );


            if (
                shouldReplace(
                    old,
                    signal
                )
            ) {

                bestByCoin.set(
                    key,
                    signal
                );
            }
        }


        // ====================================================
        // ACTIVE SIGNALS
        // ====================================================

        for (
            const signal of
            bestByCoin.values()
        ) {

            const old =
                signals.get(
                    signal.id
                );


            // Zaten giriş bölgesindeyse
            // sinyalin yaşını sıfırlama.

            if (
                old &&
                old.status ===
                'ENTRY'
            ) {

                old.lastPrice =
                    signal.price;

                old.updatedAt =
                    now();

                continue;
            }


            // Aynı coin için eski sinyal
            const sameCoin =
                [...signals.values()]
                    .find(
                        x =>
                            clean(
                                x.symbol
                            ) ===
                            clean(
                                signal.symbol
                            )
                    );


            if (
                shouldReplace(
                    sameCoin,
                    signal
                )
            ) {

                // Eski sinyal aynı seviye ise
                // yaşını koru.

                if (
                    sameCoin &&
                    sameCoin.id ===
                    signal.id
                ) {

                    signal.createdAt =
                        sameCoin.createdAt;
                }


                signals.set(
                    signal.id,
                    signal
                );
            }
        }


        // ====================================================
        // MAX SIGNAL
        // ====================================================

        const sorted =
            [...signals.values()]
                .sort(
                    (a, b) => {

                        const aEntry =
                            a.status ===
                            'ENTRY'
                                ? 1
                                : 0;

                        const bEntry =
                            b.status ===
                            'ENTRY'
                                ? 1
                                : 0;


                        return (

                            bEntry -
                            aEntry ||

                            b.confidence -
                            a.confidence
                        );
                    }
                );


        signals =
            new Map(

                sorted

                    .slice(
                        0,
                        CONFIG.MAX_SIGNALS
                    )

                    .map(
                        s =>
                            [
                                s.id,
                                s
                            ]
                    )
            );


        stats.scanned =
            universe.length;

        stats.signals =
            signals.size;

        stats.lastDuration =
            now() -
            started;

        lastScan =
            now();


        console.log(

            `RADAR tamamlandı | ` +

            `Universe=${universe.length} | ` +

            `Analiz=${universe.length} | ` +

            `SIGNAL=${signals.size}`
        );


        broadcast(
            'scan_complete'
        );

    } catch (error) {

        stats.errors++;


        console.error(
            'RADAR ERROR:',
            error.message
        );


        broadcast(
            'error'
        );

    } finally {

        scanRunning =
            false;
    }
}


// ============================================================
// API
// ============================================================

app.get(
    '/api/state',
    (req, res) => {

        res.json({

            signals:
                getSignalPayload(),

            selected:

                selectedSignalId
                    ? signals.get(
                        selectedSignalId
                      ) || null
                    : null,

            stats: {

                ...stats,

                universe:
                    universe.length,

                active:
                    signals.size
            },

            lastScan,

            serverTime:
                now()
        });
    }
);


// ============================================================
// SINGLE SIGNAL
// ============================================================

app.get(
    '/api/signal/:id',
    (req, res) => {

        res.json(
            signals.get(
                req.params.id
            ) || null
        );
    }
);


// ============================================================
// SELECT SIGNAL
// ============================================================

app.post(
    '/api/select',
    (req, res) => {

        selectedSignalId =
            req.body?.id ||
            null;


        broadcast(
            'selection'
        );


        res.json({
            ok: true
        });
    }
);


// ============================================================
// MANUAL SCAN
// ============================================================

app.post(
    '/api/scan',
    async (req, res) => {

        runScan()
            .catch(
                () => {}
            );


        res.json({

            ok: true,

            message:
                'Tarama başlatıldı'
        });
    }
);


// ============================================================
// HEALTH
// ============================================================

app.get(
    '/health',
    (req, res) => {

        res.json({

            ok: true,

            uptime:
                process.uptime(),

            signals:
                signals.size,

            lastScan
        });
    }
);


// ============================================================
// FRONTEND
// ============================================================

app.get(
    '/',
    (req, res) => {

        res.send(
            INDEX_HTML
        );
    }
);


// ============================================================
// WEBSOCKET
// ============================================================

wss.on(
    'connection',
    ws => {

        console.log(
            'WS client connected'
        );


        ws.send(
            JSON.stringify({

                type:
                    'state',

                signals:
                    getSignalPayload(),

                selected:

                    selectedSignalId
                        ? signals.get(
                            selectedSignalId
                          ) || null
                        : null,

                stats: {

                    ...stats,

                    universe:
                        universe.length,

                    active:
                        signals.size
                },

                lastScan,

                serverTime:
                    now()
            })
        );
    }
);


// ============================================================
// FRONTEND HTML
// ============================================================

const INDEX_HTML = `<!doctype html>

<html lang="tr">

<head>

<meta charset="utf-8">

<meta
name="viewport"
content="width=device-width,initial-scale=1">

<title>
Sonny AI Trader V10
</title>

<style>

:root{

--bg:#080b10;
--panel:#10151d;
--panel2:#141b25;
--line:#26303d;

--text:#edf2f7;
--muted:#8d99a8;

--green:#18d889;
--red:#ff4d67;
--yellow:#ffc857;
--blue:#58a6ff;

}

*{
box-sizing:border-box;
}

body{

margin:0;

background:
var(--bg);

color:
var(--text);

font-family:
Inter,
Segoe UI,
Arial,
sans-serif;

height:100vh;

overflow:hidden;

}

.app{

height:100vh;

display:grid;

grid-template-columns:
330px
1fr
310px;

grid-template-rows:
72px
1fr;

}

.top{

grid-column:
1 / 4;

border-bottom:
1px solid var(--line);

display:flex;

align-items:center;

gap:18px;

padding:
12px 18px;

background:
#0b0f15;

}

.brand{

font-weight:
900;

font-size:
19px;

white-space:
nowrap;

}

.brand b{

color:
var(--green);

}

.pill{

border:
1px solid var(--line);

background:
var(--panel);

padding:
9px 13px;

border-radius:
10px;

color:
var(--muted);

}

.pill strong{

color:
var(--text);

margin-left:
5px;

}

.live{

color:
var(--green) !important;

}

.side{

min-width:0;

background:
var(--panel);

border-right:
1px solid var(--line);

overflow:auto;

}

.right{

min-width:0;

background:
var(--panel);

border-left:
1px solid var(--line);

overflow:auto;

}

.title{

padding:
17px 16px;

border-bottom:
1px solid var(--line);

font-weight:
800;

}

.signal{

margin:
10px;

border:
1px solid var(--line);

background:
var(--panel2);

border-radius:
13px;

padding:
13px;

cursor:
pointer;

transition:
.15s;

}

.signal:hover,
.signal.sel{

border-color:
#59687a;

transform:
translateY(-1px);

}

.signal.long{

border-left:
4px solid var(--green);

}

.signal.short{

border-left:
4px solid var(--red);

}

.row{

display:flex;

justify-content:
space-between;

gap:
8px;

}

.coin{

font-weight:
900;

font-size:
16px;

}

.longtxt{

color:
var(--green);

}

.shorttxt{

color:
var(--red);

}

.badge{

font-size:
11px;

padding:
4px 7px;

border-radius:
6px;

background:
#1b2430;

color:
var(--muted);

}

.entrybadge{

background:
#123b2b;

color:
var(--green);

}

.waitbadge{

background:
#302b16;

color:
var(--yellow);

}

.meta{

color:
var(--muted);

font-size:
12px;

margin-top:
8px;

}

.center{

min-width:0;

display:flex;

flex-direction:
column;

background:
#090d13;

}

.charthead{

padding:
14px 18px;

border-bottom:
1px solid var(--line);

display:flex;

justify-content:
space-between;

}

.chartwrap{

position:
relative;

flex:
1;

min-height:
0;

}

.chart{

position:
absolute;

inset:
0;

}

.empty{

height:
100%;

display:grid;

place-items:
center;

color:
var(--muted);

font-size:
16px;

}

.details{

padding:
18px;

}

.bigdir{

font-size:
30px;

font-weight:
950;

margin:
7px 0 18px;

}

.score{

font-size:
13px;

color:
var(--muted);

}

.score strong{

font-size:
25px;

color:
var(--text);

}

.price{

font-size:
26px;

font-weight:
900;

margin:
5px 0 20px;

}

.kv{

display:grid;

grid-template-columns:
1fr 1fr;

gap:
8px;

margin-top:
10px;

}

.box{

background:
var(--panel2);

border:
1px solid var(--line);

border-radius:
10px;

padding:
11px;

}

.box label{

display:block;

color:
var(--muted);

font-size:
11px;

margin-bottom:
5px;

}

.box b{

font-size:
15px;

}

.why{

margin-top:
16px;

background:
var(--panel2);

border:
1px solid var(--line);

border-radius:
10px;

padding:
12px;

line-height:
1.6;

color:
#cbd4df;

}

.tv{

display:block;

text-align:center;

margin-top:
16px;

padding:
12px;

border-radius:
9px;

background:
#263041;

color:
white;

text-decoration:
none;

font-weight:
800;

}

.foot{

padding:
10px 16px;

color:
var(--muted);

font-size:
11px;

border-top:
1px solid var(--line);

}

canvas{

width:
100%;

height:
100%;

}

@media(max-width:1000px){

.app{

grid-template-columns:
280px
1fr;

}

.right{

display:none;

}

}

@media(max-width:700px){

.app{

grid-template-columns:
1fr;

grid-template-rows:
auto
auto
1fr;

}

.top{

grid-column:
1;

}

.side{

display:none;

}

}

</style>

</head>

<body>

<div class="app">

<header class="top">

<div class="brand">

⚡ SONNY
<b>AI TRADER V10</b>

</div>

<div class="pill live">

● CANLI

<strong id="age">
-
</strong>

</div>

<div class="pill">

EVREN

<strong id="universe">
0
</strong>

</div>

<div class="pill">

AKTİF

<strong id="active">
0
</strong>

</div>

<div class="pill">

SON TARAMA

<strong id="scan">
-
</strong>

</div>

<div class="pill">

VERİ

<strong>BITGET</strong>

·

TV

<strong>BINANCE</strong>

</div>

</header>


<!-- SOL SİNYALLER -->

<aside class="side">

<div class="title">

AKTİF SİNYALLER

<span id="sigcount">
0
</span>

</div>

<div id="signals"></div>

<div class="foot">

Sinyal giriş bölgesini geçerse
otomatik olarak kaldırılır.

</div>

</aside>


<!-- ORTA GRAFİK -->

<main class="center">

<div class="charthead">

<b id="charttitle">

Sinyal seç

</b>

<span id="chartstatus">

-

</span>

</div>


<div class="chartwrap">

<canvas id="chart"></canvas>

<div
class="empty"
id="empty"
>

Soldan bir sinyal seç.

</div>

</div>

</main>


<!-- SAĞ DETAY -->

<aside class="right">

<div class="title">

SONNY KARARI

</div>

<div
id="details"
class="details"
>

<div
class="empty"
style="height:300px"
>

Sinyal seç.

</div>

</div>

</aside>

</div>


<script>

let state = {

signals: [],

selected: null,

stats: {},

lastScan: 0

};


let ws;


const $ =
id =>
document.getElementById(id);


// ========================================================
// FORMAT
// ========================================================

const fmt = n => {

n = Number(n);

if (!Number.isFinite(n))
return '-';

if (n >= 1000)

return n.toLocaleString(
'en-US',
{
maximumFractionDigits:2
}
);

if (n >= 1)

return n.toLocaleString(
'en-US',
{
maximumFractionDigits:4
}
);

return n.toLocaleString(
'en-US',
{
maximumFractionDigits:8
}
);

};


// ========================================================
// AGE
// ========================================================

const age = ms => {

let seconds =
Math.floor(
ms / 1000
);

if (
seconds < 60
)

return seconds + ' sn';


let minutes =
Math.floor(
seconds / 60
);


if (
minutes < 60
)

return minutes + ' dk';


return (

Math.floor(
minutes / 60
) +

' sa ' +

(
minutes % 60
) +

' dk'
);

};


// ========================================================
// RENDER
// ========================================================

function render(){

const sigs =
state.signals || [];


$('universe')
.textContent =
state.stats?.universe || 0;


$('active')
.textContent =
sigs.length;


$('sigcount')
.textContent =
sigs.length;


$('scan')
.textContent =

state.lastScan

? new Date(
state.lastScan
).toLocaleTimeString(
'tr-TR'
)

: '-';


$('signals')
.innerHTML =

sigs.map(
signal => {

const active =
signal.status ===
'ENTRY';


return \\`<div
class="signal
\${signal.direction === 'LONG'
? 'long'
: 'short'}
\${state.selected?.id === signal.id
? 'sel'
: ''}"
onclick="selectSignal('\${signal.id}')">

<div class="row">

<span class="coin">

\${signal.symbol}

</span>

<b class="\${signal.direction === 'LONG'
? 'longtxt'
: 'shorttxt'}">

\${signal.direction}

</b>

</div>


<div
class="row"
style="margin-top:8px"
>

<span
class="badge
\${active
? 'entrybadge'
: 'waitbadge'}"
>

\${active
? 'GİRİŞ BÖLGESİNDE'
: 'BEKLENİYOR'}

</span>


<span class="badge">

\${signal.confidence}/100

</span>

</div>


<div class="meta">

Canlı
\${fmt(signal.lastPrice)}

·

\${age(
Date.now() -
signal.createdAt
)}
önce

</div>


</div>\\`;

}

).join('')

||

'<div class="foot">Şu an aktif sinyal yok.</div>';


renderDetails();

renderChart();

}


// ========================================================
// SELECT
// ========================================================

async function selectSignal(id){

state.selected =
state.signals.find(
s => s.id === id
) || null;


render();


await fetch(
'/api/select',
{

method:'POST',

headers:{
'Content-Type':
'application/json'
},

body:
JSON.stringify({
id
})

}

);

}


// ========================================================
// DETAILS
// ========================================================

function renderDetails(){

const s =
state.selected;


if (!s){

$('details')
.innerHTML =
'<div class="empty" style="height:300px">Sinyal seç.</div>';

return;

}


const cls =
s.direction === 'LONG'
? 'longtxt'
: 'shorttxt';


$('charttitle')
.textContent =

s.symbol +
' · ' +
s.direction;


$('chartstatus')
.textContent =

s.status === 'ENTRY'

? '● GİRİŞ BÖLGESİNDE'

: '○ BEKLENİYOR';


$('details')
.innerHTML =

\\`<div class="score">

KALİTE

<strong>
\${s.confidence}/100
</strong>

</div>

<div
class="bigdir \${cls}"
>

\${s.direction}

</div>


<div class="score">

CANLI FİYAT

</div>

<div class="price">

\${fmt(s.lastPrice)}

</div>


<div class="kv">


<div class="box">

<label>
GİRİŞ
</label>

<b>

\${fmt(s.entryLow)}
-
\${fmt(s.entryHigh)}

</b>

</div>


<div class="box">

<label>
SEVİYE
</label>

<b>

\${fmt(s.level)}

</b>

</div>


<div class="box">

<label>
STOP
</label>

<b>

\${fmt(s.stop)}

</b>

</div>


<div class="box">

<label>
TP1
</label>

<b>

\${fmt(s.tp1)}

</b>

</div>


<div class="box">

<label>
TP2
</label>

<b>

\${fmt(s.tp2)}

</b>

</div>


<div class="box">

<label>
TP3
</label>

<b>

\${fmt(s.tp3)}

</b>

</div>


</div>


<div class="why">

<b>NEDEN?</b>

<br>

\${s.reason}

<br>

<span
style="color:#8d99a8"
>

15M yapı:

\${s.structureText}

·

\${s.touches}
temas

</span>

<br>

<span
style="color:#8d99a8"
>

Sinyal yaşı:

\${age(
Date.now() -
s.createdAt
)}

</span>

</div>


<a
class="tv"
href="\${s.tvLink}"
target="_blank"
>

📊 BINANCE TRADINGVIEW AÇ

</a>\\`;

}


// ========================================================
// CHART
// ========================================================

function renderChart(){

const s =
state.selected;


const canvas =
$('chart');


const ctx =
canvas.getContext('2d');


const rect =
canvas.getBoundingClientRect();


const dpr =
window.devicePixelRatio || 1;


canvas.width =
rect.width * dpr;


canvas.height =
rect.height * dpr;


ctx.setTransform(
dpr,
0,
0,
dpr,
0,
0
);


ctx.clearRect(
0,
0,
rect.width,
rect.height
);


if (!s){

$('empty')
.style.display =
'grid';

return;

}


$('empty')
.style.display =
'none';


const data =
s.chart?.candles15 ||
[];


if (
!data.length
)
return;


const W =
rect.width;


const H =
rect.height;


const pad = {

l:65,

r:25,

t:25,

b:35

};


const low =
Math.min(

...data.map(
x => x[3]
),

s.stop,

s.tp3,

s.entryLow
);


const high =
Math.max(

...data.map(
x => x[2]
),

s.stop,

s.tp3,

s.entryHigh
);


const y =
price =>

pad.t +

(
high - price
) /
(
high - low
) *
(
H -
pad.t -
pad.b
);


const x =
index =>

pad.l +

index /
(data.length - 1) *
(
W -
pad.l -
pad.r
);


// ========================================================
// GRID
// ========================================================

ctx.strokeStyle =
'#1f2935';

ctx.lineWidth = 1;


for (
let i = 0;
i < 7;
i++
){

const yy =

pad.t +

i *
(
H -
pad.t -
pad.b
) /
6;


ctx.beginPath();

ctx.moveTo(
pad.l,
yy
);

ctx.lineTo(
W - pad.r,
yy
);

ctx.stroke();


ctx.fillStyle =
'#718096';

ctx.font =
'11px Arial';


ctx.fillText(

fmt(
high -
(
high - low
) *
i /
6
),

8,

yy + 4
);

}


// ========================================================
// CANDLES
// ========================================================

data.forEach(
(k, i) => {

const xx =
x(i);


const open =
y(k[1]);


const close =
y(k[4]);


const highY =
y(k[2]);


const lowY =
y(k[3]);


const bullish =
k[4] >= k[1];


ctx.strokeStyle =
bullish
? '#18d889'
: '#ff4d67';


ctx.beginPath();

ctx.moveTo(
xx,
highY
);

ctx.lineTo(
xx,
lowY
);

ctx.stroke();


ctx.fillStyle =
ctx.strokeStyle;


ctx.fillRect(

xx - 2,

Math.min(
open,
close
),

4,

Math.max(
1,
Math.abs(
close -
open
)
)

);

});


// ========================================================
// PRICE LINES
// ========================================================

function line(
value,
color,
label,
dashed = false
){

ctx.strokeStyle =
color;


ctx.setLineDash(
dashed
? [6,5]
: []
);


ctx.beginPath();

ctx.moveTo(
pad.l,
y(value)
);

ctx.lineTo(
W - pad.r,
y(value)
);

ctx.stroke();


ctx.setLineDash([]);


ctx.fillStyle =
color;

ctx.font =
'bold 11px Arial';


ctx.fillText(

label +
' ' +
fmt(value),

W -
pad.r -
150,

y(value) - 5
);

}


// 4H / 2H
line(
s.level,
'#ffc857',
'4H/2H'
);


// Giriş
line(
s.entryLow,
'#58a6ff',
'GİRİŞ'
);

line(
s.entryHigh,
'#58a6ff',
''
);


// Stop
line(
s.stop,
'#ff4d67',
'STOP'
);


// TP
line(
s.tp1,
'#18d889',
'TP1'
);

line(
s.tp2,
'#18d889',
'TP2'
);

line(
s.tp3,
'#18d889',
'TP3'
);


// Live
line(

s.lastPrice,

s.direction === 'LONG'
? '#18d889'
: '#ff4d67',

'CANLI',

true

);

}


// ========================================================
// WEBSOCKET
// ========================================================

function connect(){

ws =

new WebSocket(

(
location.protocol ===
'https:'

? 'wss://'
: 'ws://'
) +

location.host

);


ws.onmessage =
event => {

try {

const payload =
JSON.parse(
event.data
);


if (
payload.signals
) {

state.signals =
payload.signals;

}


if (
'selected'
in payload
) {

state.selected =
payload.selected;

}


if (
payload.stats
) {

state.stats =
payload.stats;

}


if (
payload.lastScan
) {

state.lastScan =
payload.lastScan;

}


render();


} catch {}

};


ws.onclose = () => {

setTimeout(
connect,
2000
);

};

}


// ========================================================
// LIVE UI
// ========================================================

setInterval(

() => {

if (
state.selected
) {

const current =
state.signals.find(
s =>
s.id ===
state.selected.id
);


if (current)
state.selected =
current;

}


render();

},

1000

);


connect();

render();

</script>

</body>

</html>`;


// ============================================================
// START
// ============================================================

async function start(){

console.log(
'=============================================='
);

console.log(
'Sonny AI Trader V10 started'
);

console.log(
'Data source: BITGET'
);

console.log(
'TradingView: BINANCE'
);

console.log(
'Strategy: 4H SUPPORT/RESISTANCE + 2H CONFIRMATION + 15M STRUCTURE'
);

console.log(
'Scan: 60s | Live price: 5s'
);


// İlk evren
await fetchUniverse();


// İlk tarama
await runScan();


// Her 60 saniye
setInterval(
runScan,
CONFIG.SCAN_INTERVAL
);


// Her 5 saniye canlı fiyat
setInterval(
updateLivePrices,
CONFIG.PRICE_INTERVAL
);

}


// ============================================================
// SERVER
// ============================================================

server.listen(
PORT,
() => {

console.log(
`Server listening on port ${PORT}`
);

start()
.catch(
error =>
console.error(
'START ERROR',
error
)
);

});
