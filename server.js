const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

const SYSTEM_NAME = "Sonny AI Signal Scanner";
const VERSION = "2.0.0";

const BITGET_BASE = "https://api.bitget.com";

// ======================================================
// STATE
// ======================================================

const state = {
    startedAt: Date.now(),

    lastUniverseScan: null,
    lastMarketScan: null,

    universe: [],
    candidates: [],
    signals: [],

    scanning: false,

    stats: {
        totalSymbols: 0,
        liquidSymbols: 0,
        dnaCandidates: 0,
        setups: 0,
        signals: 0
    }
};

// ======================================================
// LOG
// ======================================================

function log(message) {
    console.log(
        `[${new Date().toISOString()}] ${message}`
    );
}

// ======================================================
// HTTP HELPERS
// ======================================================

async function getJSON(url) {
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(
            `HTTP ${response.status} - ${url}`
        );
    }

    const data = await response.json();

    if (data.code && data.code !== "00000") {
        throw new Error(
            `Bitget error ${data.code}: ${data.msg || "unknown"}`
        );
    }

    return data;
}

// ======================================================
// BITGET - SYMBOLS
// ======================================================

async function getSpotSymbols() {

    const url =
        `${BITGET_BASE}/api/v2/spot/public/symbols`;

    const data = await getJSON(url);

    return data.data || [];
}

// ======================================================
// BITGET - TICKERS
// ======================================================

async function getSpotTickers() {

    const url =
        `${BITGET_BASE}/api/v2/spot/market/tickers`;

    const data = await getJSON(url);

    return data.data || [];
}

// ======================================================
// BITGET - CANDLES
// ======================================================

async function getCandles(
    symbol,
    granularity = "15m",
    limit = 120
) {

    const url =
        `${BITGET_BASE}/api/v2/spot/market/candles` +
        `?symbol=${encodeURIComponent(symbol)}` +
        `&granularity=${granularity}` +
        `&limit=${limit}`;

    const data = await getJSON(url);

    return (data.data || [])
        .map(row => ({
            timestamp: Number(row[0]),
            open: Number(row[1]),
            high: Number(row[2]),
            low: Number(row[3]),
            close: Number(row[4]),
            volume: Number(row[5]),
            quoteVolume: Number(row[6])
        }))
        .reverse();
}

// ======================================================
// BASIC MATH
// ======================================================

function average(values) {

    if (!values.length) {
        return 0;
    }

    return (
        values.reduce(
            (sum, value) => sum + value,
            0
        ) / values.length
    );
}

function percentageChange(a, b) {

    if (!a || !b) {
        return 0;
    }

    return ((b - a) / a) * 100;
}

function clamp(value, min, max) {
    return Math.max(
        min,
        Math.min(max, value)
    );
}

// ======================================================
// RETURNS
// ======================================================

function returns(candles, period) {

    if (candles.length <= period) {
        return 0;
    }

    const oldPrice =
        candles[candles.length - 1 - period].close;

    const newPrice =
        candles[candles.length - 1].close;

    return percentageChange(
        oldPrice,
        newPrice
    );
}

// ======================================================
// VOLATILITY
// ======================================================

function volatility(candles, period = 20) {

    if (candles.length < period + 1) {
        return 0;
    }

    const values = [];

    for (
        let i = candles.length - period;
        i < candles.length;
        i++
    ) {

        const previous =
            candles[i - 1].close;

        const current =
            candles[i].close;

        if (previous > 0) {
            values.push(
                Math.abs(
                    (current - previous) /
                    previous
                ) * 100
            );
        }
    }

    return average(values);
}

// ======================================================
// ATR
// ======================================================

function atr(candles, period = 14) {

    if (candles.length < period + 1) {
        return 0;
    }

    const trueRanges = [];

    for (
        let i = candles.length - period;
        i < candles.length;
        i++
    ) {

        const current = candles[i];
        const previous = candles[i - 1];

        const tr1 =
            current.high -
            current.low;

        const tr2 =
            Math.abs(
                current.high -
                previous.close
            );

        const tr3 =
            Math.abs(
                current.low -
                previous.close
            );

        trueRanges.push(
            Math.max(
                tr1,
                tr2,
                tr3
            )
        );
    }

    return average(trueRanges);
}

// ======================================================
// VOLUME ANOMALY
// ======================================================

