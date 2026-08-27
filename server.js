'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = Number(process.env.PORT || 10000);

app.use(express.json());

/* =========================================================
   SONNY AI TRADER FINAL
   BITGET USDT FUTURES
   500 RADAR
   150 CANDIDATE
   40 DEEP
   4H + 2H
   15M BREAKOUT
   RETEST
   5M BONUS
========================================================= */

const CFG = {
    RADAR: 500,
    CANDIDATES: 150,
    DEEP: 40,

    MAX_SIGNALS: 15,

    MIN_VOLUME_USDT: 750000,

    SCAN_MS: 60000,

    CONCURRENCY: 5,

    H1_LIMIT: 220,
    M15_LIMIT: 180,
    M5_LIMIT: 120,
    CHART_LIMIT: 160,

    MIN_SCORE: 60,
    MIN_RR: 1.20,

    TP2_RR: 2.00,
    TP3_RR: 3.00,

    ATR_STOP: 1.00,

    RETEST_TOL: 0.008,

    REQUIRE_5M: false
};

/* =========================================================
   BITGET
========================================================= */

const exchange = new ccxt.bitget({
    enableRateLimit: true,
    timeout: 25000,
    options: {
        defaultType: 'swap'
    }
});

/* =========================================================
   STATE
========================================================= */

const STATE = {
    markets: [],
    marketMap: new Map(),

    universe: [],
    candidates: [],
    deep: [],

    pending: new Map(),
    signals: new Map(),

    selected: null,

    timeframe: '15m',

    scanning: false,
    ready: false,

    lastScan: 0,
    lastError: null,

    stats: {
        universe: 0,
        candidates: 0,
        deep: 0,
        analyzed: 0,
        pending: 0,
        signals: 0,
        errors: 0
    },

    market: {
        label: 'YATAY / KARIŞIK',
        direction: 'FLAT',
        breadth: 50,
        green: 0,
        red: 0,
        average: 0
    },

    chart: {
        symbol: null,
        timeframe: '15m',
        candles: [],
        signal: null
    }
};

/* =========================================================
   CACHE
========================================================= */

const cache = new Map();

/* =========================================================
   HELPERS
========================================================= */

function n(value, fallback = 0) {
    const x = Number(value);

    return Number.isFinite(x)
        ? x
        : fallback;
}

function sym(symbol) {
    let s = String(symbol || '')
        .toUpperCase()
        .replace('/USDT:USDT', '')
        .replace('/USDT', '')
        .replace(':USDT', '');

    if (!s.endsWith('USDT')) {
        s += 'USDT';
    }

    return s;
}

function fmt(value) {
    const x = Number(value);

    if (!Number.isFinite(x)) {
        return '-';
    }

    if (x >= 1000) {
        return x.toFixed(2);
    }

    if (x >= 100) {
        return x.toFixed(3);
    }

    if (x >= 1) {
        return x.toFixed(5);
    }

    if (x >= 0.01) {
        return x.toFixed(7);
    }

    if (x >= 0.0001) {
        return x.toFixed(8);
    }

    return x.toFixed(10);
}

function avg(values) {
    if (!values.length) {
        return 0;
    }

    return values.reduce(
        (a, b) => a + b,
        0
    ) / values.length;
}

function closed(candles) {
    if (!Array.isArray(candles)) {
        return [];
    }

    return candles.length > 1
        ? candles.slice(0, -1)
        : candles;
}

/* =========================================================
   MARKET LOOKUP
========================================================= */

function findMarket(symbol) {

    const target = sym(symbol);

    if (
        STATE.marketMap &&
        STATE.marketMap.has(target)
    ) {
        return STATE.marketMap.get(target);
    }

    return (
        STATE.markets || []
    ).find(
        market =>
            sym(
                market?.symbol || market
            ) === target
    ) || null;
}

/* =========================================================
   LOAD REAL USDT PERPETUAL MARKETS
========================================================= */

