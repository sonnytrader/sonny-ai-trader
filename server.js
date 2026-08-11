const express = require('express');

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 10000;

const SYSTEM_NAME = 'Sonny AI Signal Scanner';

const BINANCE_BASE = 'https://fapi.binance.com';


/* =========================================================
   SYSTEM STATE
========================================================= */

let state = {
    status: 'starting',

    lastUniverseScan: null,
    lastSignalScan: null,

    universeCount: 0,
    candidates: [],

    signals: [],

    scanRunning: false,

    error: null,

    cycle: 0
};


/* =========================================================
   LOGGER
========================================================= */

function log(message) {

    console.log(
        `[${new Date().toISOString()}] ${message}`
    );

}


/* =========================================================
   BINANCE REQUEST
========================================================= */

async function binance(path) {

    const response = await fetch(
        BINANCE_BASE + path,
        {
            headers: {
                'User-Agent':
                    'Sonny-AI-Signal-Scanner'
            }
        }
    );

    if (!response.ok) {

        throw new Error(
            `Binance HTTP ${response.status}`
        );

    }

    return response.json();

}


/* =========================================================
   UNIVERSE DISCOVERY
========================================================= */

async function getUniverse() {

    const info =
        await binance('/fapi/v1/exchangeInfo');

    return info.symbols
        .filter(symbol => {

            return (
                symbol.status === 'TRADING' &&
                symbol.quoteAsset === 'USDT' &&
                symbol.contractType === 'PERPETUAL'
            );

        })
        .map(symbol => symbol.symbol);

}


/* =========================================================
   24H MARKET DATA
========================================================= */

async function getTicker24h() {

    const data =
        await binance('/fapi/v1/ticker/24hr');

    return data.filter(
        item => item.symbol.endsWith('USDT')
    );

}


/* =========================================================
   NUMBER HELPER
========================================================= */

function safeNumber(value) {

    const number = Number(value);

    return Number.isFinite(number)
        ? number
        : 0;

}


/* =========================================================
   CANDIDATE RANKING
========================================================= */

function rankCandidates(
    symbols,
    tickers
) {

    const map =
        new Map(
            tickers.map(
                ticker => [
                    ticker.symbol,
                    ticker
                ]
            )
        );

    return symbols

        .map(symbol => {

            const ticker =
                map.get(symbol) || {};

            const volume =
                safeNumber(
                    ticker.quoteVolume
                );

            const change =
                Math.abs(
                    safeNumber(
                        ticker.priceChangePercent
                    )
                );

            const high =
                safeNumber(
                    ticker.highPrice
                );

            const low =
                safeNumber(
                    ticker.lowPrice
                );

            const last =
                safeNumber(
                    ticker.lastPrice
                );


            const range =
                last > 0
                    ? ((high - low) / last) * 100
                    : 0;


            /*
             NEW CANDIDATE MODEL

             Liquidity
             +
             Volatility
             +
             Directional movement
             -
             Poor liquidity penalty
            */

            const liquidityScore =
                Math.min(
                    35,
                    Math.log10(
                        Math.max(volume, 1)
                    ) * 3.5
                );


            const volatilityScore =
                Math.min(
                    30,
                    range * 6
                );


            const movementScore =
                Math.min(
                    25,
                    change * 3
                );


            const stabilityPenalty =
                volume < 5000000
                    ? 12
                    : 0;


            const score =
                Math.max(
                    0,
                    liquidityScore +
                    volatilityScore +
                    movementScore -
                    stabilityPenalty
                );


            return {

                symbol,

                score:
                    Number(
                        score.toFixed(2)
                    ),

                volume24h:
                    volume,

                change24h:
                    safeNumber(
                        ticker.priceChangePercent
                    ),

                range24h:
                    Number(
                        range.toFixed(2)
                    ),

                price:
                    last

            };

        })

        .sort(
            (a, b) =>
                b.score - a.score
        );

}