function volumeAnomaly(
    candles,
    period = 20
) {

    if (candles.length < period + 1) {
        return 0;
    }

    const current =
        candles[candles.length - 1]
            .volume;

    const previousVolumes =
        candles
            .slice(
                candles.length - period - 1,
                candles.length - 1
            )
            .map(c => c.volume);

    const avg =
        average(previousVolumes);

    if (!avg) {
        return 0;
    }

    return (
        ((current / avg) - 1) * 100
    );
}

// ======================================================
// RANGE POSITION
// ======================================================

function rangePosition(
    candles,
    period = 30
) {

    if (candles.length < period) {
        return 50;
    }

    const recent =
        candles.slice(
            candles.length - period
        );

    const highs =
        recent.map(c => c.high);

    const lows =
        recent.map(c => c.low);

    const highest =
        Math.max(...highs);

    const lowest =
        Math.min(...lows);

    const price =
        candles[candles.length - 1]
            .close;

    if (highest === lowest) {
        return 50;
    }

    return (
        (price - lowest) /
        (highest - lowest)
    ) * 100;
}

// ======================================================
// COMPRESSION
// ======================================================

function compressionScore(
    candles
) {

    if (candles.length < 50) {
        return 0;
    }

    const shortVol =
        volatility(candles.slice(-10), 9);

    const longVol =
        volatility(candles.slice(-40), 20);

    if (!longVol) {
        return 0;
    }

    const ratio =
        shortVol / longVol;

    // Lower short-term volatility
    // compared with the larger regime
    // = stronger compression.

    const score =
        (1 - clamp(ratio, 0, 1)) * 100;

    return clamp(
        score,
        0,
        100
    );
}

// ======================================================
// MOMENTUM
// ======================================================

function momentumScore(candles) {

    const r5 =
        returns(candles, 5);

    const r15 =
        returns(candles, 15);

    const r30 =
        returns(candles, 30);

    const raw =
        (
            r5 * 0.25 +
            r15 * 0.35 +
            r30 * 0.40
        );

    return clamp(
        50 + raw * 5,
        0,
        100
    );
}

// ======================================================
// TREND SCORE
// ======================================================

function trendScore(candles) {

    if (candles.length < 60) {
        return 50;
    }

    const close =
        candles[candles.length - 1]
            .close;

    const ma20 =
        average(
            candles
                .slice(-20)
                .map(c => c.close)
        );

    const ma50 =
        average(
            candles
                .slice(-50)
                .map(c => c.close)
        );

    let score = 50;

    if (close > ma20) {
        score += 20;
    } else {
        score -= 20;
    }

    if (ma20 > ma50) {
        score += 25;
    } else {
        score -= 25;
    }

    return clamp(
        score,
        0,
        100
    );
}

// ======================================================
// MARKET DNA
// ======================================================

function calculateMarketDNA(
    symbol,
    ticker,
    candles
) {

    if (!candles.length) {
        return null;
    }

    const price =
        candles[candles.length - 1]
            .close;

    const volume =
        Number(
            ticker.usdtVolume ||
            ticker.quoteVolume ||
            0
        );

    const change24h =
        Number(
            ticker.change24h || 0
        ) * 100;

    const vol =
        volatility(candles);

    const atrValue =
        atr(candles);

    const atrPercent =
        price
            ? (atrValue / price) * 100
            : 0;

    const volumeSpike =
        volumeAnomaly(candles);

    const compression =
        compressionScore(candles);

    const momentum =
        momentumScore(candles);

    const trend =
        trendScore(candles);

    const position =
        rangePosition(candles);

    // --------------------------------------------
    // LIQUIDITY
    // --------------------------------------------

    let liquidity = 0;

    if (volume >= 1000000) {
        liquidity = 100;
    } else if (volume >= 500000) {
        liquidity = 80;
    } else if (volume >= 250000) {
        liquidity = 60;
    } else if (volume >= 100000) {
        liquidity = 40;
    } else {
        liquidity = 20;
    }

    // --------------------------------------------
    // VOLATILITY QUALITY
    // --------------------------------------------

    let volatilityQuality = 50;

    if (
        atrPercent >= 0.5 &&
        atrPercent <= 5
    ) {
        volatilityQuality = 90;
    }

    if (atrPercent > 8) {
        volatilityQuality = 35;
    }

    // --------------------------------------------
    // VOLUME QUALITY
    // --------------------------------------------

    const volumeQuality =
        clamp(
            50 +
            volumeSpike * 0.35,
            0,
            100
        );

    // --------------------------------------------
    // OVERALL DNA
    // --------------------------------------------

    const dna =
        (
            liquidity * 0.25 +
            volatilityQuality * 0.15 +
            trend * 0.20 +
            momentum * 0.20 +
            volumeQuality * 0.10 +
            compression * 0.10
        );

    return {

        symbol,

        price,

        volume24h: volume,

        change24h,

        volatility: Number(
            vol.toFixed(3)
        ),

        atrPercent: Number(
            atrPercent.toFixed(3)
        ),

        volumeAnomaly: Number(
            volumeSpike.toFixed(1)
        ),

        compression: Number(
            compression.toFixed(1)
        ),

        momentum: Number(
            momentum.toFixed(1)
        ),

        trend: Number(
            trend.toFixed(1)
        ),

        rangePosition: Number(
            position.toFixed(1)
        ),

        dnaScore: Number(
            dna.toFixed(1)
        )
    };
}

