```javascript
require('dotenv').config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const ccxt = require('ccxt');
const path = require('path');

const {
    EMA,
    RSI,
    ADX,
    ATR,
    MACD,
    OBV
} = require('technicalindicators');


// ============================================================
// SONNY AI SIGNAL SCANNER
// MANUAL TRADING ONLY
// ============================================================

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;


// ============================================================
// MIDDLEWARE
// ============================================================

app.use(cors());
app.use(express.json());

app.use(
    express.static(path.join(__dirname, 'public'))
);


// ============================================================
// BITGET PUBLIC MARKET
// ============================================================

const exchange = new ccxt.bitget({
    options: {
        defaultType: 'spot'
    },

    timeout: 30000,
    enableRateLimit: true
});


// ============================================================
// CONFIGURATION
// ============================================================

const CONFIG = {

    // Tarama
    scanInterval: 5 * 60 * 1000,

    // Kaç coin taranacak
    maxSymbols: 80,

    // Minimum 24h hacim
    minVolumeUSD: 500000,

    // Minimum fiyat
    minPrice: 0.000001,

    // Timeframes
    timeframes: [
        '15m',
        '1h',
        '4h'
    ],

    // Sinyal minimum puanı
    minimumScore: 70,

    // Çok güçlü sinyal
    strongScore: 82,

    // Aynı coin tekrar sinyal
    signalCooldown: 30 * 60 * 1000,

    // Kaç sinyal saklanacak
    maxSignals: 100,

    // ATR
    stopATR: 1.5,
    targetATR: 3.0
};


// ============================================================
// GLOBAL STATE
// ============================================================

let globalSignals = [];

let lastScan = null;

let scannerRunning = false;

let marketCache = [];

let lastMarketLoad = 0;

const signalCooldowns = new Map();


// ============================================================
// LOGGER
// ============================================================

function log(message) {

    console.log(
        `[${new Date().toISOString()}] ${message}`
    );

}


// ============================================================
// HELPERS
// ============================================================

function sleep(ms) {

    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });

}


function roundPrice(price) {

    if (!price) return 0;

    if (price >= 1000) {
        return Number(price.toFixed(2));
    }

    if (price >= 1) {
        return Number(price.toFixed(4));
    }

    if (price >= 0.01) {
        return Number(price.toFixed(6));
    }

    return Number(price.toFixed(8));
}


function clamp(value, min, max) {

    return Math.max(min, Math.min(max, value));

}


// ============================================================
// INDICATOR CALCULATIONS
// ============================================================

function calculateIndicators(ohlcv) {

    const highs = ohlcv.map(x => x[2]);

    const lows = ohlcv.map(x => x[3]);

    const closes = ohlcv.map(x => x[4]);

    const volumes = ohlcv.map(x => x[5]);


    const currentPrice =
        closes[closes.length - 1];


    // --------------------------------------------------------
    // EMA
    // --------------------------------------------------------

    const ema9 = EMA.calculate({
        period: 9,
        values: closes
    });

    const ema21 = EMA.calculate({
        period: 21,
        values: closes
    });

    const ema50 = EMA.calculate({
        period: 50,
        values: closes
    });


    const e9 = ema9[ema9.length - 1];

    const e21 = ema21[ema21.length - 1];

    const e50 = ema50[ema50.length - 1];


    // --------------------------------------------------------
    // RSI
    // --------------------------------------------------------

    const rsiValues = RSI.calculate({
        period: 14,
        values: closes
    });

    const rsi =
        rsiValues[rsiValues.length - 1] || 50;


    // --------------------------------------------------------
    // ADX
    // --------------------------------------------------------

    const adxValues = ADX.calculate({

        high: highs,
        low: lows,
        close: closes,

        period: 14
    });

    const adxObject =
        adxValues[adxValues.length - 1];

    const adx =
        adxObject ? adxObject.adx : 0;


    const plusDI =
        adxObject ? adxObject.pdi : 0;

    const minusDI =
        adxObject ? adxObject.mdi : 0;


    // --------------------------------------------------------
    // ATR
    // --------------------------------------------------------

    const atrValues = ATR.calculate({

        high: highs,
        low: lows,
        close: closes,

        period: 14
    });

    const atr =
        atrValues[atrValues.length - 1] ||
        currentPrice * 0.01;


    // --------------------------------------------------------
    // MACD
    // --------------------------------------------------------

    const macdValues = MACD.calculate({

        values: closes,

        fastPeriod: 12,

        slowPeriod: 26,

        signalPeriod: 9,

        SimpleMAOscillator: false,

        SimpleMASignal: false
    });


    const macd =
        macdValues[macdValues.length - 1];


    // --------------------------------------------------------
    // OBV
    // --------------------------------------------------------

    const obvValues = OBV.calculate({

        close: closes,

        volume: volumes

    });


    const currentOBV =
        obvValues[obvValues.length - 1] || 0;

    const previousOBV =
        obvValues[obvValues.length - 2] || 0;


    // --------------------------------------------------------
    // VOLUME RATIO
    // --------------------------------------------------------

    const recentVolumes =
        volumes.slice(-20, -1);

    const averageVolume =
        recentVolumes.length
            ? recentVolumes.reduce(
                (a, b) => a + b,
                0
            ) / recentVolumes.length
            : 0;


    const currentVolume =
        volumes[volumes.length - 1];


    const volumeRatio =
        averageVolume > 0
            ? currentVolume / averageVolume
            : 0;


    // --------------------------------------------------------
    // PRICE MOMENTUM
    // --------------------------------------------------------

    const previousClose =
        closes[closes.length - 2];


    const priceChange =
        previousClose
            ? ((currentPrice - previousClose) /
                previousClose) * 100
            : 0;


    // --------------------------------------------------------
    // TREND
    // --------------------------------------------------------

    let trend = 'NEUTRAL';


    if (
        e9 > e21 &&
        e21 > e50
    ) {

        trend = 'BULLISH';

    } else if (
        e9 < e21 &&
        e21 < e50
    ) {

        trend = 'BEARISH';

    }


    return {

        price: currentPrice,

        ema9: e9,

        ema21: e21,

        ema50: e50,

        rsi,

        adx,

        plusDI,

        minusDI,

        atr,

        macd,

        currentOBV,

        previousOBV,

        volumeRatio,

        priceChange,

        trend

    };

}


// ============================================================
// AI-LIKE DECISION ENGINE
// ============================================================

function analyzeMarket(indicators, timeframe) {

    let longScore = 0;

    let shortScore = 0;


    const reasonsLong = [];

    const reasonsShort = [];


    // ========================================================
    // EMA TREND
    // ========================================================

    if (
        indicators.ema9 >
        indicators.ema21
    ) {

        longScore += 10;

        reasonsLong.push(
            'EMA9 > EMA21'
        );

    }


    if (
        indicators.ema9 <
        indicators.ema21
    ) {

        shortScore += 10;

        reasonsShort.push(
            'EMA9 < EMA21'
        );

    }


    if (
        indicators.ema21 >
        indicators.ema50
    ) {

        longScore += 8;

        reasonsLong.push(
            'EMA21 > EMA50'
        );

    }


    if (
        indicators.ema21 <
        indicators.ema50
    ) {

        shortScore += 8;

        reasonsShort.push(
            'EMA21 < EMA50'
        );

    }


    // ========================================================
    // RSI
    // ========================================================

    if (
        indicators.rsi >= 52 &&
        indicators.rsi <= 68
    ) {

        longScore += 12;

        reasonsLong.push(
            `RSI güçlü (${indicators.rsi.toFixed(1)})`
        );

    }


    if (
        indicators.rsi <= 48 &&
        indicators.rsi >= 32
    ) {

        shortScore += 12;

        reasonsShort.push(
            `RSI zayıf (${indicators.rsi.toFixed(1)})`
        );

    }


    // Aşırı alım / satım cezalandırması

    if (indicators.rsi > 75) {

        longScore -= 10;

    }


    if (indicators.rsi < 25) {

        shortScore -= 10;

    }


    // ========================================================
    // ADX
    // ========================================================

    if (indicators.adx >= 25) {

        if (
            indicators.plusDI >
            indicators.minusDI
        ) {

            longScore += 15;

            reasonsLong.push(
                `ADX güçlü (${indicators.adx.toFixed(1)})`
            );

        }


        if (
            indicators.minusDI >
            indicators.plusDI
        ) {

            shortScore += 15;

            reasonsShort.push(
                `ADX güçlü (${indicators.adx.toFixed(1)})`
            );

        }

    }


    // ========================================================
    // MACD
    // ========================================================

    if (indicators.macd) {

        if (
            indicators.macd.MACD >
            indicators.macd.signal
        ) {

            longScore += 12;

            reasonsLong.push(
                'MACD pozitif'
            );

        }


        if (
            indicators.macd.MACD <
            indicators.macd.signal
        ) {

            shortScore += 12;

            reasonsShort.push(
                'MACD negatif'
            );

        }

    }


    // ========================================================
    // VOLUME
    // ========================================================

    if (
        indicators.volumeRatio >= 1.5
    ) {

        longScore += 8;

        shortScore += 8;

        reasonsLong.push(
            `Hacim ${indicators.volumeRatio.toFixed(1)}x`
        );

        reasonsShort.push(
            `Hacim ${indicators.volumeRatio.toFixed(1)}x`
        );

    }


    if (
        indicators.volumeRatio >= 2.5
    ) {

        longScore += 5;

        shortScore += 5;

    }


    // ========================================================
    // OBV
    // ========================================================

    if (
        indicators.currentOBV >
        indicators.previousOBV
    ) {

        longScore += 8;

        reasonsLong.push(
            'OBV yükseliyor'
        );

    }


    if (
        indicators.currentOBV <
        indicators.previousOBV
    ) {

        shortScore += 8;

        reasonsShort.push(
            'OBV düşüyor'
        );

    }


    // ========================================================
    // TIMEFRAME BONUS
    // ========================================================

    if (timeframe === '4h') {

        longScore *= 1.10;

        shortScore *= 1.10;

    }

    if (timeframe === '1h') {

        longScore *= 1.05;

        shortScore *= 1.05;

    }


    longScore =
        clamp(Math.round(longScore), 0, 100);

    shortScore =
        clamp(Math.round(shortScore), 0, 100);


    let direction = 'NONE';

    let score = 0;

    let reasons = [];


    if (
        longScore >= CONFIG.minimumScore &&
        longScore > shortScore
    ) {

        direction = 'LONG';

        score = longScore;

        reasons = reasonsLong;

    }


    if (
        shortScore >= CONFIG.minimumScore &&
        shortScore > longScore
    ) {

        direction = 'SHORT';

        score = shortScore;

        reasons = reasonsShort;

    }


    return {

        direction,

        score,

        longScore,

        shortScore,

        reasons

    };

}


// ============================================================
// CREATE SIGNAL
// ============================================================

function createSignal(
    symbol,
    timeframe,
    indicators,
    analysis
) {

    const price =
        indicators.price;

    const atr =
        indicators.atr;


    let stopLoss;

    let takeProfit;


    if (
        analysis.direction === 'LONG'
    ) {

        stopLoss =
            price -
            atr * CONFIG.stopATR;

        takeProfit =
            price +
            atr * CONFIG.targetATR;

    } else {

        stopLoss =
            price +
            atr * CONFIG.stopATR;

        takeProfit =
            price -
            atr * CONFIG.targetATR;

    }


    const risk =
        Math.abs(
            price - stopLoss
        );


    const reward =
        Math.abs(
            takeProfit - price
        );


    const rr =
        risk > 0
            ? reward / risk
            : 0;


    let strength = 'NORMAL';


    if (
        analysis.score >=
        CONFIG.strongScore
    ) {

        strength = 'STRONG';

    }


    return {

        id:
            `${symbol}-${timeframe}-${Date.now()}`,

        coin:
            symbol.replace('/USDT', ''),

        symbol,

        timeframe,

        direction:
            analysis.direction,

        score:
            analysis.score,

        strength,

        entry:
            roundPrice(price),

        stopLoss:
            roundPrice(stopLoss),

        takeProfit:
            roundPrice(takeProfit),

        riskReward:
            Number(rr.toFixed(2)),

        rsi:
            Number(
                indicators.rsi.toFixed(2)
            ),

        adx:
            Number(
                indicators.adx.toFixed(2)
            ),

        volumeRatio:
            Number(
                indicators.volumeRatio.toFixed(2)
            ),

        priceChange:
            Number(
                indicators.priceChange.toFixed(2)
            ),

        trend:
            indicators.trend,

        reasons:
            analysis.reasons,

        createdAt:
            Date.now(),

        createdAtISO:
            new Date().toISOString(),

        manualOnly:
            true

    };

}


// ============================================================
// SIGNAL VALIDATION
// ============================================================

function canCreateSignal(
    symbol,
    direction
) {

    const key =
        `${symbol}:${direction}`;


    const last =
        signalCooldowns.get(key);


    if (!last) {

        return true;

    }


    return (
        Date.now() - last >
        CONFIG.signalCooldown
    );

}


// ============================================================
// SAVE SIGNAL
// ============================================================

function saveSignal(signal) {

    const key =
        `${signal.symbol}:${signal.direction}`;


    signalCooldowns.set(
        key,
        Date.now()
    );


    globalSignals.unshift(signal);


    if (
        globalSignals.length >
        CONFIG.maxSignals
    ) {

        globalSignals =
            globalSignals.slice(
                0,
                CONFIG.maxSignals
            );

    }


    log(
        `🎯 SIGNAL ${signal.coin} ${signal.direction} ${signal.score}%`
    );


    broadcast({

        type: 'NEW_SIGNAL',

        data: signal

    });


    broadcast({

        type: 'SIGNAL_LIST',

        data: globalSignals

    });

}


// ============================================================
// WEBSOCKET BROADCAST
// ============================================================

function broadcast(message) {

    const payload =
        JSON.stringify(message);


    wss.clients.forEach(client => {

        if (
            client.readyState ===
            WebSocket.OPEN
        ) {

            client.send(payload);

        }

    });

}


// ============================================================
// LOAD MARKETS
// ============================================================

async function loadMarkets() {

    const now =
        Date.now();


    if (
        marketCache.length > 0 &&
        now - lastMarketLoad <
        15 * 60 * 1000
    ) {

        return marketCache;

    }


    log(
        '📊 Bitget market listesi yükleniyor...'
    );


    const markets =
        await exchange.loadMarkets();


    const symbols =
        Object.keys(markets)
            .filter(symbol => {

                const market =
                    markets[symbol];

                return (
                    market &&
                    market.active !== false &&
                    market.spot === true &&
                    symbol.endsWith('/USDT')
                );

            });


    marketCache =
        symbols;


    lastMarketLoad =
        now;


    log(
        `📊 ${symbols.length} USDT market bulundu`
    );


    return symbols;

}


// ============================================================
// GET HIGH VOLUME SYMBOLS
// ============================================================

async function getSymbolsToScan() {

    const symbols =
        await loadMarkets();


    const selected = [];


    log(
        '💰 Hacim filtrelemesi başlıyor...'
    );


    for (
        let i = 0;
        i < symbols.length &&
        selected.length <
        CONFIG.maxSymbols;
        i++
    ) {

        const symbol =
            symbols[i];


        try {

            const ticker =
                await exchange.fetchTicker(
                    symbol
                );


            const price =
                ticker.last || 0;


            const baseVolume =
                ticker.baseVolume || 0;


            const volumeUSD =
                baseVolume * price;


            if (
                volumeUSD >=
                CONFIG.minVolumeUSD &&
                price >=
                CONFIG.minPrice
            ) {

                selected.push({

                    symbol,

                    volumeUSD

                });

            }


        } catch (error) {

            // tek coin hatası tüm taramayı bozmasın

        }


        await sleep(80);

    }


    selected.sort(
        (a, b) =>
            b.volumeUSD -
            a.volumeUSD
    );


    log(
        `🔥 ${selected.length} yüksek hacimli coin seçildi`
    );


    return selected.map(
        x => x.symbol
    );

}


// ============================================================
// SCAN SYMBOL
// ============================================================

async function scanSymbol(symbol) {

    for (
        const timeframe of
        CONFIG.timeframes
    ) {

        try {

            const ohlcv =
                await exchange.fetchOHLCV(
                    symbol,
                    timeframe,
                    undefined,
                    150
                );


            if (
                !ohlcv ||
                ohlcv.length < 60
            ) {

                continue;

            }


            const indicators =
                calculateIndicators(
                    ohlcv
                );


            const analysis =
                analyzeMarket(
                    indicators,
                    timeframe
                );


            if (
                analysis.direction ===
                'NONE'
            ) {

                continue;

            }


            if (
                !canCreateSignal(
                    symbol,
                    analysis.direction
                )
            ) {

                continue;

            }


            const signal =
                createSignal(
                    symbol,
                    timeframe,
                    indicators,
                    analysis
                );


            saveSignal(signal);


        } catch (error) {

            log(
                `⚠️ ${symbol} ${timeframe}: ${error.message}`
            );

        }


        await sleep(100);

    }

}


// ============================================================
// MARKET SCANNER
// ============================================================

async function runMarketScan() {

    if (scannerRunning) {

        log(
            '⏳ Önceki tarama hâlâ devam ediyor.'
        );

        return;

    }


    scannerRunning =
        true;


    const started =
        Date.now();


    try {

        log(
            '🚀 MARKET SCAN BAŞLADI'
        );


        const symbols =
            await getSymbolsToScan();


        log(
            `🔎 ${symbols.length} coin taranıyor...`
        );


        for (
            const symbol of symbols
        ) {

            await scanSymbol(
                symbol
            );

        }


        lastScan =
            new Date().toISOString();


        log(
            `✅ MARKET SCAN TAMAMLANDI - ${Date.now() - started}ms`
        );


        broadcast({

            type: 'SCAN_COMPLETE',

            data: {

                lastScan,

                signals:
                    globalSignals.length

            }

        });


    } catch (error) {

        log(
            `❌ Scan error: ${error.message}`
        );

    } finally {

        scannerRunning =
            false;

    }

}


// ============================================================
// API: STATUS
// ============================================================

app.get(
    '/api/status',
    (req, res) => {

        res.json({

            success: true,

            system:
                'Sonny AI Signal Scanner',

            status:
                'online',

            mode:
                'MANUAL TRADING ONLY',

            scannerRunning,

            lastScan,

            totalSignals:
                globalSignals.length,

            marketsLoaded:
                marketCache.length,

            config: {

                minimumScore:
                    CONFIG.minimumScore,

                timeframes:
                    CONFIG.timeframes,

                scanInterval:
                    CONFIG.scanInterval

            }

        });

    }
);


// ============================================================
// API: SIGNALS
// ============================================================

app.get(
    '/api/signals',
    (req, res) => {

        res.json({

            success: true,

            count:
                globalSignals.length,

            signals:
                globalSignals

        });

    }
);


// ============================================================
// API: LAST SIGNALS
// ============================================================

app.get(
    '/api/signals/latest',
    (req, res) => {

        res.json({

            success: true,

            signals:
                globalSignals.slice(
                    0,
                    20
                )

        });

    }
);


// ============================================================
// API: MANUAL SCAN
// ============================================================

app.get(
    '/api/scan',
    async (req, res) => {

        if (scannerRunning) {

            return res.json({

                success: false,

                message:
                    'Tarama zaten çalışıyor.'

            });

        }


        // Tarama arka planda başlar

        runMarketScan();


        res.json({

            success: true,

            message:
                'Market taraması başlatıldı.',

            mode:
                'MANUAL TRADING ONLY'

        });

    }
);


// ============================================================
// API: SINGLE COIN ANALYSIS
// ============================================================

app.get(
    '/api/analyze',
    async (req, res) => {

        try {

            let symbol =
                (
                    req.query.symbol ||
                    'BTC'
                ).toUpperCase();


            if (
                !symbol.endsWith('/USDT')
            ) {

                symbol += '/USDT';

            }


            const timeframe =
                req.query.timeframe ||
                '15m';


            const ohlcv =
                await exchange.fetchOHLCV(
                    symbol,
                    timeframe,
                    undefined,
                    150
                );


            if (
                !ohlcv ||
                ohlcv.length < 60
            ) {

                return res.status(400).json({

                    success: false,

                    error:
                        'Yeterli market verisi yok.'

                });

            }


            const indicators =
                calculateIndicators(
                    ohlcv
                );


            const analysis =
                analyzeMarket(
                    indicators,
                    timeframe
                );


            let signal = null;


            if (
                analysis.direction !==
                'NONE'
            ) {

                signal =
                    createSignal(
                        symbol,
                        timeframe,
                        indicators,
                        analysis
                    );

            }


            res.json({

                success: true,

                symbol,

                timeframe,

                signal,

                market: {

                    price:
                        roundPrice(
                            indicators.price
                        ),

                    rsi:
                        indicators.rsi,

                    adx:
                        indicators.adx,

                    volumeRatio:
                        indicators.volumeRatio,

                    trend:
                        indicators.trend,

                    longScore:
                        analysis.longScore,

                    shortScore:
                        analysis.shortScore

                }

            });


        } catch (error) {

            res.status(500).json({

                success: false,

                error:
                    error.message

            });

        }

    }
);


// ============================================================
// WEBSOCKET
// ============================================================

wss.on(
    'connection',
    ws => {

        log(
            '🔌 WebSocket client bağlandı'
        );


        ws.send(
            JSON.stringify({

                type:
                    'SIGNAL_LIST',

                data:
                    globalSignals

            })
        );


        ws.send(
            JSON.stringify({

                type:
                    'SYSTEM_STATUS',

                data: {

                    status:
                        'online',

                    mode:
                        'MANUAL TRADING ONLY',

                    lastScan,

                    scannerRunning

                }

            })
        );


        ws.on(
            'close',
            () => {

                log(
                    '🔌 WebSocket client ayrıldı'
                );

            }
        );

    }
);


// ============================================================
// AUTOMATIC SCAN LOOP
// ============================================================

setInterval(
    () => {

        runMarketScan();

    },
    CONFIG.scanInterval
);


// ============================================================
// START SERVER
// ============================================================

async function startServer() {

    try {

        log(
            '=========================================='
        );

        log(
            '🚀 SONNY AI SIGNAL SCANNER'
        );

        log(
            '=========================================='
        );

        log(
            '🤖 Decision Engine: ACTIVE'
        );

        log(
            '📊 Market Scanner: ACTIVE'
        );

        log(
            '💰 Auto Trading: DISABLED'
        );

        log(
            '🖐️ Manual Trading: ENABLED'
        );

        log(
            '📡 WebSocket: ACTIVE'
        );

        log(
            '=========================================='
        );


        await exchange.loadMarkets();


        server.listen(
            PORT,
            '0.0.0.0',
            () => {

                log(
                    `🌐 Server running on port ${PORT}`
                );

                log(
                    `🔗 http://localhost:${PORT}`
                );


                // İlk taramayı başlat

                setTimeout(
                    () => {

                        runMarketScan();

                    },
                    5000
                );

            }
        );


    } catch (error) {

        console.error(
            'SERVER START ERROR:',
            error
        );

        process.exit(1);

    }

}


startServer();


// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

process.on(
    'SIGTERM',
    () => {

        log(
            'SIGTERM received.'
        );

        server.close(
            () => {

                process.exit(0);

            }
        );

    }
);
```
