const express = require('express');
const path = require('path');

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PORT || 10000);

const API = 'https://api.bitget.com';

const CFG = {
    MIN_VOL: 5_000_000,

    // Hacimli ama tamamen ölü coinleri de ele.
    MIN_RANGE: 1.5,

    // Bitget'ten uygun coin havuzunda en fazla kaç coin analiz edilecek.
    MAX_COINS: 160,

    // Ekranda en fazla kaç sinyal gösterilecek.
    MAX_SIGNALS: 15,

    // Ana tarama.
    SCAN_MS: 60_000,

    // Aktif sinyallerin canlı fiyat kontrolü.
    LIVE_MS: 10_000,

    // Bir sinyal en fazla 1 saat yaşar.
    TTL: 60 * 60 * 1000,

    // Fiyatın destek/dirence yaklaşma toleransı.
    LEVEL_TOLERANCE: 0.75,

    // Aynı bölge kabul edilen 4H/2H seviye farkı.
    CLUSTER_TOLERANCE: 0.35,

    // Sinyal üretmek için minimum puan.
    MIN_SCORE: 72,

    // Aynı anda kaç coin analiz edilecek.
    CONCURRENCY: 6,

    // Mum sayısı.
    CANDLES: 100,

    // Grafik mum sayısı.
    CHART: 160,

    // ==== KIRILIM + RETEST STRATEJİSİ ====

    // Kırılımdan sonra kaç 15M mum içinde retest aranacak.
    RETEST_WINDOW: 8,

    // Retest sırasında seviyenin ne kadar tutması gerekiyor (%).
    RETEST_TOLERANCE: 0.35,

    // Kırılım mumunun hacim oranı en az bu kadar olmalı (fake-out filtresi).
    MIN_BREAKOUT_VOLUME_RATIO: 1.3,

    // 4H trend filtresi: EMA farkı bu eşiği aşmazsa NEUTRAL sayılır.
    TREND_EMA_FAST: 21,
    TREND_EMA_SLOW: 50,
    TREND_NEUTRAL_BAND: 0.15,

    // Aynı coin + aynı seviye STOP olduktan sonra bekleme süresi (ms).
    LEVEL_COOLDOWN_MS: 4 * 60 * 60 * 1000
};


/* =========================================================
   GLOBAL STATE
   ========================================================= */

const STATE = {

    scanning: false,

    lastScan: 0,

    lastError: null,

    universe: [],

    signals: new Map(),

    tickers: new Map(),

    // symbol_levelPrice -> STOP olduğu zaman damgası (cooldown için).
    stoppedLevels: new Map(),

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


function sleep(ms) {

    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });

}


function price(value) {

    const x = n(value);

    if (!x) {
        return 0;
    }

    if (x < 0.000001) {
        return Number(x.toFixed(10));
    }

    if (x < 0.0001) {
        return Number(x.toFixed(8));
    }

    if (x < 0.01) {
        return Number(x.toFixed(7));
    }

    if (x < 1) {
        return Number(x.toFixed(5));
    }

    if (x < 10) {
        return Number(x.toFixed(4));
    }

    if (x < 100) {
        return Number(x.toFixed(3));
    }

    return Number(x.toFixed(2));
}


function percentDistance(a, b) {

    if (!b) {
        return 999;
    }

    return Math.abs(a - b) / b * 100;

}


function ageText(milliseconds) {

    const seconds =
        Math.max(
            0,
            Math.floor(milliseconds / 1000)
        );

    if (seconds < 60) {
        return `${seconds} sn`;
    }

    if (seconds < 3600) {
        return `${Math.floor(seconds / 60)} dk`;
    }

    return `${Math.floor(seconds / 3600)} sa`;

}


/* =========================================================
   BITGET REQUEST
   ========================================================= */