// ======================================================
// BUILD MARKET UNIVERSE
// ======================================================

async function buildUniverse() {

    log(
        "Building new market universe..."
    );

    const [
        symbols,
        tickers
    ] = await Promise.all([
        getSpotSymbols(),
        getSpotTickers()
    ]);

    const tickerMap =
        new Map(
            tickers.map(
                ticker => [
                    ticker.symbol,
                    ticker
                ]
            )
        );

    const validSymbols =
        symbols.filter(
            item =>
                item.status === "online" &&
                item.quoteCoin === "USDT"
        );

    const liquid =
        validSymbols
            .map(item => {

                const ticker =
                    tickerMap.get(
                        item.symbol
                    );

                if (!ticker) {
                    return null;
                }

                const volume =
                    Number(
                        ticker.usdtVolume ||
                        ticker.quoteVolume ||
                        0
                    );

                return {
                    symbol: item.symbol,
                    volume,
                    ticker
                };
            })
            .filter(Boolean)
            .filter(
                item =>
                    item.volume >= 100000
            )
            .sort(
                (a, b) =>
                    b.volume -
                    a.volume
            );

    state.stats.totalSymbols =
        validSymbols.length;

    state.stats.liquidSymbols =
        liquid.length;

    state.universe =
        liquid.slice(0, 100);

    state.lastUniverseScan =
        new Date().toISOString();

    log(
        `Universe ready: ${state.universe.length} symbols`
    );

    return state.universe;
}

// ======================================================
// SCAN ONE SYMBOL
// ======================================================

async function analyzeSymbol(
    item
) {

    try {

        const candles =
            await getCandles(
                item.symbol,
                "15m",
                120
            );

        const dna =
            calculateMarketDNA(
                item.symbol,
                item.ticker,
                candles
            );

        if (!dna) {
            return null;
        }

        return dna;

    } catch (error) {

        log(
            `Analysis failed ${item.symbol}: ${error.message}`
        );

        return null;
    }
}

// ======================================================
// MARKET SCAN
// ======================================================

async function runMarketScan() {

    if (state.scanning) {
        return {
            success: false,
            message: "Scan already running"
        };
    }

    state.scanning = true;

    try {

        if (!state.universe.length) {
            await buildUniverse();
        }

        log(
            `Starting Market DNA scan of ${state.universe.length} symbols`
        );

        const results = [];

        // Keep requests gentle on public API.
        // We deliberately process in small batches.

        const batchSize = 5;

        for (
            let i = 0;
            i < state.universe.length;
            i += batchSize
        ) {

            const batch =
                state.universe.slice(
                    i,
                    i + batchSize
                );

            const batchResults =
                await Promise.all(
                    batch.map(
                        analyzeSymbol
                    )
                );

            for (
                const result of batchResults
            ) {

                if (result) {
                    results.push(result);
                }
            }

            await new Promise(
                resolve =>
                    setTimeout(
                        resolve,
                        250
                    )
            );
        }

        results.sort(
            (a, b) =>
                b.dnaScore -
                a.dnaScore
        );

        state.candidates =
            results
                .filter(
                    item =>
                        item.dnaScore >= 55
                )
                .slice(0, 30);

        state.stats.dnaCandidates =
            state.candidates.length;

        state.stats.setups = 0;

        state.signals = [];

        state.stats.signals = 0;

        state.lastMarketScan =
            new Date().toISOString();

        log(
            `Market DNA scan complete. Candidates: ${state.candidates.length}`
        );

        return {
            success: true,
            scanned: results.length,
            candidates:
                state.candidates
        };

    } finally {

        state.scanning = false;
    }
}

// ======================================================
// WEB UI
// ======================================================

