'use strict';

/*
=========================================================
 SONNY AI TRADER
 MOMENTUM SCALPER V2

 AMAÇ:
 - 15M = piyasa bağlamı
 - 5M  = yapı
 - 1M  = tetik
 - LIVE = fiyat + hacim + trade flow + OI
 - WAIT = manuel giriş için fırsatı canlı tut
 - ENTRY WINDOW = hâlâ girilebilir bölge
 - EXHAUSTION = momentum bozulması
 - TOO LATE = FOMO engeli

 NOT:
 Bu sistem otomatik işlem açmaz.
 AUTO_TRADE = false.
=========================================================
*/

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = Number(process.env.PORT || 10000);
const API_TOKEN = process.env.API_TOKEN || '';

app.use(express.json());

/* ======================================================
   CONFIG
====================================================== */

const CFG = {
    RADAR: 500,

    // Canlı WS için ilk aşamada en fazla 50 coin
    LIVE_SYMBOLS: 50,

    // Derin analiz
    DEEP_SYMBOLS: 20,

    // Maksimum canlı fırsat
    MAX_LIVE_SIGNALS: 3,

    // 15M
    M15_HISTORY: 180,

    // REST
    MIN_VOLUME_USDT: Number(process.env.MIN_VOLUME_USDT || 1000000),

    // Momentum
    MOMENTUM_MIN: 60,
    WAIT_MIN: 70,
    ENTRY_MIN: 82,

    // Hacim
    VOLUME_BUILDING: 1.4,
    VOLUME_IGNITION: 2.0,
    VOLUME_ENTRY: 2.5,

    // Trade flow
    FLOW_BUILDING: 0.58,
    FLOW_ENTRY: 0.65,

    // OI
    OI_MIN_DELTA: 0.20,

    // Fiyat hızlanması
    PRICE_BUILDING_30S: 0.15,
    PRICE_ENTRY_30S: 0.35,

    // 15M
    EMA_PERIOD: 21,
    ATR_PERIOD: 10,
    VWAP_LOOKBACK: 120,
    BREAKOUT_LOOKBACK: 12,

    // WAIT / ENTRY
    WAIT_TTL: 90 * 1000,
    ENTRY_WINDOW_TTL: 90 * 1000,

    // FOMO
    MAX_ENTRY_EXTENSION_ATR: 1.25,
    MAX_ENTRY_DISTANCE_PERCENT: 0.90,

    // Exhaustion
    EXHAUSTION_FLOW_DROP: 0.12,
    EXHAUSTION_PRICE_STALL: 0.08,

    // Cooldown
    COOLDOWN: 30 * 60 * 1000,

    // REST cache
    CANDLE_CACHE_TTL: 2 * 60 * 1000,

    // Scan
    DISCOVERY_MS: 30 * 1000,
    CONTEXT_REFRESH_MS: 60 * 1000,

    // WS
    WS_URL: 'wss://ws.bitget.com/v2/ws/public',

    // UI
    BROADCAST_MS: 500,

    DEBUG: process.env.DEBUG === 'true'
};

/* ======================================================
   EXCHANGE
====================================================== */

const exchange = new ccxt.bitget({
    enableRateLimit: true,
    timeout: 30000,
    options: {
        defaultType: 'swap'
    }
});

/* ======================================================
   STATE
====================================================== */

const STATE = {
    markets: [],
    marketMap: new Map(),

    universe: [],
    liveUniverse: [],

    signals: new Map(),
    cooldowns: new Map(),

    context: new Map(),
    live: new Map(),

    selected: 'BTC/USDT:USDT',
    selectedTf: '15m',

    lastDiscovery: 0,
    lastContextRefresh: 0,

    wsConnected: false,
    wsLastMessage: 0,
    wsReconnects: 0,

    scanning: false,
    lastError: '',

    market: {
        label: 'YATAY / KARIŞIK',
        direction: 'FLAT',
        breadth: 50,
        green: 0,
        red: 0,
        average: 0,
        btc: 'NÖTR',
        eth: 'NÖTR'
    },

    stats: {
        universe: 0,
        live: 0,
        watching: 0,
        ignition: 0,
        entries: 0,
        errors: 0
    }
};

const candleCache = new Map();

let restQueue = [];
let restBusy = false;

let broadcastTimer = null;
let wsTimer = null;

/* ======================================================
   HELPERS
====================================================== */

function num(v, d = 8) {
    const x = Number(v);
    return Number.isFinite(x) ? Number(x.toFixed(d)) : 0;
}

function avg(arr) {
    return arr.length
        ? arr.reduce((a, b) => a + b, 0) / arr.length
        : 0;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function closed(candles) {
    if (!Array.isArray(candles)) return [];
    return candles.length > 1 ? candles.slice(0, -1) : candles;
}

function cleanSymbol(symbol) {
    let x = String(symbol || '')
        .toUpperCase()
        .replace('/USDT:USDT', '')
        .replace('/USDT', '')
        .replace(':USDT', '');

    if (x.endsWith('USDT')) {
        x = x.slice(0, -4);
    }

    return x + 'USDT';
}

function ccxtSymbol(instId) {
    return `${instId.replace('USDT', '')}/USDT:USDT`;
}

function fmt(v) {
    const x = Number(v);

    if (!Number.isFinite(x)) return '-';
    if (x >= 1000) return x.toFixed(2);
    if (x >= 100) return x.toFixed(3);
    if (x >= 1) return x.toFixed(5);
    if (x >= 0.01) return x.toFixed(7);
    if (x >= 0.0001) return x.toFixed(8);

    return x.toFixed(10);
}

function volumeFmt(v) {
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';

    return Math.round(v).toString();
}

function pct(a, b) {
    if (!b) return 0;
    return ((a - b) / b) * 100;
}

function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}

/* ======================================================
   REST QUEUE
====================================================== */

async function processRestQueue() {
    if (restBusy) return;

    restBusy = true;

    while (restQueue.length) {
        const task = restQueue.shift();

        try {
            const result = await task.fn();
            task.resolve(result);
        } catch (err) {
            task.reject(err);
        }

        // Bitget rate limit baskısını azalt
        await sleep(350);
    }

    restBusy = false;
}

function rest(fn) {
    return new Promise((resolve, reject) => {
        restQueue.push({
            fn,
            resolve,
            reject
        });

        processRestQueue();
    });
}

/* ======================================================
   MARKETS
====================================================== */

async function loadMarkets() {
    const markets = await exchange.loadMarkets(true);

    STATE.markets = Object.values(markets).filter(m =>
        m &&
        m.active !== false &&
        m.swap === true &&
        m.linear === true &&
        m.quote === 'USDT' &&
        m.settle === 'USDT'
    );

    STATE.marketMap = new Map(
        STATE.markets.map(m => [m.symbol, m])
    );

    console.log(
        `MARKETLER | USDT perpetual: ${STATE.markets.length}`
    );
}

async function loadMarketsRetry() {
    let last;

    for (let i = 0; i < 3; i++) {
        try {
            await loadMarkets();
            return;
        } catch (err) {
            last = err;
            console.error(
                `Market yükleme hatası ${i + 1}/3:`,
                err.message
            );

            await sleep(3000);
        }
    }

    throw last;
}

/* ======================================================
   CANDLES
====================================================== */

async function getCandles(symbol, timeframe, limit) {
    const key = `${symbol}|${timeframe}|${limit}`;
    const cached = candleCache.get(key);

    if (
        cached &&
        Date.now() - cached.time < CFG.CANDLE_CACHE_TTL
    ) {
        return cached.data;
    }

    try {
        const data = await rest(() =>
            exchange.fetchOHLCV(
                symbol,
                timeframe,
                undefined,
                limit
            )
        );

        const clean = Array.isArray(data)
            ? data
                .filter(x => Array.isArray(x) && x.length >= 6)
                .sort((a, b) => a[0] - b[0])
            : [];

        candleCache.set(key, {
            time: Date.now(),
            data: clean
        });

        return clean;
    } catch (err) {
        console.error(
            `Mum alınamadı ${symbol} ${timeframe}:`,
            err.message
        );

        return cached ? cached.data : [];
    }
}

/* ======================================================
   INDICATORS
====================================================== */

function ATR(candles, period = 10) {
    const c = closed(candles);

    if (c.length < period + 1) return 0;

    const trs = [];

    for (let i = 1; i < c.length; i++) {
        const high = Number(c[i][2]);
        const low = Number(c[i][3]);
        const prevClose = Number(c[i - 1][4]);

        trs.push(
            Math.max(
                high - low,
                Math.abs(high - prevClose),
                Math.abs(low - prevClose)
            )
        );
    }

    return avg(trs.slice(-period));
}

function EMA(candles, period = 21) {
    const c = closed(candles);

    if (c.length < period) return 0;

    const closes = c.map(x => Number(x[4]));
    const k = 2 / (period + 1);

    let ema = avg(closes.slice(0, period));

    for (let i = period; i < closes.length; i++) {
        ema = closes[i] * k + ema * (1 - k);
    }

    return ema;
}

