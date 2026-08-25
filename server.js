'use strict';

/*
===========================================================
SONNY AI SIGNAL SCANNER V6.2
===========================================================

STRATEJİ
4H BREAKOUT
+
2H CONFIRMATION
+
RETEST
+
15M RSI
+
5M RSI
+
VOLUME

ÖNEMLİ
- Preparing görünmez
- Missed görünmez
- Missed aktif listeden direkt çıkar
- Missed performansa girmez
- TP / STOP performansa girer
- Canlı fiyat güncellenir
- Her dakika yeni tarama
- Bitget USDT perpetual universe otomatik keşfedilir
===========================================================
*/

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 10000);

const API = 'https://api.bitget.com';

const PRODUCT_TYPE = 'USDT-FUTURES';

const SCAN_INTERVAL = 60 * 1000;
const PRICE_INTERVAL = 5000;

const MAX_ACTIVE_SIGNALS = 12;
const PERFORMANCE_LIMIT = 50;

/*
-----------------------------------------------------------
STATE
-----------------------------------------------------------
*/

let state = {
    universe: [],
    activeSignals: [],
    history: [],
    market: {
        direction: 'BEKLENİYOR',
        description: 'Piyasa hesaplanıyor...',
        score: 0
    },
    stats: {
        market: 0,
        analyzed: 0,
        active: 0,
        lastScan: null
    },
    scanning: false,
    startedAt: Date.now()
};

let lastPrices = new Map();
let lastScanStarted = 0;

/*
-----------------------------------------------------------
PERSISTENCE
-----------------------------------------------------------
*/

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'sonny-v62-history.json');

function ensureDataDir() {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
    } catch (e) {
        console.log('Data klasörü oluşturulamadı:', e.message);
    }
}

function loadHistory() {
    ensureDataDir();

    try {
        if (!fs.existsSync(DATA_FILE)) return [];

        const raw = fs.readFileSync(DATA_FILE, 'utf8');

        if (!raw.trim()) return [];

        const parsed = JSON.parse(raw);

        if (!Array.isArray(parsed)) return [];

        return parsed.slice(-PERFORMANCE_LIMIT);
    } catch (e) {
        console.log('History okunamadı:', e.message);
        return [];
    }
}

function saveHistory() {
    ensureDataDir();

    try {
        fs.writeFileSync(
            DATA_FILE,
            JSON.stringify(state.history.slice(-PERFORMANCE_LIMIT), null, 2),
            'utf8'
        );
    } catch (e) {
        console.log('History kaydedilemedi:', e.message);
    }
}

state.history = loadHistory();

/*
-----------------------------------------------------------
UTIL
-----------------------------------------------------------
*/

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function round(value, decimals = 6) {
    if (!Number.isFinite(value)) return 0;

    const factor = Math.pow(10, decimals);

    return Math.round(value * factor) / factor;
}

function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function fmtPrice(value) {
    const n = num(value);

    if (!n) return '0';

    if (n >= 1000) return n.toFixed(2);
    if (n >= 100) return n.toFixed(3);
    if (n >= 10) return n.toFixed(4);
    if (n >= 1) return n.toFixed(4);
    if (n >= 0.1) return n.toFixed(5);
    if (n >= 0.01) return n.toFixed(6);
    return n.toFixed(8);
}

function pctDistance(a, b) {
    if (!a || !b) return 999;

    return Math.abs((a - b) / b) * 100;
}

/*
-----------------------------------------------------------
BITGET API
-----------------------------------------------------------
*/

async function bitget(endpoint, params = {}) {
    const url = new URL(API + endpoint);

    for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, String(value));
    }

    const response = await fetch(url, {
        method: 'GET',
        headers: {
            'Accept': 'application/json'
        }
    });

    if (!response.ok) {
        throw new Error(`Bitget HTTP ${response.status}`);
    }

    const json = await response.json();

    if (json.code && json.code !== '00000') {
        throw new Error(
            `Bitget ${json.code}: ${json.msg || 'unknown error'}`
        );
    }

    return json;
}

/*
-----------------------------------------------------------
DISCOVERY
-----------------------------------------------------------
*/

async function discoverUniverse() {

    const result = await bitget(
        '/api/v2/mix/market/contracts',
        {
            productType: PRODUCT_TYPE
        }
    );

    const rows = Array.isArray(result.data)
        ? result.data
        : [];

    const symbols = [];

    for (const row of rows) {

        const symbol = String(
            row.symbol ||
            row.instId ||
            ''
        ).toUpperCase();

        if (!symbol.endsWith('USDT')) continue;

        const status = String(
            row.symbolStatus ||
            row.status ||
            'normal'
        ).toLowerCase();

        if (
            status !== 'normal' &&
            status !== 'online' &&
            status !== 'listed'
        ) {
            continue;
        }

        symbols.push(symbol);
    }

    return [...new Set(symbols)];
}

/*
-----------------------------------------------------------
TICKERS
-----------------------------------------------------------
*/

async function getTickers() {

    const result = await bitget(
        '/api/v2/mix/market/tickers',
        {
            productType: PRODUCT_TYPE
        }
    );

    const rows = Array.isArray(result.data)
        ? result.data
        : [];

    const map = new Map();

    for (const row of rows) {

        const symbol = String(
            row.symbol ||
            row.instId ||
            ''
        ).toUpperCase();

        if (!symbol) continue;

        const price = num(
            row.lastPr ||
            row.last ||
            row.close
        );

        const quoteVolume = num(
            row.quoteVolume ||
            row.usdtVolume ||
            row.quoteVol
        );

        const change24h = num(
            row.change24h ||
            row.changeUtc24h ||
            0
        );

        map.set(symbol, {
            symbol,
            price,
            quoteVolume,
            change24h
        });
    }

    return map;
}

/*
-----------------------------------------------------------
CANDLES
-----------------------------------------------------------
*/