async function loadMarkets() {

    const all =
        await exchange.loadMarkets(true);

    const result = [];

    for (
        const market
        of Object.values(all)
    ) {

        if (!market) {
            continue;
        }

        if (
            market.active === false
        ) {
            continue;
        }

        if (
            market.swap !== true
        ) {
            continue;
        }

        if (
            market.linear !== true
        ) {
            continue;
        }

        if (
            market.quote !== 'USDT'
        ) {
            continue;
        }

        if (
            market.settle !== 'USDT'
        ) {
            continue;
        }

        result.push(market);
    }

    STATE.markets = result;

    STATE.marketMap =
        new Map(
            result.map(
                market => [
                    sym(market.symbol),
                    market
                ]
            )
        );

    console.log(
        'MARKETS | Gerçek USDT perpetual=' +
        STATE.markets.length
    );
}

/* =========================================================
   CANDLE DATA
========================================================= */

async function candles(
    symbol,
    timeframe,
    limit
) {

    const market =
        findMarket(symbol);

    if (!market) {
        return [];
    }

    const key =
        market.symbol +
        '|' +
        timeframe +
        '|' +
        limit;

    const old =
        cache.get(key);

    if (
        old &&
        Date.now() - old.time < 8000
    ) {
        return old.data;
    }

    const raw =
        await exchange.fetchOHLCV(
            market.symbol,
            timeframe,
            undefined,
            limit
        );

    const data =
        (raw || [])
            .map(row => [
                n(row[0]),
                n(row[1]),
                n(row[2]),
                n(row[3]),
                n(row[4]),
                n(row[5])
            ])
            .sort(
                (a, b) =>
                    a[0] - b[0]
            );

    cache.set(
        key,
        {
            time: Date.now(),
            data
        }
    );

    return data;
}

/* =========================================================
   INDICATORS
========================================================= */

function ema(
    candlesData,
    period
) {

    const c =
        closed(candlesData);

    if (
        c.length < period
    ) {
        return null;
    }

    let value =
        avg(
            c
                .slice(0, period)
                .map(x => x[4])
        );

    const k =
        2 / (period + 1);

    for (
        let i = period;
        i < c.length;
        i++
    ) {

        value =
            c[i][4] * k +
            value * (1 - k);
    }

    return value;
}

function rsi(
    candlesData,
    period = 14
) {

    const c =
        closed(candlesData);

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
        i < c.length;
        i++
    ) {

        const diff =
            c[i][4] -
            c[i - 1][4];

        if (diff > 0) {
            gains += diff;
        }
        else {
            losses +=
                Math.abs(diff);
        }
    }

    if (losses === 0) {
        return 100;
    }

    const rs =
        gains / losses;

    return 100 -
        100 / (1 + rs);
}

function atr(
    candlesData,
    period = 14
) {

    const c =
        closed(candlesData);

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
                c[i][2] - c[i][3],
                Math.abs(
                    c[i][2] -
                    c[i - 1][4]
                ),
                Math.abs(
                    c[i][3] -
                    c[i - 1][4]
                )
            )
        );
    }

    const last =
        values.slice(-period);

    return avg(last);
}

function trend(candlesData) {

    const e20 =
        ema(candlesData, 20);

    const e50 =
        ema(candlesData, 50);

    const c =
        closed(candlesData);

    const price =
        c.at(-1)?.[4] || 0;

    if (
        !e20 ||
        !e50 ||
        !price
    ) {
        return 'FLAT';
    }

    if (
        price > e20 &&
        e20 > e50
    ) {
        return 'LONG';
    }

    if (
        price < e20 &&
        e20 < e50
    ) {
        return 'SHORT';
    }

    return 'FLAT';
}

/* =========================================================
   UNIVERSE
========================================================= */

async function fetchUniverse() {

    const tickers =
        await exchange.fetchTickers();

    const rows = [];

    for (
        const market
        of STATE.markets
    ) {

        const ticker =
            tickers[
                market.symbol
            ];

        if (!ticker) {
            continue;
        }

        const price =
            n(
                ticker.last ||
                ticker.close
            );

        const volume =
            n(
                ticker.quoteVolume
            );

        const change =
            n(
                ticker.percentage
            );

        const high =
            n(ticker.high);

        const low =
            n(ticker.low);

        if (
            price <= 0 ||
            volume <
            CFG.MIN_VOLUME_USDT
        ) {
            continue;
        }

        const range =
            low > 0
                ? (
                    (high - low) /
                    low
                ) * 100
                : 0;

        const activity =
            volume *
            (
                1 +
                Math.min(
                    Math.abs(change),
                    30
                ) / 100
            );

        rows.push({
            symbol: market.symbol,
            price,
            volume,
            change,
            range,
            activity
        });
    }

    rows.sort(
        (a, b) =>
            b.activity -
            a.activity
    );

    return rows.slice(
        0,
        CFG.RADAR
    );
}