async function get(url, timeout = 15000) {

    const controller =
        new AbortController();

    const timer =
        setTimeout(
            () => controller.abort(),
            timeout
        );

    try {

        const response =
            await fetch(
                url,
                {
                    signal: controller.signal,
                    headers: {
                        accept: 'application/json'
                    }
                }
            );

        const json =
            await response.json();

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

async function mapLimit(items, limit, worker) {

    const result =
        new Array(items.length);

    let cursor = 0;

    async function runner() {

        while (true) {

            const index =
                cursor++;

            if (index >= items.length) {
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
   ALL TICKERS
   ========================================================= */

async function getTickers(force = false) {

    if (
        !force &&
        tickerCache.map.size &&
        Date.now() - tickerCache.ts < 8000
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
        const row of json.data || []
    ) {

        const symbol =
            String(
                row.symbol || ''
            ).toUpperCase();

        if (!symbol.endsWith('USDT')) {
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

    STATE.tickers = map;

    return map;

}


/* =========================================================
   MARKET DISCOVERY
   ========================================================= */

async function discoverUniverse() {

    const [
        contracts,
        tickerMap
    ] = await Promise.all(
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


        if (!symbol.endsWith('USDT')) {
            continue;
        }


        if (
            status &&
            status !== 'normal' &&
            status !== 'online' &&
            status !== 'listed'
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
         * Minimum hacim.
         */

        if (
            ticker.volume <
            CFG.MIN_VOL
        ) {

            continue;

        }


        /*
         * 24H hareket filtresi.
         *
         * Böylece sadece hacimli değil,
         * gerçekten hareket eden coinleri
         * de radarın içine alıyoruz.
         */

        const range =
            ticker.low > 0
                ? (
                    (ticker.high - ticker.low) /
                    ticker.low
                  ) * 100
                : 0;


        if (
            range <
            CFG.MIN_RANGE
        ) {

            continue;

        }


        result.push(
            {
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
            }
        );

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
        Date.now() - cached.ts < 50000
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

function closedCandles(candles) {

    if (
        !candles ||
        candles.length < 3
    ) {

        return [];

    }

    /*
     * Son mum henüz oluşuyor olabilir.
     * Sinyal hesabında tamamlanmış mumları
     * kullanıyoruz.
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
                type === 'resistance'
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


        if (!valid) {
            continue;
        }


        result.push(
            {
                price:
                    type === 'resistance'
                        ? c[i].high
                        : c[i].low,

                time:
                    c[i].time
            }
        );

    }


    return result;

}


/* =========================================================
   LEVEL CLUSTER
   ========================================================= */

function clusterLevels(points) {

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

            groups.push(
                {
                    prices: [
                        point.price
                    ],

                    times: [
                        point.time
                    ]
                }
            );

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

            groups.push(
                {
                    prices: [
                        point.price
                    ],

                    times: [
                        point.time
                    ]
                }
            );

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

function getLevels(candles) {

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
   EMA / 4H TREND FİLTRESİ
   ========================================================= */

function calculateEMA(candles, period) {

    const c = closedCandles(candles);

    if (c.length < period) {
        return null;
    }

    const k = 2 / (period + 1);

    let ema =
        c.slice(0, period)
            .reduce((sum, x) => sum + x.close, 0) /
        period;

    for (let i = period; i < c.length; i++) {
        ema = c[i].close * k + ema * (1 - k);
    }

    return ema;

}


function getTrendBias(candles4H) {

    const emaFast = calculateEMA(candles4H, CFG.TREND_EMA_FAST);
    const emaSlow = calculateEMA(candles4H, CFG.TREND_EMA_SLOW);

    if (!emaFast || !emaSlow) {

        return {
            direction: 'NEUTRAL',
            diffPct: 0
        };

    }

    const diffPct = (emaFast - emaSlow) / emaSlow * 100;

    if (diffPct > CFG.TREND_NEUTRAL_BAND) {

        return { direction: 'LONG', diffPct };

    }

    if (diffPct < -CFG.TREND_NEUTRAL_BAND) {

        return { direction: 'SHORT', diffPct };

    }

    return { direction: 'NEUTRAL', diffPct };

}


/* =========================================================
   RSI (destekleyici teyit, tek başına giriş sebebi değil)
   ========================================================= */

function calculateRSI(candles, period = 14) {

    const c = closedCandles(candles);

    if (c.length < period + 1) {
        return 50;
    }

    let gains = 0;
    let losses = 0;

    for (let i = c.length - period; i < c.length; i++) {

        const diff = c[i].close - c[i - 1].close;

        if (diff > 0) {
            gains += diff;
        } else {
            losses -= diff;
        }

    }

    if (losses === 0) {
        return 100;
    }

    const rs = (gains / period) / (losses / period);

    return 100 - (100 / (1 + rs));

}


/* =========================================================
   KIRILIM TESPİTİ (4H/2H seviyeler, 15M kapanışla kırılım)
   ========================================================= */

function detectBreakout(candles15M, allLevels) {

    const c = closedCandles(candles15M);

    if (c.length < 5) {
        return null;
    }

    const lastClosed = c[c.length - 1];
    const prevClosed = c[c.length - 2];

    /*
     * Yukarı kırılım: bir direnç seviyesi
     * kapanışla yukarı geçildi.
     */

    for (const level of allLevels.resistances) {

        const brokenNow =
            lastClosed.close > level.price &&
            prevClosed.close <= level.price;

        if (brokenNow) {

            return {
                direction: 'LONG',
                level,
                breakoutCandle: lastClosed
            };

        }

    }

    /*
     * Aşağı kırılım: bir destek seviyesi
     * kapanışla aşağı geçildi.
     */

    for (const level of allLevels.supports) {

        const brokenNow =
            lastClosed.close < level.price &&
            prevClosed.close >= level.price;

        if (brokenNow) {

            return {
                direction: 'SHORT',
                level,
                breakoutCandle: lastClosed
            };

        }

    }

    return null;

}


/* =========================================================
   RETEST TESPİTİ
   ========================================================= */

function detectRetest(candles15M, brokenLevel, direction) {

    const c = closedCandles(candles15M);

    const recent = c.slice(-CFG.RETEST_WINDOW);

    for (const candle of recent) {

        const nearLevel =
            percentDistance(candle.close, brokenLevel.price) <=
            CFG.RETEST_TOLERANCE;

        if (!nearLevel) {
            continue;
        }

        /*
         * Kırılan seviye rolünü değiştirdi mi
         * (eski direnç artık destek, eski destek
         * artık direnç) kontrol ediyoruz.
         */

        const holds =
            direction === 'LONG'
                ? candle.low >= brokenLevel.price * (1 - CFG.RETEST_TOLERANCE / 100)
                : candle.high <= brokenLevel.price * (1 + CFG.RETEST_TOLERANCE / 100);

        if (holds) {

            return {
                retested: true,
                candle
            };

        }

    }

    return { retested: false };

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
        c.length < 20
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


    if (momentumUp) {

        return {
            direction:
                'LONG',

            strength:
                10,

            reason:
                '15M momentum yukarı'
        };

    }


    if (momentumDown) {

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


    return (
        recent.reduce(
            (a, b) =>
                a + b,
            0
        ) /
        recent.length
    );

}


/* =========================================================
   15M VOLUME RATIO
   ========================================================= */

function calculateVolumeRatio(
    candles
) {

    const c =
        closedCandles(
            candles
        );


    if (
        c.length < 22
    ) {

        return 1;

    }


    const current =
        c[c.length - 1]
            .turnover ||
        c[c.length - 1]
            .volume;


    const average =
        c
            .slice(
                -21,
                -1
            )
            .reduce(
                (sum, candle) =>
                    sum +
                    (
                        candle.turnover ||
                        candle.volume
                    ),
                0
            ) /
        20;


    if (
        average <= 0
    ) {

        return 1;

    }


    return current /
        average;

}


/* =========================================================
   SCORE (Kırılım + Retest stratejisi için yeniden kuruldu)
   ========================================================= */

function calculateScore(
    data
) {

    /*
     * 4H trend filtresi ZORUNLU.
     * Trend yönüyle ters bir kırılıma
     * hiç girmiyoruz — bu en büyük
     * "terse düşme" sebebiydi.
     */

    if (
        data.trendBias.direction !== 'NEUTRAL' &&
        data.trendBias.direction !== data.direction
    ) {

        return {
            score: 0,
            reasons: ['4H trend ters yönde, ele']
        };

    }


    let score = 30;

    const reasons = [];


    if (data.trendBias.direction === data.direction) {

        score += 15;

        reasons.push('4H trend yönü uyumlu');

    } else {

        reasons.push('4H trend nötr');

    }


    if (data.confluence) {

        score += 15;

        reasons.push('4H + 2H aynı bölgeden kırılım');

    } else {

        score += 8;

        reasons.push('tek zaman diliminden kırılım');

    }


    if (
        data.level.touches >= 4
    ) {

        score += 10;

        reasons.push(
            `kırılan seviye ${data.level.touches} kez test edilmiş`
        );

    } else if (
        data.level.touches >= 2
    ) {

        score += 6;

        reasons.push(
            `kırılan seviye ${data.level.touches} kez test edilmiş`
        );

    }


    /*
     * Kırılım mumunun hacmi — fake-out filtresi.
     * Düşük hacimli kırılım güvenilmez.
     */

    if (
        data.breakoutVolumeRatio >=
        CFG.MIN_BREAKOUT_VOLUME_RATIO * 1.4
    ) {

        score += 15;

        reasons.push('kırılım hacmi çok güçlü');

    } else if (
        data.breakoutVolumeRatio >=
        CFG.MIN_BREAKOUT_VOLUME_RATIO
    ) {

        score += 8;

        reasons.push('kırılım hacmi yeterli');

    } else {

        score -= 20;

        reasons.push('kırılım hacmi zayıf, fake-out riski');

    }


    if (
        data.structure.direction ===
        data.direction
    ) {

        score +=
            data.structure.strength;

        reasons.push(
            '15M yön onayı'
        );

    } else if (
        data.structure.direction ===
        'NEUTRAL'
    ) {

        score -= 5;

        reasons.push(
            '15M nötr'
        );

    } else {

        score -= 15;

        reasons.push(
            '15M ters yönde'
        );

    }


    if (
        data.direction === 'LONG'
            ? data.rsi <= 60
            : data.rsi >= 40
    ) {

        score += 5;

        reasons.push('RSI aşırı uzamamış');

    } else {

        score -= 5;

        reasons.push('RSI aşırı bölgede, tükenme riski');

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
   TRADE PLAN (Kırılım + Retest için: stop kırılan
   seviyenin eski tarafında, hedefler bir sonraki
   karşı seviyeye kadar mantıklı sıralanır)
   ========================================================= */

function buildTradePlan(
    direction,
    level,
    atr,
    opposite
) {

    const zone =
        Math.max(
            atr * 0.12,
            level.price * 0.0008
        );


    const risk =
        Math.max(
            atr * 0.9,
            level.price * 0.004
        );


    const isLong =
        direction === 'LONG';


    const entryLow =
        level.price - zone;

    const entryHigh =
        level.price + zone;

    const stop =
        isLong
            ? level.price - risk
            : level.price + risk;


    let tp1 =
        isLong
            ? level.price + risk
            : level.price - risk;

    let tp2 =
        isLong
            ? level.price + risk * 2
            : level.price - risk * 2;

    let tp3 =
        isLong
            ? level.price + risk * 3
            : level.price - risk * 3;


    /*
     * Karşı taraftaki ilk güçlü seviye bir tavan/taban
     * oluşturuyorsa TP1/TP2/TP3'ün ÜÇÜNÜ de o tavana göre
     * sıkıştırıyoruz. Önceki sürümde sadece TP3 sıkıştırılıp
     * TP1/TP2 kontrol edilmediği için sıralama bozuluyordu.
     */

    if (opposite) {

        const cap =
            isLong
                ? opposite.price * 0.995
                : opposite.price * 1.005;

        if (isLong) {

            tp1 = Math.min(tp1, cap);
            tp2 = Math.min(tp2, cap);
            tp3 = Math.min(tp3, cap);

        } else {

            tp1 = Math.max(tp1, cap);
            tp2 = Math.max(tp2, cap);
            tp3 = Math.max(tp3, cap);

        }

    }


    /*
     * Sıralama garantisi. Sıkıştırma yüzünden
     * TP'ler çakıştıysa (karşı seviye çok yakınsa)
     * risk/ödül anlamsızlaşmıştır — sinyali iptal et.
     */

    const validOrder =
        isLong
            ? tp1 < tp2 && tp2 < tp3
            : tp1 > tp2 && tp2 > tp3;

    if (!validOrder) {

        return null;

    }


    /*
     * Minimum risk/ödül kontrolü — TP1 bile
     * riske değecek kadar uzak değilse (ör.
     * karşı seviye çok yakınsa) sinyali ele.
     */

    const rewardToTp1 =
        Math.abs(tp1 - level.price);

    if (rewardToTp1 < risk * 0.8) {

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
            price(tp3)

    };

}


/* =========================================================
   SIGNAL STATE
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
            ) / 1000
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


    if (stopHit) {

        signal.status =
            'STOP';

    } else if (tp3Hit) {

        signal.status =
            'TP3';

    } else if (inEntry) {

        signal.status =
            'GİRİŞ ALANI';

    } else if (movedAway) {

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
   COIN ANALYSIS (Kırılım + Retest stratejisi)
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

        return null;

    }


    const [
        candles4H,
        candles2H,
        candles15M
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
                )
            ]
        );


    if (
        !candles4H ||
        !candles2H ||
        !candles15M
    ) {

        return null;

    }


    if (
        candles4H.length < 55 ||
        candles2H.length < 55 ||
        candles15M.length < 30
    ) {

        return null;

    }


    const currentPrice =
        ticker.last;


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


    /*
     * 1) KIRILIM var mı? (4H/2H seviye,
     *    15M kapanışla geçildi mi)
     */

    const breakout =
        detectBreakout(
            candles15M,
            allLevels
        );


    if (!breakout) {

        return null;

    }


    const direction =
        breakout.direction;

    const level =
        breakout.level;


    /*
     * Cooldown: bu coin + bu seviye
     * yakın zamanda STOP olduysa tekrar
     * girme (aynı fake bölgede art arda
     * stop yememek için).
     */

    const cooldownKey =
        `${coin.symbol}_${price(level.price)}`;

    const stoppedAt =
        STATE.stoppedLevels.get(
            cooldownKey
        );

    if (
        stoppedAt &&
        Date.now() - stoppedAt <
        CFG.LEVEL_COOLDOWN_MS
    ) {

        return null;

    }


    /*
     * 2) RETEST oldu mu? Ham kırılımda
     *    girmiyoruz, seviyeye geri dönüp
     *    tuttuğunu görmek istiyoruz.
     */

    const retest =
        detectRetest(
            candles15M,
            level,
            direction
        );


    if (!retest.retested) {

        return null;

    }


    const levelType =
        direction === 'LONG'
            ? 'KIRILAN DİRENÇ (ARTIK DESTEK)'
            : 'KIRILAN DESTEK (ARTIK DİRENÇ)';

    const distance =
        percentDistance(
            currentPrice,
            level.price
        );


    /*
     * 3) 4H trend filtresi — ters trendde
     *    kırılıma güvenme.
     */

    const trendBias =
        getTrendBias(
            candles4H
        );


    /*
     * 4H ve 2H aynı bölgeden mi kırıldı?
     */

    const sameSideLevels =
        direction === 'LONG'
            ? [
                ...levels4H.resistances,
                ...levels2H.resistances
            ]
            : [
                ...levels4H.supports,
                ...levels2H.supports
            ];


    const has4H =
        direction === 'LONG'
            ? levels4H.resistances.some(
                x =>
                    percentDistance(x.price, level.price) <=
                    CFG.CLUSTER_TOLERANCE
            )
            : levels4H.supports.some(
                x =>
                    percentDistance(x.price, level.price) <=
                    CFG.CLUSTER_TOLERANCE
            );


    const has2H =
        direction === 'LONG'
            ? levels2H.resistances.some(
                x =>
                    percentDistance(x.price, level.price) <=
                    CFG.CLUSTER_TOLERANCE
            )
            : levels2H.supports.some(
                x =>
                    percentDistance(x.price, level.price) <=
                    CFG.CLUSTER_TOLERANCE
            );


    const confluence =
        has4H && has2H;


    const structure =
        get15mStructure(
            candles15M
        );


    const volumeRatio =
        calculateVolumeRatio(
            candles15M
        );


    const rsi =
        calculateRSI(
            candles15M
        );


    const scored =
        calculateScore(
            {
                trendBias,
                confluence,
                level,
                distance,
                structure,
                direction,
                breakoutVolumeRatio: volumeRatio,
                rsi
            }
        );


    if (
        scored.score <
        CFG.MIN_SCORE
    ) {

        return null;

    }


    /*
     * Karşıdaki ilk güçlü seviye
     * (TP tavanı / risk-ödül sınırı için).
     */

    let opposite = null;


    if (
        direction === 'LONG'
    ) {

        opposite =
            [
                ...levels4H.resistances,
                ...levels2H.resistances
            ]
                .filter(
                    x =>
                        x.price >
                        level.price * 1.001
                )
                .sort(
                    (a, b) =>
                        a.price -
                        b.price
                )[0];

    } else {

        opposite =
            [
                ...levels4H.supports,
                ...levels2H.supports
            ]
                .filter(
                    x =>
                        x.price <
                        level.price * 0.999
                )
                .sort(
                    (a, b) =>
                        b.price -
                        a.price
                )[0];

    }


    const currentATR =
        calculateATR(
            candles15M
        ) ||
        currentPrice * 0.006;


    const trade =
        buildTradePlan(
            direction,
            level,
            currentATR,
            opposite
        );


    if (!trade) {

        return null;

    }


    const now =
        Date.now();


    const signal = {

        id:
            `${coin.symbol}_` +
            `${direction}_` +
            `${Math.round(
                level.price * 100000000
            )}_` +
            `${now}`,

        coin:
            coin.symbol,

        symbol:
            coin.symbol,

        taraf:
            direction,

        direction:
            direction,

        confidence:
            scored.score,

        score:
            scored.score,

        livePrice:
            currentPrice,

        level:
            price(level.price),

        levelType:
            levelType,

        distance:
            Number(
                distance.toFixed(2)
            ),

        touches:
            level.touches,

        confluence:
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
                volumeRatio.toFixed(2)
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
            'KIRILIM + RETEST (4H/2H) + 15M + Trend',

        signalQuality:
            scored.score,

        riskReward:
            '1:3',

        adx:
            '-',

        cooldownKey,

        tradingView:
            `https://www.tradingview.com/symbols/` +
            `${coin.symbol}/?exchange=BINANCE`

    };


    updateSignalState(
        signal,
        currentPrice,
        now
    );


    return signal;

}


/* =========================================================
   LIVE SIGNAL UPDATE
   ========================================================= */

async function updateLiveSignals() {

    if (
        STATE.signals.size === 0
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
            ticker &&
            ticker.last
        ) {

            updateSignalState(
                signal,
                ticker.last,
                now
            );

        }


        /*
         * STOP olduysa cooldown listesine yaz
         * ki aynı seviyede hemen yeni sinyal
         * üretilmesin.
         */

        if (
            signal.status === 'STOP' &&
            signal.cooldownKey
        ) {

            STATE.stoppedLevels.set(
                signal.cooldownKey,
                now
            );

        }


        /*
         * Sinyal 1 saati geçtiyse
         * veya işlem sonucu belli olduysa
         * ekrandan kaldır.
         */

        if (
            now -
            signal.timestamp >
            CFG.TTL
        ) {

            STATE.signals.delete(
                id
            );

            continue;

        }


        if (
            signal.status ===
                'STOP' ||

            signal.status ===
                'TP3' ||

            signal.status ===
                'KAÇTI'
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
        const [key, ts] of STATE.stoppedLevels
    ) {

        if (
            now - ts >
            CFG.LEVEL_COOLDOWN_MS
        ) {

            STATE.stoppedLevels.delete(key);

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
        const coin
        of sample
    ) {

        const ticker =
            STATE.tickers.get(
                coin.symbol
            );


        if (!ticker) {
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


        weight += w;

        counted++;

        if (ticker.change > 0) {
            positives++;
        }

    }


    const average =
        weight
            ? total / weight
            : 0;

    const breadth =
        counted
            ? positives / counted
            : 0.5;


    STATE.market.avg =
        Number(
            average.toFixed(2)
        );

    STATE.market.breadth =
        Number(
            (breadth * 100).toFixed(0)
        );


    /*
     * Eski eşik (±0.75) sadece hacim ağırlıklı
     * ortalamaya bakıyordu; en yüksek hacimli
     * coinler (majörler) günlük az oynadığı için
     * eşik neredeyse hiç tetiklenmiyordu.
     * Şimdi ortalama değişim + yön dağılımı
     * (breadth) birlikte aynı yöne işaret
     * etmeden etiket değişmiyor.
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

    STATE.lastError =
        null;


    try {

        await getTickers(
            true
        );


        await discoverUniverse();


        await calculateMarketSentiment();


        console.log(
            `RADAR başladı | ` +
            `Universe=${STATE.universe.length} | ` +
            `MinHacim=$${CFG.MIN_VOL.toLocaleString()}`
        );


        const results =
            await mapLimit(
                STATE.universe,
                CFG.CONCURRENCY,
                coin =>
                    analyzeCoin(
                        coin
                    )
            );


        const found =
            results
                .filter(Boolean)
                .sort(
                    (a, b) =>
                        b.score -
                        a.score
                );


        /*
         * Aynı coinden birden fazla
         * sinyal oluşturma.
         */

        const used =
            new Set();


        for (
            const signal
            of found
        ) {

            if (
                used.has(
                    signal.symbol
                )
            ) {

                continue;

            }


            /*
             * Aynı coin için zaten aktif
             * sinyal varsa yenisini üretme.
             */

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


        console.log(
            `RADAR tamamlandı | ` +
            `Universe=${STATE.universe.length} | ` +
            `Analiz=${results.filter(Boolean).length} | ` +
            `SIGNAL=${STATE.signals.size}`
        );


    } catch (error) {

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
                ) / 1000
            ),

        signalAge:
            Math.floor(
                (
                    now -
                    signal.timestamp
                ) / 1000
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
    async (req, res) => {

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


            res.json(
                {

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

                    config:
                        {

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

                            strategy:
                                'Kırılım + Retest (4H/2H seviye, 15M teyit)'

                        },

                    system:
                        {

                            marketSentiment:
                                STATE.market.label,

                            filterCount:
                                STATE.universe.length,

                            marketDetail:
                                STATE.market.reason

                        },

                    stats:
                        {

                            universe:
                                STATE.universe.length,

                            analyzed:
                                STATE.universe.length,

                            signals:
                                signals.length

                        },

                    market:
                        {

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

                }
            );


        } catch (error) {

            res
                .status(500)
                .json(
                    {
                        success:
                            false,

                        error:
                            error.message
                    }
                );

        }

    }
);


/* =========================================================
   CHART API
   ========================================================= */

app.get(
    '/api/chart',
    async (req, res) => {

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


            if (!symbol) {

                return res
                    .status(400)
                    .json(
                        {
                            success:
                                false,

                            error:
                                'Sembol yok.'
                        }
                    );

            }


            if (
                !symbol.endsWith(
                    'USDT'
                )
            ) {

                symbol +=
                    'USDT';

            }


            const timeframeMap =
                {

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
                    .json(
                        {
                            success:
                                false,

                            error:
                                'Grafik verisi yok.'
                        }
                    );

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


            res.json(
                {

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

                }
            );


        } catch (error) {

            console.error(
                '[/api/chart]',
                error.message
            );


            res
                .status(500)
                .json(
                    {
                        success:
                            false,

                        error:
                            error.message
                    }
                );

        }

    }
);


/* =========================================================
   MANUAL SCAN
   ========================================================= */

app.get(
    '/api/scan',
    (req, res) => {

        runScan()
            .catch(
                error =>
                    console.error(
                        error
                    )
            );


        res.json(
            {
                success:
                    true,

                message:
                    'Tarama başlatıldı.'
            }
        );

    }
);


/* =========================================================
   HEALTH
   ========================================================= */

app.get(
    '/health',
    (req, res) => {

        res.json(
            {

                ok:
                    true,

                service:
                    'Sonny AI Trader FINAL',

                uptime:
                    process.uptime(),

                scanning:
                    STATE.scanning,

                lastScan:
                    STATE.lastScan,

                universe:
                    STATE.universe.length,

                signals:
                    STATE.signals.size

            }
        );

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
            '🚀 Sonny AI Trader FINAL'
        );

        console.log(
            '📡 Bitget USDT Futures'
        );

        console.log(
            '📊 4H + 2H Kırılım + Retest'
        );

        console.log(
            '🕐 15M Yapı + 4H Trend Onayı'
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
            `🎯 Minimum Sinyal Skoru: ${CFG.MIN_SCORE}`
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

        } catch (error) {

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