async function getCandles(symbol, granularity, limit = 150) {

    const result = await bitget(
        '/api/v2/mix/market/candles',
        {
            symbol,
            productType: PRODUCT_TYPE,
            granularity,
            limit
        }
    );

    const rows = Array.isArray(result.data)
        ? result.data
        : [];

    return rows
        .map(row => {

            return {
                time: num(row[0]),
                open: num(row[1]),
                high: num(row[2]),
                low: num(row[3]),
                close: num(row[4]),
                volume: num(row[5]),
                quoteVolume: num(row[6])
            };

        })
        .filter(x =>
            x.open &&
            x.high &&
            x.low &&
            x.close
        )
        .reverse();
}

/*
-----------------------------------------------------------
INDICATORS
-----------------------------------------------------------
*/

function calculateRSI(candles, period = 14) {

    if (!candles || candles.length < period + 2) {
        return 50;
    }

    let gain = 0;
    let loss = 0;

    for (
        let i = candles.length - period;
        i < candles.length;
        i++
    ) {

        const prev = candles[i - 1].close;
        const current = candles[i].close;

        const diff = current - prev;

        if (diff > 0) {
            gain += diff;
        } else {
            loss += Math.abs(diff);
        }
    }

    const avgGain = gain / period;
    const avgLoss = loss / period;

    if (avgLoss === 0) return 100;

    const rs = avgGain / avgLoss;

    return 100 - (100 / (1 + rs));
}

function averageVolume(candles, count = 20) {

    if (!candles || candles.length < count) {
        return 0;
    }

    const slice = candles.slice(-count);

    return (
        slice.reduce(
            (sum, candle) => sum + candle.volume,
            0
        ) / slice.length
    );
}

function volumeRatio(candles) {

    if (!candles || candles.length < 22) {
        return 1;
    }

    const current = candles[candles.length - 1].volume;

    const avg = averageVolume(
        candles.slice(0, -1),
        20
    );

    if (!avg) return 1;

    return current / avg;
}

function bollingerWidth(candles, period = 20) {

    if (!candles || candles.length < period) {
        return 0;
    }

    const closes = candles
        .slice(-period)
        .map(x => x.close);

    const mean =
        closes.reduce((a, b) => a + b, 0) /
        closes.length;

    const variance =
        closes.reduce(
            (sum, value) =>
                sum + Math.pow(value - mean, 2),
            0
        ) / closes.length;

    const std = Math.sqrt(variance);

    if (!mean) return 0;

    return ((std * 4) / mean) * 100;
}

/*
-----------------------------------------------------------
SUPPORT / RESISTANCE
-----------------------------------------------------------
*/

function getLevels(candles) {

    if (!candles || candles.length < 30) {
        return null;
    }

    /*
     Son kapanmış 20 mumun yüksek/düşük seviyelerini
     kullanıyoruz.

     Son mum kırılım mumu olarak değerlendirilir.
    */

    const previous = candles.slice(
        Math.max(0, candles.length - 21),
        candles.length - 1
    );

    if (previous.length < 10) return null;

    let resistance = 0;
    let support = Infinity;

    for (const candle of previous) {

        resistance = Math.max(
            resistance,
            candle.high
        );

        support = Math.min(
            support,
            candle.low
        );
    }

    if (!Number.isFinite(support)) {
        support = 0;
    }

    return {
        resistance,
        support
    };
}

/*
-----------------------------------------------------------
BREAKOUT
-----------------------------------------------------------
*/

function detectBreakout(candles) {

    const levels = getLevels(candles);

    if (!levels) {
        return {
            direction: null,
            level: 0,
            strength: 0
        };
    }

    const current =
        candles[candles.length - 1];

    const previous =
        candles[candles.length - 2];

    const close = current.close;

    /*
    LONG
    */

    if (
        close > levels.resistance &&
        previous.close <= levels.resistance
    ) {

        const breakoutSize =
            ((close - levels.resistance) /
                levels.resistance) * 100;

        return {
            direction: 'LONG',
            level: levels.resistance,
            strength: clamp(
                70 + breakoutSize * 10,
                70,
                100
            )
        };
    }

    /*
    SHORT
    */

    if (
        close < levels.support &&
        previous.close >= levels.support
    ) {

        const breakoutSize =
            ((levels.support - close) /
                levels.support) * 100;

        return {
            direction: 'SHORT',
            level: levels.support,
            strength: clamp(
                70 + breakoutSize * 10,
                70,
                100
            )
        };
    }

    /*
    Yeni kırılım yoksa son mumun konumunu
    da kontrol ediyoruz.
    */

    if (close > levels.resistance) {

        return {
            direction: 'LONG',
            level: levels.resistance,
            strength: 65
        };
    }

    if (close < levels.support) {

        return {
            direction: 'SHORT',
            level: levels.support,
            strength: 65
        };
    }

    return {
        direction: null,
        level: 0,
        strength: 0
    };
}

/*
-----------------------------------------------------------
2H CONFIRMATION
-----------------------------------------------------------
*/

function confirmTwoHour(candles, direction) {

    if (!candles || candles.length < 30) {
        return false;
    }

    const levels = getLevels(candles);

    if (!levels) return false;

    const last =
        candles[candles.length - 1];

    if (direction === 'LONG') {
        return last.close > levels.resistance;
    }

    if (direction === 'SHORT') {
        return last.close < levels.support;
    }

    return false;
}

/*
-----------------------------------------------------------
RETEST
-----------------------------------------------------------
*/

function detectRetest(candles, level, direction) {

    if (!candles || candles.length < 5) {
        return false;
    }

    const recent =
        candles.slice(-5);

    const tolerance =
        Math.abs(level) * 0.004;

    for (const candle of recent) {

        if (direction === 'LONG') {

            const touched =
                candle.low <=
                level + tolerance;

            const held =
                candle.close > level;

            if (touched && held) {
                return true;
            }
        }

        if (direction === 'SHORT') {

            const touched =
                candle.high >=
                level - tolerance;

            const held =
                candle.close < level;

            if (touched && held) {
                return true;
            }
        }
    }

    return false;
}

/*
-----------------------------------------------------------
RSI
-----------------------------------------------------------
*/

