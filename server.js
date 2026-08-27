'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = Number(process.env.PORT || 10000);

app.use(express.json({ limit: '1mb' }));

/* =========================================================
   SONNY AI TRADER V5.1
   4H / 2H TREND
   15M BREAKOUT / RETEST
   5M CONFIRMATION
   ========================================================= */

const CFG = {
    MAX_RADAR: 500,
    CANDIDATES: 150,
    DEEP: 40,

    MAX_SIGNALS: 15,

    MIN_VOLUME_USDT:
        Number(
            process.env.MIN_VOLUME_USDT ||
            750000
        ),

    SCAN_MS: 60000,
    LIVE_MS: 10000,

    MARKET_REFRESH_MS:
        15 * 60 * 1000,

    CONCURRENCY: 6,

    CANDLE_LIMIT: 160,
    CHART_LIMIT: 140,

    MIN_SCORE: 72,

    BREAKOUT_LOOKBACK: 12,
    BREAKOUT_VOL: 1.25,

    RETEST_TOL: 0.0045,
    RETEST_WINDOW: 8,

    MIN_RR: 1.50,
    TP2_RR: 2.25,
    TP3_RR: 3.25,

    ATR_STOP: 1.20,

    SIGNAL_TTL:
        45 * 60 * 1000,

    PENDING_TTL:
        90 * 60 * 1000,

    COOLDOWN:
        4 * 60 * 60 * 1000,

    REQUIRE_5M: true,

    AUTO_TRADE: false
};


/* =========================================================
   BITGET
   ========================================================= */

const exchange =
    new ccxt.bitget({
        enableRateLimit: true,

        timeout: 20000,

        options: {
            defaultType: 'swap'
        },

        apiKey:
            process.env.BITGET_API_KEY ||
            '',

        secret:
            process.env.BITGET_SECRET ||
            '',

        password:
            process.env.BITGET_PASSPHRASE ||
            ''
    });


/* =========================================================
   STATE
   ========================================================= */

const STATE = {

    markets: [],

    universe: [],

    candidates: [],

    deep: [],

    signals:
        new Map(),

    pending:
        new Map(),

    cooldowns:
        new Map(),

    history: [],

    selected:
        'BTC/USDT:USDT',

    timeframe:
        '15m',

    scanning:
        false,

    lastScan:
        0,

    marketRefresh:
        0,

    lastError:
        '',

    market: {

        label:
            'YATAY',

        direction:
            'FLAT',

        breadth:
            50,

        green:
            0,

        red:
            0,

        average:
            0,

        btc:
            'NEUTRAL',

        eth:
            'NEUTRAL',

        reason:
            'Piyasa analiz ediliyor.'
    },

    stats: {

        universe:
            0,

        candidates:
            0,

        deep:
            0,

        analyzed:
            0,

        pending:
            0,

        signals:
            0
    }
};


/* =========================================================
   HELPERS
   ========================================================= */

function num(
    value,
    fallback = 0
) {

    const x =
        Number(value);

    return Number.isFinite(x)
        ? x
        : fallback;
}


function clamp(
    value,
    min,
    max
) {

    return Math.max(
        min,
        Math.min(
            max,
            value
        )
    );
}


function cleanSymbol(
    symbol
) {

    return String(
        symbol || ''
    )
        .replace(
            ':USDT',
            ''
        )
        .replace(
            '/USDT',
            ''
        ) +
        'USDT';
}


function rawSymbol(
    symbol
) {

    const s =
        String(
            symbol || ''
        )
            .toUpperCase();

    if (
        s.includes('/')
    ) {

        return s;
    }

    if (
        s.endsWith('USDT')
    ) {

        return (
            s.slice(
                0,
                -4
            ) +
            '/USDT:USDT'
        );
    }

    return (
        s +
        '/USDT:USDT'
    );
}


function digits(
    value
) {

    const x =
        Math.abs(
            num(value)
        );

    if (
        x >= 1000
    ) return 2;

    if (
        x >= 100
    ) return 2;

    if (
        x >= 1
    ) return 4;

    if (
        x >= 0.01
    ) return 6;

    if (
        x >= 0.0001
    ) return 8;

    return 10;
}


function fmt(
    value
) {

    const x =
        Number(value);

    if (
        !Number.isFinite(x)
    ) {

        return '-';
    }

    return x.toFixed(
        digits(x)
    );
}


function closed(
    candles
) {

    if (
        !Array.isArray(
            candles
        )
    ) {

        return [];
    }

    if (
        candles.length < 2
    ) {

        return candles;
    }

    return candles.slice(
        0,
        -1
    );
}


/* =========================================================
   INDICATORS
   ========================================================= */

function ema(
    candles,
    period
) {

    const c =
        closed(candles);

    if (
        c.length < period
    ) {

        return null;
    }

    let value =
        c
            .slice(
                0,
                period
            )
            .reduce(
                (
                    sum,
                    item
                ) =>
                    sum +
                    num(item[4]),
                0
            ) /
        period;

    const k =
        2 /
        (
            period +
            1
        );

    for (
        let i = period;
        i < c.length;
        i++
    ) {

        value =
            num(
                c[i][4]
            ) *
            k +
            value *
            (
                1 -
                k
            );
    }

    return value;
}


function rsi(
    candles,
    period = 14
) {

    const c =
        closed(candles);

    if (
        c.length <
        period + 1
    ) {

        return 50;
    }

    let gain = 0;
    let loss = 0;

    for (
        let i =
            c.length -
            period;

        i <
            c.length;

        i++
    ) {

        const change =
            num(
                c[i][4]
            ) -
            num(
                c[i - 1][4]
            );

        if (
            change >= 0
        ) {

            gain += change;

        } else {

            loss -= change;
        }
    }

    if (
        loss === 0
    ) {

        return 100;
    }

    const rs =
        (
            gain /
            period
        ) /
        (
            loss /
            period
        );

    return (
        100 -
        100 /
        (
            1 +
            rs
        )
    );
}