function VWAP(candles, lookback = 120) {
    const c = closed(candles).slice(-lookback);

    let pv = 0;
    let vol = 0;

    for (const candle of c) {
        const high = Number(candle[2]);
        const low = Number(candle[3]);
        const close = Number(candle[4]);
        const volume = Number(candle[5]);

        const typical = (high + low + close) / 3;

        pv += typical * volume;
        vol += volume;
    }

    return vol > 0 ? pv / vol : 0;
}

/* ======================================================
   15M CONTEXT
====================================================== */

function buildContext(candles) {
    const c = closed(candles);

    if (c.length < 60) return null;

    const last = c[c.length - 1];
    const previous = c[c.length - 2];

    const close = Number(last[4]);
    const previousClose = Number(previous[4]);

    const ema = EMA(candles, CFG.EMA_PERIOD);
    const vwap = VWAP(
        candles,
        CFG.VWAP_LOOKBACK
    );

    const atr = ATR(
        candles,
        CFG.ATR_PERIOD
    );

    if (!ema || !vwap || !atr) return null;

    let direction = 'FLAT';

    if (close > ema && close > vwap) {
        direction = 'LONG';
    } else if (
        close < ema &&
        close < vwap
    ) {
        direction = 'SHORT';
    }

    const recent = c.slice(
        -CFG.BREAKOUT_LOOKBACK - 1,
        -1
    );

    const high = Math.max(
        ...recent.map(x => Number(x[2]))
    );

    const low = Math.min(
        ...recent.map(x => Number(x[3]))
    );

    const ranges = c
        .slice(-12)
        .map(x => Number(x[2]) - Number(x[3]));

    const recentRange = avg(
        ranges.slice(-4)
    );

    const oldRange = avg(
        ranges.slice(0, 8)
    );

    const compression =
        oldRange > 0
            ? recentRange / oldRange
            : 1;

    return {
        direction,
        close,
        previousClose,
        ema,
        vwap,
        atr,
        recentHigh: high,
        recentLow: low,
        compression,
        timestamp: Date.now()
    };
}

/* ======================================================
   MARKET DISCOVERY
====================================================== */

async function discoverUniverse() {
    try {
        const tickers = await rest(() =>
            exchange.fetchTickers()
        );

        const rows = [];

        for (const market of STATE.markets) {
            const ticker = tickers[market.symbol];

            if (!ticker) continue;

            const price = Number(
                ticker.last || ticker.close
            );

            const volume = Number(
                ticker.quoteVolume || 0
            );

            const change = Number(
                ticker.percentage || 0
            );

            if (
                !Number.isFinite(price) ||
                price <= 0 ||
                volume < CFG.MIN_VOLUME_USDT
            ) {
                continue;
            }

            rows.push({
                symbol: market.symbol,
                instId: cleanSymbol(market.symbol),
                price,
                volume,
                volumeFormatted: volumeFmt(volume),
                change
            });
        }

        rows.sort((a, b) => {
            const scoreA =
                Math.abs(a.change) * 0.65 +
                Math.log10(a.volume + 1) * 0.35;

            const scoreB =
                Math.abs(b.change) * 0.65 +
                Math.log10(b.volume + 1) * 0.35;

            return scoreB - scoreA;
        });

        STATE.universe = rows.slice(
            0,
            CFG.RADAR
        );

        STATE.liveUniverse = STATE.universe.slice(
            0,
            CFG.LIVE_SYMBOLS
        );

        STATE.stats.universe =
            STATE.universe.length;

        STATE.stats.live =
            STATE.liveUniverse.length;

        calculateMarketRegime(
            STATE.universe
        );

        STATE.lastDiscovery = Date.now();

        console.log(
            `RADAR | ${STATE.universe.length} coin | LIVE ${STATE.liveUniverse.length}`
        );

    } catch (err) {
        STATE.lastError = err.message;
        STATE.stats.errors++;

        console.error(
            'RADAR HATASI:',
            err.message
        );
    }
}

/* ======================================================
   MARKET REGIME
====================================================== */

function calculateMarketRegime(rows) {
    if (!rows.length) return;

    let green = 0;
    let red = 0;
    let total = 0;

    for (const r of rows) {
        if (r.change > 0.5) green++;
        if (r.change < -0.5) red++;

        total += r.change;
    }

    const breadth =
        green /
        Math.max(green + red, 1) *
        100;

    const average =
        total / rows.length;

    const btc =
        rows.find(r =>
            r.symbol.includes('BTC')
        );

    const eth =
        rows.find(r =>
            r.symbol.includes('ETH')
        );

    let direction = 'FLAT';
    let label = 'YATAY / KARIŞIK';

    if (
        breadth >= 55 &&
        average >= 0.5
    ) {
        direction = 'LONG';
        label = 'POZİTİF / YÜKSELİŞ';
    } else if (
        breadth <= 45 &&
        average <= -0.5
    ) {
        direction = 'SHORT';
        label = 'NEGATİF / DÜŞÜŞ';
    }

    STATE.market = {
        label,
        direction,
        breadth: num(breadth, 1),
        green,
        red,
        average: num(average, 2),

        btc:
            btc?.change > 1
                ? 'LONG'
                : btc?.change < -1
                    ? 'SHORT'
                    : 'NÖTR',

        eth:
            eth?.change > 1
                ? 'LONG'
                : eth?.change < -1
                    ? 'SHORT'
                    : 'NÖTR'
    };
}

/* ======================================================
   LIVE DATA OBJECT
====================================================== */

function getLive(instId) {
    if (!STATE.live.has(instId)) {
        STATE.live.set(instId, {
            symbol: ccxtSymbol(instId),

            price: 0,
            previousPrice: 0,

            bid: 0,
            ask: 0,

            volume24h: 0,
            oi: 0,
            previousOi: 0,

            firstPrice30s: 0,
            firstPrice60s: 0,

            volumeWindow: 0,
            buyNotional: 0,
            sellNotional: 0,

            trades: [],

            lastUpdate: 0,

            candles1m: [],
            candles5m: [],

            priceSamples: []
        });
    }

    return STATE.live.get(instId);
}

/* ======================================================
   TRADE FLOW
====================================================== */

function addTrade(instId, trade) {
    const l = getLive(instId);

    const price = Number(trade.price);
    const size = Number(trade.size);

    if (
        !Number.isFinite(price) ||
        !Number.isFinite(size) ||
        price <= 0 ||
        size <= 0
    ) {
        return;
    }

    const notional =
        price * size;

    if (trade.side === 'buy') {
        l.buyNotional += notional;
    } else {
        l.sellNotional += notional;
    }

    l.trades.push({
        time: Date.now(),
        side: trade.side,
        notional
    });

    // Son 60 saniye
    const cutoff =
        Date.now() - 60000;

    while (
        l.trades.length &&
        l.trades[0].time < cutoff
    ) {
        l.trades.shift();
    }

    l.lastUpdate = Date.now();

    evaluateLive(instId);
}

/* ======================================================
   TICKER
====================================================== */

function addTicker(instId, data) {
    const l = getLive(instId);

    const price = Number(
        data.lastPr ||
        data.last ||
        data.close ||
        0
    );

    if (!price) return;

    const now = Date.now();

    if (!l.firstPrice30s) {
        l.firstPrice30s = price;
        l.firstPrice60s = price;
    }

    l.previousPrice =
        l.price || price;

    l.price = price;

    l.bid = Number(
        data.bidPr || 0
    );

    l.ask = Number(
        data.askPr || 0
    );

    l.volume24h = Number(
        data.quoteVolume || 0
    );

    const newOi = Number(
        data.holdingAmount || 0
    );

    if (newOi > 0) {
        l.previousOi =
            l.oi || newOi;

        l.oi = newOi;
    }

    l.priceSamples.push({
        time: now,
        price
    });

    while (
        l.priceSamples.length &&
        l.priceSamples[0].time <
        now - 60000
    ) {
        l.priceSamples.shift();
    }

    const sample30 =
        l.priceSamples.find(
            x => x.time >= now - 30000
        );

    const sample60 =
        l.priceSamples.find(
            x => x.time >= now - 60000
        );

    if (sample30) {
        l.firstPrice30s =
            sample30.price;
    }

    if (sample60) {
        l.firstPrice60s =
            sample60.price;
    }

    l.lastUpdate = now;

    evaluateLive(instId);
}

/* ======================================================
   CANDLE WS
====================================================== */

function addCandle(instId, timeframe, raw) {
    const l = getLive(instId);

    if (!Array.isArray(raw)) return;

    const candle = [
        Number(raw[0]),
        Number(raw[1]),
        Number(raw[2]),
        Number(raw[3]),
        Number(raw[4]),
        Number(raw[5] || 0)
    ];

    if (timeframe === '1m') {
        upsertCandle(
            l.candles1m,
            candle,
            100
        );
    }

    if (timeframe === '5m') {
        upsertCandle(
            l.candles5m,
            candle,
            100
        );
    }

    evaluateLive(instId);
}

function upsertCandle(arr, candle, max) {
    const last =
        arr[arr.length - 1];

    if (
        last &&
        last[0] === candle[0]
    ) {
        arr[arr.length - 1] =
            candle;
    } else {
        arr.push(candle);
    }

    while (arr.length > max) {
        arr.shift();
    }
}

/* ======================================================
   FLOW METRICS
====================================================== */