function rsiAllowsEntry(rsi15, rsi5, direction) {

    if (direction === 'LONG') {

        /*
        Çok aşırı alınmış coinleri kovalamıyoruz.
        */

        return (
            rsi15 >= 48 &&
            rsi15 <= 70 &&
            rsi5 >= 45 &&
            rsi5 <= 75
        );
    }

    if (direction === 'SHORT') {

        return (
            rsi15 >= 30 &&
            rsi15 <= 55 &&
            rsi5 >= 25 &&
            rsi5 <= 58
        );
    }

    return false;
}

/*
-----------------------------------------------------------
FAKE BREAKOUT
-----------------------------------------------------------
*/

function fakeBreakoutRisk(candles, direction, level) {

    if (!candles || candles.length < 3) {
        return true;
    }

    const last =
        candles[candles.length - 1];

    const previous =
        candles[candles.length - 2];

    if (direction === 'LONG') {

        if (
            previous.close > level &&
            last.close < level
        ) {
            return true;
        }
    }

    if (direction === 'SHORT') {

        if (
            previous.close < level &&
            last.close > level
        ) {
            return true;
        }
    }

    return false;
}

/*
-----------------------------------------------------------
MARKET DIRECTION
-----------------------------------------------------------
*/

async function calculateMarketDirection(tickers) {

    try {

        const btc = tickers.get('BTCUSDT');
        const eth = tickers.get('ETHUSDT');

        let score = 0;

        if (btc) {
            score += btc.change24h > 0 ? 1 : -1;
        }

        if (eth) {
            score += eth.change24h > 0 ? 1 : -1;
        }

        const all = [...tickers.values()];

        const positive =
            all.filter(x => x.change24h > 0).length;

        const negative =
            all.filter(x => x.change24h < 0).length;

        if (positive > negative * 1.15) {
            score += 2;
        }

        if (negative > positive * 1.15) {
            score -= 2;
        }

        let direction = 'YATAY';
        let description =
            'Piyasa dengeli görünüyor.';

        if (score >= 2) {

            direction = 'YUKARI';

            description =
                'BTC / ETH ve piyasa genişliği yükseliş ağırlıklı.';
        }

        if (score <= -2) {

            direction = 'AŞAĞI';

            description =
                'BTC / ETH ve piyasa genişliği düşüş ağırlıklı.';
        }

        return {
            direction,
            description,
            score
        };

    } catch (e) {

        return {
            direction: 'BEKLENİYOR',
            description: 'Piyasa hesaplanıyor...',
            score: 0
        };
    }
}

/*
-----------------------------------------------------------
SIGNAL ID
-----------------------------------------------------------
*/

function makeSignalId(
    symbol,
    direction,
    level
) {

    /*
    Aynı coin + aynı yön + aynı breakout
    tekrar tekrar yeni sinyal üretmesin.
    */

    return [
        symbol,
        direction,
        round(level, 8)
    ].join('_');
}

/*
-----------------------------------------------------------
DIRECTION LEVELS
-----------------------------------------------------------
*/

function createTradePlan(
    direction,
    price,
    level
) {

    /*
    Risk mesafesi breakout seviyesine göre
    belirlenir.

    Aşırı uzak stop üretmemek için sınırlandırılır.
    */

    const baseRisk =
        Math.abs(price - level);

    const minimumRisk =
        Math.abs(level) * 0.006;

    const risk =
        Math.max(
            baseRisk,
            minimumRisk
        );

    if (direction === 'LONG') {

        const entryLow =
            Math.min(
                price,
                level + risk * 0.15
            );

        const entryHigh =
            Math.max(
                price,
                level + risk * 0.55
            );

        const entryMid =
            (entryLow + entryHigh) / 2;

        const stop =
            entryLow - risk * 1.25;

        const r =
            entryMid - stop;

        return {
            entryLow,
            entryHigh,
            stop,
            tp1: entryMid + r * 1.4,
            tp2: entryMid + r * 2.0,
            tp3: entryMid + r * 2.8
        };
    }

    const entryLow =
        Math.min(
            price,
            level - risk * 0.55
        );

    const entryHigh =
        Math.max(
            price,
            level - risk * 0.15
        );

    const entryMid =
        (entryLow + entryHigh) / 2;

    const stop =
        entryHigh + risk * 1.25;

    const r =
        stop - entryMid;

    return {
        entryLow,
        entryHigh,
        stop,
        tp1: entryMid - r * 1.4,
        tp2: entryMid - r * 2.0,
        tp3: entryMid - r * 2.8
    };
}

/*
-----------------------------------------------------------
BUILD SIGNAL
-----------------------------------------------------------
*/