/* =========================================================
   SIGNAL SCORE
========================================================= */

function calculateScore(data) {

    let score = 0;

    if (
        data.t4 ===
        data.direction
    ) {
        score += 22;
    }

    if (
        data.t2 ===
        data.direction
    ) {
        score += 22;
    }

    if (
        data.breakout
    ) {
        score += 20;
    }

    if (
        data.retest
    ) {
        score += 15;
    }

    if (
        data.volumeRatio >= 1.25
    ) {
        score += 10;
    }
    else if (
        data.volumeRatio >= 1.05
    ) {
        score += 6;
    }

    if (
        data.rr >= CFG.MIN_RR
    ) {
        score += 11;
    }

    return Math.min(
        100,
        score
    );
}

/* =========================================================
   TRADE PLAN
========================================================= */

function createTradePlan(
    symbol,
    direction,
    level,
    data
) {

    const atrValue =
        atr(data.c15);

    const stopDistance =
        Math.max(
            atrValue *
            CFG.ATR_STOP,
            level * 0.003
        );

    const stopLoss =
        direction === 'LONG'
            ? level - stopDistance
            : level + stopDistance;

    const risk =
        Math.abs(
            level -
            stopLoss
        );

    const tp1 =
        direction === 'LONG'
            ? level +
              risk * CFG.MIN_RR
            : level -
              risk * CFG.MIN_RR;

    const tp2 =
        direction === 'LONG'
            ? level +
              risk * CFG.TP2_RR
            : level -
              risk * CFG.TP2_RR;

    const tp3 =
        direction === 'LONG'
            ? level +
              risk * CFG.TP3_RR
            : level -
              risk * CFG.TP3_RR;

    const tolerance =
        level *
        CFG.RETEST_TOL;

    return {

        symbol:
            sym(symbol),

        marketSymbol:
            symbol,

        direction,

        entry:
            level,

        entryLow:
            direction === 'LONG'
                ? level - tolerance
                : level - tolerance,

        entryHigh:
            direction === 'LONG'
                ? level + tolerance
                : level + tolerance,

        stopLoss,

        tp1,
        tp2,
        tp3,

        score:
            data.score,

        rr:
            CFG.MIN_RR,

        rsi:
            Number(
                data.rsi.toFixed(2)
            ),

        reason:
            data.reason,

        createdAt:
            Date.now()
    };
}

/* =========================================================
   ANALYZE ONE SYMBOL
========================================================= */

async function analyze(row) {

    const symbol =
        row.symbol;

    const c4 =
        await candles(
            symbol,
            '4h',
            80
        );

    const c2 =
        await candles(
            symbol,
            '2h',
            80
        );

    const c15 =
        await candles(
            symbol,
            '15m',
            CFG.M15_LIMIT
        );

    const c5 =
        await candles(
            symbol,
            '5m',
            CFG.M5_LIMIT
        );

    if (
        c15.length < 50
    ) {
        return null;
    }

    const t4 =
        trend(c4);

    const t2 =
        trend(c2);

    const t5 =
        trend(c5);

    const c =
        closed(c15);

    const last =
        c.at(-1);

    if (!last) {
        return null;
    }

    const look =
        c.slice(
            -25,
            -1
        );

    if (!look.length) {
        return null;
    }

    const highest =
        Math.max(
            ...look.map(
                x => x[2]
            )
        );

    const lowest =
        Math.min(
            ...look.map(
                x => x[3]
            )
        );

    const volumeAverage =
        avg(
            look
                .slice(-20)
                .map(
                    x => x[5]
                )
        );

    const volumeRatio =
        volumeAverage > 0
            ? last[5] /
              volumeAverage
            : 0;

    let direction = null;
    let level = 0;

    if (
        last[4] >
        highest
    ) {

        direction =
            'LONG';

        level =
            highest;
    }

    else if (
        last[4] <
        lowest
    ) {

        direction =
            'SHORT';

        level =
            lowest;
    }

    if (!direction) {
        return null;
    }

    const tolerance =
        level *
        CFG.RETEST_TOL;

    const recent =
        c.slice(-9);

    const retest =
        recent.some(
            candle =>
                candle[3] <=
                    level +
                    tolerance &&
                candle[2] >=
                    level -
                    tolerance
        );

    if (!retest) {
        return null;
    }

    if (
        CFG.REQUIRE_5M &&
        t5 !== direction
    ) {
        return null;
    }

    const data = {

        c15,

        t4,
        t2,

        direction,

        breakout: true,

        retest,

        volumeRatio,

        rr:
            CFG.MIN_RR,

        rsi:
            rsi(c15),

        reason:
            `4H ${t4} • ` +
            `2H ${t2} • ` +
            `15M BREAKOUT • ` +
            `RETEST • ` +
            `5M ${t5}`
    };

    data.score =
        calculateScore(data);

    if (
        data.score <
        CFG.MIN_SCORE
    ) {
        return null;
    }

    return createTradePlan(
        symbol,
        direction,
        level,
        data
    );
}

