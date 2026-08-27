const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PORT || 10000);
const API = 'https://api.bitget.com';

/* =========================================================
   SONNY AI TRADER — BREAKOUT ENGINE v2

   STRATEJİ:
   4H/2H SEVİYE
        ↓
   15M BREAKOUT
        ↓
   BREAKOUT STATE
        ↓
   15M RETEST
        ↓
   5M ENTRY CONFIRMATION
        ↓
   DYNAMIC TP / R:R
   ========================================================= */

const CFG = {

    /* =========================
       RADAR
       ========================= */

    MIN_VOL: 5_000_000,
    MIN_RANGE: 1.5,

    MAX_COINS: 160,
    MAX_SIGNALS: 15,

    SCAN_MS: 60_000,
    LIVE_MS: 10_000,

    TTL: 60 * 60 * 1000,


    /* =========================
       LEVELS
       ========================= */

    LEVEL_TOLERANCE: 0.75,
    CLUSTER_TOLERANCE: 0.35,

    CONCURRENCY: 6,

    CANDLES: 100,
    CHART: 160,


    /* =========================
       BREAKOUT
       ========================= */

    // 15M x 6 = 90 dakika
    RETEST_WINDOW: 6,

    // Kırılan seviyenin çevresindeki tolerans
    RETEST_TOLERANCE: 0.35,

    // LONG breakout sonrası seviyenin altında,
    // SHORT breakout sonrası seviyenin üstünde
    // bu oranda kapanış setup'ı iptal eder.
    BREAKOUT_INVALIDATION: 0.20,

    // Breakout mumunun ortalama hacme oranı
    MIN_BREAKOUT_VOLUME_RATIO: 1.30,

    // Breakout gövdesinin ATR'ye oranı
    MIN_BREAKOUT_BODY_ATR: 0.35,

    // Kapanışın kırılan seviyeden minimum uzaklığı
    MIN_BREAKOUT_CLOSE_DISTANCE: 0.08,


    /* =========================
       4H TREND
       ========================= */

    TREND_EMA_FAST: 21,
    TREND_EMA_SLOW: 50,

    TREND_NEUTRAL_BAND: 0.15,


    /* =========================
       5M ENTRY
       ========================= */

    ENTRY_MAX_DISTANCE: 0.55,

    ENTRY_ZONE_ATR: 0.18,


    /* =========================
       RISK / REWARD
       ========================= */

    MIN_RR: 1.50,


    /* =========================
       COOLDOWN
       ========================= */

    LEVEL_COOLDOWN_MS: 4 * 60 * 60 * 1000
};


/* =========================================================
   STATE
   ========================================================= */

const STATE = {

    scanning: false,

    lastScan: 0,

    lastError: null,

    lastAnalyzed: 0,

    universe: [],

    signals: new Map(),

    tickers: new Map(),

    stoppedLevels: new Map(),

    /*
     * BREAKOUT STATE
     *
     * Burada kırılmış seviyeleri hafızada tutuyoruz.
     *
     * Böylece breakout sadece son mumda aranıp
     * 15 dakika sonra kaybolmuyor.
     */
    pendingBreakouts: new Map(),

    market: {

        label: 'YATAY / KARIŞIK',

        reason: 'Piyasa verisi bekleniyor.',

        avg: 0,

        breadth: 0
    }
};


const candleCache = new Map();

let tickerCache = {

    ts: 0,

    map: new Map()
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


function price(value) {

    const x = n(value);

    if (!x) return 0;

    if (x < 0.000001)
        return Number(x.toFixed(10));

    if (x < 0.0001)
        return Number(x.toFixed(8));

    if (x < 0.01)
        return Number(x.toFixed(7));

    if (x < 1)
        return Number(x.toFixed(5));

    if (x < 10)
        return Number(x.toFixed(4));

    if (x < 100)
        return Number(x.toFixed(3));

    return Number(x.toFixed(2));
}


function percentDistance(a, b) {

    if (!b) return 999;

    return Math.abs(a - b) / b * 100;
}


/* =========================================================
   HTTP
   ========================================================= */

async function get(url, timeout = 15000) {

    const controller = new AbortController();

    const timer = setTimeout(
        () => controller.abort(),
        timeout
    );

    try {

        const response = await fetch(
            url,
            {
                signal: controller.signal,
                headers: {
                    accept: 'application/json'
                }
            }
        );

        const json = await response.json();

        if (!response.ok) {

            throw new Error(
                `HTTP ${response.status}`
            );
        }

        if (
            json.code &&
            json.code !== '00000'
        ) {

            throw new Error(
                json.msg ||
                `Bitget ${json.code}`
            );
        }

        return json;

    } finally {

        clearTimeout(timer);
    }
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

            } catch {

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
            {
                length: workers
            },
            runner
        )
    );


    return result;
}


/* =========================================================
   TICKERS
   ========================================================= */

async function getTickers(
    force = false
) {

    if (
        !force &&
        tickerCache.map.size &&
        Date.now() -
        tickerCache.ts <
        8000
    ) {

        return tickerCache.map;
    }


    const url =
        `${API}/api/v2/mix/market/tickers` +
        `?productType=USDT-FUTURES`;


    const json =
        await get(url);


    const map =
        new Map();


    for (
        const row of
        json.data || []
    ) {

        const symbol =
            String(
                row.symbol || ''
            ).toUpperCase();


        if (
            !symbol.endsWith('USDT')
        ) {

            continue;
        }


        map.set(
            symbol,
            {

                symbol,

                last:
                    n(row.lastPr),

                volume:
                    n(
                        row.quoteVolume ||
                        row.usdtVolume
                    ),

                change:
                    n(row.change24h),

                high:
                    n(row.high24h),

                low:
                    n(row.low24h),

                ts:
                    n(
                        row.ts,
                        Date.now()
                    )
            }
        );
    }


    tickerCache = {

        ts: Date.now(),

        map
    };


    STATE.tickers =
        map;


    return map;
}


/* =========================================================
   MARKET DISCOVERY
   ========================================================= */

async function discoverUniverse() {

    const [
        contracts,
        tickerMap
    ] =
        await Promise.all(
            [

                get(
                    `${API}/api/v2/mix/market/contracts` +
                    `?productType=USDT-FUTURES`
                ),

                getTickers(true)
            ]
        );


    const result = [];


    for (
        const contract of
        contracts.data || []
    ) {

        const symbol =
            String(
                contract.symbol || ''
            ).toUpperCase();


        const status =
            String(
                contract.symbolStatus ||
                contract.status ||
                ''
            ).toLowerCase();


        if (
            !symbol.endsWith('USDT')
        ) {

            continue;
        }


        if (
            status &&
            ![
                'normal',
                'online',
                'listed'
            ].includes(status)
        ) {

            continue;
        }


        const ticker =
            tickerMap.get(symbol);


        if (
            !ticker ||
            !ticker.last
        ) {

            continue;
        }


        /*
         * Minimum hacim
         */

        if (
            ticker.volume <
            CFG.MIN_VOL
        ) {

            continue;
        }


        /*
         * 24H hareket
         */

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
            CFG.MIN_RANGE
        ) {

            continue;
        }


        result.push({

            symbol,

            base:
                symbol.replace(
                    'USDT',
                    ''
                ),

            last:
                ticker.last,

            volume:
                ticker.volume,

            change:
                ticker.change,

            range
        });
    }


    result.sort(
        (a, b) =>
            b.volume -
            a.volume
    );


    STATE.universe =
        result.slice(
            0,
            CFG.MAX_COINS
        );


    return STATE.universe;
}