async function analyzeCoin(symbol, ticker) {

    try {

        if (!ticker || !ticker.price) {
            return null;
        }

        /*
        4H
        */

        const candles4h =
            await getCandles(
                symbol,
                '4H',
                100
            );

        /*
        2H
        */

        const candles2h =
            await getCandles(
                symbol,
                '2H',
                100
            );

        /*
        15M
        */

        const candles15m =
            await getCandles(
                symbol,
                '15m',
                100
            );

        /*
        5M
        */

        const candles5m =
            await getCandles(
                symbol,
                '5m',
                100
            );

        if (
            candles4h.length < 40 ||
            candles2h.length < 40 ||
            candles15m.length < 30 ||
            candles5m.length < 30
        ) {
            return null;
        }

        const breakout =
            detectBreakout(candles4h);

        if (!breakout.direction) {
            return null;
        }

        const direction =
            breakout.direction;

        /*
        2H confirmation
        */

        if (
            !confirmTwoHour(
                candles2h,
                direction
            )
        ) {
            return null;
        }

        /*
        Retest
        */

        if (
            !detectRetest(
                candles4h,
                breakout.level,
                direction
            )
        ) {
            return null;
        }

        /*
        Fake breakout filter
        */

        if (
            fakeBreakoutRisk(
                candles4h,
                direction,
                breakout.level
            )
        ) {
            return null;
        }

        const rsi15 =
            calculateRSI(
                candles15m
            );

        const rsi5 =
            calculateRSI(
                candles5m
            );

        if (
            !rsiAllowsEntry(
                rsi15,
                rsi5,
                direction
            )
        ) {
            return null;
        }

        const volume =
            volumeRatio(candles15m);

        const bbWidth =
            bollingerWidth(candles15m);

        /*
        Volume aşırı zayıfsa sinyal alma.
        Ancak tamamen sıfırlamıyoruz çünkü bazı
        coinlerde Bitget hacim verisi geç gelebiliyor.
        */

        if (volume < 0.15) {
            return null;
        }

        const price =
            ticker.price;

        /*
        KRİTİK:
        Fiyat breakout seviyesinden çok uzaklaşmışsa
        sinyal üretme.

        Böylece kullanıcı ekranda geç kalmış
        sinyal görmez.
        */

        const distance =
            pctDistance(
                price,
                breakout.level
            );

        if (distance > 1.25) {
            return null;
        }

        const plan =
            createTradePlan(
                direction,
                price,
                breakout.level
            );

        /*
        Giriş bölgesinin dışında ve kaçmış
        durumda ise sinyal üretme.
        */

        const inEntry =
            price >= plan.entryLow &&
            price <= plan.entryHigh;

        if (!inEntry) {
            return null;
        }

        /*
        SCORE
        */

        let score =
            breakout.strength;

        if (volume >= 1.5) {
            score += 8;
        } else if (volume >= 1) {
            score += 5;
        }

        if (bbWidth > 2) {
            score += 4;
        }

        if (
            direction === 'LONG' &&
            rsi15 >= 50 &&
            rsi15 <= 65
        ) {
            score += 5;
        }

        if (
            direction === 'SHORT' &&
            rsi15 >= 35 &&
            rsi15 <= 50
        ) {
            score += 5;
        }

        if (
            direction === 'LONG' &&
            rsi5 >= 45 &&
            rsi5 <= 65
        ) {
            score += 3;
        }

        if (
            direction === 'SHORT' &&
            rsi5 >= 35 &&
            rsi5 <= 55
        ) {
            score += 3;
        }

        score = Math.round(
            clamp(score, 60, 100)
        );

        const signalId =
            makeSignalId(
                symbol,
                direction,
                breakout.level
            );

        return {
            id: signalId,
            symbol,
            direction,
            score,
            price,
            level: breakout.level,
            entryLow: plan.entryLow,
            entryHigh: plan.entryHigh,
            stop: plan.stop,
            tp1: plan.tp1,
            tp2: plan.tp2,
            tp3: plan.tp3,
            rsi15,
            rsi5,
            volume,
            bbWidth,
            change24h: ticker.change24h,
            createdAt: Date.now(),
            status: 'ACTIVE',
            tp1Hit: false,
            tp2Hit: false,
            tp3Hit: false
        };

    } catch (e) {

        return null;
    }
}

/*
-----------------------------------------------------------
ACTIVE SIGNAL MANAGEMENT
-----------------------------------------------------------
*/

function isSameSetup(signal) {

    return state.activeSignals.some(
        existing =>
            existing.id === signal.id
    );
}

function addSignal(signal) {

    if (!signal) return false;

    if (isSameSetup(signal)) {
        return false;
    }

    /*
    Geçmişte aynı setup tamamlandıysa tekrar
    üretmemek için kontrol.
    */

    const alreadyCompleted =
        state.history.some(
            x => x.id === signal.id
        );

    if (alreadyCompleted) {
        return false;
    }

    /*
    Aynı coin için aynı anda iki farklı sinyal
    tutmuyoruz.
    */

    const sameCoin =
        state.activeSignals.find(
            x => x.symbol === signal.symbol
        );

    if (sameCoin) {

        /*
        Daha güçlü yeni setup varsa eskiyi
        kaldırıp yenisini koy.
        */

        if (
            signal.score >
            sameCoin.score + 5
        ) {

            state.activeSignals =
                state.activeSignals.filter(
                    x =>
                        x.symbol !==
                        signal.symbol
                );
        } else {
            return false;
        }
    }

    if (
        state.activeSignals.length >=
        MAX_ACTIVE_SIGNALS
    ) {

        state.activeSignals.sort(
            (a, b) =>
                b.score - a.score
        );

        const weakest =
            state.activeSignals[
                state.activeSignals.length - 1
            ];

        if (
            weakest &&
            signal.score >
            weakest.score
        ) {

            state.activeSignals.pop();

        } else {

            return false;
        }
    }

    state.activeSignals.push(signal);

    state.activeSignals.sort(
        (a, b) =>
            b.score - a.score
    );

    return true;
}

/*
-----------------------------------------------------------
MISSED SIGNAL
-----------------------------------------------------------
*/

function checkMissedSignal(signal, price) {

    if (!signal) return false;

    /*
    LONG:
    Giriş bölgesinin üstüne çıkarsa fırsat kaçtı.

    SHORT:
    Giriş bölgesinin altına inerse fırsat kaçtı.
    */

    if (signal.direction === 'LONG') {

        if (price > signal.entryHigh) {
            return true;
        }
    }

    if (signal.direction === 'SHORT') {

        if (price < signal.entryLow) {
            return true;
        }
    }

    return false;
}

function removeMissedSignals() {

    const remaining = [];

    for (const signal of state.activeSignals) {

        const price =
            lastPrices.get(
                signal.symbol
            );

        if (!price) {
            remaining.push(signal);
            continue;
        }

        if (
            checkMissedSignal(
                signal,
                price
            )
        ) {

            /*
            ÖNEMLİ:
            MISSED history'ye yazılmıyor.

            Kullanıcı ekranda da görmüyor.
            */

            console.log(
                `[MISSED] ${signal.symbol} ${signal.direction} giriş fırsatı kaçtı.`
            );

            continue;
        }

        remaining.push(signal);
    }

    state.activeSignals =
        remaining;
}

/*
-----------------------------------------------------------
PERFORMANCE
-----------------------------------------------------------
*/

function calculateR(signal, exitPrice) {

    const entry =
        (signal.entryLow +
            signal.entryHigh) / 2;

    let risk;

    if (signal.direction === 'LONG') {

        risk =
            entry - signal.stop;

        if (!risk) return 0;

        return (
            (exitPrice - entry) /
            risk
        );
    }

    risk =
        signal.stop - entry;

    if (!risk) return 0;

    return (
        (entry - exitPrice) /
        risk
    );
}