function atr(
    candles,
    period = 14
) {

    const c =
        closed(candles);

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
            num(
                c[i][2]
            );

        const low =
            num(
                c[i][3]
            );

        const previousClose =
            num(
                c[i - 1][4]
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

    const values =
        tr.slice(
            -period
        );

    return (
        values.reduce(
            (
                sum,
                value
            ) =>
                sum +
                value,
            0
        ) /
        values.length
    );
}


function volumeRatio(
    candles,
    lookback = 20
) {

    const c =
        closed(candles);

    if (
        c.length <
        lookback + 1
    ) {

        return 1;
    }

    const last =
        num(
            c[
                c.length - 1
            ][5]
        );

    const base =
        c
            .slice(
                -lookback - 1,
                -1
            )
            .map(
                item =>
                    num(
                        item[5]
                    )
            )
            .filter(
                value =>
                    value > 0
            );

    if (
        !base.length
    ) {

        return 1;
    }

    const average =
        base.reduce(
            (
                sum,
                value
            ) =>
                sum +
                value,
            0
        ) /
        base.length;

    return average > 0
        ? last / average
        : 1;
}


function trend(
    candles
) {

    const c =
        closed(candles);

    const ema21 =
        ema(
            candles,
            21
        );

    const ema50 =
        ema(
            candles,
            50
        );

    if (
        !c.length ||
        ema21 === null ||
        ema50 === null
    ) {

        return 'NEUTRAL';
    }

    const last =
        num(
            c[
                c.length - 1
            ][4]
        );

    if (
        last >
            ema21 &&
        ema21 >
            ema50
    ) {

        return 'LONG';
    }

    if (
        last <
            ema21 &&
        ema21 <
            ema50
    ) {

        return 'SHORT';
    }

    return 'NEUTRAL';
}


function structure(
    candles,
    lookback = 20
) {

    const c =
        closed(candles)
            .slice(
                -lookback
            );

    if (
        c.length < 8
    ) {

        return 'NEUTRAL';
    }

    const half =
        Math.floor(
            c.length / 2
        );

    const first =
        c.slice(
            0,
            half
        );

    const second =
        c.slice(
            half
        );

    const firstHigh =
        Math.max(
            ...first.map(
                x =>
                    num(x[2])
            )
        );

    const firstLow =
        Math.min(
            ...first.map(
                x =>
                    num(x[3])
            )
        );

    const secondHigh =
        Math.max(
            ...second.map(
                x =>
                    num(x[2])
            )
        );

    const secondLow =
        Math.min(
            ...second.map(
                x =>
                    num(x[3])
            )
        );

    if (
        secondHigh >
            firstHigh &&
        secondLow >
            firstLow
    ) {

        return 'LONG';
    }

    if (
        secondHigh <
            firstHigh &&
        secondLow <
            firstLow
    ) {

        return 'SHORT';
    }

    return 'NEUTRAL';
}


function rangeLevels(
    candles,
    lookback =
        CFG.BREAKOUT_LOOKBACK
) {

    const c =
        closed(candles);

    if (
        c.length <
        lookback + 3
    ) {

        return null;
    }

    const base =
        c.slice(
            -(lookback + 1),
            -1
        );

    return {

        high:
            Math.max(
                ...base.map(
                    x =>
                        num(
                            x[2]
                        )
                )
            ),

        low:
            Math.min(
                ...base.map(
                    x =>
                        num(
                            x[3]
                        )
                )
            )
    };
}


function lastPrice(
    candles
) {

    const c =
        closed(candles);

    if (
        !c.length
    ) {

        return 0;
    }

    return num(
        c[
            c.length - 1
        ][4]
    );
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
        new Array(
            items.length
        );

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
                        items[index],
                        index
                    );

            } catch (_) {

                result[index] =
                    null;
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
            {
                length:
                    workers
            },
            runner
        )
    );

    return result.filter(
        Boolean
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
        Object.values(
            markets
        ).filter(
            market =>
                market &&
                market.active !== false &&
                market.swap &&
                market.linear &&
                market.quote ===
                    'USDT' &&
                market.settle ===
                    'USDT'
        );

    return STATE.markets;
}


async function fetchTickers() {

    const tickers =
        await exchange.fetchTickers();

    const rows = [];

    for (
        const market of
            STATE.markets
    ) {

        const ticker =
            tickers[
                market.symbol
            ];

        if (
            !ticker
        ) {

            continue;
        }

        const price =
            num(
                ticker.last ||
                ticker.close
            );

        const volume =
            num(
                ticker.quoteVolume ||
                (
                    price *
                    num(
                        ticker.baseVolume
                    )
                )
            );

        if (
            !(price > 0) ||
            !(volume > 0)
        ) {

            continue;
        }

        rows.push({

            symbol:
                market.symbol,

            price,

            volume,

            change:
                num(
                    ticker.percentage
                ),

            high:
                num(
                    ticker.high
                ),

            low:
                num(
                    ticker.low
                )
        });
    }

    rows.sort(
        (
            a,
            b
        ) =>
            b.volume -
            a.volume
    );

    return rows.slice(
        0,
        CFG.MAX_RADAR
    );
}


function findMarket(
    query
) {

    const target =
        rawSymbol(
            query
        );

    return (
        STATE.markets.find(
            market =>
                market.symbol ===
                target
        ) ||

        STATE.markets.find(
            market =>
                cleanSymbol(
                    market.symbol
                ) ===
                cleanSymbol(
                    query
                )
        )
    );
}


async function getCandles(
    symbol,
    timeframe,
    limit =
        CFG.CANDLE_LIMIT
) {

    return exchange.fetchOHLCV(
        symbol,
        timeframe,
        undefined,
        limit
    );
}


/* =========================================================
   GENERAL MARKET
   ========================================================= */

async function getMarketRegime(
    rows
) {

    const valid =
        rows.filter(
            item =>
                Number.isFinite(
                    item.change
                )
        );

    const green =
        valid.filter(
            item =>
                item.change > 0
        ).length;

    const red =
        valid.filter(
            item =>
                item.change < 0
        ).length;

    const average =
        valid.length
            ? valid.reduce(
                (
                    sum,
                    item
                ) =>
                    sum +
                    item.change,
                0
            ) /
            valid.length
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

        const btcMarket =
            findMarket(
                'BTCUSDT'
            );

        const ethMarket =
            findMarket(
                'ETHUSDT'
            );

        if (
            btcMarket
        ) {

            btc =
                trend(
                    await getCandles(
                        btcMarket.symbol,
                        '1h',
                        100
                    )
                );
        }

        if (
            ethMarket
        ) {

            eth =
                trend(
                    await getCandles(
                        ethMarket.symbol,
                        '1h',
                        100
                    )
                );
        }

    } catch (_) {}

    const bullish =
        breadth >= 58 &&
        average >= 0.35 &&
        (
            btc === 'LONG' ||
            eth === 'LONG'
        );

    const bearish =
        breadth <= 42 &&
        average <= -0.35 &&
        (
            btc === 'SHORT' ||
            eth === 'SHORT'
        );

    let label =
        'YATAY';

    let direction =
        'FLAT';

    if (
        bullish &&
        breadth >= 68 &&
        average >= 1
    ) {

        label =
            'GÜÇLÜ YÜKSELİŞ';

        direction =
            'LONG';

    } else if (
        bullish
    ) {

        label =
            'YÜKSELİŞ';

        direction =
            'LONG';

    } else if (
        bearish &&
        breadth <= 32 &&
        average <= -1
    ) {

        label =
            'GÜÇLÜ DÜŞÜŞ';

        direction =
            'SHORT';

    } else if (
        bearish
    ) {

        label =
            'DÜŞÜŞ';

        direction =
            'SHORT';
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

        eth,

        reason:
            `Breadth %${breadth.toFixed(1)} • ` +
            `Ortalama ${average.toFixed(2)}% • ` +
            `BTC 1H ${btc} • ` +
            `ETH 1H ${eth}`
    };
}


/* =========================================================
   TRADE PLAN
   ========================================================= */