/* =========================================================
   RADAR
========================================================= */

async function runScan() {

    if (STATE.scanning) {
        return;
    }

    STATE.scanning = true;

    STATE.stats = {
        universe: 0,
        candidates: 0,
        deep: 0,
        analyzed: 0,
        pending: 0,
        signals: 0,
        errors: 0
    };

    try {

        STATE.universe =
            await fetchUniverse();

        STATE.stats.universe =
            STATE.universe.length;

        STATE.candidates =
            STATE.universe.slice(
                0,
                CFG.CANDIDATES
            );

        STATE.stats.candidates =
            STATE.candidates.length;

        STATE.deep =
            STATE.candidates.slice(
                0,
                CFG.DEEP
            );

        STATE.stats.deep =
            STATE.deep.length;

        const results = [];

        for (
            let i = 0;
            i < STATE.deep.length;
            i += CFG.CONCURRENCY
        ) {

            const batch =
                STATE.deep.slice(
                    i,
                    i + CFG.CONCURRENCY
                );

            const analyzed =
                await Promise.all(
                    batch.map(
                        item =>
                            analyze(item)
                                .catch(error => {

                                    STATE.stats.errors++;

                                    console.error(
                                        'ANALİZ ERROR |',
                                        item.symbol,
                                        '|',
                                        error.message
                                    );

                                    return null;
                                })
                    )
                );

            results.push(
                ...analyzed.filter(Boolean)
            );
        }

        STATE.stats.analyzed =
            STATE.deep.length;

        for (
            const signal
            of results
        ) {

            STATE.signals.set(
                signal.symbol,
                signal
            );

            console.log(
                'SIGNAL | ' +
                signal.symbol +
                ' | ' +
                signal.direction +
                ' | SCORE ' +
                signal.score +
                ' | RR 1:' +
                signal.rr
            );
        }

        STATE.stats.pending = 0;

        STATE.stats.signals =
            STATE.signals.size;

        STATE.lastScan =
            Date.now();

        STATE.ready = true;

        if (
            !STATE.chart.symbol
        ) {

            STATE.chart.symbol =
                STATE.selected ||
                results[0]?.symbol ||
                STATE.universe[0]?.symbol ||
                null;
        }

        if (
            STATE.chart.symbol
        ) {

            await updateChart(
                STATE.chart.symbol,
                STATE.timeframe
            );
        }

        console.log(
            'RADAR tamamlandı | ' +
            'Universe=' +
            STATE.stats.universe +
            ' | Candidates=' +
            STATE.stats.candidates +
            ' | Deep=' +
            STATE.stats.deep +
            ' | Analiz=' +
            STATE.stats.analyzed +
            ' | Pending=0' +
            ' | SIGNAL=' +
            STATE.stats.signals +
            ' | ERR=' +
            STATE.stats.errors
        );

        broadcast();

    }

    catch (error) {

        STATE.lastError =
            error.message;

        console.error(
            'RADAR ERROR:',
            error.message
        );
    }

    finally {

        STATE.scanning =
            false;
    }
}