function resolveSignal(
    signal,
    result,
    exitPrice
) {

    const completed = {
        ...signal,
        status: result,
        exitPrice,
        resolvedAt: Date.now(),
        r: round(
            calculateR(
                signal,
                exitPrice
            ),
            3
        )
    };

    /*
    Aynı sonucu iki kere kaydetme.
    */

    if (
        state.history.some(
            x =>
                x.id === signal.id &&
                x.status === result
        )
    ) {
        return;
    }

    state.history.push(completed);

    state.history =
        state.history.slice(
            -PERFORMANCE_LIMIT
        );

    saveHistory();

    console.log(
        `[RESULT] ${signal.symbol} ${signal.direction} => ${result} | R=${completed.r}`
    );
}

/*
-----------------------------------------------------------
CHECK TP / STOP
-----------------------------------------------------------
*/

function checkSignalResults() {

    const remaining = [];

    for (const signal of state.activeSignals) {

        const price =
            lastPrices.get(
                signal.symbol
            );

        if (!price) {
            remaining.push(signal);
            continue;
        }

        /*
        ÖNCE STOP
        */

        if (signal.direction === 'LONG') {

            if (price <= signal.stop) {

                resolveSignal(
                    signal,
                    'STOP',
                    price
                );

                continue;
            }

            if (price >= signal.tp3) {

                resolveSignal(
                    signal,
                    'TP3',
                    price
                );

                continue;
            }

            if (price >= signal.tp2) {

                /*
                TP2'ye ulaşmış ama TP3'e
                henüz ulaşmamış sinyal aktif
                kalabilir.

                Performansa TP2 olarak kaydediyoruz.
                */

                resolveSignal(
                    signal,
                    'TP2',
                    price
                );

                continue;
            }

            if (price >= signal.tp1) {

                resolveSignal(
                    signal,
                    'TP1',
                    price
                );

                continue;
            }
        }

        if (signal.direction === 'SHORT') {

            if (price >= signal.stop) {

                resolveSignal(
                    signal,
                    'STOP',
                    price
                );

                continue;
            }

            if (price <= signal.tp3) {

                resolveSignal(
                    signal,
                    'TP3',
                    price
                );

                continue;
            }

            if (price <= signal.tp2) {

                resolveSignal(
                    signal,
                    'TP2',
                    price
                );

                continue;
            }

            if (price <= signal.tp1) {

                resolveSignal(
                    signal,
                    'TP1',
                    price
                );

                continue;
            }
        }

        remaining.push(signal);
    }

    state.activeSignals =
        remaining;
}

/*
-----------------------------------------------------------
PERFORMANCE STATS
-----------------------------------------------------------
*/

function getPerformance() {

    const completed =
        state.history
            .filter(
                x =>
                    x.status !== 'MISSED'
            )
            .slice(
                -PERFORMANCE_LIMIT
            );

    const total =
        completed.length;

    if (!total) {

        return {
            total: 0,
            wins: 0,
            losses: 0,
            tp1Rate: 0,
            stopRate: 0,
            totalR: 0,
            averageR: 0
        };
    }

    const wins =
        completed.filter(
            x =>
                x.status === 'TP1' ||
                x.status === 'TP2' ||
                x.status === 'TP3'
        ).length;

    const losses =
        completed.filter(
            x =>
                x.status === 'STOP'
        ).length;

    const totalR =
        completed.reduce(
            (sum, x) =>
                sum + num(x.r),
            0
        );

    return {
        total,
        wins,
        losses,
        tp1Rate: round(
            (wins / total) * 100,
            1
        ),
        stopRate: round(
            (losses / total) * 100,
            1
        ),
        totalR: round(
            totalR,
            2
        ),
        averageR: round(
            totalR / total,
            2
        )
    };
}

/*
-----------------------------------------------------------
PRICE REFRESH
-----------------------------------------------------------
*/

async function refreshPrices() {

    try {

        const tickers =
            await getTickers();

        for (const [
            symbol,
            ticker
        ] of tickers.entries()) {

            if (ticker.price) {

                lastPrices.set(
                    symbol,
                    ticker.price
                );
            }
        }

        /*
        Aktif sinyallerin canlı fiyatını
        güncelle.
        */

        for (
            const signal of
            state.activeSignals
        ) {

            const price =
                lastPrices.get(
                    signal.symbol
                );

            if (price) {
                signal.price = price;
            }
        }

        checkSignalResults();

        removeMissedSignals();

    } catch (e) {

        console.log(
            'Fiyat güncelleme hatası:',
            e.message
        );
    }
}

/*
-----------------------------------------------------------
SCAN
-----------------------------------------------------------
*/