function buildPlan(
    symbol,
    direction,
    level,
    candles,
    fiveMinuteCandles
) {

    const price =
        lastPrice(
            candles
        );

    const currentAtr =
        atr(
            candles
        );

    const atrValue =
        currentAtr > 0
            ? currentAtr
            : price * 0.01;

    const recent =
        closed(
            candles
        ).slice(
            -6
        );

    const swingLow =
        Math.min(
            ...recent.map(
                x =>
                    num(x[3])
            )
        );

    const swingHigh =
        Math.max(
            ...recent.map(
                x =>
                    num(x[2])
            )
        );

    let entry =
        price;

    let stop;

    if (
        direction ===
        'LONG'
    ) {

        entry =
            Math.max(
                price,
                level
            );

        stop =
            Math.min(
                swingLow,
                level -
                    atrValue *
                    CFG.ATR_STOP
            );

        if (
            stop >= entry
        ) {

            stop =
                entry -
                atrValue *
                CFG.ATR_STOP;
        }

    } else {

        entry =
            Math.min(
                price,
                level
            );

        stop =
            Math.max(
                swingHigh,
                level +
                    atrValue *
                    CFG.ATR_STOP
            );

        if (
            stop <= entry
        ) {

            stop =
                entry +
                atrValue *
                CFG.ATR_STOP;
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
    }


    /*
       KRİTİK KONTROL

       LONG:
       STOP < ENTRY < TP1 < TP2 < TP3

       SHORT:
       TP3 < TP2 < TP1 < ENTRY < STOP
    */

    if (
        direction ===
        'LONG'
    ) {

        if (
            !(
                stop <
                entry &&
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
                tp3 <
                tp2 &&
                tp2 <
                tp1 &&
                tp1 <
                entry &&
                entry <
                stop
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


    const five =
        fiveMinuteCandles
            ? structure(
                fiveMinuteCandles,
                16
            )
            : 'NEUTRAL';


    return {

        symbol,

        direction,

        entry:
            Number(
                entry
            ),

        entryLow:
            Number(
                Math.min(
                    entry,
                    level
                )
            ),

        entryHigh:
            Number(
                Math.max(
                    entry,
                    level
                )
            ),

        stop:
            Number(
                stop
            ),

        stopLoss:
            Number(
                stop
            ),

        tp1:
            Number(
                tp1
            ),

        tp2:
            Number(
                tp2
            ),

        tp3:
            Number(
                tp3
            ),

        rr:
            Number(
                rr.toFixed(2)
            ),

        risk:
            Number(
                risk
            ),

        rsi:
            Number(
                rsi(
                    candles
                ).toFixed(1)
            ),

        fiveMin:
            five,

        level:
            Number(
                level
            ),

        createdAt:
            Date.now()
    };
}


/* =========================================================
   DEEP ANALYSIS
   ========================================================= */

async function analyze(
    symbolRow
) {

    const symbol =
        symbolRow.symbol;

    const [
        h4,
        h2,
        m15,
        m5
    ] =
        await Promise.all([

            getCandles(
                symbol,
                '4h',
                CFG.CANDLE_LIMIT
            ),

            getCandles(
                symbol,
                '2h',
                CFG.CANDLE_LIMIT
            ),

            getCandles(
                symbol,
                '15m',
                CFG.CANDLE_LIMIT
            ),

            getCandles(
                symbol,
                '5m',
                80
            )
        ]);


    const h4Trend =
        trend(h4);

    const h2Trend =
        trend(h2);

    const s15 =
        structure(
            m15,
            24
        );

    const levels =
        rangeLevels(
            h4,
            CFG.BREAKOUT_LOOKBACK
        );

    if (
        !levels
    ) {

        return null;
    }


    const c15 =
        closed(
            m15
        );

    if (
        c15.length < 5
    ) {

        return null;
    }


    const current =
        lastPrice(
            m15
        );

    const previous =
        c15[
            c15.length - 2
        ];

    const last =
        c15[
            c15.length - 1
        ];

    const volume =
        volumeRatio(
            m15
        );

    const five =
        structure(
            m5,
            16
        );


    let direction =
        null;

    let level =
        0;


    /*
       15M BREAKOUT
    */

    if (
        num(
            last[4]
        ) >
            levels.high &&
        num(
            previous[4]
        ) <=
            levels.high
    ) {

        direction =
            'LONG';

        level =
            levels.high;

    } else if (
        num(
            last[4]
        ) <
            levels.low &&
        num(
            previous[4]
        ) >=
            levels.low
    ) {

        direction =
            'SHORT';

        level =
            levels.low;
    }


    /*
       RETEST
    */

    if (
        !direction
    ) {

        const high =
            levels.high;

        const low =
            levels.low;

        if (
            current >
                high &&
            Math.abs(
                current -
                high
            ) /
                high <=
                CFG.RETEST_TOL
        ) {

            direction =
                'LONG';

            level =
                high;

        } else if (
            current <
                low &&
            Math.abs(
                current -
                low
            ) /
                low <=
                CFG.RETEST_TOL
        ) {

            direction =
                'SHORT';

            level =
                low;
        }
    }


    if (
        !direction
    ) {

        return null;
    }


    /*
       ÜST ZAMAN DİLİMİ ÇATIŞMASI
    */

    if (
        h4Trend !==
            'NEUTRAL' &&
        h4Trend !==
            direction
    ) {

        return null;
    }

    if (
        h2Trend !==
            'NEUTRAL' &&
        h2Trend !==
            direction
    ) {

        return null;
    }


    /*
       GENEL PİYASA ÇATIŞMASI
    */

    if (
        STATE.market.direction !==
            'FLAT' &&
        STATE.market.direction !==
            direction
    ) {

        return null;
    }


    /*
       HACİM
    */

    if (
        volume <
        CFG.BREAKOUT_VOL
    ) {

        return null;
    }


    /*
       BREAKOUT MUMU KALİTESİ
    */

    const candleRange =
        Math.max(
            num(
                last[2]
            ) -
            num(
                last[3]
            ),

            current *
            0.000001
        );

    const closePosition =
        direction ===
            'LONG'

            ?

            (
                num(
                    last[4]
                ) -
                num(
                    last[3]
                )
            ) /
            candleRange

            :

            (
                num(
                    last[2]
                ) -
                num(
                    last[4]
                )
            ) /
            candleRange;


    if (
        closePosition <
        0.55
    ) {

        return null;
    }


    /*
       5M TEYİT
    */

    if (
        CFG.REQUIRE_5M &&
        five !==
            direction
    ) {

        return null;
    }


    /*
       SCORE
    */

    let score =
        50;


    if (
        h4Trend ===
        direction
    ) {

        score +=
            10;
    }


    if (
        h2Trend ===
        direction
    ) {

        score +=
            10;
    }


    if (
        s15 ===
        direction
    ) {

        score +=
            8;
    }


    if (
        volume >=
        1.5
    ) {

        score +=
            8;
    }


    if (
        volume >=
        2
    ) {

        score +=
            5;
    }


    if (
        five ===
        direction
    ) {

        score +=
            9;
    }


    const currentRsi =
        rsi(
            m15
        );


    if (
        direction ===
            'LONG' &&
        currentRsi >=
            50 &&
        currentRsi <=
            72
    ) {

        score +=
            5;
    }


    if (
        direction ===
            'SHORT' &&
        currentRsi <=
            50 &&
        currentRsi >=
            28
    ) {

        score +=
            5;
    }


    if (
        score <
        CFG.MIN_SCORE
    ) {

        return null;
    }


    const plan =
        buildPlan(
            symbol,
            direction,
            level,
            m15,
            m5
        );


    if (
        !plan
    ) {

        return null;
    }


    const key =
        cleanSymbol(
            symbol
        ) +
        ':' +
        direction +
        ':' +
        level.toFixed(
            digits(level)
        );


    if (
        STATE.cooldowns.has(
            key
        )
    ) {

        const cooldownTime =
            STATE.cooldowns.get(
                key
            );

        if (
            Date.now() -
            cooldownTime <
            CFG.COOLDOWN
        ) {

            return null;
        }
    }


    return {

        ...plan,

        score:
            Math.min(
                100,
                score
            ),

        status:
            'GİRİŞ ALANI',

        reason:
            `${direction} • ` +
            `4H ${h4Trend} • ` +
            `2H ${h2Trend} • ` +
            `15M breakout/retest • ` +
            `5M ${five} • ` +
            `VOL ${volume.toFixed(2)}x`,

        signalAt:
            Date.now(),

        key
    };
}


/* =========================================================
   CLEANUP
   ========================================================= */

function cleanup() {

    const now =
        Date.now();


    for (
        const [
            key,
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
                key
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


    for (
        const [
            key,
            time
        ]
        of STATE.cooldowns
    ) {

        if (
            now -
            time >
            CFG.COOLDOWN
        ) {

            STATE.cooldowns.delete(
                key
            );
        }
    }


    STATE.stats.signals =
        STATE.signals.size;

    STATE.stats.pending =
        STATE.pending.size;
}


/* =========================================================
   MAIN SCANNER
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

    const started =
        Date.now();


    try {

        /*
           MARKET LISTESİ
        */

        if (
            !STATE.markets.length ||
            Date.now() -
                STATE.marketRefresh >
                CFG.MARKET_REFRESH_MS
        ) {

            await loadMarkets();

            STATE.marketRefresh =
                Date.now();

            console.log(
                'MARKETS | Gerçek USDT perpetual=' +
                STATE.markets.length
            );
        }


        /*
           500 COIN RADAR
        */

        const rows =
            await fetchTickers();

        STATE.universe =
            rows;

        STATE.stats.universe =
            rows.length;


        /*
           GENEL PİYASA
        */

        await getMarketRegime(
            rows
        );


        /*
           150 ADAY
        */

        const candidates =
            rows
                .filter(
                    item =>
                        item.volume >=
                        CFG.MIN_VOLUME_USDT
                )
                .sort(
                    (
                        a,
                        b
                    ) =>

                        (
                            b.volume *
                            (
                                1 +
                                Math.abs(
                                    b.change
                                ) /
                                100
                            )
                        ) -

                        (
                            a.volume *
                            (
                                1 +
                                Math.abs(
                                    a.change
                                ) /
                                100
                            )
                        )
                )
                .slice(
                    0,
                    CFG.CANDIDATES
                );


        STATE.candidates =
            candidates;

        STATE.stats.candidates =
            candidates.length;


        /*
           40 DERİN ANALİZ
        */

        const deep =
            candidates.slice(
                0,
                CFG.DEEP
            );


        STATE.deep =
            deep;

        STATE.stats.deep =
            deep.length;


        const analyses =
            await mapLimit(
                deep,
                CFG.CONCURRENCY,
                analyze
            );


        STATE.stats.analyzed =
            analyses.length;


        /*
           GERÇEK SİNYALLER
        */

        for (
            const signal
            of analyses
        ) {

            if (
                !signal
            ) {

                continue;
            }


            const old =
                STATE.signals.get(
                    signal.key
                );


            if (
                !old ||
                Date.now() -
                    old.signalAt >
                    CFG.SIGNAL_TTL
            ) {

                STATE.signals.set(
                    signal.key,
                    signal
                );

                STATE.selected =
                    signal.symbol;
            }
        }


        STATE.lastScan =
            Date.now();


        cleanup();


        console.log(
            `RADAR tamamlandı | ` +
            `Universe=${STATE.stats.universe} | ` +
            `Candidates=${STATE.stats.candidates} | ` +
            `Deep=${STATE.stats.deep} | ` +
            `Analiz=${STATE.stats.analyzed} | ` +
            `Pending=${STATE.pending.size} | ` +
            `SIGNAL=${STATE.signals.size} | ` +
            `${(
                (
                    Date.now() -
                    started
                ) /
                1000
            ).toFixed(1)}s`
        );


    } catch (
        error
    ) {

        STATE.lastError =
            error &&
            error.message
                ? error.message
                : String(
                    error
                );

        console.error(
            'RADAR ERROR:',
            STATE.lastError
        );


    } finally {

        STATE.scanning =
            false;

        broadcast();
    }
}


/* =========================================================
   LIVE SIGNAL UPDATE
   ========================================================= */

async function updateLiveSignals() {

    const signals =
        [
            ...STATE.signals.values()
        ];


    await mapLimit(
        signals,
        4,
        async signal => {

            try {

                const market =
                    findMarket(
                        signal.symbol
                    );

                if (
                    !market
                ) {

                    return signal;
                }


                const ticker =
                    await exchange.fetchTicker(
                        market.symbol
                    );


                signal.currentPrice =
                    num(
                        ticker.last ||
                        ticker.close
                    );


                signal.livePnlPct =
                    signal.direction ===
                        'LONG'

                        ?

                        (
                            (
                                signal.currentPrice -
                                signal.entry
                            ) /
                            signal.entry
                        ) *
                        100

                        :

                        (
                            (
                                signal.entry -
                                signal.currentPrice
                            ) /
                            signal.entry
                        ) *
                        100;


                /*
                   LONG DURUM
                */

                if (
                    signal.direction ===
                    'LONG'
                ) {

                    if (
                        signal.currentPrice <=
                        signal.stop
                    ) {

                        signal.status =
                            'STOP';

                    } else if (
                        signal.currentPrice >=
                        signal.tp3
                    ) {

                        signal.status =
                            'TP3';

                    } else if (
                        signal.currentPrice >=
                        signal.tp2
                    ) {

                        signal.status =
                            'TP2';

                    } else if (
                        signal.currentPrice >=
                        signal.tp1
                    ) {

                        signal.status =
                            'TP1';
                    }


                /*
                   SHORT DURUM
                */

                } else {

                    if (
                        signal.currentPrice >=
                        signal.stop
                    ) {

                        signal.status =
                            'STOP';

                    } else if (
                        signal.currentPrice <=
                        signal.tp3
                    ) {

                        signal.status =
                            'TP3';

                    } else if (
                        signal.currentPrice <=
                        signal.tp2
                    ) {

                        signal.status =
                            'TP2';

                    } else if (
                        signal.currentPrice <=
                        signal.tp1
                    ) {

                        signal.status =
                            'TP1';
                    }
                }


                return signal;

            } catch (_) {

                return signal;
            }
        }
    );


    cleanup();

    broadcast();
}


/* =========================================================
   PUBLIC SIGNAL
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
            signal.symbol,

        ageSeconds:
            Math.floor(
                (
                    Date.now() -
                    signal.signalAt
                ) /
                1000
            )
    };
}


/* =========================================================
   STATUS
   ========================================================= */

function statusData() {

    return {

        success:
            true,

        engine:
            'SONNY AI TRADER V5.1',

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

            candidates:
                STATE.stats.candidates,

            deep:
                STATE.stats.deep,

            analyzed:
                STATE.stats.analyzed,

            pending:
                STATE.pending.size,

            signals:
                STATE.signals.size
        },

        market:
            STATE.market,

        selected:
            STATE.selected,

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
                    CFG.MAX_SIGNALS
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
    };
}


/* =========================================================
   WEBSOCKET
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

            } catch (_) {}
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

        } catch (_) {}
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

            service:
                'Sonny AI Trader V5.1',

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

            deep:
                STATE.stats.deep,

            analyzed:
                STATE.stats.analyzed,

            signals:
                STATE.signals.size,

            pending:
                STATE.pending.size,

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
    '/api/scalp-radar',
    (
        req,
        res
    ) => {

        res.json(
            statusData()
        );
    }
);


/* =========================================================
   MANUAL SCAN
   ========================================================= */

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

            const market =
                findMarket(
                    req.query.symbol ||
                    STATE.selected
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
                    market.symbol,
                    timeframe,
                    CFG.CHART_LIMIT
                );


            const signal =

                [
                    ...STATE.signals.values()
                ]
                    .find(
                        item =>
                            item.symbol ===
                            market.symbol
                    ) ||

                [
                    ...STATE.pending.values()
                ]
                    .find(
                        item =>
                            item.symbol ===
                            market.symbol
                    ) ||

                null;


            STATE.selected =
                market.symbol;

            STATE.timeframe =
                timeframe;


            res.json({

                success:
                    true,

                symbol:
                    market.symbol,

                timeframe,

                candles:
                    candles.map(
                        item => ({

                            time:
                                item[0],

                            open:
                                item[1],

                            high:
                                item[2],

                            low:
                                item[3],

                            close:
                                item[4],

                            volume:
                                item[5]
                        })
                    ),

                signal:
                    signal
                        ? publicSignal(
                            signal
                        )
                        : null
            });


        } catch (
            error
        ) {

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
   FRONTEND
   ========================================================= */

const HTML =
String.raw`<!doctype html>

<html lang="tr">

<head>

<meta charset="utf-8">

<meta
    name="viewport"
    content="width=device-width,initial-scale=1"
>

<title>
SONNY AI TRADER V5.1
</title>


<style>

* {
    box-sizing:
        border-box;
}


:root {

    --bg:
        #070b11;

    --panel:
        #0e151f;

    --panel2:
        #111a25;

    --line:
        #202c3b;

    --muted:
        #718096;

    --text:
        #edf3f8;

    --green:
        #13e0a2;

    --red:
        #ff4d6d;

    --yellow:
        #f4c84a;

    --blue:
        #4da3ff;
}


html,
body {

    margin:
        0;

    background:
        var(--bg);

    color:
        var(--text);

    font-family:
        Inter,
        Segoe UI,
        Arial,
        sans-serif;
}


button {

    font:
        inherit;
}


.app {

    min-height:
        100vh;

    display:
        grid;

    grid-template-columns:
        235px
        minmax(0,1fr)
        285px;
}


/* =========================================================
   LEFT
   ========================================================= */

.sidebar {

    border-right:
        1px solid
        var(--line);

    padding:
        14px 10px;

    overflow:
        auto;

    background:
        #080d14;
}


.brand {

    font-weight:
        900;

    font-size:
        19px;

    letter-spacing:
        .2px;

    margin:
        3px 4px 2px;
}


.sub {

    font-size:
        9px;

    color:
        var(--muted);

    margin:
        0 4px 12px;
}


.scan {

    width:
        100%;

    border:
        0;

    background:
        #172742;

    color:
        #fff;

    padding:
        10px;

    border-radius:
        7px;

    font-weight:
        800;

    cursor:
        pointer;

    margin-bottom:
        10px;
}


.stats {

    display:
        grid;

    grid-template-columns:
        repeat(
            3,
            1fr
        );

    gap:
        5px;

    margin-bottom:
        10px;
}


.stat {

    background:
        var(--panel);

    border:
        1px solid
        var(--line);

    border-radius:
        6px;

    padding:
        7px;

    text-align:
        center;
}


.stat b {

    display:
        block;

    font-size:
        15px;
}


.stat span {

    font-size:
        8px;

    color:
        var(--muted);
}


.signal-list {

    display:
        flex;

    flex-direction:
        column;

    gap:
        7px;
}


.card {

    background:
        var(--panel);

    border:
        1px solid
        var(--line);

    border-left:
        3px solid
        var(--blue);

    border-radius:
        8px;

    padding:
        10px;

    cursor:
        pointer;
}


.card:hover,
.card.active {

    border-color:
        #315a89;

    background:
        #111d2a;
}


.card.long {

    border-left-color:
        var(--green);
}


.card.short {

    border-left-color:
        var(--red);
}


.card-top {

    display:
        flex;

    justify-content:
        space-between;

    gap:
        6px;
}


.coin {

    font-weight:
        900;

    font-size:
        13px;
}


.badge {

    font-size:
        9px;

    font-weight:
        900;

    padding:
        3px 6px;

    border-radius:
        4px;
}


.badge.long {

    color:
        var(--green);

    background:
        #073c2e;
}


.badge.short {

    color:
        var(--red);

    background:
        #451322;
}


.price {

    font-size:
        18px;

    font-weight:
        900;

    margin:
        7px 0;
}


.card-meta {

    font-size:
        9px;

    color:
        var(--muted);

    display:
        flex;

    justify-content:
        space-between;
}


.dot {

    color:
        var(--green);

    font-weight:
        900;
}


.empty {

    color:
        var(--muted);

    font-size:
        11px;

    padding:
        12px;
}


/* =========================================================
   CENTER
   ========================================================= */

.main {

    min-width:
        0;

    padding:
        10px;
}


.header {

    height:
        55px;

    display:
        flex;

    align-items:
        center;

    justify-content:
        space-between;

    gap:
        10px;
}


.title {

    font-weight:
        900;

    font-size:
        20px;
}


.title small {

    font-size:
        10px;

    color:
        var(--muted);

    font-weight:
        500;

    display:
        block;

    margin-top:
        3px;
}


.market-pill {

    font-size:
        10px;

    color:
        var(--green);

    background:
        #073323;

    border:
        1px solid
        #0b684a;

    border-radius:
        20px;

    padding:
        7px 10px;

    white-space:
        nowrap;
}


.chart-panel {

    background:
        #080e16;

    border:
        1px solid
        var(--line);

    border-radius:
        8px;

    overflow:
        hidden;
}


.chart-head {

    height:
        46px;

    border-bottom:
        1px solid
        var(--line);

    display:
        flex;

    align-items:
        center;

    justify-content:
        space-between;

    padding:
        0 10px;
}


.chart-name {

    font-size:
        12px;

    font-weight:
        900;
}


.tf {

    display:
        flex;

    gap:
        4px;
}


.tf button {

    border:
        1px solid
        var(--line);

    background:
        #111b29;

    color:
        #9aa8b8;

    border-radius:
        5px;

    padding:
        6px 9px;

    font-size:
        9px;

    cursor:
        pointer;
}


.tf button.active {

    color:
        #fff;

    border-color:
        #428cff;

    background:
        #172a47;
}


.canvas-wrap {

    height:
        calc(
            100vh - 155px
        );

    min-height:
        430px;

    position:
        relative;
}


canvas {

    display:
        block;

    width:
        100%;

    height:
        100%;
}


.legend {

    position:
        absolute;

    left:
        10px;

    bottom:
        8px;

    font-size:
        9px;

    color:
        #8090a0;

    background:
        rgba(
            7,
            11,
            17,
            .78
        );

    padding:
        5px 7px;

    border-radius:
        4px;
}


.legend i {

    display:
        inline-block;

    width:
        7px;

    height:
        7px;

    border-radius:
        50%;

    margin-right:
        4px;
}


.lg-entry {

    background:
        var(--green);
}


.lg-stop {

    background:
        var(--red);
}


.lg-tp {

    background:
        var(--blue);
}


/* =========================================================
   RIGHT
   ========================================================= */

.right {

    border-left:
        1px solid
        var(--line);

    padding:
        10px;

    background:
        #080d14;

    overflow:
        auto;
}


.box {

    background:
        var(--panel);

    border:
        1px solid
        var(--line);

    border-radius:
        8px;

    padding:
        12px;

    margin-bottom:
        9px;
}


.box h3 {

    margin:
        0 0 8px;

    font-size:
        10px;

    color:
        #8797aa;

    text-transform:
        uppercase;
}


.regime {

    font-size:
        18px;

    font-weight:
        900;

    color:
        var(--yellow);
}


.regime.long {

    color:
        var(--green);
}


.regime.short {

    color:
        var(--red);
}


.regime-meta {

    font-size:
        9px;

    color:
        var(--muted);

    line-height:
        1.7;
}


.active-head {

    font-size:
        16px;

    font-weight:
        900;

    margin-bottom:
        8px;
}


.active-head.long {

    color:
        var(--green);
}


.active-head.short {

    color:
        var(--red);
}


.plan {

    display:
        grid;

    grid-template-columns:
        1fr 1fr;

    gap:
        5px;
}


.level {

    background:
        #09111b;

    border:
        1px solid
        #182534;

    border-radius:
        5px;

    padding:
        7px;
}


.level span {

    display:
        block;

    font-size:
        8px;

    color:
        var(--muted);
}


.level b {

    font-size:
        12px;
}


.entry b {

    color:
        var(--green);
}


.sl b {

    color:
        var(--red);
}


.tp b {

    color:
        var(--blue);
}


.reason {

    margin-top:
        8px;

    font-size:
        9px;

    color:
        #8997a8;

    line-height:
        1.5;
}


.pending {

    font-size:
        10px;

    color:
        #b8c3cf;
}


.pending-item {

    padding:
        7px 0;

    border-bottom:
        1px solid
        var(--line);
}


.pending-item:last-child {

    border-bottom:
        0;
}


/* =========================================================
   MOBILE
   ========================================================= */

@media (
    max-width:900px
) {

    .app {

        grid-template-columns:
            1fr;

        display:
            block;
    }


    .sidebar {

        border:
            0;

        border-bottom:
            1px solid
            var(--line);

        padding:
            9px;

        max-height:
            230px;
    }


    .brand {

        font-size:
            16px;
    }


    .sub {

        display:
            none;
    }


    .stats {

        display:
            none;
    }


    .scan {

        margin-bottom:
            7px;
    }


    .signal-list {

        display:
            flex;

        flex-direction:
            row;

        overflow-x:
            auto;

        padding-bottom:
            3px;
    }


    .card {

        min-width:
            165px;
    }


    .main {

        padding:
            7px;
    }


    .right {

        border:
            0;

        padding:
            7px;

        display:
            grid;

        grid-template-columns:
            1fr 1fr;

        gap:
            7px;
    }


    .right .box {

        margin:
            0;
    }


    .right .box:first-child {

        grid-column:
            1/-1;
    }


    .header {

        height:
            45px;
    }


    .title {

        font-size:
            16px;
    }


    .market-pill {

        font-size:
            8px;

        padding:
            6px;
    }


    .canvas-wrap {

        height:
            62vh;

        min-height:
            360px;
    }
}


@media (
    max-width:560px
) {

    .right {

        display:
            block;
    }


    .right .box {

        margin-bottom:
            7px;
    }


    .canvas-wrap {

        height:
            58vh;

        min-height:
            330px;
    }


    .tf button {

        padding:
            5px 7px;
    }


    .chart-head {

        height:
            42px;
    }


    .card {

        min-width:
            150px;
    }
}

</style>

</head>


<body>


<div class="app">


<!-- =====================================================
     SOL PANEL
     ===================================================== -->

<aside class="sidebar">

    <div class="brand">
        ⚡ SONNY AI TRADER
    </div>


    <div class="sub">

        4H/2H DESTEK-DİRENÇ •
        15M BREAKOUT/RETEST •
        5M TEYİT

    </div>


    <button
        id="scan"
        class="scan"
    >
        RADARI YENİLE
    </button>


    <div class="stats">

        <div class="stat">

            <b id="universe">
                0
            </b>

            <span>
                RADAR
            </span>

        </div>


        <div class="stat">

            <b id="candidates">
                0
            </b>

            <span>
                ADAY
            </span>

        </div>


        <div class="stat">

            <b id="deep">
                0
            </b>

            <span>
                DERİN
            </span>

        </div>

    </div>


    <div
        id="signals"
        class="signal-list"
    >

        <div class="empty">

            Sinyal bekleniyor...

        </div>

    </div>

</aside>


<!-- =====================================================
     ANA GRAFİK
     ===================================================== -->

<main class="main">


    <div class="header">

        <div class="title">

            <span id="pageSymbol">
                BTCUSDT
            </span>

            •

            <span id="pageTf">
                15M
            </span>


            <small id="scanInfo">

                Sistem hazırlanıyor...

            </small>

        </div>


        <div
            id="marketPill"
            class="market-pill"
        >

            ● SİSTEM AKTİF •
            AUTO TRADE KAPALI

        </div>

    </div>


    <section class="chart-panel">


        <div class="chart-head">


            <div
                id="chartName"
                class="chart-name"
            >

                BTCUSDT • 15M

            </div>


            <div class="tf">

                <button
                    data-tf="5m"
                >
                    5M
                </button>


                <button
                    data-tf="15m"
                    class="active"
                >
                    15M
                </button>


                <button
                    data-tf="1h"
                >
                    1H
                </button>


                <button
                    data-tf="2h"
                >
                    2H
                </button>


                <button
                    data-tf="4h"
                >
                    4H
                </button>

            </div>

        </div>


        <div class="canvas-wrap">

            <canvas
                id="chart"
            ></canvas>


            <div class="legend">

                <i class="lg-entry"></i>
                GİRİŞ

                &nbsp;

                <i class="lg-stop"></i>
                STOP

                &nbsp;

                <i class="lg-tp"></i>
                TP

            </div>

        </div>

    </section>

</main>


<!-- =====================================================
     SAĞ PANEL
     ===================================================== -->

<aside class="right">


    <div class="box">

        <h3>
            Genel piyasa durumu
        </h3>


        <div
            id="regime"
            class="regime"
        >
            YATAY
        </div>


        <div
            id="regimeMeta"
            class="regime-meta"
        >

            Analiz ediliyor...

        </div>

    </div>


    <div class="box">

        <h3>
            Aktif scalp sinyali
        </h3>


        <div id="active">

            <div class="empty">

                Henüz teyit edilmiş
                sinyal yok.

            </div>

        </div>

    </div>


    <div class="box">

        <h3>
            Bekleyen kırılım / retest
        </h3>


        <div
            id="pending"
            class="pending"
        >

            Bekleyen setup yok.

        </div>

    </div>


</aside>


</div>


<script>

(function(){

'use strict';


/* =========================================================
   STATE
   ========================================================= */

var state = {

    data:
        null,

    selected:
        'BTC/USDT:USDT',

    timeframe:
        '15m',

    candles:
        [],

    signal:
        null
};


/* =========================================================
   HELPERS
   ========================================================= */

function $(
    id
) {

    return document.getElementById(
        id
    );
}


function esc(
    value
) {

    return String(
        value == null
            ? ''
            : value
    ).replace(
        /[&<>"']/g,
        function(
            character
        ) {

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

            }[
                character
            ];
        }
    );
}


function price(
    value
) {

    var x =
        Number(value);

    if (
        !Number.isFinite(x)
    ) {

        return '-';
    }


    if (
        x >= 1000
    ) {

        return x.toFixed(
            2
        );
    }


    if (
        x >= 100
    ) {

        return x.toFixed(
            2
        );
    }


    if (
        x >= 1
    ) {

        return x.toFixed(
            4
        );
    }


    if (
        x >= 0.01
    ) {

        return x.toFixed(
            6
        );
    }


    if (
        x >= 0.0001
    ) {

        return x.toFixed(
            8
        );
    }


    return x.toFixed(
        10
    );
}


/* =========================================================
   RENDER
   ========================================================= */

function render(
    data
) {

    state.data =
        data;


    $('universe')
        .textContent =
        data.stats &&
        data.stats.universe
            ? data.stats.universe
            : 0;


    $('candidates')
        .textContent =
        data.stats &&
        data.stats.candidates
            ? data.stats.candidates
            : 0;


    $('deep')
        .textContent =
        data.stats &&
        data.stats.deep
            ? data.stats.deep
            : 0;


    $('scanInfo')
        .textContent =
        data.lastScan

            ?

            'Son tarama: ' +
            new Date(
                data.lastScan
            ).toLocaleTimeString(
                'tr-TR'
            )

            :

            'Tarama bekleniyor...';


    /* =====================================================
       MARKET
       ===================================================== */

    var market =
        data.market ||
        {};


    var regime =
        $('regime');


    regime.textContent =
        market.label ||
        'YATAY';


    regime.className =
        'regime ' +
        (
            market.direction ===
            'LONG'
                ? 'long'
                : market.direction ===
                  'SHORT'
                    ? 'short'
                    : ''
        );


    $('regimeMeta')
        .innerHTML =

        'Breadth <b>%'+
        esc(
            market.breadth
        )+
        '</b> • Yeşil '+
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

        '<br>BTC 1H: '+
        esc(
            market.btc
        )+
        ' • ETH 1H: '+
        esc(
            market.eth
        );


    /* =====================================================
       SIGNAL LIST
       ===================================================== */

    var list =
        $('signals');


    list.innerHTML =
        '';


    var signals =
        data.signals ||
        [];


    if (
        !signals.length
    ) {

        list.innerHTML =
            '<div class="empty">'+
            'Teyit edilmiş sinyal yok.'+
            '</div>';
    }


    signals.forEach(
        function(
            signal
        ) {

            var element =
                document.createElement(
                    'div'
                );


            element.className =
                'card ' +

                (
                    signal.direction ===
                    'LONG'
                        ? 'long'
                        : 'short'
                ) +

                (
                    signal.marketSymbol ===
                    state.selected
                        ? ' active'
                        : ''
                );


            element.setAttribute(
                'data-symbol',
                signal.marketSymbol
            );


            element.innerHTML =

                '<div class="card-top">'+

                    '<div class="coin">'+
                        esc(
                            signal.symbol
                        )+
                    '</div>'+

                    '<div class="badge '+
                        (
                            signal.direction ===
                            'LONG'
                                ? 'long'
                                : 'short'
                        )+
                    '">'+
                        esc(
                            signal.direction
                        )+
                    '</div>'+

                '</div>'+

                '<div class="price">'+
                    price(
                        signal.currentPrice ||
                        signal.entry
                    )+
                '</div>'+

                '<div class="card-meta">'+

                    '<span>'+
                        '<span class="dot">●</span>'+
                        ' GİRİŞ ALANI'+
                    '</span>'+

                    '<span>'+
                        'Güven '+
                        esc(
                            signal.score
                        )+
                        '/100'+
                    '</span>'+

                '</div>';


            element.onclick =
                function(){

                    state.selected =
                        signal.marketSymbol;

                    loadChart();
                };


            list.appendChild(
                element
            );
        }
    );


    /* =====================================================
       ACTIVE SIGNAL
       ===================================================== */

    var selectedSignal =
        signals.find(
            function(
                signal
            ){

                return (
                    signal.marketSymbol ===
                    state.selected
                );
            }
        ) ||

        signals[0] ||

        null;


    if (
        selectedSignal
    ) {

        state.selected =
            selectedSignal.marketSymbol;
    }


    renderActive(
        selectedSignal
    );


    renderPending(
        data.pending ||
        []
    );


    loadChart();
}


/* =========================================================
   ACTIVE SIGNAL
   ========================================================= */

function renderActive(
    signal
) {

    if (
        !signal
    ) {

        $('active')
            .innerHTML =

            '<div class="empty">'+
            'Henüz teyit edilmiş '+
            'sinyal yok.'+
            '</div>';

        return;
    }


    var cls =
        signal.direction ===
        'LONG'
            ? 'long'
            : 'short';


    $('active')
        .innerHTML =

        '<div class="active-head '+
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


            '<div class="level entry">'+

                '<span>GİRİŞ</span>'+

                '<b>'+

                    price(
                        signal.entryLow
                    )+

                    ' — '+

                    price(
                        signal.entryHigh
                    )+

                '</b>'+

            '</div>'+


            '<div class="level sl">'+

                '<span>STOP</span>'+

                '<b>'+

                    price(
                        signal.stop
                    )+

                '</b>'+

            '</div>'+


            '<div class="level tp">'+

                '<span>TP1</span>'+

                '<b>'+

                    price(
                        signal.tp1
                    )+

                '</b>'+

            '</div>'+


            '<div class="level tp">'+

                '<span>TP2</span>'+

                '<b>'+

                    price(
                        signal.tp2
                    )+

                '</b>'+

            '</div>'+


            '<div class="level tp">'+

                '<span>TP3</span>'+

                '<b>'+

                    price(
                        signal.tp3
                    )+

                '</b>'+

            '</div>'+


            '<div class="level">'+

                '<span>R:R</span>'+

                '<b>'+
                    '1:'+
                    esc(
                        signal.rr
                    )+
                '</b>'+

            '</div>'+


        '</div>'+

        '<div class="reason">'+

            esc(
                signal.status ||
                'GİRİŞ ALANI'
            )+

            ' • Skor '+

            esc(
                signal.score
            )+

            '/100 • RSI '+

            esc(
                signal.rsi
            )+

            '<br>'+

            esc(
                signal.reason ||
                ''
            )+

        '</div>';
}


/* =========================================================
   PENDING
   ========================================================= */

function renderPending(
    items
) {

    var box =
        $('pending');


    if (
        !items.length
    ) {

        box.textContent =
            'Bekleyen setup yok.';

        return;
    }


    box.innerHTML =
        items.map(
            function(
                item
            ) {

                return

                    '<div class="pending-item">'+

                        '<b>'+

                            esc(
                                item.symbol ||
                                ''
                            )+

                            ' '+

                            esc(
                                item.direction ||
                                ''
                            )+

                        '</b>'+

                        '<br>'+

                        'Seviye '+

                        price(
                            item.level ||
                            item.entry
                        )+

                        ' • BEKLENİYOR'+

                    '</div>';
            }
        ).join('');
}


/* =========================================================
   CHART LOAD
   ========================================================= */

async function loadChart(){

    try {

        var response =
            await fetch(

                '/api/chart?symbol='+
                encodeURIComponent(
                    state.selected
                )+

                '&timeframe='+
                encodeURIComponent(
                    state.timeframe
                ),

                {
                    cache:
                        'no-store'
                }
            );


        var data =
            await response.json();


        if (
            !data.success
        ) {

            return;
        }


        state.candles =
            data.candles ||
            [];


        state.signal =
            data.signal ||
            null;


        $('pageSymbol')
            .textContent =

            (
                data.symbol ||
                state.selected
            )
                .replace(
                    '/USDT:USDT',
                    'USDT'
                );


        $('pageTf')
            .textContent =
            (
                data.timeframe ||
                state.timeframe
            )
                .toUpperCase();


        $('chartName')
            .textContent =

            $('pageSymbol')
                .textContent +

            ' • ' +

            $('pageTf')
                .textContent;


        draw();


    } catch (
        error
    ) {

        console.error(
            'Grafik:',
            error
        );
    }
}


/* =========================================================
   DRAW CHART
   ========================================================= */

function draw(){

    var canvas =
        $('chart');


    var rect =
        canvas.getBoundingClientRect();


    var dpr =
        window.devicePixelRatio ||
        1;


    var width =
        Math.max(
            1,
            rect.width
        );


    var height =
        Math.max(
            1,
            rect.height
        );


    canvas.width =
        Math.floor(
            width *
            dpr
        );


    canvas.height =
        Math.floor(
            height *
            dpr
        );


    var ctx =
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


    ctx.clearRect(
        0,
        0,
        width,
        height
    );


    if (
        !state.candles.length
    ) {

        ctx.fillStyle =
            '#718096';

        ctx.font =
            '13px Arial';

        ctx.fillText(
            'Grafik verisi bekleniyor...',
            18,
            30
        );

        return;
    }


    var candles =
        state.candles;


    var signal =
        state.signal;


    var values =
        [];


    candles.forEach(
        function(
            candle
        ){

            values.push(
                Number(
                    candle.high
                )
            );

            values.push(
                Number(
                    candle.low
                )
            );
        }
    );


    if (
        signal
    ) {

        [

            signal.entryLow,

            signal.entryHigh,

            signal.stop,

            signal.tp1,

            signal.tp2,

            signal.tp3

        ].forEach(
            function(
                value
            ){

                if (
                    Number.isFinite(
                        Number(value)
                    )
                ) {

                    values.push(
                        Number(value)
                    );
                }
            }
        );
    }


    var min =
        Math.min.apply(
            Math,
            values
        );


    var max =
        Math.max.apply(
            Math,
            values
        );


    var padding =
        (
            max -
            min
        ) *
        0.07 ||
        1;


    min -=
        padding;


    max +=
        padding;


    var left =
        52;


    var right =
        72;


    var top =
        18;


    var bottom =
        24;


    var chartWidth =
        Math.max(
            1,
            width -
            left -
            right
        );


    var chartHeight =
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

            chartHeight

        );
    }


    function x(
        index
    ){

        return (

            left +

            index *
            chartWidth /
            Math.max(
                1,
                candles.length - 1
            )

        );
    }


    /* =====================================================
       GRID
       ===================================================== */

    ctx.strokeStyle =
        '#182330';

    ctx.lineWidth =
        1;


    for (
        var grid = 0;
        grid <= 5;
        grid++
    ){

        var gy =
            top +
            chartHeight *
            grid /
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
    }


    /* =====================================================
       PRICE SCALE
       ===================================================== */

    ctx.font =
        '9px Arial';

    ctx.fillStyle =
        '#607083';


    for (
        var priceIndex = 0;
        priceIndex <= 5;
        priceIndex++
    ){

        var py =
            top +
            chartHeight *
            priceIndex /
            5;


        var pv =
            max -
            (
                max -
                min
            ) *
            priceIndex /
            5;


        ctx.fillText(
            price(pv),
            5,
            py + 3
        );
    }


    /* =====================================================
       CANDLES
       ===================================================== */

    var step =
        chartWidth /
        Math.max(
            1,
            candles.length - 1
        );


    var body =
        Math.max(
            2,
            Math.min(
                9,
                step *
                0.62
            )
        );


    candles.forEach(
        function(
            candle,
            index
        ){

            var xx =
                x(index);


            var open =
                Number(
                    candle.open
                );


            var high =
                Number(
                    candle.high
                );


            var low =
                Number(
                    candle.low
                );


            var close =
                Number(
                    candle.close
                );


            var up =
                close >=
                open;


            ctx.strokeStyle =
                up
                    ? '#13e0a2'
                    : '#ff4d6d';


            ctx.fillStyle =
                up
                    ? '#13e0a2'
                    : '#ff4d6d';


            /* WICK */

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


            /* BODY */

            var openY =
                y(open);


            var closeY =
                y(close);


            var bodyHeight =
                Math.max(
                    1,
                    Math.abs(
                        closeY -
                        openY
                    )
                );


            ctx.fillRect(

                xx -
                body / 2,

                Math.min(
                    openY,
                    closeY
                ),

                body,

                bodyHeight
            );
        }
    );


    /* =====================================================
       SIGNAL LEVELS
       ===================================================== */

    if (
        signal
    ) {

        drawLine(
            signal.stop,
            '#ff4d6d',
            'STOP'
        );


        drawLine(
            signal.entry,
            '#13e0a2',
            'GİRİŞ'
        );


        drawLine(
            signal.tp1,
            '#4da3ff',
            'TP1'
        );


        drawLine(
            signal.tp2,
            '#4da3ff',
            'TP2'
        );


        drawLine(
            signal.tp3,
            '#4da3ff',
            'TP3'
        );


        /* GİRİŞ ALANI */

        if (
            signal.entryLow !==
            signal.entryHigh
        ) {

            ctx.fillStyle =
                'rgba(19,224,162,.12)';


            var entryA =
                y(
                    signal.entryLow
                );


            var entryB =
                y(
                    signal.entryHigh
                );


            ctx.fillRect(

                left,

                Math.min(
                    entryA,
                    entryB
                ),

                chartWidth,

                Math.abs(
                    entryA -
                    entryB
                )
            );
        }
    }


    function drawLine(
        value,
        color,
        label
    ){

        if (
            !Number.isFinite(
                Number(value)
            )
        ) {

            return;
        }


        var yy =
            y(value);


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
            '9px Arial';


        ctx.fillText(

            label +
            ' ' +
            price(value),

            width -
            right +
            5,

            yy + 3
        );
    }
}


/* =========================================================
   TIMEFRAME BUTTONS
   ========================================================= */

Array.prototype.forEach.call(

    document.querySelectorAll(
        '.tf button'
    ),

    function(
        button
    ){

        button.onclick =
            function(){

                Array.prototype.forEach.call(

                    document.querySelectorAll(
                        '.tf button'
                    ),

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


                state.timeframe =
                    button.getAttribute(
                        'data-tf'
                    );


                loadChart();
            };
    }
);


/* =========================================================
   MANUAL SCAN BUTTON
   ========================================================= */

$('scan').onclick =
    function(){

        fetch(
            '/api/scan'
        )
            .catch(
                function(){}
            );
    };


/* =========================================================
   WEBSOCKET
   ========================================================= */

var ws;


function connect(){

    try {

        var protocol =
            location.protocol ===
            'https:'

                ? 'wss://'

                : 'ws://';


        ws =
            new WebSocket(
                protocol +
                location.host
            );


        ws.onmessage =
            function(
                event
            ){

                try {

                    var message =
                        JSON.parse(
                            event.data
                        );


                    if (
                        message.type ===
                        'snapshot'
                    ) {

                        render(
                            message.data
                        );
                    }

                } catch (_) {}
            };


        ws.onclose =
            function(){

                setTimeout(
                    connect,
                    3000
                );
            };


    } catch (_) {

        setTimeout(
            connect,
            3000
        );
    }
}


/* =========================================================
   RESIZE
   ========================================================= */

window.addEventListener(
    'resize',
    draw
);


/* =========================================================
   CHART REFRESH
   ========================================================= */

setInterval(
    function(){

        if (
            state.selected
        ) {

            loadChart();
        }

    },
    15000
);


/* =========================================================
   START
   ========================================================= */

connect();


fetch(
    '/api/status'
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
        function(){}
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
            .send(
                HTML
            );
    }
);


/* =========================================================
   ERROR HANDLING
   ========================================================= */

process.on(
    'unhandledRejection',
    error => {

        STATE.lastError =
            error &&
            error.message
                ? error.message
                : String(
                    error
                );

        console.error(
            'UNHANDLED:',
            STATE.lastError
        );
    }
);


/* =========================================================
   SERVER START
   ========================================================= */

server.listen(
    PORT,
    '0.0.0.0',
    async () => {

        console.log(
            '================================================='
        );

        console.log(
            '🚀 SONNY AI TRADER V5.1'
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
            '🌐 Port: ' +
            PORT
        );

        console.log(
            '================================================='
        );


        try {

            await runScan();

        } catch (
            error
        ) {

            console.error(
                'İlk tarama hatası:',
                error.message
            );
        }


        setInterval(
            function(){

                runScan()
                    .catch(
                        function(
                            error
                        ){

                            console.error(
                                'SCAN LOOP:',
                                error.message
                            );
                        }
                    );

            },
            CFG.SCAN_MS
        );


        setInterval(
            function(){

                updateLiveSignals()
                    .catch(
                        function(
                            error
                        ){

                            console.error(
                                'LIVE:',
                                error.message
                            );
                        }
                    );

            },
            CFG.LIVE_MS
        );
    }
);