/* =========================================================
   KLINES
========================================================= */

async function getKlines(
    symbol,
    interval = '15m',
    limit = 120
) {

    return binance(
        `/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`
    );

}


/* =========================================================
   CANDLE ANALYSIS
========================================================= */

function candleStats(klines) {

    const closes =
        klines.map(
            candle =>
                safeNumber(candle[4])
        );

    const highs =
        klines.map(
            candle =>
                safeNumber(candle[2])
        );

    const lows =
        klines.map(
            candle =>
                safeNumber(candle[3])
        );

    const volumes =
        klines.map(
            candle =>
                safeNumber(candle[5])
        );


    const last =
        closes.at(-1);

    const previous =
        closes.at(-2);


    const recentVolumes =
        volumes.slice(-20);


    const averageVolume =
        recentVolumes.reduce(
            (a, b) => a + b,
            0
        ) /
        Math.max(
            1,
            recentVolumes.length
        );


    const lastVolume =
        volumes.at(-1);


    const previousHigh =
        Math.max(
            ...highs.slice(-9, -1)
        );


    const previousLow =
        Math.min(
            ...lows.slice(-9, -1)
        );


    const high20 =
        Math.max(
            ...highs.slice(-20, -1)
        );


    const low20 =
        Math.min(
            ...lows.slice(-20, -1)
        );


    const change =
        previous
            ? ((last - previous) / previous) * 100
            : 0;


    const range20 =
        last
            ? ((high20 - low20) / last) * 100
            : 0;


    const volumeRatio =
        averageVolume
            ? lastVolume / averageVolume
            : 0;


    return {

        last,

        change,

        previousHigh,

        previousLow,

        high20,

        low20,

        range20,

        volumeRatio

    };

}


/* =========================================================
   NEW MULTI-TIMEFRAME ANALYSIS
========================================================= */

async function analyzeSymbol(
    candidate
) {

    const [
        candles15m,
        candles1h,
        candles4h
    ] = await Promise.all([

        getKlines(
            candidate.symbol,
            '15m',
            80
        ),

        getKlines(
            candidate.symbol,
            '1h',
            80
        ),

        getKlines(
            candidate.symbol,
            '4h',
            60
        )

    ]);


    const shortTerm =
        candleStats(candles15m);

    const mediumTerm =
        candleStats(candles1h);

    const higherTerm =
        candleStats(candles4h);


    let score = 0;

    const reasons = [];


    /* =====================================================
       4H MARKET STRUCTURE
    ===================================================== */

    if (
        higherTerm.last >
        higherTerm.high20 * 0.995
    ) {

        score += 20;

        reasons.push(
            '4H resistance pressure'
        );

    }


    if (
        higherTerm.last <
        higherTerm.low20 * 1.005
    ) {

        score += 20;

        reasons.push(
            '4H support pressure'
        );

    }


    /* =====================================================
       1H STRUCTURE
    ===================================================== */

    if (
        mediumTerm.last >
        mediumTerm.high20
    ) {

        score += 20;

        reasons.push(
            '1H breakout'
        );

    }


    if (
        mediumTerm.last <
        mediumTerm.low20
    ) {

        score += 20;

        reasons.push(
            '1H breakdown'
        );

    }


    /* =====================================================
       15M TRIGGER
    ===================================================== */

    if (
        shortTerm.last >
        shortTerm.previousHigh &&
        shortTerm.volumeRatio >= 1.5
    ) {

        score += 30;

        reasons.push(
            '15M volume breakout'
        );

    }


    if (
        shortTerm.last <
        shortTerm.previousLow &&
        shortTerm.volumeRatio >= 1.5
    ) {

        score += 30;

        reasons.push(
            '15M volume breakdown'
        );

    }


    let direction = null;


    if (
        shortTerm.last >
        shortTerm.previousHigh
    ) {

        direction = 'LONG';

    }


    if (
        shortTerm.last <
        shortTerm.previousLow
    ) {

        direction = 'SHORT';

    }


    const confidence =
        Math.min(
            100,
            score +
            Math.min(
                15,
                candidate.score / 5
            )
        );


    return {

        symbol:
            candidate.symbol,

        direction,

        confidence:
            Number(
                confidence.toFixed(1)
            ),

        price:
            shortTerm.last,

        volumeRatio:
            Number(
                shortTerm.volumeRatio.toFixed(2)
            ),

        candidateScore:
            candidate.score,

        reasons,

        timeframe:
            '4H → 1H → 15M',

        timestamp:
            new Date().toISOString()

    };

}