function flowRatio(l) {
    const total =
        l.buyNotional +
        l.sellNotional;

    if (!total) return 0.5;

    return l.buyNotional / total;
}

function oiChange(l) {
    if (
        !l.previousOi ||
        !l.oi
    ) {
        return 0;
    }

    return (
        (l.oi - l.previousOi) /
        Math.abs(l.previousOi)
    ) * 100;
}

function price30s(l) {
    if (!l.firstPrice30s) return 0;

    return pct(
        l.price,
        l.firstPrice30s
    );
}

function price60s(l) {
    if (!l.firstPrice60s) return 0;

    return pct(
        l.price,
        l.firstPrice60s
    );
}

function spreadPercent(l) {
    if (!l.bid || !l.ask) return 0;

    return (
        (l.ask - l.bid) /
        ((l.ask + l.bid) / 2)
    ) * 100;
}

function liveVolumeRatio(l) {
    if (!l.volume24h) return 1;

    // 24h hacmin 30 saniyelik teorik ortalaması
    const expected30 =
        l.volume24h / 2880;

    const trades = l.trades
        .filter(
            x => x.time >= Date.now() - 30000
        );

    const actual =
        trades.reduce(
            (s, x) => s + x.notional,
            0
        );

    if (!expected30) return 1;

    return actual / expected30;
}

/* ======================================================
   MOMENTUM
====================================================== */

function calculateMomentum(
    instId,
    context
) {
    const l = getLive(instId);

    if (!l.price || !context) {
        return null;
    }

    const p30 = price30s(l);
    const p60 = price60s(l);

    const flow = flowRatio(l);
    const oi = oiChange(l);
    const vol = liveVolumeRatio(l);

    const long =
        context.direction === 'LONG';

    const short =
        context.direction === 'SHORT';

    let direction = null;

    if (
        long &&
        p30 > 0 &&
        flow >= 0.50
    ) {
        direction = 'LONG';
    }

    if (
        short &&
        p30 < 0 &&
        flow <= 0.50
    ) {
        direction = 'SHORT';
    }

    // 15M nötrse güçlü canlı hareket yine
    // izlenebilir fakat giriş verilmez
    if (!direction) {
        if (
            p30 > 0.20 &&
            flow > 0.65
        ) {
            direction = 'LONG';
        } else if (
            p30 < -0.20 &&
            flow < 0.35
        ) {
            direction = 'SHORT';
        }
    }

    if (!direction) return null;

    const absMove =
        Math.abs(p30);

    let score = 0;

    // Fiyat hızlanması: 25
    score += clamp(
        absMove / 0.50 * 25,
        0,
        25
    );

    // Flow: 20
    const flowStrength =
        direction === 'LONG'
            ? flow
            : 1 - flow;

    score += clamp(
        ((flowStrength - 0.50) / 0.35) * 20,
        0,
        20
    );

    // Hacim: 20
    score += clamp(
        ((vol - 1) / 4) * 20,
        0,
        20
    );

    // OI: 15
    const oiStrength =
        Math.abs(oi);

    score += clamp(
        (oiStrength / 3) * 15,
        0,
        15
    );

    // Yapı: 10
    const breakout =
        direction === 'LONG'
            ? l.price > context.recentHigh
            : l.price < context.recentLow;

    if (breakout) {
        score += 10;
    }

    // Sıkışma sonrası hareket: 10
    if (context.compression < 0.80) {
        score += 10;
    } else if (context.compression < 1) {
        score += 5;
    }

    return {
        direction,
        score: Math.round(
            clamp(score, 0, 100)
        ),

        priceMove30s: num(p30, 3),
        priceMove60s: num(p60, 3),

        flow: num(flow * 100, 1),
        volumeRatio: num(vol, 2),

        oiChange: num(oi, 2),

        breakout,
        spread: num(
            spreadPercent(l),
            4
        ),

        price: l.price
    };
}

/* ======================================================
   FOMO / EXHAUSTION
====================================================== */

function detectTooLate(
    momentum,
    context
) {
    if (!momentum || !context) {
        return false;
    }

    const distance =
        Math.abs(
            momentum.price -
            (
                momentum.direction === 'LONG'
                    ? context.recentHigh
                    : context.recentLow
            )
        );

    const atrDistance =
        context.atr > 0
            ? distance / context.atr
            : 0;

    if (
        atrDistance >
        CFG.MAX_ENTRY_EXTENSION_ATR
    ) {
        return true;
    }

    if (
        Math.abs(
            momentum.priceMove30s
        ) >
        CFG.MAX_ENTRY_DISTANCE_PERCENT
    ) {
        return true;
    }

    return false;
}

function detectExhaustion(
    signal,
    momentum
) {
    if (!signal || !momentum) {
        return false;
    }

    const flowNow =
        momentum.direction === 'LONG'
            ? momentum.flow / 100
            : 1 - momentum.flow / 100;

    const previousFlow =
        signal.lastFlow || flowNow;

    const flowDrop =
        previousFlow - flowNow;

    const priceMove =
        Math.abs(
            momentum.priceMove30s
        );

    const priceStall =
        priceMove <
        CFG.EXHAUSTION_PRICE_STALL;

    const flowWeak =
        flowDrop >=
        CFG.EXHAUSTION_FLOW_DROP;

    signal.lastFlow =
        flowNow;

    return flowWeak && priceStall;
}

/* ======================================================
   TRADE PLAN
====================================================== */

function makePlan(
    direction,
    price,
    context
) {
    const atr = context.atr;

    if (!atr || !price) {
        return null;
    }

    const risk =
        Math.max(
            atr * 0.75,
            price * 0.003
        );

    let stop;
    let tp1;
    let tp2;
    let tp3;

    if (direction === 'LONG') {
        stop = price - risk;
        tp1 = price + risk;
        tp2 = price + risk * 1.8;
        tp3 = price + risk * 2.7;
    } else {
        stop = price + risk;
        tp1 = price - risk;
        tp2 = price - risk * 1.8;
        tp3 = price - risk * 2.7;
    }

    return {
        entry: price,
        stop,
        tp1,
        tp2,
        tp3,
        risk
    };
}

/* ======================================================
   SIGNAL STATE
====================================================== */

function createSignal(
    instId,
    momentum,
    context,
    stage
) {
    const now = Date.now();

    const plan =
        makePlan(
            momentum.direction,
            momentum.price,
            context
        );

    if (!plan) return null;

    const symbol =
        ccxtSymbol(instId);

    return {
        id:
            `${instId}|${momentum.direction}|${now}`,

        symbol,
        marketSymbol: symbol,
        instId,

        direction:
            momentum.direction,

        stage,

        status:
            stage === 'WATCH'
                ? 'İZLE'
                : stage === 'IGNITION'
                    ? 'HAREKET BAŞLADI'
                    : 'GİRİŞ FIRSATI',

        signalAt: now,
        lastUpdate: now,

        ageSeconds: 0,

        entryWindowEnds:
            stage === 'ENTRY'
                ? now +
                  CFG.ENTRY_WINDOW_TTL
                : null,

        entry:
            num(plan.entry),

        entryLow:
            num(
                momentum.direction === 'LONG'
                    ? plan.entry * 0.9985
                    : plan.entry * 1.0015
            ),

        entryHigh:
            num(
                momentum.direction === 'LONG'
                    ? plan.entry * 1.0015
                    : plan.entry * 0.9985
            ),

        stop:
            num(plan.stop),

        tp1:
            num(plan.tp1),

        tp2:
            num(plan.tp2),

        tp3:
            num(plan.tp3),

        rr: 1,

        currentPrice:
            num(momentum.price),

        score:
            momentum.score,

        momentumScore:
            momentum.score,

        priceMove30s:
            momentum.priceMove30s,

        priceMove60s:
            momentum.priceMove60s,

        flow:
            momentum.flow,

        volumeRatio:
            momentum.volumeRatio,

        oiChange:
            momentum.oiChange,

        spread:
            momentum.spread,

        breakout:
            momentum.breakout,

        contextDirection:
            context.direction,

        ema:
            num(context.ema),

        vwap:
            num(context.vwap),

        atr:
            num(context.atr),

        reason:
            '',

        lastFlow:
            momentum.direction === 'LONG'
                ? momentum.flow / 100
                : 1 - momentum.flow / 100
    };
}

/* ======================================================
   STATE TRANSITIONS
====================================================== */

function reasonFor(
    momentum,
    context
) {
    if (!momentum) {
        return 'Canlı momentum yetersiz';
    }

    const parts = [];

    if (momentum.breakout) {
        parts.push('seviye kırılımı');
    }

    if (
        momentum.volumeRatio >=
        CFG.VOLUME_ENTRY
    ) {
        parts.push('hacim patlaması');
    }

    if (
        momentum.direction === 'LONG' &&
        momentum.flow >= 65
    ) {
        parts.push('alış baskısı');
    }

    if (
        momentum.direction === 'SHORT' &&
        momentum.flow <= 35
    ) {
        parts.push('satış baskısı');
    }

    if (
        Math.abs(momentum.oiChange) >= 1
    ) {
        parts.push('OI artışı');
    }

    return parts.length
        ? parts.join(' + ')
        : 'momentum oluşuyor';
}