/* =========================================================
   CHART
========================================================= */

async function updateChart(
    symbol,
    timeframe = '15m'
) {

    try {

        const market =
            findMarket(symbol);

        if (!market) {
            return;
        }

        const data =
            await candles(
                market.symbol,
                timeframe,
                CFG.CHART_LIMIT
            );

        STATE.chart = {

            symbol:
                market.symbol,

            timeframe,

            candles:
                data,

            signal:
                STATE.signals.get(
                    sym(
                        market.symbol
                    )
                ) || null
        };

        broadcast();

    }

    catch (error) {

        console.error(
            'CHART ERROR:',
            error.message
        );
    }
}

/* =========================================================
   PUBLIC SIGNAL
========================================================= */

function publicSignal(signal) {

    if (!signal) {
        return null;
    }

    return {

        symbol:
            signal.symbol,

        direction:
            signal.direction,

        score:
            signal.score,

        entry:
            fmt(signal.entry),

        entryZone:
            fmt(signal.entryLow) +
            ' - ' +
            fmt(signal.entryHigh),

        stopLoss:
            fmt(signal.stopLoss),

        tp1:
            fmt(signal.tp1),

        tp2:
            fmt(signal.tp2),

        tp3:
            fmt(signal.tp3),

        rr:
            signal.rr,

        rsi:
            signal.rsi,

        reason:
            signal.reason,

        createdAt:
            signal.createdAt
    };
}

/* =========================================================
   STATUS
========================================================= */

function statusData() {

    return {

        success: true,

        ready:
            STATE.ready,

        scanning:
            STATE.scanning,

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
                STATE.signals.size,

            errors:
                STATE.stats.errors
        },

        market:
            STATE.market,

        signals:
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
                ),

        chart: {

            symbol:
                STATE.chart.symbol,

            timeframe:
                STATE.chart.timeframe,

            candles:
                STATE.chart.candles,

            signal:
                publicSignal(
                    STATE.chart.signal
                )
        }
    };
}

/* =========================================================
   BROADCAST
========================================================= */

function broadcast() {

    const packet =
        JSON.stringify({
            type: 'snapshot',
            data:
                statusData()
        });

    wss.clients.forEach(
        client => {

            if (
                client.readyState ===
                WebSocket.OPEN
            ) {

                client.send(
                    packet
                );
            }
        }
    );
}

/* =========================================================
   HTML
   SERVER İÇİNDE
========================================================= */

