require("dotenv").config();

const express = require("express");
const cors = require("cors");
const ccxt = require("ccxt");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ============================================================
// CONFIG
// ============================================================

const CONFIG = {
    exchange: "bitget",

    scanInterval: 5 * 60 * 1000,

    // İlk aşamada sadece yüksek hacimli USDT çiftleri
    maxCoins: 30,

    // Aday oluşturma kriterleri
    minVolumeUSDT: 5000000,
    minPriceChange: 1.0,

    // AI'ye gönderilecek maksimum aday
    maxAiCandidates: 5,

    timeframes: ["15m", "1h", "4h"]
};

// ============================================================
// EXCHANGE
// ============================================================

const exchange = new ccxt.bitget({
    enableRateLimit: true,
    timeout: 30000,
    options: {
        defaultType: "spot"
    }
});

// ============================================================
// STATE
// ============================================================

let marketData = {
    lastScan: null,
    scanning: false,
    candidates: [],
    signals: [],
    marketCount: 0
};

// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/", (req, res) => {
    res.json({
        success: true,
        system: "Sonny AI Signal Scanner",
        status: "online",
        mode: "MANUAL TRADING ONLY",
        lastScan: marketData.lastScan
    });
});

app.get("/api/status", (req, res) => {
    res.json({
        success: true,
        status: "online",
        mode: "MANUAL TRADING ONLY",
        scanning: marketData.scanning,
        lastScan: marketData.lastScan,
        marketCount: marketData.marketCount,
        candidateCount: marketData.candidates.length,
        signalCount: marketData.signals.length
    });
});

app.get("/api/signals", (req, res) => {
    res.json({
        success: true,
        signals: marketData.signals
    });
});

app.get("/api/candidates", (req, res) => {
    res.json({
        success: true,
        candidates: marketData.candidates
    });
});

// ============================================================
// HELPER
// ============================================================

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function calculatePercentage(oldPrice, newPrice) {
    if (!oldPrice) return 0;

    return ((newPrice - oldPrice) / oldPrice) * 100;
}

// ============================================================
// MARKET DISCOVERY
// ============================================================

async function getMarkets() {

    console.log("📡 Marketler yükleniyor...");

    const markets = await exchange.loadMarkets();

    const symbols = Object.values(markets)
        .filter(market =>
            market.active &&
            market.spot &&
            market.quote === "USDT"
        )
        .map(market => market.symbol);

    console.log(`📊 ${symbols.length} USDT market bulundu.`);

    marketData.marketCount = symbols.length;

    return symbols;
}

// ============================================================
// MARKET SCAN
// ============================================================

async function scanMarkets() {

    console.log("\n======================================");
    console.log("🔍 MARKET TARAMASI BAŞLADI");
    console.log(new Date().toISOString());
    console.log("======================================");

    const symbols = await getMarkets();

    const candidates = [];

    for (const symbol of symbols) {

        try {

            const ticker = await exchange.fetchTicker(symbol);

            const price = ticker.last || 0;
            const volume = ticker.quoteVolume || 0;
            const change = ticker.percentage || 0;

            if (!price) continue;

            // Hacim filtresi
            if (volume < CONFIG.minVolumeUSDT) {
                continue;
            }

            // Fiyat hareketi filtresi
            if (Math.abs(change) < CONFIG.minPriceChange) {
                continue;
            }

            candidates.push({
                symbol,
                price,
                change24h: Number(change.toFixed(2)),
                volume24h: Math.round(volume)
            });

        } catch (error) {

            console.log(
                `⚠️ ${symbol} ticker alınamadı: ${error.message}`
            );

        }

        // Bitget rate limit
        await sleep(80);
    }

    // En yüksek hacimlileri sırala
    candidates.sort(
        (a, b) => b.volume24h - a.volume24h
    );

    marketData.candidates =
        candidates.slice(0, CONFIG.maxCoins);

    console.log(
        `🎯 ${marketData.candidates.length} güçlü aday bulundu.`
    );

    for (const candidate of marketData.candidates) {

        console.log(
            `${candidate.symbol} | ` +
            `Değişim: ${candidate.change24h}% | ` +
            `Hacim: $${candidate.volume24h.toLocaleString()}`
        );
    }

    return marketData.candidates;
}

// ============================================================
// OHLCV DATA
// ============================================================

async function getOHLCV(symbol, timeframe) {

    try {

        const data = await exchange.fetchOHLCV(
            symbol,
            timeframe,
            undefined,
            100
        );

        return data;

    } catch (error) {

        console.log(
            `⚠️ ${symbol} ${timeframe} OHLCV hatası:`,
            error.message
        );

        return [];
    }
}

// ============================================================
// TECHNICAL ANALYSIS
// ============================================================