async function runScan() {

    if (state.scanning) {
        return;
    }

    state.scanning = true;
    lastScanStarted = Date.now();

    try {

        console.log(
            'Bitget piyasası yeniden taranıyor...'
        );

        const [
            universe,
            tickers
        ] = await Promise.all([
            discoverUniverse(),
            getTickers()
        ]);

        state.universe =
            universe;

        state.market =
            await calculateMarketDirection(
                tickers
            );

        /*
        En likit coinleri önce analiz ediyoruz.

        Fakat universe limiti yok.
        Böylece Bitget'te bulunan tüm
        uygun perpetual'lar keşfediliyor.

        Fast radar 250 coin.
        Daha sonra sinyal oluşabilecek
        coinler derin analizden geçiriliyor.
        */

        const ranked =
            universe
                .map(symbol => {

                    const ticker =
                        tickers.get(
                            symbol
                        );

                    if (!ticker) {
                        return null;
                    }

                    return {
                        symbol,
                        ticker,
                        liquidity:
                            ticker.quoteVolume || 0
                    };

                })
                .filter(Boolean)
                .sort(
                    (a, b) =>
                        b.liquidity -
                        a.liquidity
                );

        const fastRadar =
            ranked.slice(
                0,
                Math.min(
                    250,
                    ranked.length
                )
            );

        /*
        Çok sayıda API isteğini aynı anda
        göndermemek için küçük batch'ler.
        */

        const discoveredSignals = [];

        const BATCH = 8;

        for (
            let i = 0;
            i < fastRadar.length;
            i += BATCH
        ) {

            const batch =
                fastRadar.slice(
                    i,
                    i + BATCH
                );

            const results =
                await Promise.all(
                    batch.map(
                        item =>
                            analyzeCoin(
                                item.symbol,
                                item.ticker
                            )
                    )
                );

            for (const signal of results) {

                if (signal) {
                    discoveredSignals.push(
                        signal
                    );
                }
            }

            /*
            Bitget'i gereksiz zorlamamak
            için küçük bekleme.
            */

            if (
                i + BATCH <
                fastRadar.length
            ) {
                await sleep(120);
            }
        }

        /*
        Yeni sinyalleri ekle.
        */

        for (
            const signal of
            discoveredSignals
        ) {

            addSignal(signal);
        }

        /*
        Aktif sinyallerin fiyatını tekrar
        güncelle.
        */

        for (
            const signal of
            state.activeSignals
        ) {

            const ticker =
                tickers.get(
                    signal.symbol
                );

            if (
                ticker &&
                ticker.price
            ) {

                signal.price =
                    ticker.price;

                lastPrices.set(
                    signal.symbol,
                    ticker.price
                );
            }
        }

        checkSignalResults();

        removeMissedSignals();

        state.stats = {
            market:
                universe.length,

            analyzed:
                fastRadar.length,

            active:
                state.activeSignals.length,

            lastScan:
                Date.now()
        };

        console.log(
            `RADAR tamamlandı | Universe=${universe.length} | Analiz=${fastRadar.length} | SIGNAL=${state.activeSignals.length} | PERFORMANCE=${state.history.length}`
        );

    } catch (e) {

        console.log(
            'RADAR HATASI:',
            e.message
        );

    } finally {

        state.scanning = false;
    }
}

/*
-----------------------------------------------------------
HTML
-----------------------------------------------------------
*/