function transitionSignal(
    signal,
    momentum,
    context
) {
    const now = Date.now();

    signal.lastUpdate = now;
    signal.ageSeconds =
        Math.floor(
            (now - signal.signalAt) / 1000
        );

    signal.currentPrice =
        num(momentum.price);

    signal.score =
        momentum.score;

    signal.momentumScore =
        momentum.score;

    signal.priceMove30s =
        momentum.priceMove30s;

    signal.priceMove60s =
        momentum.priceMove60s;

    signal.flow =
        momentum.flow;

    signal.volumeRatio =
        momentum.volumeRatio;

    signal.oiChange =
        momentum.oiChange;

    signal.spread =
        momentum.spread;

    signal.breakout =
        momentum.breakout;

    signal.reason =
        reasonFor(
            momentum,
            context
        );

    /*
    ----------------------------------------
    GEÇ KALINDI
    ----------------------------------------
    */
    if (
        signal.stage === 'ENTRY' &&
        detectTooLate(momentum, context)
    ) {
        signal.stage = 'TOO_LATE';
        signal.status = 'GEÇ KALINDI';

        return;
    }

    /*
    ----------------------------------------
    EXHAUSTION
    ----------------------------------------
    */
    if (
        signal.stage === 'ENTRY' &&
        detectExhaustion(
            signal,
            momentum
        )
    ) {
        signal.stage = 'EXHAUSTION';
        signal.status =
            'MOMENTUM ZAYIFLIYOR';

        return;
    }

    /*
    ----------------------------------------
    WAIT
    ----------------------------------------
    */
    if (
        signal.stage === 'WATCH' &&
        momentum.score >= CFG.WAIT_MIN
    ) {
        signal.stage = 'IGNITION';
        signal.status =
            'HAREKET BAŞLADI';

        return;
    }

    /*
    ----------------------------------------
    ENTRY
    ----------------------------------------
    */
    if (
        (
            signal.stage === 'WATCH' ||
            signal.stage === 'IGNITION'
        ) &&
        momentum.score >= CFG.ENTRY_MIN &&
        momentum.volumeRatio >=
            CFG.VOLUME_ENTRY &&
        (
            momentum.direction === 'LONG'
                ? momentum.flow >=
                  CFG.FLOW_ENTRY * 100
                : momentum.flow <=
                  (1 - CFG.FLOW_ENTRY) * 100
        ) &&
        momentum.breakout &&
        !detectTooLate(
            momentum,
            context
        )
    ) {
        signal.stage = 'ENTRY';
        signal.status =
            'GİRİŞ FIRSATI';

        signal.entry =
            num(momentum.price);

        const plan =
            makePlan(
                momentum.direction,
                momentum.price,
                context
            );

        if (plan) {
            signal.entry =
                num(plan.entry);

            signal.entryLow =
                num(
                    momentum.direction === 'LONG'
                        ? plan.entry * 0.9985
                        : plan.entry * 1.0015
                );

            signal.entryHigh =
                num(
                    momentum.direction === 'LONG'
                        ? plan.entry * 1.0015
                        : plan.entry * 0.9985
                );

            signal.stop =
                num(plan.stop);

            signal.tp1 =
                num(plan.tp1);

            signal.tp2 =
                num(plan.tp2);

            signal.tp3 =
                num(plan.tp3);
        }

        signal.entryWindowEnds =
            now +
            CFG.ENTRY_WINDOW_TTL;

        return;
    }
}

/* ======================================================
   SIGNAL ENGINE
====================================================== */

function evaluateLive(instId) {
    const context =
        STATE.context.get(
            ccxtSymbol(instId)
        );

    if (!context) return;

    const momentum =
        calculateMomentum(
            instId,
            context
        );

    if (!momentum) return;

    /*
    Mevcut sinyal var mı?
    */
    let signal =
        [...STATE.signals.values()]
            .find(
                s =>
                    s.instId === instId
            );

    /*
    Yeni aday oluştur
    */
    if (!signal) {
        if (
            momentum.score <
            CFG.MOMENTUM_MIN
        ) {
            return;
        }

        const cooldown =
            STATE.cooldowns.get(
                `${instId}|${momentum.direction}`
            );

        if (
            cooldown &&
            Date.now() - cooldown <
            CFG.COOLDOWN
        ) {
            return;
        }

        // Çok fazla canlı sinyal istemiyoruz
        if (
            STATE.signals.size >=
            CFG.MAX_LIVE_SIGNALS
        ) {
            return;
        }

        const stage =
            momentum.score >= CFG.ENTRY_MIN
                ? 'IGNITION'
                : 'WATCH';

        signal =
            createSignal(
                instId,
                momentum,
                context,
                stage
            );

        if (!signal) return;

        signal.reason =
            reasonFor(
                momentum,
                context
            );

        STATE.signals.set(
            signal.id,
            signal
        );

        scheduleBroadcast();

        return;
    }

    /*
    Mevcut sinyali güncelle
    */
    transitionSignal(
        signal,
        momentum,
        context
    );

    /*
    TTL
    */
    const now = Date.now();

    if (
        signal.stage === 'WATCH' ||
        signal.stage === 'IGNITION'
    ) {
        if (
            now - signal.signalAt >
            CFG.WAIT_TTL
        ) {
            closeSignal(
                signal,
                'CANCELLED'
            );

            return;
        }
    }

    if (
        signal.stage === 'ENTRY' &&
        signal.entryWindowEnds &&
        now >
        signal.entryWindowEnds
    ) {
        closeSignal(
            signal,
            'EXPIRED'
        );

        return;
    }

    /*
    Çok zayıfladıysa iptal
    */
    if (
        (
            signal.stage === 'WATCH' ||
            signal.stage === 'IGNITION'
        ) &&
        momentum.score < 48
    ) {
        closeSignal(
            signal,
            'CANCELLED'
        );
    }

    scheduleBroadcast();
}

/* ======================================================
   CLOSE SIGNAL
====================================================== */

function closeSignal(
    signal,
    reason
) {
    STATE.signals.delete(
        signal.id
    );

    STATE.cooldowns.set(
        `${signal.instId}|${signal.direction}`,
        Date.now()
    );

    if (reason === 'EXPIRED') {
        console.log(
            `FIRSAT SÜRESİ DOLDU | ${signal.symbol}`
        );
    } else if (reason === 'CANCELLED') {
        console.log(
            `FIRSAT İPTAL | ${signal.symbol}`
        );
    }

    scheduleBroadcast();
}

/* ======================================================
   CONTEXT REFRESH
====================================================== */

async function refreshContexts() {
    if (STATE.scanning) return;

    STATE.scanning = true;

    try {
        const candidates =
            STATE.liveUniverse
                .slice(
                    0,
                    CFG.DEEP_SYMBOLS
                );

        for (const row of candidates) {
            const candles =
                await getCandles(
                    row.symbol,
                    '15m',
                    CFG.M15_HISTORY
                );

            const context =
                buildContext(candles);

            if (context) {
                STATE.context.set(
                    row.symbol,
                    context
                );
            }
        }

        STATE.lastContextRefresh =
            Date.now();

    } catch (err) {
        STATE.lastError =
            err.message;

        STATE.stats.errors++;
    } finally {
        STATE.scanning = false;
    }
}

/* ======================================================
   BITGET WEBSOCKET
====================================================== */

let bitgetWs = null;

function wsSendSubscriptions(ws) {
    const symbols =
        STATE.liveUniverse
            .slice(
                0,
                CFG.LIVE_SYMBOLS
            )
            .map(
                x => x.instId
            );

    /*
    Bitget subscription mesajı 4096 byte sınırına
    takılmasın diye küçük paketler kullanıyoruz.
    */

    const args = [];

    for (const instId of symbols) {
        args.push({
            instType: 'USDT-FUTURES',
            channel: 'ticker',
            instId
        });

        args.push({
            instType: 'USDT-FUTURES',
            channel: 'trade',
            instId
        });

        args.push({
            instType: 'USDT-FUTURES',
            channel: 'candle1m',
            instId
        });

        args.push({
            instType: 'USDT-FUTURES',
            channel: 'candle5m',
            instId
        });
    }

    const chunks = [];

    let current = [];

    for (const arg of args) {
        const test = JSON.stringify({
            op: 'subscribe',
            args: [
                ...current,
                arg
            ]
        });

        if (test.length > 3500) {
            chunks.push(current);
            current = [arg];
        } else {
            current.push(arg);
        }
    }

    if (current.length) {
        chunks.push(current);
    }

    for (const chunk of chunks) {
        ws.send(
            JSON.stringify({
                op: 'subscribe',
                args: chunk
            })
        );
    }

    console.log(
        `WS ABONELİK | ${symbols.length} coin | ${chunks.length} paket`
    );
}