/* =========================================================
   CANDLES
   ========================================================= */

async function getCandles(
    symbol,
    timeframe,
    limit = CFG.CANDLES
) {

    const key =
        `${symbol}_${timeframe}_${limit}`;


    const cached =
        candleCache.get(key);


    if (
        cached &&
        Date.now() -
        cached.ts <
        50000
    ) {

        return cached.data;
    }


    const url =
        `${API}/api/v2/mix/market/candles` +
        `?symbol=${symbol}` +
        `&granularity=${timeframe}` +
        `&limit=${limit}` +
        `&productType=USDT-FUTURES`;


    const json =
        await get(url);


    const candles =
        (json.data || [])
            .map(
                candle => ({

                    time:
                        n(candle[0]),

                    open:
                        n(candle[1]),

                    high:
                        n(candle[2]),

                    low:
                        n(candle[3]),

                    close:
                        n(candle[4]),

                    volume:
                        n(candle[5]),

                    turnover:
                        n(candle[6])
                })
            )
            .filter(
                candle =>
                    candle.close > 0
            )
            .sort(
                (a, b) =>
                    a.time -
                    b.time
            );


    candleCache.set(
        key,
        {

            ts: Date.now(),

            data: candles
        }
    );


    return candles;
}


/* =========================================================
   CLOSED CANDLES
   ========================================================= */

function closedCandles(
    candles
) {

    if (
        !candles ||
        candles.length < 3
    ) {

        return [];
    }


    /*
     * Son mum henüz oluşuyor olabilir.
     *
     * Sinyal hesabında sadece tamamlanmış
     * mumları kullanıyoruz.
     */

    return candles.slice(
        0,
        -1
    );
}


/* =========================================================
   SWING PIVOTS
   ========================================================= */

function findPivots(
    candles,
    type
) {

    const c =
        closedCandles(
            candles
        );


    const result = [];


    /*
     * Daha güçlü swing tespiti.
     */

    const span = 3;


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

            if (
                type ===
                'resistance'
            ) {

                if (
                    c[i].high <=
                    c[i - j].high ||
                    c[i].high <=
                    c[i + j].high
                ) {

                    valid = false;

                    break;
                }

            } else {

                if (
                    c[i].low >=
                    c[i - j].low ||
                    c[i].low >=
                    c[i + j].low
                ) {

                    valid = false;

                    break;
                }
            }
        }


        if (!valid)
            continue;


        result.push({

            price:
                type ===
                'resistance'
                    ? c[i].high
                    : c[i].low,

            time:
                c[i].time
        });
    }


    return result;
}


/* =========================================================
   LEVEL CLUSTER
   ========================================================= */

function clusterLevels(
    points
) {

    const groups = [];


    for (
        const point of
        [...points].sort(
            (a, b) =>
                a.price -
                b.price
        )
    ) {

        const last =
            groups[
                groups.length - 1
            ];


        if (!last) {

            groups.push({

                prices: [
                    point.price
                ],

                times: [
                    point.time
                ]
            });

            continue;
        }


        const average =
            last.prices.reduce(
                (sum, value) =>
                    sum + value,
                0
            ) /
            last.prices.length;


        if (
            percentDistance(
                point.price,
                average
            ) <=
            CFG.CLUSTER_TOLERANCE
        ) {

            last.prices.push(
                point.price
            );

            last.times.push(
                point.time
            );

        } else {

            groups.push({

                prices: [
                    point.price
                ],

                times: [
                    point.time
                ]
            });
        }
    }


    return groups.map(
        group => ({

            price:
                group.prices.reduce(
                    (a, b) =>
                        a + b,
                    0
                ) /
                group.prices.length,

            touches:
                group.prices.length,

            time:
                Math.max(
                    ...group.times
                )
        })
    );
}


/* =========================================================
   LEVELS
   ========================================================= */

function getLevels(
    candles
) {

    return {

        supports:
            clusterLevels(
                findPivots(
                    candles,
                    'support'
                )
            ),

        resistances:
            clusterLevels(
                findPivots(
                    candles,
                    'resistance'
                )
            )
    };
}


/* =========================================================
   EMA
   ========================================================= */

function calculateEMA(
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


    let ema =
        c
            .slice(
                0,
                period
            )
            .reduce(
                (sum, x) =>
                    sum + x.close,
                0
            ) /
        period;


    for (
        let i = period;
        i < c.length;
        i++
    ) {

        ema =
            c[i].close * k +
            ema * (1 - k);
    }


    return ema;
}


/* =========================================================
   4H TREND
   ========================================================= */

function getTrendBias(
    candles4H
) {

    const emaFast =
        calculateEMA(
            candles4H,
            CFG.TREND_EMA_FAST
        );


    const emaSlow =
        calculateEMA(
            candles4H,
            CFG.TREND_EMA_SLOW
        );


    if (
        !emaFast ||
        !emaSlow
    ) {

        return {

            direction:
                'NEUTRAL',

            diffPct: 0
        };
    }


    const diffPct =
        (
            emaFast -
            emaSlow
        ) /
        emaSlow *
        100;


    if (
        diffPct >
        CFG.TREND_NEUTRAL_BAND
    ) {

        return {

            direction:
                'LONG',

            diffPct
        };
    }


    if (
        diffPct <
        -CFG.TREND_NEUTRAL_BAND
    ) {

        return {

            direction:
                'SHORT',

            diffPct
        };
    }


    return {

        direction:
            'NEUTRAL',

        diffPct
    };
}


/* =========================================================
   RSI
   ========================================================= */

function calculateRSI(
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


    for (
        let i =
            c.length - period;
        i <
            c.length;
        i++
    ) {

        const diff =
            c[i].close -
            c[i - 1].close;


        if (
            diff > 0
        ) {

            gains += diff;

        } else {

            losses -= diff;
        }
    }


    if (
        losses === 0
    ) {

        return 100;
    }


    const rs =
        (
            gains /
            period
        ) /
        (
            losses /
            period
        );


    return (
        100 -
        (
            100 /
            (1 + rs)
        )
    );
}


/* =========================================================
   ATR
   ========================================================= */

function calculateATR(
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


    const values = [];


    for (
        let i = 1;
        i < c.length;
        i++
    ) {

        values.push(
            Math.max(

                c[i].high -
                c[i].low,

                Math.abs(
                    c[i].high -
                    c[i - 1].close
                ),

                Math.abs(
                    c[i].low -
                    c[i - 1].close
                )
            )
        );
    }


    const recent =
        values.slice(
            -period
        );


    return recent.reduce(
        (a, b) =>
            a + b,
        0
    ) /
    recent.length;
}


/* =========================================================
   VOLUME RATIO
   ========================================================= */

function volumeRatioForCandle(
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
        c[index].turnover ||
        c[index].volume;


    const start =
        Math.max(
            0,
            index - 20
        );


    const previous =
        c.slice(
            start,
            index
        );


    if (
        !previous.length
    ) {

        return 1;
    }


    const average =
        previous.reduce(
            (
                sum,
                candle
            ) =>
                sum +
                (
                    candle.turnover ||
                    candle.volume
                ),
            0
        ) /
        previous.length;


    return average > 0
        ? current / average
        : 1;
}


/* =========================================================
   BREAKOUT QUALITY
   ========================================================= */