app.get("/", (req, res) => {

    res.send(`
<!DOCTYPE html>

<html lang="tr">

<head>

<meta charset="UTF-8">

<meta name="viewport"
content="width=device-width,initial-scale=1">

<title>${SYSTEM_NAME}</title>

<style>

* {
    box-sizing: border-box;
}

body {
    margin: 0;
    background: #080d1c;
    color: #f5f7ff;
    font-family:
        Arial,
        Helvetica,
        sans-serif;
}

.container {
    width: min(1200px, 94%);
    margin: 35px auto;
}

.header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 25px;
}

.title {
    font-size: 28px;
    font-weight: 800;
}

.subtitle {
    color: #8491b2;
    margin-top: 7px;
}

.status {
    background: #0d2b1b;
    color: #4cff9b;
    padding: 10px 16px;
    border-radius: 20px;
    font-weight: 700;
}

.grid {
    display: grid;
    grid-template-columns:
        repeat(4, 1fr);
    gap: 14px;
}

.card {
    background: #11182b;
    border: 1px solid #202b45;
    border-radius: 14px;
    padding: 18px;
}

.label {
    color: #7d8baa;
    font-size: 12px;
    text-transform: uppercase;
}

.value {
    margin-top: 8px;
    font-size: 24px;
    font-weight: 800;
}

.main {
    margin-top: 18px;
    display: grid;
    grid-template-columns:
        2fr 1fr;
    gap: 18px;
}

button {
    border: 0;
    border-radius: 9px;
    padding: 12px 18px;
    cursor: pointer;
    font-weight: 700;
    margin-right: 8px;
}

.scan {
    background: #ffffff;
    color: #111827;
}

.refresh {
    background: #1e2a45;
    color: white;
}

.panel-title {
    font-size: 18px;
    font-weight: 800;
    margin-bottom: 15px;
}

.info {
    background: #0d1426;
    border: 1px solid #24304c;
    border-radius: 10px;
    padding: 14px;
    color: #9ca9c8;
    margin-top: 14px;
}

table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 20px;
}

th,
td {
    text-align: left;
    padding: 12px 8px;
    border-bottom: 1px solid #202a43;
}

th {
    color: #7f8cab;
    font-size: 12px;
}

.score {
    font-weight: 800;
}

.green {
    color: #4cff9b;
}

.yellow {
    color: #ffd66b;
}

.muted {
    color: #71809f;
}

@media(max-width:800px) {

    .grid {
        grid-template-columns:
            repeat(2,1fr);
    }

    .main {
        grid-template-columns: 1fr;
    }
}

</style>

</head>

<body>

<div class="container">

<div class="header">

<div>

<div class="title">
🚀 ${SYSTEM_NAME}
</div>

<div class="subtitle">
Yeni nesil market intelligence
•
Manual trading only
</div>

</div>

<div class="status">
● SYSTEM ONLINE
</div>

</div>


<div class="grid">

<div class="card">
<div class="label">
Market
</div>
<div class="value"
id="total">
0
</div>
</div>

<div class="card">
<div class="label">
Liquid
</div>
<div class="value"
id="liquid">
0
</div>
</div>

<div class="card">
<div class="label">
DNA Candidates
</div>
<div class="value"
id="candidates">
0
</div>
</div>

<div class="card">
<div class="label">
Signals
</div>
<div class="value"
id="signals">
0
</div>
</div>

</div>


<div class="main">

<div class="card">

<div class="panel-title">
🧠 Market DNA Scanner
</div>

<div>

<button
class="scan"
onclick="scan()">
🔎 Yeni Tarama
</button>

<button
class="refresh"
onclick="loadStatus()">
↻ Yenile
</button>

</div>

<div
class="info"
id="message">
Sistem hazır.
Yeni nesil market taraması başlatılabilir.
</div>

<table>

<thead>

<tr>

<th>COIN</th>
<th>DNA</th>
<th>MOMENTUM</th>
<th>TREND</th>
<th>VOLUME</th>
<th>COMPRESSION</th>

</tr>

</thead>

<tbody id="rows">

<tr>
<td colspan="6"
class="muted">
Henüz tarama yapılmadı.
</td>
</tr>

</tbody>

</table>

</div>


<div class="card">

<div class="panel-title">
⚙️ Sistem
</div>

<p>
<b>Engine</b><br>
Market DNA v${VERSION}
</p>

<p>
<b>Trading</b><br>
<span class="green">
MANUAL ONLY
</span>
</p>

<p>
<b>Automatic Orders</b><br>
<span class="green">
DISABLED
</span>
</p>

<p>
<b>Exchange</b><br>
Bitget Spot
</p>

<p>
<b>Strategy</b><br>
Regime + Momentum +
Compression + Volume
</p>

</div>

</div>

</div>


<script>

async function loadStatus() {

    try {

        const response =
            await fetch("/api/status");

        const data =
            await response.json();

        document.getElementById(
            "total"
        ).innerText =
            data.stats.totalSymbols;

        document.getElementById(
            "liquid"
        ).innerText =
            data.stats.liquidSymbols;

        document.getElementById(
            "candidates"
        ).innerText =
            data.stats.dnaCandidates;

        document.getElementById(
            "signals"
        ).innerText =
            data.stats.signals;

        renderRows(
            data.candidates || []
        );

    } catch(error) {

        document.getElementById(
            "message"
        ).innerText =
            "Status alınamadı: " +
            error.message;
    }
}


async function scan() {

    const message =
        document.getElementById(
            "message"
        );

    message.innerText =
        "Market DNA taraması çalışıyor...";

    try {

        const response =
            await fetch(
                "/api/scan",
                {
                    method: "POST"
                }
            );

        const data =
            await response.json();

        if (!data.success) {

            message.innerText =
                data.message ||
                "Tarama başlatılamadı.";

            return;
        }

        message.innerText =
            "Tarama tamamlandı. " +
            data.candidates.length +
            " güçlü aday bulundu.";

        await loadStatus();

    } catch(error) {

        message.innerText =
            "Tarama hatası: " +
            error.message;
    }
}


function renderRows(items) {

    const rows =
        document.getElementById(
            "rows"
        );

    if (!items.length) {

        rows.innerHTML = `
<tr>
<td colspan="6"
class="muted">
Henüz güçlü aday yok.
</td>
</tr>
`;

        return;
    }

    rows.innerHTML =
        items.map(item => `

<tr>

<td>
<b>${item.symbol}</b>
</td>

<td class="score">
${item.dnaScore}
</td>

<td>
${item.momentum}
</td>

<td>
${item.trend}
</td>

<td>
${item.volumeAnomaly}%
</td>

<td>
${item.compression}
</td>

</tr>

`).join("");
}


loadStatus();

setInterval(
    loadStatus,
    30000
);

</script>

</body>

</html>
`);
});