const INDEX = `<!doctype html>
<html lang="tr">

<head>

<meta charset="utf-8">

<meta
    name="viewport"
    content="width=device-width,initial-scale=1"
>

<title>SONNY AI TRADER</title>

<script src="https://cdn.jsdelivr.net/npm/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js"></script>

<style>

* {
    box-sizing: border-box;
}

body {
    margin: 0;
    background: #0b0e14;
    color: #e5e7eb;
    font-family: Arial, sans-serif;
}

.app {
    display: grid;
    grid-template-columns: 330px 1fr;
    height: 100vh;
}

.side {
    padding: 16px;
    background: #101522;
    overflow-y: auto;
}

.title {
    font-size: 20px;
    font-weight: 700;
    color: #00e5ff;
    margin-bottom: 15px;
}

.sig {
    padding: 13px;
    margin: 9px 0;
    background: #171e2d;
    border-left: 4px solid #64748b;
    border-radius: 8px;
    cursor: pointer;
}

.sig:hover {
    background: #1c2638;
}

.sig.LONG {
    border-color: #16c784;
}

.sig.SHORT {
    border-color: #ea3943;
}

.sym {
    font-size: 16px;
    font-weight: 700;
}

.score {
    float: right;
}

.chartbox {
    padding: 14px;
    display: flex;
    flex-direction: column;
    min-width: 0;
}

.panel {
    background: #111827;
    border-radius: 10px;
    padding: 12px;
    margin-bottom: 12px;
}

.levels {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 12px;
}

.lv {
    padding: 8px 12px;
    background: #182132;
    border-radius: 6px;
}

.entry {
    border: 1px solid #00e5ff;
}

.tp {
    color: #16c784;
}

.sl {
    color: #ea3943;
}

#chart {
    flex: 1;
    min-height: 450px;
}

@media(max-width:800px) {

    .app {
        grid-template-columns: 1fr;
        height: auto;
    }

    .side {
        max-height: 380px;
    }

    #chart {
        height: 550px;
    }
}

</style>

</head>

<body>

<div class="app">

<aside class="side">

<div class="title">
⚡ SONNY AI TRADER
</div>

<div id="stats">
Radar hazırlanıyor...
</div>

<div id="signals"></div>

</aside>

<main class="chartbox">

<div
    class="panel"
    id="detail"
>
Bir sinyal seç.
</div>

<div id="chart"></div>

</main>

</div>

<script>

let DATA = null;
let chart = null;
let series = null;

const $ = id =>
    document.getElementById(id);

/* =========================
   CHART
========================= */

function initChart() {

    chart =
        LightweightCharts.createChart(
            $('chart'),
            {
                layout: {
                    background: {
                        color: '#0b0e14'
                    },
                    textColor:
                        '#8a99ad'
                },

                grid: {
                    vertLines: {
                        color:
                            '#18202d'
                    },
                    horzLines: {
                        color:
                            '#18202d'
                    }
                },

                rightPriceScale: {
                    borderColor:
                        '#263244'
                },

                timeScale: {
                    borderColor:
                        '#263244'
                }
            }
        );

    series =
        chart.addCandlestickSeries({
            upColor:
                '#16c784',

            downColor:
                '#ea3943',

            borderUpColor:
                '#16c784',

            borderDownColor:
                '#ea3943',

            wickUpColor:
                '#16c784',

            wickDownColor:
                '#ea3943'
        });

    window.addEventListener(
        'resize',
        () => {

            chart.resize(
                $('chart').clientWidth,
                $('chart').clientHeight
            );
        }
    );
}

/* =========================
   RENDER
========================= */

function render() {

    if (!DATA) {
        return;
    }

    const stats =
        DATA.stats || {};

    $('stats').innerText =
        stats.universe +
        ' Tarandı • ' +
        stats.candidates +
        ' Aday • ' +
        stats.signals +
        ' Aktif Sinyal';

    const signals =
        DATA.signals || [];

    $('signals').innerHTML =
        signals
            .map(
                (x, i) =>

                    '<div class="sig ' +
                    x.direction +
                    '" onclick="selectSignal(' +
                    i +
                    ')">' +

                    '<span class="sym">' +
                    x.symbol +
                    '</span>' +

                    '<span class="score">' +
                    x.direction +
                    ' • ' +
                    x.score +
                    '</span>' +

                    '<div>Giriş: ' +
                    x.entryZone +
                    '</div>' +

                    '<div>SL: ' +
                    x.stopLoss +
                    '</div>' +

                    '<div>TP1: ' +
                    x.tp1 +
                    '</div>' +

                    '</div>'
            )
            .join('');

    const chartData =
        DATA.chart;

    if (
        chartData &&
        chartData.candles &&
        chartData.candles.length
    ) {

        series.setData(
            chartData.candles.map(
                x => ({
                    time:
                        Math.floor(
                            x[0] / 1000
                        ),

                    open:
                        x[1],

                    high:
                        x[2],

                    low:
                        x[3],

                    close:
                        x[4]
                })
            )
        );

        chart.timeScale()
            .fitContent();
    }

    if (
        chartData &&
        chartData.signal
    ) {

        showSignal(
            chartData.signal
        );
    }
}

/* =========================
   SIGNAL DETAIL
========================= */

function showSignal(x) {

    $('detail').innerHTML =

        '<b>' +
        x.symbol +
        ' — ' +
        x.direction +
        '</b>' +

        '<span class="score">' +
        'SKOR ' +
        x.score +
        '</span>' +

        '<div class="levels">' +

        '<div class="lv entry">' +
        'GİRİŞ<br>' +
        x.entryZone +
        '</div>' +

        '<div class="lv sl">' +
        'STOP<br>' +
        x.stopLoss +
        '</div>' +

        '<div class="lv tp">' +
        'TP1<br>' +
        x.tp1 +
        '</div>' +

        '<div class="lv tp">' +
        'TP2<br>' +
        x.tp2 +
        '</div>' +

        '<div class="lv tp">' +
        'TP3<br>' +
        x.tp3 +
        '</div>' +

        '</div>' +

        '<small>' +
        (x.reason || '') +
        '</small>';

    try {

        series.createPriceLine({
            price:
                Number(x.entry),

            color:
                '#00e5ff',

            lineWidth: 2,

            title:
                'ENTRY'
        });

        series.createPriceLine({
            price:
                Number(x.stopLoss),

            color:
                '#ea3943',

            lineWidth: 2,

            title:
                'STOP'
        });

        series.createPriceLine({
            price:
                Number(x.tp1),

            color:
                '#16c784',

            lineWidth: 1,

            title:
                'TP1'
        });

        series.createPriceLine({
            price:
                Number(x.tp2),

            color:
                '#16c784',

            lineWidth: 1,

            title:
                'TP2'
        });

        series.createPriceLine({
            price:
                Number(x.tp3),

            color:
                '#16c784',

            lineWidth: 1,

            title:
                'TP3'
        });

    }
    catch (e) {}

}

/* =========================
   SELECT
========================= */

function selectSignal(index) {

    const signal =
        DATA.signals[index];

    if (!signal) {
        return;
    }

    showSignal(signal);

    fetch(
        '/api/chart?symbol=' +
        encodeURIComponent(
            signal.symbol
        ) +
        '&timeframe=15m'
    )
        .catch(() => {});
}

/* =========================
   WEBSOCKET
========================= */

function connect() {

    const protocol =
        location.protocol === 'https:'
            ? 'wss:'
            : 'ws:';

    const ws =
        new WebSocket(
            protocol +
            '://' +
            location.host
        );

    ws.onmessage =
        event => {

            try {

                const packet =
                    JSON.parse(
                        event.data
                    );

                DATA =
                    packet.data;

                render();

            }
            catch (e) {}
        };

    ws.onclose =
        () => {

            setTimeout(
                connect,
                2000
            );
        };
}

initChart();
connect();

</script>

</body>

</html>`;