function breakoutQuality(
    candle,
    candles15M,
    direction
) {

    const atr =
        calculateATR(
            candles15M
        ) ||
        candle.close *
        0.003;


    const body =
        Math.abs(
            candle.close -
            candle.open
        );


    const bodyAtr =
        body /
        atr;


    const range =
        Math.max(
            candle.high -
            candle.low,

            candle.close *
            0.000001
        );


    const bodyRatio =
        body /
        range;


    const closePosition =
        direction ===
        'LONG'

            ? (
                candle.close -
                candle.low
            ) /
            range

            : (
                candle.high -
                candle.close
            ) /
            range;


    return {

        atr,

        bodyAtr,

        bodyRatio,

        closePosition
    };
}


/* =========================================================
   BREAKOUT DISCOVERY
   ========================================================= */

function detectRecentBreakouts(
    candles15M,
    allLevels
) {

    const c =
        closedCandles(
            candles15M
        );


    if (
        c.length < 25
    ) {

        return [];
    }


    const found = [];


    /*
     * Son birkaç kapanmış mum taranıyor.
     *
     * Bulunan breakout STATE'e kaydediliyor.
     *
     * Böylece breakout bir sonraki scan'de
     * kaybolmuyor.
     */

    const start =
        Math.max(
            1,
            c.length - 4
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


        /* =========================
           LONG BREAKOUT
           ========================= */

        for (
            const level of
            allLevels.resistances
        ) {

            const brokenNow =
                current.close >
                    level.price &&
                previous.close <=
                    level.price;


            if (!brokenNow)
                continue;


            const quality =
                breakoutQuality(
                    current,
                    candles15M,
                    'LONG'
                );


            const volumeRatio =
                volumeRatioForCandle(
                    candles15M,
                    i
                );


            found.push({

                direction:
                    'LONG',

                level,

                breakoutCandle:
                    current,

                breakoutTime:
                    current.time,

                /*
                 * KRİTİK:
                 * Gerçek breakout mumunun hacmi.
                 */

                breakoutVolumeRatio:
                    volumeRatio,

                breakoutBodyAtr:
                    quality.bodyAtr,

                breakoutBodyRatio:
                    quality.bodyRatio,

                closeDistancePct:
                    percentDistance(
                        current.close,
                        level.price
                    )
            });
        }


        /* =========================
           SHORT BREAKOUT
           ========================= */

        for (
            const level of
            allLevels.supports
        ) {

            const brokenNow =
                current.close <
                    level.price &&
                previous.close >=
                    level.price;


            if (!brokenNow)
                continue;


            const quality =
                breakoutQuality(
                    current,
                    candles15M,
                    'SHORT'
                );


            const volumeRatio =
                volumeRatioForCandle(
                    candles15M,
                    i
                );


            found.push({

                direction:
                    'SHORT',

                level,

                breakoutCandle:
                    current,

                breakoutTime:
                    current.time,

                breakoutVolumeRatio:
                    volumeRatio,

                breakoutBodyAtr:
                    quality.bodyAtr,

                breakoutBodyRatio:
                    quality.bodyRatio,

                closeDistancePct:
                    percentDistance(
                        current.close,
                        level.price
                    )
            });
        }
    }


    return found;
}


/* =========================================================
   BREAKOUT KEY
   ========================================================= */

function breakoutKey(
    symbol,
    breakout
) {

    return (
        `${symbol}_` +
        `${breakout.direction}_` +
        `${price(
            breakout.level.price
        )}_` +
        `${breakout.breakoutTime}`
    );
}


/* =========================================================
   ADD BREAKOUT STATE
   ========================================================= */

function addPendingBreakouts(
    symbol,
    breakouts
) {

    const now =
        Date.now();


    for (
        const b of
        breakouts
    ) {

        const age =
            now -
            b.breakoutTime;


        if (
            age >
            CFG.RETEST_WINDOW *
            15 *
            60 *
            1000
        ) {

            continue;
        }


        const key =
            breakoutKey(
                symbol,
                b
            );


        if (
            !STATE.pendingBreakouts.has(
                key
            )
        ) {

            STATE.pendingBreakouts.set(
                key,
                {

                    key,

                    symbol,

                    ...b,

                    createdAt:
                        now,

                    status:
                        'WAITING_RETEST'
                }
            );
        }
    }
}


/* =========================================================
   RETEST
   ========================================================= */