// ======================================================
// API - STATUS
// ======================================================

app.get("/api/status", (req, res) => {

    res.json({

        success: true,

        system: SYSTEM_NAME,

        version: VERSION,

        status: "online",

        mode: "MANUAL TRADING ONLY",

        exchange: "BITGET SPOT",

        scanning:
            state.scanning,

        lastUniverseScan:
            state.lastUniverseScan,

        lastMarketScan:
            state.lastMarketScan,

        stats:
            state.stats,

        candidates:
            state.candidates,

        signals:
            state.signals,

        uptime:
            process.uptime()
    });
});

// ======================================================
// API - UNIVERSE
// ======================================================

app.get(
    "/api/universe",
    async (req, res) => {

        try {

            if (!state.universe.length) {
                await buildUniverse();
            }

            res.json({

                success: true,

                count:
                    state.universe.length,

                universe:
                    state.universe.map(
                        item => ({
                            symbol:
                                item.symbol,
                            volume:
                                item.volume
                        })
                    )
            });

        } catch(error) {

            res.status(500).json({

                success: false,

                error:
                    error.message
            });
        }
    }
);

// ======================================================
// API - SCAN
// ======================================================

app.post(
    "/api/scan",
    async (req, res) => {

        try {

            const result =
                await runMarketScan();

            res.json(result);

        } catch(error) {

            log(
                `Scan error: ${error.message}`
            );

            res.status(500).json({

                success: false,

                error:
                    error.message
            });
        }
    }
);

// ======================================================
// API - HEALTH
// ======================================================

app.get(
    "/health",
    (req, res) => {

        res.json({

            success: true,

            status: "healthy",

            system: SYSTEM_NAME,

            version: VERSION,

            uptime:
                process.uptime()
        });
    }
);

// ======================================================
// 404
// ======================================================

app.use(
    (req, res) => {

        res.status(404).json({

            success: false,

            error: "Endpoint not found"
        });
    }
);

// ======================================================
// SERVER
// ======================================================

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        log(
            `${SYSTEM_NAME} v${VERSION} started`
        );

        log(
            `Server listening on port ${PORT}`
        );

        log(
            "Automatic trading: DISABLED"
        );

        log(
            "New engine: MARKET DNA"
        );
    }
);