/* =========================================================
   MAIN SCANNER
========================================================= */

async function runScanner() {

    if (state.scanRunning) {

        return;

    }


    state.scanRunning = true;

    state.error = null;

    state.cycle++;


    try {

        log(
            `Cycle ${state.cycle}: universe discovery started`
        );


        const [
            universe,
            tickers
        ] = await Promise.all([

            getUniverse(),

            getTicker24h()

        ]);


        const ranked =
            rankCandidates(
                universe,
                tickers
            );


        state.universeCount =
            universe.length;


        /*
         FIRST FILTER

         All coins
         ↓
         top 40
        */

        state.candidates =
            ranked.slice(0, 40);


        state.lastUniverseScan =
            new Date().toISOString();


        log(
            `Universe ${universe.length} coins -> ${state.candidates.length} candidates`
        );


        /*
         SECOND FILTER

         Analyze only top 25
        */

        const results = [];


        for (
            const candidate
            of state.candidates.slice(0, 25)
        ) {

            try {

                const result =
                    await analyzeSymbol(
                        candidate
                    );


                if (
                    result.direction &&
                    result.confidence >= 70
                ) {

                    results.push(result);

                }

            } catch (error) {

                log(
                    `${candidate.symbol} analysis failed: ${error.message}`
                );

            }

        }


        state.signals =
            results

                .sort(
                    (a, b) =>
                        b.confidence -
                        a.confidence
                )

                .slice(0, 15);


        state.lastSignalScan =
            new Date().toISOString();


        state.status =
            'online';


        log(
            `Cycle ${state.cycle}: ${state.signals.length} signals found`
        );


    } catch (error) {

        state.status =
            'degraded';


        state.error =
            error.message;


        log(
            `Scanner error: ${error.message}`
        );


    } finally {

        state.scanRunning =
            false;

    }

}


/* =========================================================
   WEB PANEL
========================================================= */