function detectRetestForBreakout(
    candles15M,
    pending
) {

    const c =
        closedCandles(
            candles15M
        );


    /*
     * Breakout mumunu zamanından buluyoruz.
     */

    const breakoutIndex =
        c.findIndex(
            x =>
                x.time ===
                pending.breakoutTime
        );


    if (
        breakoutIndex < 0
    ) {

        return {

            status:
                'WAITING_RETEST'
        };
    }


    const end =
        Math.min(
            c.length,

            breakoutIndex +
            1 +
            CFG.RETEST_WINDOW
        );


    /*
     * Önce fiyat breakout seviyesinden
     * gerçekten uzaklaşmalı.
     *
     * Böylece breakout mumunun kendisini
     * retest olarak kabul etmiyoruz.
     */

    let movedAway = false;


    for (
        let i =
            breakoutIndex + 1;
        i < end;
        i++
    ) {

        const candle =
            c[i];


        const level =
            pending.level.price;


        /* =========================
           LONG
           ========================= */

        if (
            pending.direction ===
            'LONG'
        ) {

            /*
             * Kırılımın altına ciddi kapanış
             * gelirse fake breakout.
             */

            if (
                candle.close <=
                level *
                (
                    1 -
                    CFG.BREAKOUT_INVALIDATION /
                    100
                )
            ) {

                return {

                    status:
                        'INVALIDATED',

                    reason:
                        '15M kırılım sonrası seviye altında kapanış'
                };
            }


            /*
             * Fiyat seviyeden biraz uzaklaştı mı?
             */

            if (
                candle.close >=
                level *
                1.0015
            ) {

                movedAway = true;
            }


            /*
             * Fiyat seviyeye geri döndü mü?
             */

            const touched =
                candle.low <=
                level *
                (
                    1 +
                    CFG.RETEST_TOLERANCE /
                    100
                );


            /*
             * Retest sonrası kapanış hâlâ
             * seviyeyi koruyor mu?
             */

            const held =
                candle.close >=
                level *
                (
                    1 -
                    CFG.RETEST_TOLERANCE /
                    100
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

        /* =========================
           SHORT
           ========================= */

        else {

            /*
             * Kırılımın üstüne ciddi kapanış
             * gelirse fake breakout.
             */

            if (
                candle.close >=
                level *
                (
                    1 +
                    CFG.BREAKOUT_INVALIDATION /
                    100
                )
            ) {

                return {

                    status:
                        'INVALIDATED',

                    reason:
                        '15M kırılım sonrası seviye üstünde kapanış'
                };
            }


            /*
             * Fiyat aşağı uzaklaştı mı?
             */

            if (
                candle.close <=
                level *
                0.9985
            ) {

                movedAway = true;
            }


            /*
             * Seviyeye geri dokundu mu?
             */

            const touched =
                candle.high >=
                level *
                (
                    1 -
                    CFG.RETEST_TOLERANCE /
                    100
                );


            /*
             * Seviye üzerinde kapanmadı mı?
             */

            const held =
                candle.close <=
                level *
                (
                    1 +
                    CFG.RETEST_TOLERANCE /
                    100
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


    /*
     * Pencere dolduysa setup artık geçersiz.
     */

    if (
        c.length - 1 >=
        breakoutIndex +
        CFG.RETEST_WINDOW
    ) {

        return {

            status:
                'EXPIRED',

            reason:
                'Retest penceresi doldu'
        };
    }


    return {

        status:
            'WAITING_RETEST'
    };
}


/* =========================================================
   5M ENTRY CONFIRMATION
   ========================================================= */

function confirm5mEntry(
    candles5M,
    retest,
    direction,
    levelPrice
) {

    const c =
        closedCandles(
            candles5M
        );


    if (
        c.length < 8 ||
        !retest?.candle
    ) {

        return {

            confirmed:
                false
        };
    }


    /*
     * Retest mumundan sonraki 5M mumları
     * tarıyoruz.
     *
     * Böylece scan tam teyit mumunda çalışmasa bile
     * teyit sonradan bulunabiliyor.
     */

    const after =
        c
            .filter(
                x =>
                    x.time >
                    retest.candle.time
            )
            .slice(-12);


    if (
        after.length < 2
    ) {

        return {

            confirmed:
                false
        };
    }


    for (
        let i = 1;
        i < after.length;
        i++
    ) {

        const prev =
            after[i - 1];


        const last =
            after[i];


        /* =========================
           LONG
           ========================= */

        if (
            direction ===
            'LONG'
        ) {

            const higherLow =
                last.low >=
                prev.low;


            const bullishClose =
                last.close >
                last.open;


            const continuation =
                last.close >
                prev.high;


            const aboveLevel =
                last.close >
                levelPrice;


            if (
                higherLow &&
                bullishClose &&
                continuation &&
                aboveLevel
            ) {

                return {

                    confirmed:
                        true,

                    candle:
                        last
                };
            }


        }

        /* =========================
           SHORT
           ========================= */

        else {

            const lowerHigh =
                last.high <=
                prev.high;


            const bearishClose =
                last.close <
                last.open;


            const continuation =
                last.close <
                prev.low;


            const belowLevel =
                last.close <
                levelPrice;


            if (
                lowerHigh &&
                bearishClose &&
                continuation &&
                belowLevel
            ) {

                return {

                    confirmed:
                        true,

                    candle:
                        last
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

function get15mStructure(
    candles
) {

    const c =
        closedCandles(
            candles
        );


    if (
        c.length < 24
    ) {

        return {

            direction:
                'NEUTRAL',

            strength:
                0,

            reason:
                '15M veri yetersiz'
        };
    }


    const recent =
        c.slice(-12);


    const previous =
        c.slice(-24, -12);


    const recentHigh =
        Math.max(
            ...recent.map(
                x => x.high
            )
        );


    const previousHigh =
        Math.max(
            ...previous.map(
                x => x.high
            )
        );


    const recentLow =
        Math.min(
            ...recent.map(
                x => x.low
            )
        );


    const previousLow =
        Math.min(
            ...previous.map(
                x => x.low
            )
        );


    const lastThree =
        recent.slice(-3);


    const momentumUp =
        lastThree[2].close >
        lastThree[0].close;


    const momentumDown =
        lastThree[2].close <
        lastThree[0].close;


    if (
        recentHigh >
        previousHigh &&
        recentLow >
        previousLow &&
        momentumUp
    ) {

        return {

            direction:
                'LONG',

            strength:
                20,

            reason:
                '15M yapı yukarı dönüyor'
        };
    }


    if (
        recentHigh <
        previousHigh &&
        recentLow <
        previousLow &&
        momentumDown
    ) {

        return {

            direction:
                'SHORT',

            strength:
                20,

            reason:
                '15M yapı aşağı dönüyor'
        };
    }


    if (
        momentumUp
    ) {

        return {

            direction:
                'LONG',

            strength:
                10,

            reason:
                '15M momentum yukarı'
        };
    }


    if (
        momentumDown
    ) {

        return {

            direction:
                'SHORT',

            strength:
                10,

            reason:
                '15M momentum aşağı'
        };
    }


    return {

        direction:
            'NEUTRAL',

        strength:
            0,

        reason:
            '15M yön kararsız'
    };
}


/* =========================================================
   SCORE
   ========================================================= */

function calculateScore(
    data
) {

    /*
     * Score artık GATE değil.
     *
     * Zorunlu şartlar ayrı kontrol ediliyor.
     * Score sadece kalite sıralaması için.
     */

    let score = 25;

    const reasons = [];


    /* =========================
       4H TREND
       ========================= */

    if (
        data.trendBias.direction ===
        data.direction
    ) {

        score += 20;

        reasons.push(
            '4H trend yönü uyumlu'
        );

    } else if (
        data.trendBias.direction ===
        'NEUTRAL'
    ) {

        score += 8;

        reasons.push(
            '4H trend nötr'
        );
    }


    /* =========================
       CONFLUENCE
       ========================= */

    if (
        data.confluence
    ) {

        score += 15;

        reasons.push(
            '4H + 2H aynı bölge'
        );

    } else {

        score += 6;

        reasons.push(
            data.has4H
                ? '4H seviye'
                : '2H seviye'
        );
    }


    /* =========================
       TOUCHES
       ========================= */

    if (
        data.level.touches >= 4
    ) {

        score += 10;

        reasons.push(
            `seviye ${data.level.touches} temaslı`
        );

    } else if (
        data.level.touches >= 2
    ) {

        score += 6;

        reasons.push(
            `seviye ${data.level.touches} temaslı`
        );
    }


    /* =========================
       BREAKOUT VOLUME
       ========================= */

    if (
        data.breakoutVolumeRatio >=
        1.8
    ) {

        score += 15;

        reasons.push(
            'kırılım hacmi çok güçlü'
        );

    } else if (
        data.breakoutVolumeRatio >=
        CFG.MIN_BREAKOUT_VOLUME_RATIO
    ) {

        score += 8;

        reasons.push(
            'kırılım hacmi yeterli'
        );
    }


    /* =========================
       BREAKOUT BODY
       ========================= */

    if (
        data.breakoutBodyAtr >=
        0.70
    ) {

        score += 10;

        reasons.push(
            'kırılım gövdesi güçlü'
        );

    } else {

        score += 4;

        reasons.push(
            'kırılım gövdesi yeterli'
        );
    }


    /* =========================
       15M STRUCTURE
       ========================= */

    if (
        data.structure.direction ===
        data.direction
    ) {

        score +=
            data.structure.strength;

        reasons.push(
            '15M yapı uyumlu'
        );

    } else if (
        data.structure.direction ===
        'NEUTRAL'
    ) {

        reasons.push(
            '15M nötr'
        );

    } else {

        score -= 10;

        reasons.push(
            '15M ters yönde'
        );
    }


    /* =========================
       RSI
       ========================= */

    if (
        data.rsi >= 45 &&
        data.rsi <= 65
    ) {

        score += 5;

        reasons.push(
            'RSI sağlıklı bölgede'
        );

    } else if (
        (
            data.direction === 'LONG' &&
            data.rsi < 72
        ) ||
        (
            data.direction === 'SHORT' &&
            data.rsi > 28
        )
    ) {

        score += 2;

        reasons.push(
            'RSI kabul edilebilir'
        );

    } else {

        score -= 5;

        reasons.push(
            'RSI aşırı'
        );
    }


    return {

        score:
            Math.max(
                0,
                Math.min(
                    100,
                    Math.round(score)
                )
            ),

        reasons
    };
}


/* =========================================================
   UNIQUE LEVELS
   ========================================================= */

function uniqueLevels(
    levels,
    direction,
    reference
) {

    const sorted =
        [...levels]
            .filter(
                x =>
                    direction ===
                    'LONG'

                        ? x.price >
                          reference *
                          1.001

                        : x.price <
                          reference *
                          0.999
            )
            .sort(
                (a, b) =>
                    direction ===
                    'LONG'

                        ? a.price -
                          b.price

                        : b.price -
                          a.price
            );


    const result = [];


    for (
        const level of
        sorted
    ) {

        if (
            !result.some(
                x =>
                    percentDistance(
                        x.price,
                        level.price
                    ) <=
                    CFG.CLUSTER_TOLERANCE
            )
        ) {

            result.push(
                level
            );
        }
    }


    return result;
}


/* =========================================================
   DYNAMIC TRADE PLAN
   ========================================================= */

function buildTradePlan(
    direction,
    level,
    atr,
    oppositeLevels
) {

    const isLong =
        direction ===
        'LONG';


    /*
     * Entry zone
     */

    const zone =
        Math.max(
            atr *
            CFG.ENTRY_ZONE_ATR,

            level.price *
            0.0008
        );


    /*
     * Stop mesafesi
     */

    const risk =
        Math.max(
            atr *
            0.90,

            level.price *
            0.004
        );


    const entryLow =
        level.price -
        zone;


    const entryHigh =
        level.price +
        zone;


    const stop =
        isLong
            ? level.price - risk
            : level.price + risk;


    /*
     * Gerçek karşı seviyeleri çıkar.
     */

    const candidates =
        uniqueLevels(
            oppositeLevels,
            direction,
            level.price
        )
            .map(
                x => ({

                    ...x,

                    safePrice:
                        isLong
                            ? x.price *
                              0.995
                            : x.price *
                              1.005,

                    distance:
                        Math.abs(
                            x.price -
                            level.price
                        )
                })
            )
            .sort(
                (a, b) =>
                    a.distance -
                    b.distance
            );


    /*
     * Minimum TP1 = 1.5R
     */

    const idealMultipliers = [
        1.50,
        2.25,
        3.00
    ];


    const targets = [];

    const used = new Set();


    /*
     * İlk karşı direnç / destek
     */

    const nearestOpposite =
        candidates[0]?.safePrice ||
        null;


    /*
     * TP1 için yeterli alan yoksa
     * işlem hiç oluşturulmaz.
     */

    if (
        nearestOpposite !== null
    ) {

        const maxReward =
            Math.abs(
                nearestOpposite -
                level.price
            );


        if (
            maxReward <
            risk *
            CFG.MIN_RR
        ) {

            return null;
        }
    }


    for (
        const multiplier of
        idealMultipliers
    ) {

        const ideal =
            isLong

                ? level.price +
                  risk *
                  multiplier

                : level.price -
                  risk *
                  multiplier;


        const previous =
            targets[
                targets.length - 1
            ];


        const minDistanceFromPrevious =
            risk *
            0.25;


        let chosen =
            ideal;


        let chosenIndex =
            -1;


        /*
         * İdeal hedefe yakın gerçek
         * karşı seviye ara.
         */

        let bestDistance =
            Infinity;


        candidates.forEach(
            (
                candidate,
                index
            ) => {

                if (
                    used.has(index)
                ) {

                    return;
                }


                const candidateR =
                    candidate.distance /
                    risk;


                if (
                    candidateR <
                    1.50
                ) {

                    return;
                }


                if (
                    candidateR >
                    multiplier +
                    0.85
                ) {

                    return;
                }


                if (
                    previous &&
                    Math.abs(
                        candidate.safePrice -
                        previous
                    ) <
                    minDistanceFromPrevious
                ) {

                    return;
                }


                const d =
                    Math.abs(
                        candidateR -
                        multiplier
                    );


                if (
                    d <
                    bestDistance
                ) {

                    bestDistance = d;

                    chosen =
                        candidate.safePrice;

                    chosenIndex =
                        index;
                }
            }
        );


        /*
         * En yakın karşı seviyenin dışına çıkma.
         */

        if (
            nearestOpposite !== null
        ) {

            chosen =
                isLong

                    ? Math.min(
                        chosen,
                        nearestOpposite
                    )

                    : Math.max(
                        chosen,
                        nearestOpposite
                    );
        }


        /*
         * Hedefler birbirine çok yakınsa
         * anlamsız plan üretme.
         */

        if (
            previous &&
            Math.abs(
                chosen -
                previous
            ) <
            minDistanceFromPrevious
        ) {

            return null;
        }


        /*
         * Entry yönünün tersinde TP olamaz.
         */

        if (
            isLong &&
            chosen <=
            level.price
        ) {

            return null;
        }


        if (
            !isLong &&
            chosen >=
            level.price
        ) {

            return null;
        }


        targets.push(
            chosen
        );


        if (
            chosenIndex >= 0
        ) {

            used.add(
                chosenIndex
            );
        }
    }


    /*
     * Tam olarak 3 hedef lazım.
     */

    if (
        targets.length !== 3
    ) {

        return null;
    }


    const [
        tp1,
        tp2,
        tp3
    ] = targets;


    /*
     * TP sıralaması kesin.
     */

    const validOrder =
        isLong

            ? (
                tp1 <
                tp2 &&
                tp2 <
                tp3
            )

            : (
                tp1 >
                tp2 &&
                tp2 >
                tp3
            );


    if (
        !validOrder
    ) {

        return null;
    }


    /*
     * Gerçek R:R.
     */

    const rr =
        Math.abs(
            tp1 -
            level.price
        ) /
        risk;


    const rr3 =
        Math.abs(
            tp3 -
            level.price
        ) /
        risk;


    if (
        rr <
        CFG.MIN_RR
    ) {

        return null;
    }


    return {

        entryLow:
            price(entryLow),

        entryHigh:
            price(entryHigh),

        entry:
            price(
                (
                    entryLow +
                    entryHigh
                ) / 2
            ),

        stop:
            price(stop),

        tp1:
            price(tp1),

        tp2:
            price(tp2),

        tp3:
            price(tp3),

        /*
         * Artık sabit 1:3 yok.
         */

        riskReward:
            `1:${rr.toFixed(2)}`,

        riskRewardTp3:
            `1:${rr3.toFixed(2)}`
    };
}


/* =========================================================
   LIVE SIGNAL STATE
   ========================================================= */

function updateSignalState(
    signal,
    currentPrice,
    now = Date.now()
) {

    signal.livePrice =
        currentPrice;


    signal.ageSeconds =
        Math.floor(
            (
                now -
                signal.timestamp
            ) /
            1000
        );


    signal.signalAge =
        signal.ageSeconds;


    const inEntry =
        currentPrice >=
            signal.entryLow &&
        currentPrice <=
            signal.entryHigh;


    const isLong =
        signal.direction ===
        'LONG';


    const stopHit =
        isLong

            ? currentPrice <=
              signal.stop

            : currentPrice >=
              signal.stop;


    const tp3Hit =
        isLong

            ? currentPrice >=
              signal.tp3

            : currentPrice <=
              signal.tp3;


    const movedAway =
        isLong

            ? currentPrice >
              signal.entryHigh *
              1.003

            : currentPrice <
              signal.entryLow *
              0.997;


    if (
        stopHit
    ) {

        signal.status =
            'STOP';

    } else if (
        tp3Hit
    ) {

        signal.status =
            'TP3';

    } else if (
        inEntry
    ) {

        signal.status =
            'GİRİŞ ALANI';

    } else if (
        movedAway
    ) {

        signal.status =
            'KAÇTI';

    } else {

        signal.status =
            'GİRİŞ BEKLENİYOR';
    }


    signal.entryReady =
        inEntry;
}


/* =========================================================
   PENDING BREAKOUT ANALYSIS
   ========================================================= */

async function analyzePendingBreakout(
    coin,
    pending,
    candles4H,
    candles2H,
    candles15M,
    candles5M
) {

    const currentPrice =
        STATE.tickers.get(
            coin.symbol
        )?.last;


    if (
        !currentPrice
    ) {

        return null;
    }


    /*
     * Breakout yaşı.
     */

    const age =
        Date.now() -
        pending.breakoutTime;


    if (
        age >
        CFG.RETEST_WINDOW *
        15 *
        60 *
        1000
    ) {

        pending.status =
            'EXPIRED';

        return null;
    }


    /* =========================
       RETEST
       ========================= */

    const retest =
        detectRetestForBreakout(
            candles15M,
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


    pending.status =
        'RETESTED';


    pending.retestTime =
        retest.candle.time;


    /* =========================
       4H TREND
       ========================= */

    const trendBias =
        getTrendBias(
            candles4H
        );


    /*
     * Güçlü 4H trend varsa tersine
     * işlem yok.
     */

    if (
        trendBias.direction !==
        'NEUTRAL' &&

        trendBias.direction !==
        pending.direction
    ) {

        pending.status =
            'REJECTED_TREND';

        return null;
    }


    /* =========================
       BREAKOUT VOLUME
       ========================= */

    if (
        pending.breakoutVolumeRatio <
        CFG.MIN_BREAKOUT_VOLUME_RATIO
    ) {

        pending.status =
            'REJECTED_VOLUME';

        return null;
    }


    /* =========================
       BREAKOUT BODY
       ========================= */

    if (
        pending.breakoutBodyAtr <
        CFG.MIN_BREAKOUT_BODY_ATR
    ) {

        pending.status =
            'REJECTED_BREAKOUT_BODY';

        return null;
    }


    /* =========================
       BREAKOUT DISTANCE
       ========================= */

    if (
        pending.closeDistancePct <
        CFG.MIN_BREAKOUT_CLOSE_DISTANCE
    ) {

        pending.status =
            'REJECTED_BREAKOUT_DISTANCE';

        return null;
    }


    /* =========================
       5M ENTRY
       ========================= */

    const entryConfirmation =
        confirm5mEntry(
            candles5M,
            retest,
            pending.direction,
            pending.level.price
        );


    if (
        !entryConfirmation.confirmed
    ) {

        pending.status =
            'WAITING_5M_CONFIRM';

        return null;
    }


    /* =========================
       ENTRY DISTANCE
       ========================= */

    if (
        percentDistance(
            currentPrice,
            pending.level.price
        ) >
        CFG.ENTRY_MAX_DISTANCE
    ) {

        pending.status =
            'MISSED_ENTRY';

        return null;
    }


    /* =========================
       LEVELS
       ========================= */

    const levels4H =
        getLevels(
            candles4H
        );


    const levels2H =
        getLevels(
            candles2H
        );


    const same4H =
        pending.direction ===
        'LONG'

            ? levels4H.resistances

            : levels4H.supports;


    const same2H =
        pending.direction ===
        'LONG'

            ? levels2H.resistances

            : levels2H.supports;


    const has4H =
        same4H.some(
            x =>
                percentDistance(
                    x.price,
                    pending.level.price
                ) <=
                CFG.CLUSTER_TOLERANCE
        );


    const has2H =
        same2H.some(
            x =>
                percentDistance(
                    x.price,
                    pending.level.price
                ) <=
                CFG.CLUSTER_TOLERANCE
        );


    const confluence =
        has4H &&
        has2H;


    /* =========================
       15M STRUCTURE
       ========================= */

    const structure =
        get15mStructure(
            candles15M
        );


    /* =========================
       RSI
       ========================= */

    const rsi =
        calculateRSI(
            candles15M
        );


    /* =========================
       ATR
       ========================= */

    const atr =
        calculateATR(
            candles15M
        ) ||
        currentPrice *
        0.006;


    /* =========================
       OPPOSITE LEVELS
       ========================= */

    const oppositeLevels =
        pending.direction ===
        'LONG'

            ? [
                ...levels4H.resistances,
                ...levels2H.resistances
            ]

            : [
                ...levels4H.supports,
                ...levels2H.supports
            ];


    /* =========================
       TRADE PLAN
       ========================= */

    const trade =
        buildTradePlan(
            pending.direction,
            pending.level,
            atr,
            oppositeLevels
        );


    if (!trade) {

        pending.status =
            'REJECTED_RR';

        return null;
    }


    /* =========================
       SCORE
       ========================= */

    const scored =
        calculateScore({

            trendBias,

            confluence,

            has4H,

            level:
                pending.level,

            breakoutVolumeRatio:
                pending.breakoutVolumeRatio,

            breakoutBodyAtr:
                pending.breakoutBodyAtr,

            structure,

            direction:
                pending.direction,

            rsi
        });


    /*
     * Score artık son kalite filtresi.
     *
     * Asıl gate'ler yukarıda zorunlu.
     */

    if (
        scored.score <
        72
    ) {

        pending.status =
            'REJECTED_SCORE';

        return null;
    }


    /* =========================
       COOLDOWN
       ========================= */

    const now =
        Date.now();


    const cooldownKey =
        `${coin.symbol}_` +
        `${price(
            pending.level.price
        )}`;


    const stoppedAt =
        STATE.stoppedLevels.get(
            cooldownKey
        );


    if (
        stoppedAt &&
        now - stoppedAt <
        CFG.LEVEL_COOLDOWN_MS
    ) {

        return null;
    }


    pending.status =
        'SIGNAL_CREATED';


    /* =========================
       SIGNAL
       ========================= */

    return {

        id:
            `${coin.symbol}_` +
            `${pending.direction}_` +
            `${Math.round(
                pending.level.price *
                100000000
            )}_` +
            `${now}`,

        coin:
            coin.symbol,

        symbol:
            coin.symbol,

        taraf:
            pending.direction,

        direction:
            pending.direction,

        confidence:
            scored.score,

        score:
            scored.score,

        livePrice:
            currentPrice,

        level:
            price(
                pending.level.price
            ),

        levelType:
            pending.direction ===
            'LONG'

                ? 'KIRILAN DİRENÇ (ARTIK DESTEK)'

                : 'KIRILAN DESTEK (ARTIK DİRENÇ)',

        distance:
            Number(
                percentDistance(
                    currentPrice,
                    pending.level.price
                ).toFixed(2)
            ),

        touches:
            pending.level.touches,

        confluence,

        timeframeLevel:
            confluence
                ? '4H + 2H'
                : (
                    has4H
                        ? '4H'
                        : '2H'
                ),

        trendBias:
            trendBias.direction,

        structure15m:
            structure.direction,

        structureStrength:
            structure.strength,

        volumeRatio:
            Number(
                pending
                    .breakoutVolumeRatio
                    .toFixed(2)
            ),

        breakoutBodyAtr:
            Number(
                pending
                    .breakoutBodyAtr
                    .toFixed(2)
            ),

        breakoutBodyRatio:
            Number(
                pending
                    .breakoutBodyRatio
                    .toFixed(2)
            ),

        volume24h:
            coin.volume,

        rsi:
            Number(
                rsi.toFixed(1)
            ),

        reason:
            scored.reasons.join(
                ' + '
            ),

        reasons:
            scored.reasons,

        breakoutTime:
            pending.breakoutTime,

        retestTime:
            pending.retestTime,

        confirmation5mTime:
            entryConfirmation
                .candle?.time ||
            0,

        entryLow:
            trade.entryLow,

        entryHigh:
            trade.entryHigh,

        giris:
            trade.entry,

        entry:
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

        timestamp:
            now,

        signalAt:
            now,

        ageSeconds:
            0,

        signalAge:
            0,

        status:
            'GİRİŞ BEKLENİYOR',

        entryReady:
            false,

        signalSource:
            '4H/2H KIRILIM + 15M RETEST + 5M ENTRY',

        signalQuality:
            scored.score,

        riskReward:
            trade.riskReward,

        riskRewardTp3:
            trade.riskRewardTp3,

        adx:
            '-',

        cooldownKey,

        tradingView:
            `https://www.tradingview.com/symbols/` +
            `${coin.symbol}/?exchange=BINANCE`
    };
}


/* =========================================================
   COIN ANALYSIS
   ========================================================= */

async function analyzeCoin(
    coin
) {

    const ticker =
        STATE.tickers.get(
            coin.symbol
        );


    if (
        !ticker ||
        !ticker.last
    ) {

        return {

            analyzed:
                false,

            signals:
                []
        };
    }


    const [
        candles4H,
        candles2H,
        candles15M,
        candles5M
    ] =
        await Promise.all(
            [

                getCandles(
                    coin.symbol,
                    '4H'
                ),

                getCandles(
                    coin.symbol,
                    '2H'
                ),

                getCandles(
                    coin.symbol,
                    '15m'
                ),

                getCandles(
                    coin.symbol,
                    '5m'
                )
            ]
        );


    if (
        !candles4H ||
        !candles2H ||
        !candles15M ||
        !candles5M
    ) {

        return {

            analyzed:
                false,

            signals:
                []
        };
    }


    if (
        candles4H.length <
            55 ||

        candles2H.length <
            55 ||

        candles15M.length <
            30 ||

        candles5M.length <
            12
    ) {

        return {

            analyzed:
                false,

            signals:
                []
        };
    }


    /* =========================
       LEVELS
       ========================= */

    const levels4H =
        getLevels(
            candles4H
        );


    const levels2H =
        getLevels(
            candles2H
        );


    const allLevels = {

        supports: [

            ...levels4H.supports,

            ...levels2H.supports
        ],

        resistances: [

            ...levels4H.resistances,

            ...levels2H.resistances
        ]
    };


    /* =========================
       NEW BREAKOUTS
       ========================= */

    const recentBreakouts =
        detectRecentBreakouts(
            candles15M,
            allLevels
        );


    addPendingBreakouts(
        coin.symbol,
        recentBreakouts
    );


    /* =========================
       PENDING BREAKOUTS
       ========================= */

    const candidates =
        [
            ...STATE
                .pendingBreakouts
                .values()
        ]
            .filter(
                x =>
                    x.symbol ===
                    coin.symbol &&

                    x.status !==
                    'SIGNAL_CREATED'
            );


    const signals = [];


    for (
        const pending of
        candidates
    ) {

        const signal =
            await analyzePendingBreakout(
                coin,
                pending,
                candles4H,
                candles2H,
                candles15M,
                candles5M
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

        analyzed:
            true,

        signals
    };
}


/* =========================================================
   LIVE SIGNAL UPDATE
   ========================================================= */

async function updateLiveSignals() {

    if (
        STATE.signals.size ===
        0
    ) {

        return;
    }


    const tickerMap =
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
            tickerMap.get(
                signal.symbol
            );


        if (
            ticker?.last
        ) {

            updateSignalState(
                signal,
                ticker.last,
                now
            );
        }


        /*
         * STOP olan seviye cooldown'a girer.
         */

        if (
            signal.status ===
            'STOP' &&
            signal.cooldownKey
        ) {

            STATE.stoppedLevels.set(
                signal.cooldownKey,
                now
            );
        }


        /*
         * Sonucu belli olan sinyalleri kaldır.
         */

        if (
            now -
            signal.timestamp >
            CFG.TTL ||

            [
                'STOP',
                'TP3',
                'KAÇTI'
            ].includes(
                signal.status
            )
        ) {

            STATE.signals.delete(
                id
            );
        }
    }


    /*
     * Eski cooldown kayıtlarını temizle.
     */

    for (
        const [
            key,
            ts
        ]
        of STATE.stoppedLevels
    ) {

        if (
            now -
            ts >
            CFG.LEVEL_COOLDOWN_MS
        ) {

            STATE.stoppedLevels.delete(
                key
            );
        }
    }
}


/* =========================================================
   CLEANUP PENDING BREAKOUTS
   ========================================================= */

function cleanupPendingBreakouts() {

    const now =
        Date.now();


    const maxAge =
        CFG.RETEST_WINDOW *
        15 *
        60 *
        1000;


    const terminalStatuses = [

        'INVALIDATED',

        'EXPIRED',

        'REJECTED_TREND',

        'REJECTED_VOLUME',

        'REJECTED_BREAKOUT_BODY',

        'REJECTED_BREAKOUT_DISTANCE',

        'REJECTED_RR',

        'REJECTED_SCORE',

        'MISSED_ENTRY',

        'SIGNAL_CREATED'
    ];


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
            maxAge ||

            terminalStatuses.includes(
                pending.status
            )
        ) {

            STATE.pendingBreakouts.delete(
                key
            );
        }
    }
}


/* =========================================================
   MARKET SENTIMENT
   ========================================================= */

async function calculateMarketSentiment() {

    const sample =
        STATE.universe.slice(
            0,
            30
        );


    let total = 0;

    let weight = 0;

    let positives = 0;

    let counted = 0;


    for (
        const coin of
        sample
    ) {

        const ticker =
            STATE.tickers.get(
                coin.symbol
            );


        if (
            !ticker
        ) {

            continue;
        }


        const w =
            Math.log10(
                Math.max(
                    10,
                    ticker.volume
                )
            );


        total +=
            ticker.change *
            w;


        weight +=
            w;


        counted++;


        if (
            ticker.change > 0
        ) {

            positives++;
        }
    }


    const average =
        weight
            ? total / weight
            : 0;


    const breadth =
        counted
            ? positives /
              counted
            : 0.5;


    STATE.market.avg =
        Number(
            average.toFixed(2)
        );


    STATE.market.breadth =
        Number(
            (
                breadth *
                100
            ).toFixed(0)
        );


    /*
     * Hem ortalama yön hem breadth
     * aynı yöne bakmalı.
     */

    if (
        average >= 0.35 &&
        breadth >= 0.55
    ) {

        STATE.market.label =
            'YÜKSELİŞ';


        STATE.market.reason =
            `Piyasanın %${STATE.market.breadth}'i yeşil, hacimli tarafta LONG ağır basıyor.`;

    } else if (
        average <= -0.35 &&
        breadth <= 0.45
    ) {

        STATE.market.label =
            'DÜŞÜŞ';


        STATE.market.reason =
            `Piyasanın %${100 - STATE.market.breadth}'i kırmızı, hacimli tarafta SHORT ağır basıyor.`;

    } else {

        STATE.market.label =
            'YATAY / KARIŞIK';


        STATE.market.reason =
            `Ortalama değişim ve yön dağılımı net bir tarafı işaret etmiyor (yeşil: %${STATE.market.breadth}).`;
    }
}


/* =========================================================
   RUN SCAN
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
        null;


    try {

        await getTickers(
            true
        );


        await discoverUniverse();


        await calculateMarketSentiment();


        cleanupPendingBreakouts();


        const results =
            await mapLimit(
                STATE.universe,
                CFG.CONCURRENCY,
                analyzeCoin
            );


        const found =
            results
                .flatMap(
                    x =>
                        x?.signals ||
                        []
                )
                .sort(
                    (a, b) =>
                        b.score -
                        a.score
                );


        const used =
            new Set();


        let analyzed = 0;


        for (
            const result of
            results
        ) {

            if (
                result?.analyzed
            ) {

                analyzed++;
            }
        }


        /*
         * Aynı coin için aynı anda
         * birden fazla sinyal gösterme.
         */

        for (
            const signal of
            found
        ) {

            if (
                used.has(
                    signal.symbol
                )
            ) {

                continue;
            }


            const alreadyExists =
                [
                    ...STATE.signals.values()
                ].some(
                    x =>
                        x.symbol ===
                        signal.symbol
                );


            if (
                alreadyExists
            ) {

                continue;
            }


            used.add(
                signal.symbol
            );


            STATE.signals.set(
                signal.id,
                signal
            );


            if (
                STATE.signals.size >=
                CFG.MAX_SIGNALS
            ) {

                break;
            }
        }


        await updateLiveSignals();


        STATE.lastScan =
            Date.now();


        /*
         * ARTIK GERÇEK analiz sayısı.
         */

        STATE.lastAnalyzed =
            analyzed;


        console.log(

            `RADAR tamamlandı | ` +
            `Universe=${STATE.universe.length} | ` +
            `Analiz=${analyzed} | ` +
            `Pending=${STATE.pendingBreakouts.size} | ` +
            `SIGNAL=${STATE.signals.size}`
        );


    } catch (
        error
    ) {

        STATE.lastError =
            error.message;


        console.error(
            'RADAR ERROR:',
            error.message
        );


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

    const now =
        Date.now();


    const {
        cooldownKey,
        ...publicFields
    } = signal;


    return {

        ...publicFields,

        ageSeconds:
            Math.floor(
                (
                    now -
                    signal.timestamp
                ) /
                1000
            ),

        signalAge:
            Math.floor(
                (
                    now -
                    signal.timestamp
                ) /
                1000
            )
    };
}


/* =========================================================
   ROOT
   ========================================================= */

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


/* =========================================================
   STATUS API
   ========================================================= */

app.get(
    '/api/status',
    async (
        req,
        res
    ) => {

        try {

            await updateLiveSignals();


            const signals =
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
                    );


            res.json({

                success:
                    true,

                timestamp:
                    Date.now(),

                lastScan:
                    STATE.lastScan,

                scanning:
                    STATE.scanning,

                error:
                    STATE.lastError,


                config: {

                    minVolumeUSD:
                        CFG.MIN_VOL,

                    min24hRangePct:
                        CFG.MIN_RANGE,

                    maxCoins:
                        CFG.MAX_COINS,

                    maxSignals:
                        CFG.MAX_SIGNALS,

                    scanSeconds:
                        CFG.SCAN_MS /
                        1000,

                    signalTtlMinutes:
                        CFG.TTL /
                        60000,

                    retestWindowMinutes:
                        CFG.RETEST_WINDOW *
                        15,

                    retestTolerancePct:
                        CFG.RETEST_TOLERANCE,

                    minBreakoutVolumeRatio:
                        CFG.MIN_BREAKOUT_VOLUME_RATIO,

                    strategy:
                        '4H/2H Kırılım + 15M Retest + 5M Entry'
                },


                system: {

                    marketSentiment:
                        STATE.market.label,

                    filterCount:
                        STATE.universe.length,

                    marketDetail:
                        STATE.market.reason
                },


                stats: {

                    universe:
                        STATE.universe.length,

                    analyzed:
                        STATE.lastAnalyzed ||
                        0,

                    pendingBreakouts:
                        STATE.pendingBreakouts.size,

                    signals:
                        signals.length
                },


                market: {

                    direction:
                        STATE.market.label,

                    reason:
                        STATE.market.reason,

                    avgChange24h:
                        STATE.market.avg,

                    breadthPct:
                        STATE.market.breadth
                },


                signals
            });


        } catch (
            error
        ) {

            res.status(
                500
            ).json({

                success:
                    false,

                error:
                    error.message
            });
        }
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

            let symbol =
                String(
                    req.query.symbol ||
                    ''
                )
                    .toUpperCase()
                    .replace(
                        /[^A-Z0-9]/g,
                        ''
                    );


            if (
                !symbol
            ) {

                return res
                    .status(400)
                    .json({

                        success:
                            false,

                        error:
                            'Sembol yok.'
                    });
            }


            if (
                !symbol.endsWith(
                    'USDT'
                )
            ) {

                symbol +=
                    'USDT';
            }


            const timeframeMap = {

                '5m':
                    '5m',

                '15m':
                    '15m',

                '1h':
                    '1H',

                '2h':
                    '2H',

                '4h':
                    '4H'
            };


            const requested =
                String(
                    req.query.timeframe ||
                    '15m'
                ).toLowerCase();


            const timeframe =
                timeframeMap[
                    requested
                ] ||
                '15m';


            const chartCandles =
                await getCandles(
                    symbol,
                    timeframe,
                    Math.min(
                        CFG.CHART,
                        200
                    )
                );


            if (
                !chartCandles.length
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


            const tickerMap =
                await getTickers();


            const ticker =
                tickerMap.get(
                    symbol
                );


            const signal =
                [
                    ...STATE.signals.values()
                ]
                    .filter(
                        x =>
                            x.symbol ===
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

                symbol,

                timeframe,

                price:
                    ticker?.last ||
                    chartCandles[
                        chartCandles.length -
                        1
                    ].close,

                candles:
                    chartCandles,

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

            console.error(
                '[/api/chart]',
                error.message
            );


            res.status(
                500
            ).json({

                success:
                    false,

                error:
                    error.message
            });
        }
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

        runScan()
            .catch(
                error =>
                    console.error(
                        error
                    )
            );


        res.json({

            success:
                true,

            message:
                'Tarama başlatıldı.'
        });
    }
);


/* =========================================================
   HEALTH
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
                'Sonny AI Trader BREAKOUT ENGINE v2',

            uptime:
                process.uptime(),

            scanning:
                STATE.scanning,

            lastScan:
                STATE.lastScan,

            universe:
                STATE.universe.length,

            pendingBreakouts:
                STATE.pendingBreakouts.size,

            signals:
                STATE.signals.size
        });
    }
);


/* =========================================================
   SERVER
   ========================================================= */

app.listen(
    PORT,
    '0.0.0.0',
    async () => {

        console.log(
            '================================================='
        );


        console.log(
            '🚀 Sonny AI Trader — BREAKOUT ENGINE v2'
        );


        console.log(
            '📡 Bitget USDT Futures'
        );


        console.log(
            '📊 4H + 2H Kırılım → 15M Retest → 5M Entry'
        );


        console.log(
            `💰 Minimum Hacim: $${CFG.MIN_VOL.toLocaleString()}`
        );


        console.log(
            `📈 Minimum 24H hareket: %${CFG.MIN_RANGE}`
        );


        console.log(
            `🛰️ Maksimum Radar: ${CFG.MAX_COINS} coin`
        );


        console.log(
            `🎯 Retest: ${CFG.RETEST_WINDOW * 15} dakika`
        );


        console.log(
            `🎯 Minimum R:R (TP1): 1:${CFG.MIN_RR}`
        );


        console.log(
            `⏱️ Tarama: ${CFG.SCAN_MS / 1000} saniye`
        );


        console.log(
            `🌐 Port: ${PORT}`
        );


        console.log(
            '🤖 Otomatik emir: KAPALI'
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
            () => {

                runScan()
                    .catch(
                        error =>
                            console.error(
                                'SCAN LOOP:',
                                error.message
                            )
                    );

            },
            CFG.SCAN_MS
        );


        setInterval(
            () => {

                updateLiveSignals()
                    .catch(
                        error =>
                            console.error(
                                'LIVE UPDATE:',
                                error.message
                            )
                    );

            },
            CFG.LIVE_MS
        );
    }
);