function analyzeTechnical(symbol, data15m, data1h, data4h) {

    if (
        data15m.length < 30 ||
        data1h.length < 30 ||
        data4h.length < 30
    ) {
        return null;
    }

    const close15 =
        data15m[data15m.length - 1][4];

    const close1h =
        data1h[data1h.length - 1][4];

    const close4h =
        data4h[data4h.length - 1][4];

    const previous15 =
        data15m[data15m.length - 2][4];

    const previous1h =
        data1h[data1h.length - 2][4];

    const previous4h =
        data4h[data4h.length - 2][4];

    const change15 =
        calculatePercentage(previous15, close15);

    const change1h =
        calculatePercentage(previous1h, close1h);

    const change4h =
        calculatePercentage(previous4h, close4h);

    let scoreLong = 0;
    let scoreShort = 0;

    // 15m momentum
    if (change15 > 0.3) scoreLong += 1;
    if (change15 < -0.3) scoreShort += 1;

    // 1h momentum
    if (change1h > 0.5) scoreLong += 2;
    if (change1h < -0.5) scoreShort += 2;

    // 4h momentum
    if (change4h > 1) scoreLong += 3;
    if (change4h < -1) scoreShort += 3;

    let direction = "NEUTRAL";

    if (scoreLong >= 4 && scoreLong > scoreShort) {
        direction = "LONG";
    }

    if (scoreShort >= 4 && scoreShort > scoreLong) {
        direction = "SHORT";
    }

    if (direction === "NEUTRAL") {
        return null;
    }

    const confidence =
        Math.min(
            95,
            50 +
            Math.max(scoreLong, scoreShort) * 7
        );

    return {

        symbol,

        direction,

        confidence,

        price: close15,

        timeframeData: {

            "15m": {
                price: close15,
                change: Number(change15.toFixed(3))
            },

            "1h": {
                price: close1h,
                change: Number(change1h.toFixed(3))
            },

            "4h": {
                price: close4h,
                change: Number(change4h.toFixed(3))
            }

        },

        createdAt: Date.now()
    };
}

// ============================================================
// AI ANALYSIS
// ============================================================

async function analyzeWithAI(candidate, technicalData) {

    /*
     * ŞİMDİLİK AI API ÇAĞRISI YOK.
     *
     * Bu bölüm sistemi AI'ye hazır hale getiriyor.
     *
     * Daha sonra buraya OpenAI / Gemini / başka model
     * bağlantısı ekleyeceğiz.
     *
     * Böylece önce sistemin piyasa taramasını test edeceğiz.
     */

    console.log(
        `🤖 AI adayı hazır: ${candidate.symbol}`
    );

    return {

        symbol: candidate.symbol,

        direction: technicalData.direction,

        confidence: technicalData.confidence,

        entry: technicalData.price,

        timeframe: technicalData.timeframeData,

        reason:
            "Teknik ön filtre güçlü momentum tespit etti. AI doğrulaması bekleniyor.",

        status: "AI_PENDING",

        manualOnly: true,

        createdAt: Date.now()
    };
}

// ============================================================
// FULL SCAN
// ============================================================

async function runScan() {

    if (marketData.scanning) {

        console.log(
            "⏳ Önceki tarama halen devam ediyor."
        );

        return;
    }

    marketData.scanning = true;

    try {

        const candidates =
            await scanMarkets();

        const technicalCandidates = [];

        for (const candidate of candidates) {

            console.log(
                `🔬 Analiz: ${candidate.symbol}`
            );

            const data15 =
                await getOHLCV(candidate.symbol, "15m");

            const data1h =
                await getOHLCV(candidate.symbol, "1h");

            const data4h =
                await getOHLCV(candidate.symbol, "4h");

            const technical =
                analyzeTechnical(
                    candidate.symbol,
                    data15,
                    data1h,
                    data4h
                );

            if (technical) {

                technicalCandidates.push({
                    candidate,
                    technical
                });

                console.log(
                    `🎯 ${candidate.symbol} → ` +
                    `${technical.direction} ` +
                    `${technical.confidence}%`
                );
            }

            await sleep(100);
        }

        // En güçlü teknik adaylar
        technicalCandidates.sort(
            (a, b) =>
                b.technical.confidence -
                a.technical.confidence
        );

        const aiCandidates =
            technicalCandidates.slice(
                0,
                CONFIG.maxAiCandidates
            );

        const newSignals = [];

        for (const item of aiCandidates) {

            const signal =
                await analyzeWithAI(
                    item.candidate,
                    item.technical
                );

            if (signal) {
                newSignals.push(signal);
            }
        }

        // Yeni sinyalleri başa ekle
        marketData.signals = [
            ...newSignals,
            ...marketData.signals
        ].slice(0, 50);

        marketData.lastScan =
            new Date().toISOString();

        console.log("\n======================================");
        console.log("✅ TARAMA TAMAMLANDI");
        console.log(
            `🎯 Teknik aday: ${technicalCandidates.length}`
        );
        console.log(
            `🤖 AI adayı: ${aiCandidates.length}`
        );
        console.log(
            `📢 Toplam sinyal: ${marketData.signals.length}`
        );
        console.log("======================================\n");

    } catch (error) {

        console.error(
            "❌ Market scan error:",
            error
        );

    } finally {

        marketData.scanning = false;
    }
}

// ============================================================
// MANUAL SCAN
// ============================================================

app.post("/api/scan", async (req, res) => {

    if (marketData.scanning) {

        return res.json({
            success: false,
            message: "Tarama zaten devam ediyor."
        });
    }

    // Arka planda çalıştır
    runScan();

    res.json({
        success: true,
        message: "Market taraması başlatıldı."
    });
});

// ============================================================
// AUTOMATIC SCANNER
// ============================================================

setInterval(
    runScan,
    CONFIG.scanInterval
);

// ============================================================
// SERVER
// ============================================================

app.listen(PORT, "0.0.0.0", () => {

    console.log("");
    console.log("======================================");
    console.log("🚀 SONNY AI SIGNAL SCANNER");
    console.log("======================================");
    console.log(`🌐 Port: ${PORT}`);
    console.log("📡 Exchange: Bitget");
    console.log("🤖 AI: Hazır / API bağlantısı bekliyor");
    console.log("💰 AUTO TRADE: KAPALI");
    console.log("👤 MANUEL TRADING: AKTİF");
    console.log("======================================");
    console.log("");
});