function connectBitgetWS() {
    if (
        bitgetWs &&
        (
            bitgetWs.readyState ===
            WebSocket.OPEN ||
            bitgetWs.readyState ===
            WebSocket.CONNECTING
        )
    ) {
        return;
    }

    console.log(
        'Bitget WebSocket bağlanıyor...'
    );

    bitgetWs =
        new WebSocket(
            CFG.WS_URL
        );

    bitgetWs.on('open', () => {
        STATE.wsConnected = true;
        STATE.wsReconnects = 0;

        console.log(
            '🟢 BITGET WS BAĞLANDI'
        );

        wsSendSubscriptions(
            bitgetWs
        );

        scheduleBroadcast();
    });

    bitgetWs.on('message', raw => {
        STATE.wsLastMessage =
            Date.now();

        try {
            const msg =
                JSON.parse(
                    raw.toString()
                );

            /*
            Bitget ping mesajı
            */
            if (
                msg === 'pong' ||
                msg.event === 'pong'
            ) {
                return;
            }

            if (!msg.arg) return;

            const channel =
                msg.arg.channel;

            const instId =
                msg.arg.instId;

            if (!instId) return;

            const data =
                Array.isArray(msg.data)
                    ? msg.data
                    : [];

            if (!data.length) return;

            if (
                channel === 'ticker'
            ) {
                addTicker(
                    instId,
                    data[0]
                );
            }

            else if (
                channel === 'trade'
            ) {
                for (
                    const trade of data
                ) {
                    addTrade(
                        instId,
                        {
                            price:
                                trade.price,
                            size:
                                trade.size,
                            side:
                                trade.side
                        }
                    );
                }
            }

            else if (
                channel === 'candle1m'
            ) {
                addCandle(
                    instId,
                    '1m',
                    data[0]
                );
            }

            else if (
                channel === 'candle5m'
            ) {
                addCandle(
                    instId,
                    '5m',
                    data[0]
                );
            }

        } catch (err) {
            if (CFG.DEBUG) {
                console.error(
                    'WS parse:',
                    err.message
                );
            }
        }
    });

    bitgetWs.on('error', err => {
        STATE.lastError =
            `WS: ${err.message}`;

        console.error(
            'BITGET WS ERROR:',
            err.message
        );
    });

    bitgetWs.on('close', () => {
        STATE.wsConnected = false;
        STATE.wsReconnects++;

        console.log(
            '🔴 BITGET WS KAPANDI'
        );

        scheduleBroadcast();

        setTimeout(
            connectBitgetWS,
            3000
        );
    });
}

/* ======================================================
   WS PING
====================================================== */

function startWsHeartbeat() {
    if (wsTimer) {
        clearInterval(wsTimer);
    }

    wsTimer =
        setInterval(() => {
            if (
                bitgetWs &&
                bitgetWs.readyState ===
                WebSocket.OPEN
            ) {
                try {
                    bitgetWs.send('ping');
                } catch (_) {}
            }
        }, 25000);
}

/* ======================================================
   TOP SIGNALS
====================================================== */

function getSignals() {
    return [...STATE.signals.values()]
        .sort((a, b) => {
            const order = {
                ENTRY: 4,
                IGNITION: 3,
                WATCH: 2,
                EXHAUSTION: 1,
                TOO_LATE: 1
            };

            if (
                order[b.stage] !==
                order[a.stage]
            ) {
                return (
                    order[b.stage] -
                    order[a.stage]
                );
            }

            return (
                b.score -
                a.score
            );
        });
}

/* ======================================================
   CLEANUP
====================================================== */

function cleanup() {
    const now = Date.now();

    for (
        const [id, signal]
        of STATE.signals
    ) {
        signal.ageSeconds =
            Math.floor(
                (
                    now -
                    signal.signalAt
                ) / 1000
            );

        if (
            signal.stage === 'ENTRY' &&
            signal.entryWindowEnds &&
            now >
            signal.entryWindowEnds
        ) {
            closeSignal(
                signal,
                'EXPIRED'
            );
        }
    }

    for (
        const [key, time]
        of STATE.cooldowns
    ) {
        if (
            now - time >
            CFG.COOLDOWN
        ) {
            STATE.cooldowns.delete(key);
        }
    }
}

/* ======================================================
   STATUS
====================================================== */

function status() {
    cleanup();

    const signals =
        getSignals();

    const watching =
        signals.filter(
            s =>
                s.stage === 'WATCH'
        ).length;

    const ignition =
        signals.filter(
            s =>
                s.stage === 'IGNITION'
        ).length;

    const entries =
        signals.filter(
            s =>
                s.stage === 'ENTRY'
        ).length;

    STATE.stats.watching =
        watching;

    STATE.stats.ignition =
        ignition;

    STATE.stats.entries =
        entries;

    return {
        ok: true,

        now: Date.now(),

        lastDiscovery:
            STATE.lastDiscovery,

        lastContextRefresh:
            STATE.lastContextRefresh,

        error:
            STATE.lastError,

        ws: {
            connected:
                STATE.wsConnected,

            lastMessage:
                STATE.wsLastMessage,

            reconnects:
                STATE.wsReconnects
        },

        market:
            STATE.market,

        stats: {
            ...STATE.stats,
            signals:
                signals.length
        },

        signals,

        selected:
            STATE.selected,

        selectedTf:
            STATE.selectedTf
    };
}

/* ======================================================
   BROADCAST
====================================================== */