/* =========================================================
   ROUTES
========================================================= */

app.get(
    '/',
    (req, res) => {

        res
            .type('html')
            .send(INDEX);
    }
);

app.get(
    '/api/status',
    (req, res) => {

        res.json(
            statusData()
        );
    }
);

app.get(
    '/api/chart',
    async (req, res) => {

        const symbol =
            req.query.symbol ||
            STATE.selected ||
            'BTCUSDT';

        const timeframe =
            req.query.timeframe ||
            '15m';

        await updateChart(
            symbol,
            timeframe
        );

        res.json({

            success: true,

            symbol:
                STATE.chart.symbol,

            timeframe:
                STATE.chart.timeframe,

            candles:
                STATE.chart.candles,

            signal:
                publicSignal(
                    STATE.chart.signal
                )
        });
    }
);

/* =========================================================
   WEBSOCKET
========================================================= */

wss.on(
    'connection',
    client => {

        client.send(
            JSON.stringify({
                type:
                    'snapshot',

                data:
                    statusData()
            })
        );
    }
);

/* =========================================================
   START
========================================================= */

async function start() {

    console.log(
        '================================================='
    );

    console.log(
        '🚀 SONNY AI TRADER FINAL'
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
        '📊 4H + 2H → 15M Breakout → Retest → 5M BONUS'
    );

    console.log(
        '💰 Minimum Volume: $750000'
    );

    console.log(
        '🎯 Minimum R:R: 1:1.2'
    );

    console.log(
        '⏱️ Scan: 60 sec'
    );

    console.log(
        '🤖 Auto Trade: KAPALI'
    );

    console.log(
        '================================================='
    );

    try {

        await loadMarkets();

        await runScan();

    }
    catch (error) {

        STATE.lastError =
            error.message;

        console.error(
            'INITIALIZE ERROR:',
            error.message
        );
    }

    server.listen(
        PORT,
        () => {

            console.log(
                '🌐 Server listening on ' +
                PORT
            );
        }
    );
}

/* =========================================================
   REPEATED RADAR
========================================================= */

setInterval(
    () => {

        runScan()
            .catch(
                error =>
                    console.error(
                        'SCAN ERROR:',
                        error.message
                    )
            );

    },
    CFG.SCAN_MS
);

start();