const HTML = `<!DOCTYPE html>

<html lang="tr">

<head>

<meta charset="UTF-8">

<meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
>

<title>
    ${SYSTEM_NAME}
</title>


<style>

body {

    margin: 0;

    background: #080d1d;

    color: #e9eefc;

    font-family:
        Arial,
        Helvetica,
        sans-serif;

}


.wrap {

    max-width: 1100px;

    margin: 35px auto;

    padding: 0 18px;

}


h1 {

    margin: 0 0 5px;

}


.sub {

    color: #8ea0c5;

}


.grid {

    display: grid;

    grid-template-columns:
        repeat(4, 1fr);

    gap: 12px;

    margin: 22px 0;

}


.card,
.panel {

    background: #111a31;

    border:
        1px solid #243253;

    border-radius: 14px;

    padding: 18px;

}


.label {

    font-size: 12px;

    color: #8496bd;

    text-transform: uppercase;

}


.value {

    font-size: 24px;

    font-weight: 700;

    margin-top: 8px;

}


.green {

    color: #42e68a;

}


.yellow {

    color: #ffd166;

}


.red {

    color: #ff6874;

}


.row {

    display: grid;

    grid-template-columns:
        1.4fr 1fr;

    gap: 14px;

}


.btn {

    border: 0;

    border-radius: 9px;

    padding: 11px 15px;

    font-weight: 700;

    cursor: pointer;

    margin-right: 8px;

}


.primary {

    background: #ffffff;

    color: #101629;

}


.secondary {

    background: #263554;

    color: #ffffff;

}


.signal {

    display: flex;

    justify-content: space-between;

    align-items: center;

    padding: 13px;

    border-bottom:
        1px solid #243253;

}


.badge {

    padding: 5px 8px;

    border-radius: 7px;

    font-size: 12px;

    font-weight: 700;

}


.long {

    background: #123e2a;

    color: #53ed9a;

}


.short {

    background: #4b1d27;

    color: #ff7e89;

}


.muted {

    color: #8496bd;

}


.small {

    font-size: 12px;

}


.table {

    width: 100%;

    border-collapse: collapse;

}


.table td {

    padding: 9px;

    border-bottom:
        1px solid #243253;

}


.empty {

    text-align: center;

    padding: 35px;

    color: #6f80a7;

}


@media(max-width:800px) {

    .grid {

        grid-template-columns:
            1fr 1fr;

    }


    .row {

        grid-template-columns:
            1fr;

    }

}

</style>

</head>


<body>


<div class="wrap">


<h1>
    🚀 ${SYSTEM_NAME}
</h1>


<div class="sub">

Yeni nesil adaptif piyasa tarayıcı
· Otomatik işlem YOK

</div>


<div class="grid">


<div class="card">

<div class="label">
Sistem
</div>

<div
    id="status"
    class="value"
>
...
</div>

</div>


<div class="card">

<div class="label">
Coin Evreni
</div>

<div
    id="universe"
    class="value"
>
0
</div>

</div>


<div class="card">

<div class="label">
Adaylar
</div>

<div
    id="candidates"
    class="value"
>
0
</div>

</div>


<div class="card">

<div class="label">
Aktif Sinyal
</div>

<div
    id="signals"
    class="value"
>
0
</div>

</div>


</div>


<div class="row">


<div class="panel">


<h2>
Sinyal Motoru
</h2>


<p class="muted">

Önce piyasa evrenini puanlar,
sonra yüksek kaliteli adayları
çoklu zaman diliminde analiz eder.

</p>


<button
    class="btn primary"
    onclick="scan()"
>
🔎 Şimdi Tara
</button>


<button
    class="btn secondary"
    onclick="refresh()"
>
↻ Yenile
</button>


<div id="signalList">

</div>


</div>


<div class="panel">


<h2>
Sistem Durumu
</h2>


<table class="table">


<tr>

<td>
Mod
</td>

<td class="green">
MANUAL
</td>

</tr>


<tr>

<td>
Otomatik işlem
</td>

<td class="green">
KAPALI
</td>

</tr>


<tr>

<td>
Evren taraması
</td>

<td id="lastUniverse">
Yok
</td>

</tr>


<tr>

<td>
Sinyal taraması
</td>

<td id="lastSignal">
Yok
</td>

</tr>


<tr>

<td>
Döngü
</td>

<td id="cycle">
0
</td>

</tr>


</table>


</div>


</div>


</div>


<script>


function escapeHtml(value) {

    return String(value ?? '')

        .replace(
            /[&<>"']/g,
            function(match) {

                const map = {

                    '&': '&amp;',

                    '<': '&lt;',

                    '>': '&gt;',

                    '"': '&quot;',

                    "'": '&#39;'

                };

                return map[match];

            }
        );

}


function formatTime(value) {

    if (!value) {

        return 'Yok';

    }

    return new Date(
        value
    ).toLocaleString(
        'tr-TR'
    );

}


async function refresh() {

    try {

        const response =
            await fetch(
                '/api/status'
            );


        const data =
            await response.json();


        const status =
            document.getElementById(
                'status'
            );


        status.textContent =
            data.status.toUpperCase();


        status.className =
            'value ' +
            (
                data.status === 'online'
                    ? 'green'
                    : 'yellow'
            );


        document.getElementById(
            'universe'
        ).textContent =
            data.universeCount;


        document.getElementById(
            'candidates'
        ).textContent =
            data.candidates;


        document.getElementById(
            'signals'
        ).textContent =
            data.signalCount;


        document.getElementById(
            'lastUniverse'
        ).textContent =
            formatTime(
                data.lastUniverseScan
            );


        document.getElementById(
            'lastSignal'
        ).textContent =
            formatTime(
                data.lastSignalScan
            );


        document.getElementById(
            'cycle'
        ).textContent =
            data.cycle;


        const signalList =
            document.getElementById(
                'signalList'
            );


        if (
            !data.signals ||
            data.signals.length === 0
        ) {

            signalList.innerHTML = `

                <div class="empty">

                    Henüz yüksek güvenli
                    sinyal yok.

                </div>

            `;

            return;

        }


        signalList.innerHTML =
            data.signals
                .map(function(signal) {

                    return `