function scheduleBroadcast() {
    if (broadcastTimer) return;

    broadcastTimer =
        setTimeout(() => {
            broadcastTimer = null;

            const payload =
                JSON.stringify({
                    type: 'snapshot',
                    data: status()
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
        }, CFG.BROADCAST_MS);
}

/* ======================================================
   API
====================================================== */

function auth(req, res, next) {
    if (!API_TOKEN) {
        return next();
    }

    const token =
        req.headers['x-api-token'] ||
        req.query.token;

    if (token !== API_TOKEN) {
        return res
            .status(401)
            .json({
                error:
                    'Unauthorized'
            });
    }

    next();
}

app.get(
    '/api/status',
    (req, res) => {
        res.json(
            status()
        );
    }
);

app.get(
    '/api/health',
    (req, res) => {
        res.json({
            status: 'ok',
            uptime:
                process.uptime(),
            ws:
                STATE.wsConnected,
            lastError:
                STATE.lastError
        });
    }
);

app.get(
    '/api/scan',
    auth,
    async (req, res) => {
        try {
            await discoverUniverse();
            await refreshContexts();

            if (
                bitgetWs &&
                bitgetWs.readyState ===
                WebSocket.OPEN
            ) {
                wsSendSubscriptions(
                    bitgetWs
                );
            }

            res.json({
                success: true,
                data:
                    status()
            });
        } catch (err) {
            res
                .status(500)
                .json({
                    success: false,
                    error:
                        err.message
                });
        }
    }
);

app.get(
    '/api/chart',
    auth,
    async (req, res) => {
        try {
            const symbol =
                req.query.symbol ||
                'BTC/USDT:USDT';

            const timeframe =
                req.query.timeframe ||
                '15m';

            const market =
                STATE.marketMap.get(
                    symbol
                );

            if (!market) {
                return res.json({
                    success: false,
                    error:
                        'Market bulunamadı'
                });
            }

            const candles =
                await getCandles(
                    market.symbol,
                    timeframe,
                    160
                );

            const signal =
                getSignals()
                    .find(
                        s =>
                            s.marketSymbol ===
                            symbol
                    ) || null;

            res.json({
                success: true,
                symbol,
                timeframe,
                candles,
                signal
            });

        } catch (err) {
            res
                .status(500)
                .json({
                    success: false,
                    error:
                        err.message
                });
        }
    }
);

/*
Geçmiş sinyalleri UI'ya vermiyoruz.
Bu endpoint özellikle kaldırılmadıysa
bile boş döndürüyoruz.
*/
app.get(
    '/api/history',
    auth,
    (req, res) => {
        res.json({
            success: true,
            history: []
        });
    }
);

/* ======================================================
   FRONTEND WS
====================================================== */

wss.on(
    'connection',
    ws => {
        try {
            ws.send(
                JSON.stringify({
                    type: 'snapshot',
                    data:
                        status()
                })
            );
        } catch (_) {}
    }
);

/* ======================================================
   FRONTEND
====================================================== */

const HTML = `
<!DOCTYPE html>
<html lang="tr">

<head>
<meta charset="UTF-8">
<meta
    name="viewport"
    content="width=device-width,initial-scale=1"
/>

<title>SONNY AI TRADER</title>

<style>

* {
    box-sizing:border-box;
    margin:0;
    padding:0;
}

body {
    background:#070b11;
    color:#e6edf5;
    font-family:Arial,sans-serif;
    min-height:100vh;
}

.app {
    display:grid;
    grid-template-columns:320px 1fr 330px;
    min-height:100vh;
}

@media(max-width:1100px) {
    .app {
        grid-template-columns:280px 1fr;
    }

    .right {
        display:none;
    }
}

@media(max-width:700px) {
    .app {
        grid-template-columns:1fr;
    }

    .left {
        display:none;
    }
}

/* LEFT */

.left {
    background:#0b111b;
    border-right:1px solid #1c2837;
    padding:16px;
    overflow-y:auto;
}

.brand {
    color:#18dca0;
    font-size:18px;
    font-weight:bold;
}

.subtitle {
    color:#68778b;
    font-size:10px;
    margin-top:4px;
    margin-bottom:18px;
}

.live {
    display:flex;
    align-items:center;
    gap:6px;
    font-size:10px;
    color:#18dca0;
    margin-bottom:14px;
}

.dot {
    width:7px;
    height:7px;
    background:#18dca0;
    border-radius:50%;
    box-shadow:0 0 10px #18dca0;
}

.section {
    margin-top:16px;
}

.section-title {
    font-size:10px;
    color:#68778b;
    font-weight:bold;
    margin-bottom:7px;
}

.card {
    background:#101826;
    border:1px solid #1c2939;
    border-radius:9px;
    padding:12px;
    margin-bottom:8px;
    cursor:pointer;
}

.card:hover {
    border-color:#3a526d;
}

.card.long {
    border-left:4px solid #18dca0;
}

.card.short {
    border-left:4px solid #ff4f70;
}

.card.watch {
    border-left-color:#f3c84b;
}

.card.ignition {
    border-left-color:#ff9f43;
}

.card.entry {
    border-left-color:#18dca0;
}

.card.late,
.card.exhaustion {
    border-left-color:#ff4f70;
}

.coinrow {
    display:flex;
    justify-content:space-between;
    align-items:center;
}

.coin {
    font-size:14px;
    font-weight:bold;
}

.direction {
    font-size:9px;
    font-weight:bold;
    padding:4px 7px;
    border-radius:4px;
}

.direction.long {
    color:#18dca0;
    background:#0d382d;
}

.direction.short {
    color:#ff4f70;
    background:#3b1823;
}

.stage {
    margin-top:8px;
    font-size:10px;
    font-weight:bold;
}

.stage.watch {
    color:#f3c84b;
}

.stage.ignition {
    color:#ff9f43;
}

.stage.entry {
    color:#18dca0;
}

.stage.bad {
    color:#ff4f70;
}

.price {
    margin-top:7px;
    font-size:16px;
    font-weight:bold;
}

.meta {
    margin-top:7px;
    color:#78879b;
    font-size:9px;
    line-height:1.6;
}

.timer {
    margin-top:7px;
    color:#dbe5ef;
    font-size:10px;
}

/* MAIN */

.main {
    padding:16px;
    min-width:0;
}

.topbar {
    display:flex;
    justify-content:space-between;
    align-items:center;
    gap:10px;
    margin-bottom:12px;
}

.title {
    font-size:17px;
    font-weight:bold;
}

.connection {
    font-size:10px;
    color:#18dca0;
}

.chartbox {
    background:#0b111b;
    border:1px solid #1a2736;
    border-radius:10px;
    height:calc(100vh - 70px);
    min-height:450px;
    overflow:hidden;
}

.charthead {
    padding:10px 12px;
    border-bottom:1px solid #1a2736;
    display:flex;
    justify-content:space-between;
}

.charttitle {
    font-size:11px;
    font-weight:bold;
}

.tf button {
    background:#101826;
    border:1px solid #1c2939;
    color:#718096;
    border-radius:4px;
    padding:4px 8px;
    margin-left:3px;
    font-size:9px;
}

.tf button.active {
    border-color:#18dca0;
    color:#18dca0;
}

canvas {
    width:100%;
    height:calc(100% - 40px);
}

/* RIGHT */

.right {
    background:#0b111b;
    border-left:1px solid #1c2837;
    padding:15px;
    overflow-y:auto;
}

.box {
    background:#101826;
    border:1px solid #1b2939;
    border-radius:9px;
    padding:12px;
    margin-bottom:10px;
}

.box-title {
    color:#66758a;
    font-size:9px;
    font-weight:bold;
    margin-bottom:7px;
}

.regime {
    font-size:16px;
    font-weight:bold;
}

.regime.long {
    color:#18dca0;
}

.regime.short {
    color:#ff4f70;
}

.detail {
    color:#8492a5;
    font-size:10px;
    line-height:1.7;
}

.bigstage {
    font-size:17px;
    font-weight:bold;
    margin-bottom:5px;
}

.bigstage.entry {
    color:#18dca0;
}

.bigstage.ignition {
    color:#ff9f43;
}

.bigstage.watch {
    color:#f3c84b;
}

.bigstage.bad {
    color:#ff4f70;
}

.levels {
    display:grid;
    grid-template-columns:1fr 1fr;
    gap:6px;
    margin-top:10px;
}

.level {
    background:#0b111b;
    border:1px solid #1a2736;
    border-radius:5px;
    padding:7px;
}

.level span {
    display:block;
    color:#657489;
    font-size:8px;
}

.level b {
    font-size:10px;
}

.level.entry b {
    color:#18dca0;
}

.level.stop b {
    color:#ff4f70;
}

.level.tp b {
    color:#55a8ff;
}

.bar {
    height:6px;
    background:#1b2736;
    border-radius:4px;
    overflow:hidden;
    margin-top:8px;
}

.fill {
    height:100%;
    background:#18dca0;
}

.metric {
    display:flex;
    justify-content:space-between;
    border-bottom:1px solid #172332;
    padding:7px 0;
    font-size:9px;
}

.metric span {
    color:#718096;
}

.metric b {
    color:#dbe5ef;
}

.empty {
    color:#637185;
    font-size:10px;
    text-align:center;
    padding:15px 5px;
}

</style>
</head>

<body>

<div class="app">

<aside class="left">

    <div class="brand">
        ⚡ SONNY AI TRADER
    </div>

    <div class="subtitle">
        MOMENTUM SCALPER • 15M / 5M / 1M
    </div>

    <div class="live">
        <div class="dot"></div>
        CANLI PİYASA
    </div>

    <div class="section">

        <div class="section-title">
            🟢 GİRİŞ FIRSATLARI
        </div>

        <div id="entries">
            <div class="empty">
                Giriş fırsatı bekleniyor...
            </div>
        </div>

    </div>

    <div class="section">

        <div class="section-title">
            🟠 HAREKET BAŞLADI
        </div>

        <div id="ignitions">
            <div class="empty">
                Hareket bekleniyor...
            </div>
        </div>

    </div>

    <div class="section">

        <div class="section-title">
            🟡 İZLE
        </div>

        <div id="watch">
            <div class="empty">
                İzlenecek coin yok
            </div>
        </div>

    </div>

</aside>


<main class="main">

    <div class="topbar">

        <div class="title" id="selectedTitle">
            BTCUSDT
        </div>

        <div
            class="connection"
            id="connection"
        >
            ● BAĞLANIYOR
        </div>

    </div>

    <div class="chartbox">

        <div class="charthead">

            <div
                class="charttitle"
                id="chartTitle"
            >
                BTCUSDT • 15M
            </div>

            <div class="tf">

                <button
                    class="active"
                    data-tf="15m"
                >
                    15D
                </button>

                <button data-tf="5m">
                    5D
                </button>

                <button data-tf="1m">
                    1D
                </button>

            </div>

        </div>

        <canvas id="chart"></canvas>

    </div>

</main>


<aside class="right">

    <div class="box">

        <div class="box-title">
            GENEL PİYASA
        </div>

        <div
            id="regime"
            class="regime"
        >
            YATAY / KARIŞIK
        </div>

        <div
            id="marketInfo"
            class="detail"
        >
            Veriler bekleniyor...
        </div>

    </div>


    <div class="box">

        <div class="box-title">
            CANLI FIRSAT
        </div>

        <div id="signalDetail">

            <div class="empty">
                Bir fırsat seçin
            </div>

        </div>

    </div>


    <div class="box">

        <div class="box-title">
            SİSTEM
        </div>

        <div
            id="systemInfo"
            class="detail"
        >
            Hazırlanıyor...
        </div>

    </div>

</aside>

</div>


<script>

(function(){

let selected =
    'BTC/USDT:USDT';

let timeframe =
    '15m';

let signals = [];

let candles = [];


/* =============================================
   HELPERS
============================================= */

function esc(v){

    return String(
        v == null ? '' : v
    ).replace(
        /[&<>"']/g,
        function(c){

            return {
                '&':'&amp;',
                '<':'&lt;',
                '>':'&gt;',
                '"':'&quot;',
                "'":'&#39;'
            }[c];

        }
    );

}

function p(v){

    const x =
        Number(v);

    if(!Number.isFinite(x))
        return '-';

    if(x >= 1000)
        return x.toFixed(2);

    if(x >= 100)
        return x.toFixed(3);

    if(x >= 1)
        return x.toFixed(5);

    if(x >= .01)
        return x.toFixed(7);

    if(x >= .0001)
        return x.toFixed(8);

    return x.toFixed(10);

}

function formatAge(sec){

    sec =
        Number(sec || 0);

    if(sec < 60)
        return sec + ' sn';

    const m =
        Math.floor(sec / 60);

    const s =
        sec % 60;

    return m + ' dk ' +
        String(s).padStart(2,'0') +
        ' sn';

}

function remaining(ms){

    if(ms <= 0)
        return '0 sn';

    return formatAge(
        Math.floor(ms / 1000)
    );

}


/* =============================================
   SIGNAL CARD
============================================= */

function signalCard(s){

    const stage =
        s.stage;

    let stageClass =
        'watch';

    if(stage === 'IGNITION')
        stageClass =
            'ignition';

    if(stage === 'ENTRY')
        stageClass =
            'entry';

    if(
        stage === 'EXHAUSTION' ||
        stage === 'TOO_LATE'
    )
        stageClass =
            'bad';

    let remainingText =
        '';

    if(
        stage === 'ENTRY' &&
        s.entryWindowEnds
    ){

        remainingText =
            '<div class="timer">' +
            '⏱ Giriş penceresi: ' +
            remaining(
                s.entryWindowEnds -
                Date.now()
            ) +
            '</div>';

    }

    return (

        '<div class="card ' +
        (s.direction === 'LONG'
            ? 'long '
            : 'short ') +
        stageClass +
        '" data-symbol="' +
        esc(s.marketSymbol) +
        '">' +

        '<div class="coinrow">' +

        '<div class="coin">' +
        esc(
            s.symbol
                .replace('/USDT:USDT','')
                .replace('/USDT','')
        ) +
        '</div>' +

        '<div class="direction ' +
        (s.direction === 'LONG'
            ? 'long'
            : 'short') +
        '">' +
        esc(s.direction) +
        '</div>' +

        '</div>' +

        '<div class="stage ' +
        stageClass +
        '">' +
        esc(s.status) +
        '</div>' +

        '<div class="price">' +
        p(s.currentPrice) +
        '</div>' +

        '<div class="meta">' +
        'Momentum: ' +
        esc(s.score) +
        '/100<br>' +

        'Hacim: ' +
        esc(s.volumeRatio) +
        'x • Akış: ' +
        esc(s.flow) +
        '%<br>' +

        'OI: ' +
        esc(s.oiChange) +
        '%<br>' +

        'Sinyal: ' +
        new Date(
            s.signalAt
        ).toLocaleTimeString(
            'tr-TR'
        ) +

        '</div>' +

        remainingText +

        '</div>'
    );

}


/* =============================================
   RENDER
============================================= */

function render(data){

    signals =
        data.signals || [];

    const market =
        data.market || {};

    document
        .getElementById(
            'regime'
        )
        .textContent =
            market.label ||
            'YATAY / KARIŞIK';

    document
        .getElementById(
            'regime'
        )
        .className =
            'regime ' +
            (
                market.direction === 'LONG'
                    ? 'long'
                    : market.direction === 'SHORT'
                        ? 'short'
                        : ''
            );

    document
        .getElementById(
            'marketInfo'
        )
        .innerHTML =
            'Piyasa genişliği: %' +
            esc(market.breadth) +
            '<br>' +
            'Yükselen: ' +
            esc(market.green) +
            ' • Düşen: ' +
            esc(market.red) +
            '<br>' +
            'BTC: ' +
            esc(market.btc) +
            ' • ETH: ' +
            esc(market.eth);

    const entries =
        signals.filter(
            s =>
                s.stage === 'ENTRY'
        );

    const ignitions =
        signals.filter(
            s =>
                s.stage === 'IGNITION'
        );

    const watches =
        signals.filter(
            s =>
                s.stage === 'WATCH'
        );

    document
        .getElementById(
            'entries'
        )
        .innerHTML =
            entries.length
                ? entries
                    .map(signalCard)
                    .join('')
                : '<div class="empty">Giriş fırsatı yok</div>';

    document
        .getElementById(
            'ignitions'
        )
        .innerHTML =
            ignitions.length
                ? ignitions
                    .map(signalCard)
                    .join('')
                : '<div class="empty">Hareket yok</div>';

    document
        .getElementById(
            'watch'
        )
        .innerHTML =
            watches.length
                ? watches
                    .map(signalCard)
                    .join('')
                : '<div class="empty">İzlenecek coin yok</div>';

    document
        .getElementById(
            'connection'
        )
        .textContent =
            data.ws &&
            data.ws.connected
                ? '● CANLI'
                : '● BAĞLANTI YOK';

    document
        .getElementById(
            'connection'
        )
        .style.color =
            data.ws &&
            data.ws.connected
                ? '#18dca0'
                : '#ff4f70';

    document
        .getElementById(
            'systemInfo'
        )
        .innerHTML =
            'Radar: ' +
            esc(data.stats?.universe || 0) +
            '<br>' +
            'Canlı takip: ' +
            esc(data.stats?.live || 0) +
            '<br>' +
            'İzle: ' +
            esc(data.stats?.watching || 0) +
            '<br>' +
            'Hareket başladı: ' +
            esc(data.stats?.ignition || 0) +
            '<br>' +
            'Giriş fırsatı: ' +
            esc(data.stats?.entries || 0) +
            '<br>' +
            'WebSocket: ' +
            (
                data.ws?.connected
                    ? 'Bağlı'
                    : 'Bağlantı bekleniyor'
            );

    bindCards();

    const selectedSignal =
        signals.find(
            s =>
                s.marketSymbol ===
                selected
        ) ||
        entries[0] ||
        ignitions[0] ||
        watches[0] ||
        null;

    if(selectedSignal){

        selected =
            selectedSignal.marketSymbol;

        showSignal(
            selectedSignal
        );

    }

}


/* =============================================
   DETAIL
============================================= */

function showSignal(s){

    if(!s){

        document
            .getElementById(
                'signalDetail'
            )
            .innerHTML =
                '<div class="empty">Fırsat seçin</div>';

        return;

    }

    let cls =
        'watch';

    if(s.stage === 'IGNITION')
        cls = 'ignition';

    if(s.stage === 'ENTRY')
        cls = 'entry';

    if(
        s.stage === 'EXHAUSTION' ||
        s.stage === 'TOO_LATE'
    )
        cls = 'bad';

    let windowText =
        '';

    if(
        s.stage === 'ENTRY' &&
        s.entryWindowEnds
    ){

        windowText =
            '<div class="detail">' +
            '⏱ Giriş penceresi: <b>' +
            remaining(
                s.entryWindowEnds -
                Date.now()
            ) +
            '</b></div>';

    }

    document
        .getElementById(
            'selectedTitle'
        )
        .textContent =
            s.symbol;

    document
        .getElementById(
            'chartTitle'
        )
        .textContent =
            s.symbol +
            ' • ' +
            timeframe.toUpperCase();

    document
        .getElementById(
            'signalDetail'
        )
        .innerHTML =

        '<div class="bigstage ' +
        cls +
        '">' +
        esc(s.status) +
        '</div>' +

        '<div class="detail">' +
        esc(s.symbol) +
        ' • ' +
        esc(s.direction) +
        '<br>' +
        'Sinyal zamanı: ' +
        new Date(
            s.signalAt
        ).toLocaleTimeString(
            'tr-TR'
        ) +
        '<br>' +
        'Sinyal yaşı: ' +
        formatAge(
            s.ageSeconds
        ) +
        '</div>' +

        windowText +

        '<div class="bar">' +
        '<div class="fill" style="width:' +
        Math.min(
            100,
            Number(s.score || 0)
        ) +
        '%"></div>' +
        '</div>' +

        '<div class="detail" style="margin-top:5px">' +
        'Momentum: ' +
        esc(s.score) +
        '/100' +
        '</div>' +

        '<div class="levels">' +

        '<div class="level entry">' +
        '<span>GİRİŞ</span>' +
        '<b>' +
        p(s.entryLow) +
        ' - ' +
        p(s.entryHigh) +
        '</b>' +
        '</div>' +

        '<div class="level stop">' +
        '<span>STOP</span>' +
        '<b>' +
        p(s.stop) +
        '</b>' +
        '</div>' +

        '<div class="level tp">' +
        '<span>HEDEF 1</span>' +
        '<b>' +
        p(s.tp1) +
        '</b>' +
        '</div>' +

        '<div class="level tp">' +
        '<span>HEDEF 2</span>' +
        '<b>' +
        p(s.tp2) +
        '</b>' +
        '</div>' +

        '</div>' +

        '<div style="margin-top:10px">' +

        metric(
            'Fiyat hareketi 30 sn',
            s.priceMove30s + '%'
        ) +

        metric(
            'İşlem akışı',
            s.flow + '%'
        ) +

        metric(
            'Hacim',
            s.volumeRatio + 'x'
        ) +

        metric(
            'OI değişimi',
            s.oiChange + '%'
        ) +

        metric(
            '15M yönü',
            s.contextDirection
        ) +

        metric(
            'Kırılım',
            s.breakout
                ? 'EVET'
                : 'HAYIR'
        ) +

        metric(
            'Sebep',
            s.reason
        ) +

        '</div>';

}

function metric(
    label,
    value
){

    return (
        '<div class="metric">' +
        '<span>' +
        esc(label) +
        '</span>' +
        '<b>' +
        esc(value) +
        '</b>' +
        '</div>'
    );

}


/* =============================================
   CARDS
============================================= */

function bindCards(){

    document
        .querySelectorAll(
            '.card'
        )
        .forEach(
            el => {

                el.onclick =
                    function(){

                        selected =
                            el.getAttribute(
                                'data-symbol'
                            );

                        const s =
                            signals.find(
                                x =>
                                    x.marketSymbol ===
                                    selected
                            );

                        if(s){
                            showSignal(s);
                            loadChart();
                        }

                    };

            }
        );

}


/* =============================================
   CHART
============================================= */

function normalizeCandles(a){

    return (
        a || []
    )
    .map(
        x => {

            if(Array.isArray(x)){

                return {
                    time:+x[0],
                    open:+x[1],
                    high:+x[2],
                    low:+x[3],
                    close:+x[4]
                };

            }

            return x;

        }
    )
    .filter(
        x =>
            Number.isFinite(x.time)
    );

}

async function loadChart(){

    try{

        const response =
            await fetch(
                '/api/chart?symbol=' +
                encodeURIComponent(
                    selected
                ) +
                '&timeframe=' +
                encodeURIComponent(
                    timeframe
                ),
                {
                    cache:'no-store'
                }
            );

        const data =
            await response.json();

        if(
            data.success
        ){

            candles =
                normalizeCandles(
                    data.candles
                );

            draw();

        }

    }catch(_){}

}


/* =============================================
   DRAW
============================================= */

function draw(){

    const canvas =
        document.getElementById(
            'chart'
        );

    const rect =
        canvas.getBoundingClientRect();

    const dpr =
        window.devicePixelRatio ||
        1;

    const width =
        Math.max(
            300,
            Math.floor(
                rect.width
            )
        );

    const height =
        Math.max(
            300,
            Math.floor(
                rect.height
            )
        );

    canvas.width =
        width * dpr;

    canvas.height =
        height * dpr;

    const ctx =
        canvas.getContext('2d');

    ctx.setTransform(
        dpr,
        0,
        0,
        dpr,
        0,
        0
    );

    ctx.fillStyle =
        '#070b11';

    ctx.fillRect(
        0,
        0,
        width,
        height
    );

    if(!candles.length){

        ctx.fillStyle =
            '#66758a';

        ctx.font =
            '12px Arial';

        ctx.fillText(
            'Grafik verisi bekleniyor...',
            15,
            25
        );

        return;

    }

    const visible =
        candles.slice(-100);

    let min =
        Math.min(
            ...visible.map(
                x => x.low
            )
        );

    let max =
        Math.max(
            ...visible.map(
                x => x.high
            )
        );

    const selectedSignal =
        signals.find(
            s =>
                s.marketSymbol ===
                selected
        );

    if(selectedSignal){

        [
            selectedSignal.entry,
            selectedSignal.stop,
            selectedSignal.tp1,
            selectedSignal.tp2
        ].forEach(
            x => {

                if(
                    Number.isFinite(
                        Number(x)
                    )
                ){

                    min =
                        Math.min(
                            min,
                            Number(x)
                        );

                    max =
                        Math.max(
                            max,
                            Number(x)
                        );

                }

            }
        );

    }

    const padding =
        (max - min) *
        0.08 || 1;

    min -= padding;
    max += padding;

    const L = 50;
    const R = 70;
    const T = 15;
    const B = 15;

    const PW =
        width - L - R;

    const PH =
        height - T - B;

    function Y(v){

        return (
            T +
            (max - v) /
            (max - min) *
            PH
        );

    }

    function X(i){

        return (
            L +
            i *
            PW /
            Math.max(
                1,
                visible.length - 1
            )
        );

    }

    ctx.strokeStyle =
        '#182432';

    for(
        let i=0;
        i<=4;
        i++
    ){

        const y =
            T +
            PH *
            i /
            4;

        ctx.beginPath();

        ctx.moveTo(
            L,
            y
        );

        ctx.lineTo(
            width - R,
            y
        );

        ctx.stroke();

    }

    const step =
        PW /
        Math.max(
            1,
            visible.length - 1
        );

    const bodyWidth =
        Math.max(
            2,
            Math.min(
                8,
                step * .6
            )
        );

    visible.forEach(
        (c, i) => {

            const x =
                X(i);

            const up =
                c.close >=
                c.open;

            ctx.strokeStyle =
                up
                    ? '#18dca0'
                    : '#ff4f70';

            ctx.fillStyle =
                ctx.strokeStyle;

            ctx.beginPath();

            ctx.moveTo(
                x,
                Y(c.high)
            );

            ctx.lineTo(
                x,
                Y(c.low)
            );

            ctx.stroke();

            const openY =
                Y(c.open);

            const closeY =
                Y(c.close);

            ctx.fillRect(
                x - bodyWidth / 2,
                Math.min(
                    openY,
                    closeY
                ),
                bodyWidth,
                Math.max(
                    1,
                    Math.abs(
                        closeY -
                        openY
                    )
                )
            );

        }
    );

    if(selectedSignal){

        line(
            selectedSignal.entry,
            '#18dca0',
            'GİRİŞ'
        );

        line(
            selectedSignal.stop,
            '#ff4f70',
            'STOP'
        );

        line(
            selectedSignal.tp1,
            '#55a8ff',
            'HEDEF 1'
        );

        line(
            selectedSignal.tp2,
            '#55a8ff',
            'HEDEF 2'
        );

    }

    function line(
        value,
        color,
        label
    ){

        if(
            !Number.isFinite(
                Number(value)
            )
        )
            return;

        const y =
            Y(Number(value));

        ctx.strokeStyle =
            color;

        ctx.setLineDash(
            [5,5]
        );

        ctx.beginPath();

        ctx.moveTo(
            L,
            y
        );

        ctx.lineTo(
            width - R,
            y
        );

        ctx.stroke();

        ctx.setLineDash([]);

        ctx.fillStyle =
            color;

        ctx.font =
            'bold 9px Arial';

        ctx.fillText(
            label +
            ' ' +
            p(value),
            width - R + 4,
            y + 3
        );

    }

}


/* =============================================
   LIVE CLOCK
============================================= */

setInterval(
    function(){

        signals.forEach(
            s => {

                s.ageSeconds =
                    Math.floor(
                        (
                            Date.now() -
                            s.signalAt
                        ) / 1000
                    );

            }
        );

        const selectedSignal =
            signals.find(
                s =>
                    s.marketSymbol ===
                    selected
            );

        if(selectedSignal){

            showSignal(
                selectedSignal
            );

        }

    },
    1000
);


/* =============================================
   TIMEFRAME
============================================= */

document
    .querySelectorAll(
        '[data-tf]'
    )
    .forEach(
        button => {

            button.onclick =
                function(){

                    document
                        .querySelectorAll(
                            '[data-tf]'
                        )
                        .forEach(
                            x =>
                                x.classList
                                    .remove(
                                        'active'
                                    )
                        );

                    button.classList
                        .add(
                            'active'
                        );

                    timeframe =
                        button.getAttribute(
                            'data-tf'
                        );

                    loadChart();

                };

        }
    );


/* =============================================
   FRONTEND WS
============================================= */

function connect(){

    const protocol =
        location.protocol === 'https:'
            ? 'wss://'
            : 'ws://';

    const ws =
        new WebSocket(
            protocol +
            location.host
        );

    ws.onmessage =
        function(event){

            try{

                const message =
                    JSON.parse(
                        event.data
                    );

                if(
                    message.type ===
                    'snapshot'
                ){

                    render(
                        message.data
                    );

                }

            }catch(_){}

        };

    ws.onclose =
        function(){

            setTimeout(
                connect,
                2000
            );

        };

}

connect();

loadChart();

window.addEventListener(
    'resize',
    draw
);

})();

</script>

</body>
</html>
`;

/* ======================================================
   ROUTES
====================================================== */

app.get(
    '/',
    (req, res) => {
        res
            .type('html')
            .send(HTML);
    }
);

/* ======================================================
   ERRORS
====================================================== */

process.on(
    'unhandledRejection',
    err => {

        STATE.lastError =
            err?.message ||
            String(err);

        console.error(
            'UNHANDLED:',
            err
        );

    }
);

process.on(
    'uncaughtException',
    err => {

        STATE.lastError =
            err?.message ||
            String(err);

        console.error(
            'UNCAUGHT:',
            err
        );

    }
);

/* ======================================================
   START
====================================================== */

server.listen(
    PORT,
    '0.0.0.0',
    async () => {

        console.log(
            '=============================================='
        );

        console.log(
            '🚀 SONNY AI TRADER'
        );

        console.log(
            '🔥 MOMENTUM SCALPER V2'
        );

        console.log(
            '📡 Bitget USDT Futures'
        );

        console.log(
            '🟡 İZLE'
        );

        console.log(
            '🟠 HAREKET BAŞLADI'
        );

        console.log(
            '🟢 GİRİŞ FIRSATI'
        );

        console.log(
            '🔴 MOMENTUM ZAYIFLIYOR'
        );

        console.log(
            '=============================================='
        );

        try {

            await loadMarketsRetry();

            await discoverUniverse();

            await refreshContexts();

            connectBitgetWS();

            startWsHeartbeat();

            /*
            Radar yenileme
            */
            setInterval(
                async () => {

                    await discoverUniverse();

                    if(
                        bitgetWs &&
                        bitgetWs.readyState ===
                        WebSocket.OPEN
                    ){

                        wsSendSubscriptions(
                            bitgetWs
                        );

                    }

                },
                CFG.DISCOVERY_MS
            );

            /*
            15M bağlam yenileme
            */
            setInterval(
                async () => {

                    await refreshContexts();

                },
                CFG.CONTEXT_REFRESH_MS
            );

            /*
            Temizlik
            */
            setInterval(
                () => {

                    cleanup();
                    scheduleBroadcast();

                },
                1000
            );

            console.log(
                '🟢 SİSTEM BAŞLADI'
            );

        } catch (err) {

            STATE.lastError =
                err.message;

            console.error(
                'BOOT ERROR:',
                err
            );

        }

    }
);