function escapeHtml(value) {

    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function tvUrl(symbol) {

    return (
        'https://www.tradingview.com/symbols/' +
        encodeURIComponent(symbol) +
        '/?exchange=BITGET'
    );
}

function signalCard(signal) {

    const price =
        lastPrices.get(
            signal.symbol
        ) ||
        signal.price;

    const entryText =
        `${fmtPrice(signal.entryLow)} - ${fmtPrice(signal.entryHigh)}`;

    return `
<div class="signal-card ${signal.direction.toLowerCase()}">

    <div class="signal-top">

        <div>
            <div class="coin">
                ${escapeHtml(signal.symbol)}
            </div>

            <div class="strategy">
                4H KIRILIM · 2H ONAY · RETEST · RSI
            </div>
        </div>

        <div class="direction">
            ${signal.direction}
        </div>

    </div>

    <div class="score">
        GÜÇ ${signal.score}/100
    </div>

    <div class="live">
        CANLI FİYAT
        <strong>${fmtPrice(price)}</strong>
    </div>

    <div class="grid">

        <div>
            <span>GİRİŞ</span>
            <strong>${entryText}</strong>
        </div>

        <div>
            <span>STOP</span>
            <strong>${fmtPrice(signal.stop)}</strong>
        </div>

        <div>
            <span>TP1</span>
            <strong>${fmtPrice(signal.tp1)}</strong>
        </div>

        <div>
            <span>TP2</span>
            <strong>${fmtPrice(signal.tp2)}</strong>
        </div>

        <div>
            <span>TP3</span>
            <strong>${fmtPrice(signal.tp3)}</strong>
        </div>

        <div>
            <span>15M RSI</span>
            <strong>${signal.rsi15.toFixed(1)}</strong>
        </div>

        <div>
            <span>5M RSI</span>
            <strong>${signal.rsi5.toFixed(1)}</strong>
        </div>

        <div>
            <span>HACİM</span>
            <strong>${signal.volume.toFixed(2)}x</strong>
        </div>

    </div>

    <div class="reason">
        4H kırılımı + 2H onayı + retest +
        RSI + hacim doğrulaması.
    </div>

    <a
        class="tv"
        href="${tvUrl(signal.symbol)}"
        target="_blank"
        rel="noopener noreferrer"
    >
        📊 TRADINGVIEW AÇ
    </a>

</div>
`;
}

function performanceHtml() {

    const stats =
        getPerformance();

    if (!stats.total) {

        return `
<div class="empty-performance">

    Henüz tamamlanmış işlem yok.

    <small>
        Sonny yalnızca sonucu belli olan
        TP / STOP işlemlerini performansa dahil eder.
    </small>

</div>
`;
    }

    const recent =
        state.history
            .slice(
                -PERFORMANCE_LIMIT
            )
            .reverse();

    const rows =
        recent
            .map(item => {

                const resultClass =
                    item.status === 'STOP'
                        ? 'loss'
                        : 'win';

                return `
<tr>
    <td>${escapeHtml(item.symbol)}</td>
    <td>${item.direction}</td>
    <td class="${resultClass}">
        ${item.status}
    </td>
    <td>${fmtPrice(item.entryLow)}</td>
    <td>${fmtPrice(item.exitPrice)}</td>
    <td>${num(item.r).toFixed(2)}R</td>
</tr>
`;
            })
            .join('');

    return `
<div class="stats">

    <div class="stat">
        <span>TP BAŞARI</span>
        <strong>${stats.tp1Rate}%</strong>
    </div>

    <div class="stat">
        <span>STOP</span>
        <strong>${stats.stopRate}%</strong>
    </div>

    <div class="stat">
        <span>TOPLAM R</span>
        <strong>${stats.totalR}R</strong>
    </div>

    <div class="stat">
        <span>KAZANAN</span>
        <strong>${stats.wins}</strong>
    </div>

    <div class="stat">
        <span>KAYBEDEN</span>
        <strong>${stats.losses}</strong>
    </div>

    <div class="stat">
        <span>TOPLAM</span>
        <strong>${stats.total}</strong>
    </div>

</div>

<div class="table-wrap">

<table>

<thead>
<tr>
    <th>COIN</th>
    <th>YÖN</th>
    <th>SONUÇ</th>
    <th>GİRİŞ</th>
    <th>ÇIKIŞ</th>
    <th>R</th>
</tr>
</thead>

<tbody>
${rows}
</tbody>

</table>

</div>
`;
}

function renderPage() {

    const market =
        state.market;

    const active =
        state.activeSignals;

    const lastScan =
        state.stats.lastScan
            ? new Date(
                state.stats.lastScan
            ).toLocaleTimeString(
                'tr-TR'
            )
            : '-';

    const signalHtml =
        active.length
            ? active
                .map(signalCard)
                .join('')
            : `
<div class="empty">
    Şu anda aktif işlem sinyali yok.
    <small>
        Sonny piyasayı tarıyor ve yeni fırsat arıyor.
    </small>
</div>
`;

    return `
<!DOCTYPE html>

<html lang="tr">

<head>

<meta charset="UTF-8">

<meta
    name="viewport"
    content="width=device-width,initial-scale=1"
/>

<meta
    http-equiv="refresh"
    content="30"
/>

<title>
Sonny AI Signal Scanner V6.2
</title>

<style>

* {
    box-sizing: border-box;
}

body {

    margin: 0;

    background:
        #070b12;

    color:
        #eef2f7;

    font-family:
        Arial,
        Helvetica,
        sans-serif;
}

.container {

    max-width:
        1050px;

    margin:
        auto;

    padding:
        25px 16px 60px;
}

.header {

    display:
        flex;

    justify-content:
        space-between;

    align-items:
        center;

    gap:
        20px;

    margin-bottom:
        22px;
}

.logo {

    font-size:
        26px;

    font-weight:
        800;
}

.version {

    color:
        #8b95a7;

    font-size:
        13px;

    margin-top:
        5px;
}

.online {

    color:
        #43e19b;

    font-weight:
        700;
}

.market {

    background:
        #101722;

    border:
        1px solid #1d2938;

    border-radius:
        18px;

    padding:
        22px;

    margin-bottom:
        22px;
}

.market-title {

    color:
        #8d99aa;

    font-size:
        13px;

    margin-bottom:
        7px;
}

.market-direction {

    font-size:
        29px;

    font-weight:
        900;

    margin-bottom:
        6px;
}

.market-description {

    color:
        #aab3c1;

    margin-bottom:
        20px;
}

.market-grid {

    display:
        grid;

    grid-template-columns:
        repeat(4,1fr);

    gap:
        10px;
}

.metric {

    background:
        #0a1019;

    border-radius:
        12px;

    padding:
        15px;
}

.metric span {

    display:
        block;

    color:
        #788597;

    font-size:
        11px;

    margin-bottom:
        7px;
}

.metric strong {

    font-size:
        21px;
}

.section-title {

    font-size:
        20px;

    font-weight:
        800;

    margin:
        28px 0 6px;
}

.section-sub {

    color:
        #7f8b9c;

    font-size:
        13px;

    margin-bottom:
        15px;
}

.signal-card {

    background:
        #101722;

    border:
        1px solid #243044;

    border-radius:
        18px;

    padding:
        20px;

    margin-bottom:
        15px;

    box-shadow:
        0 10px 30px rgba(0,0,0,.18);
}

.signal-card.long {
    border-left:
        4px solid #26d99b;
}

.signal-card.short {
    border-left:
        4px solid #ff5f6d;
}

.signal-top {

    display:
        flex;

    justify-content:
        space-between;

    align-items:
        flex-start;
}

.coin {

    font-size:
        21px;

    font-weight:
        900;
}

.strategy {

    color:
        #798699;

    font-size:
        11px;

    margin-top:
        5px;
}

.direction {

    font-weight:
        900;

    font-size:
        18px;

    padding:
        7px 12px;

    border-radius:
        9px;

    background:
        #182231;
}

.score {

    display:
        inline-block;

    margin:
        14px 0;

    padding:
        6px 10px;

    border-radius:
        8px;

    background:
        #1a2534;

    color:
        #ffd166;

    font-weight:
        800;

    font-size:
        13px;
}

.live {

    background:
        #0a1019;

    padding:
        13px;

    border-radius:
        10px;

    margin-bottom:
        14px;

    color:
        #8491a3;
}

.live strong {

    color:
        #fff;

    font-size:
        20px;

    margin-left:
        8px;
}

.grid {

    display:
        grid;

    grid-template-columns:
        repeat(4,1fr);

    gap:
        9px;

    margin:
        12px 0;
}

.grid div {

    background:
        #0a1019;

    padding:
        12px;

    border-radius:
        9px;
}

.grid span {

    display:
        block;

    color:
        #738095;

    font-size:
        10px;

    margin-bottom:
        5px;
}

.grid strong {

    font-size:
        14px;
}

.reason {

    color:
        #9ca7b6;

    font-size:
        13px;

    margin:
        15px 0;
}

.tv {

    display:
        inline-block;

    text-decoration:
        none;

    background:
        #1769ff;

    color:
        white;

    padding:
        11px 16px;

    border-radius:
        9px;

    font-weight:
        800;

    font-size:
        13px;
}

.empty {

    background:
        #101722;

    border:
        1px solid #1d2938;

    border-radius:
        16px;

    padding:
        35px;

    text-align:
        center;

    color:
        #8894a5;
}

.empty small {

    display:
        block;

    margin-top:
        8px;

    color:
        #5f6c7d;
}

.performance {

    margin-top:
        35px;
}

.stats {

    display:
        grid;

    grid-template-columns:
        repeat(6,1fr);

    gap:
        9px;

    margin:
        15px 0;
}

.stat {

    background:
        #101722;

    border:
        1px solid #1d2938;

    padding:
        14px;

    border-radius:
        11px;
}

.stat span {

    display:
        block;

    color:
        #748094;

    font-size:
        10px;

    margin-bottom:
        7px;
}

.stat strong {

    font-size:
        18px;
}

.table-wrap {

    overflow-x:
        auto;

    background:
        #101722;

    border:
        1px solid #1d2938;

    border-radius:
        14px;
}

table {

    width:
        100%;

    border-collapse:
        collapse;

    font-size:
        13px;
}

th,
td {

    padding:
        12px;

    text-align:
        left;

    border-bottom:
        1px solid #1c2633;
}

th {

    color:
        #718094;

    font-size:
        10px;
}

.win {

    color:
        #42dfa0;

    font-weight:
        800;
}

.loss {

    color:
        #ff6873;

    font-weight:
        800;
}

.empty-performance {

    background:
        #101722;

    border:
        1px solid #1d2938;

    border-radius:
        15px;

    padding:
        25px;

    color:
        #7e8b9d;
}

.empty-performance small {

    display:
        block;

    margin-top:
        8px;
}

.footer {

    text-align:
        center;

    color:
        #596678;

    font-size:
        11px;

    margin-top:
        30px;
}

@media(max-width:800px) {

    .market-grid {
        grid-template-columns:
            repeat(2,1fr);
    }

    .grid {
        grid-template-columns:
            repeat(2,1fr);
    }

    .stats {
        grid-template-columns:
            repeat(2,1fr);
    }

}

</style>

</head>

<body>

<div class="container">

<header class="header">

<div>

<div class="logo">
🚀 Sonny AI Signal Scanner
</div>

<div class="version">
V6.2 · 4H / 2H Breakout + Retest + RSI
</div>

</div>

<div class="online">
● SÜREKLİ AKTİF
</div>

</header>


<section class="market">

<div class="market-title">
GENEL PİYASA DURUMU
</div>

<div class="market-direction">
${escapeHtml(
    market.direction
)}
</div>

<div class="market-description">
${escapeHtml(
    market.description
)}
</div>

<div class="market-grid">

<div class="metric">
<span>PİYASA</span>
<strong>
${state.stats.market || state.universe.length}
</strong>
</div>

<div class="metric">
<span>ANALİZ</span>
<strong>
${state.stats.analyzed || 0}
</strong>
</div>

<div class="metric">
<span>AKTİF SİNYAL</span>
<strong>
${active.length}
</strong>
</div>

<div class="metric">
<span>SON TARAMA</span>
<strong>
${lastScan}
</strong>
</div>

</div>

</section>


<section>

<div class="section-title">
🚨 AKTİF SİNYALLER
</div>

<div class="section-sub">
Şu anda işlem fırsatı hâlâ geçerli olan sinyaller.
Fiyat giriş bölgesini aşarsa sinyal otomatik olarak kaldırılır.
</div>

${signalHtml}

</section>


<section class="performance">

<div class="section-title">
📊 GERÇEK PERFORMANS · SON 50
</div>

<div class="section-sub">
Yalnızca sonucu gerçekten belli olan TP ve STOP işlemleri hesaplanır.
Kaçan fırsatlar performansa dahil edilmez.
</div>

${performanceHtml()}

</section>


<div class="footer">

Sonny AI Signal Scanner V6.2 ·
Bitget Futures ·
Her dakika otomatik tarama

</div>

</div>

<script>

setTimeout(function() {

    location.reload();

}, 30000);

</script>

</body>

</html>
`;
}

/*
-----------------------------------------------------------
HTTP SERVER
-----------------------------------------------------------
*/

const server =
    http.createServer(
        async (req, res) => {

            try {

                const url =
                    new URL(
                        req.url,
                        `http://${req.headers.host}`
                    );

                /*
                API
                */

                if (
                    url.pathname ===
                    '/api/state'
                ) {

                    const payload = {
                        market:
                            state.market,

                        stats:
                            state.stats,

                        activeSignals:
                            state.activeSignals
                                .map(signal => ({
                                    ...signal,
                                    price:
                                        lastPrices.get(
                                            signal.symbol
                                        ) ||
                                        signal.price
                                })),

                        performance:
                            getPerformance(),

                        scanning:
                            state.scanning
                    };

                    res.writeHead(
                        200,
                        {
                            'Content-Type':
                                'application/json; charset=utf-8',

                            'Cache-Control':
                                'no-store'
                        }
                    );

                    res.end(
                        JSON.stringify(
                            payload
                        )
                    );

                    return;
                }

                /*
                MANUEL SCAN
                */

                if (
                    url.pathname ===
                    '/api/scan'
                ) {

                    runScan();

                    res.writeHead(
                        200,
                        {
                            'Content-Type':
                                'application/json'
                        }
                    );

                    res.end(
                        JSON.stringify({
                            ok: true,
                            message:
                                'Tarama başlatıldı.'
                        })
                    );

                    return;
                }

                /*
                ANA SAYFA
                */

                res.writeHead(
                    200,
                    {
                        'Content-Type':
                            'text/html; charset=utf-8',

                        'Cache-Control':
                            'no-store'
                    }
                );

                res.end(
                    renderPage()
                );

            } catch (e) {

                console.log(
                    'SERVER HATASI:',
                    e.message
                );

                res.writeHead(
                    500,
                    {
                        'Content-Type':
                            'application/json'
                    }
                );

                res.end(
                    JSON.stringify({
                        error:
                            'Sunucu hatası'
                    })
                );
            }
        }
    );

/*
-----------------------------------------------------------
START
-----------------------------------------------------------
*/

server.listen(
    PORT,
    '0.0.0.0',
    () => {

        console.log(
            'Sonny AI Signal Scanner V6.2 started'
        );

        console.log(
            'Data source: BITGET'
        );

        console.log(
            'Strategy: 4H BREAKOUT + 2H CONFIRMATION + RETEST + 15M RSI + 5M RSI + VOLUME'
        );

        console.log(
            'Refresh: Every 60 seconds'
        );

        console.log(
            `Server listening on port ${PORT}`
        );

        console.log(
            `Signal history: ${state.history.length} kayıt`
        );

        /*
        İlk tarama.
        */

        setTimeout(
            () => {
                runScan();
            },
            1000
        );

        /*
        Her dakika yeni tarama.
        */

        setInterval(
            () => {
                runScan();
            },
            SCAN_INTERVAL
        );

        /*
        Canlı fiyat takibi.
        */

        setInterval(
            () => {
                refreshPrices();
            },
            PRICE_INTERVAL
        );
    }
);