<div class="signal">

<div>

<b>
${escapeHtml(signal.symbol)}
</b>

<div class="small muted">

${escapeHtml(signal.timeframe)}

·

${escapeHtml(
    signal.reasons.join(' + ')
)}

</div>

</div>


<div>

<span
    class="badge ${
        signal.direction === 'LONG'
            ? 'long'
            : 'short'
    }"
>

${escapeHtml(
    signal.direction
)}

</span>


<b>

${escapeHtml(
    signal.confidence
)}%

</b>

</div>

</div>

`;

                })
                .join('');

    }

    catch (error) {

        console.error(
            error
        );

    }

}


async function scan() {

    document.getElementById(
        'status'
    ).textContent =
        'TARANIYOR';


    await fetch(
        '/api/scan',
        {
            method: 'POST'
        }
    );


    setTimeout(
        refresh,
        500
    );

}


refresh();


setInterval(
    refresh,
    10000
);


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
            .send(HTML);

    }
);


app.get(
    '/health',
    (req, res) => {

        res.json({

            success: true,

            status:
                state.status,

            system:
                SYSTEM_NAME,

            uptime:
                process.uptime()

        });

    }
);


app.get(
    '/api/status',
    (req, res) => {

        res.json({

            success: true,

            system:
                SYSTEM_NAME,

            status:
                state.status,

            mode:
                'MANUAL TRADING ONLY',

            universeCount:
                state.universeCount,

            candidates:
                state.candidates.length,

            signalCount:
                state.signals.length,

            lastUniverseScan:
                state.lastUniverseScan,

            lastSignalScan:
                state.lastSignalScan,

            cycle:
                state.cycle,

            error:
                state.error,

            signals:
                state.signals

        });

    }
);


app.post(
    '/api/scan',
    (req, res) => {

        runScanner();

        res.json({

            success: true,

            message:
                'Scan started'

        });

    }
);


app.get(
    '/api/scan',
    (req, res) => {

        res.json({

            success: true,

            status:
                state.scanRunning
                    ? 'scanning'
                    : 'ready',

            signals:
                state.signals,

            candidates:
                state.candidates

        });

    }
);


/* =========================================================
   404
========================================================= */

app.use(
    (req, res) => {

        res
            .status(404)
            .json({

                success: false,

                error:
                    'Endpoint not found'

            });

    }
);


/* =========================================================
   START SERVER
========================================================= */

app.listen(
    PORT,
    '0.0.0.0',
    () => {

        state.status =
            'online';


        log(
            `${SYSTEM_NAME} started`
        );


        log(
            `Server listening on port ${PORT}`
        );


        /*
         FIRST SCAN
        */

        runScanner();


        /*
         CONTINUOUS SCAN
        */

        setInterval(
            runScanner,
            5 * 60 * 1000
        );

    }
);
