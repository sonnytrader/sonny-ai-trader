const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

const SYSTEM_NAME = "Sonny AI Signal Scanner V2";
const BINANCE_BASE = "https://fapi.binance.com";

let lastScan = null;
let scanRunning = false;
let cachedResult = null;
let lastError = null;

/* =========================================================
   BASIC HELPERS
========================================================= */

function log(message) {
  console.log("[" + new Date().toISOString() + "] " + message);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function number(value, digits = 2) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(digits));
}

async function api(path) {
  const response = await fetch(BINANCE_BASE + path);

  if (!response.ok) {
    throw new Error(
      "Binance API " + response.status + " - " + path
    );
  }

  return response.json();
}

/* =========================================================
   TECHNICAL INDICATORS
========================================================= */

function ema(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);

  let result =
    values
      .slice(0, period)
      .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    result =
      (values[i] - result) * multiplier + result;
  }

  return result;
}

function sma(values, period) {
  if (values.length < period) return null;

  const slice = values.slice(-period);

  return (
    slice.reduce((sum, value) => sum + value, 0) /
    period
  );
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change >= 0) gains += change;
    else losses -= change;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;

    avgGain =
      ((avgGain * (period - 1)) + gain) / period;

    avgLoss =
      ((avgLoss * (period - 1)) + loss) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;

  return 100 - (100 / (1 + rs));
}

function atr(candles, period = 14) {
  if (candles.length <= period) return null;

  const trs = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    const high = current.high;
    const low = current.low;
    const previousClose = previous.close;

    const tr = Math.max(
      high - low,
      Math.abs(high - previousClose),
      Math.abs(low - previousClose)
    );

    trs.push(tr);
  }

  return sma(trs, period);
}

function highest(candles, count) {
  const slice = candles.slice(-count);

  return Math.max(
    ...slice.map(candle => candle.high)
  );
}

function lowest(candles, count) {
  const slice = candles.slice(-count);

  return Math.min(
    ...slice.map(candle => candle.low)
  );
}

/* =========================================================
   CANDLE DATA
========================================================= */

function parseKlines(data) {
  return data.map(row => ({
    time: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5])
  }));
}

/* =========================================================
   MARKET DISCOVERY
========================================================= */

async function discoverMarket() {
  const [exchangeInfo, tickers] = await Promise.all([
    api("/fapi/v1/exchangeInfo"),
    api("/fapi/v1/ticker/24hr")
  ]);

  const validSymbols = new Set(
    exchangeInfo.symbols
      .filter(symbol => {
        return (
          symbol.status === "TRADING" &&
          symbol.quoteAsset === "USDT" &&
          symbol.contractType === "PERPETUAL"
        );
      })
      .map(symbol => symbol.symbol)
  );

  const market = tickers
    .filter(ticker => validSymbols.has(ticker.symbol))
    .map(ticker => ({
      symbol: ticker.symbol,
      price: Number(ticker.lastPrice),
      change24h: Number(ticker.priceChangePercent),
      volume24h: Number(ticker.quoteVolume),
      high24h: Number(ticker.highPrice),
      low24h: Number(ticker.lowPrice)
    }))
    .filter(item => item.volume24h > 5000000)
    .sort((a, b) => b.volume24h - a.volume24h);

  return market;
}

/* =========================================================
   COIN ANALYSIS
========================================================= */

async function analyzeCoin(marketItem) {
  const symbol = marketItem.symbol;

  try {
    const data = await api(
      "/fapi/v1/klines?symbol=" +
      symbol +
      "&interval=5m&limit=300"
    );

    const candles = parseKlines(data);

    if (candles.length < 100) {
      return null;
    }

    const closes = candles.map(c => c.close);

    const current = candles[candles.length - 1];

    const ema20 = ema(closes, 20);
    const ema50 = ema(closes, 50);
    const ema100 = ema(closes, 100);

    const currentRsi = rsi(closes, 14);
    const currentAtr = atr(candles, 14);

    const averageVolume = sma(
      candles.map(c => c.volume),
      30
    );

    const volumeRatio =
      averageVolume > 0
        ? current.volume / averageVolume
        : 0;

    /*
      2 SAATLİK BÖLGE

      5 dakikalık mumlarda:
      2 saat = 24 mum
    */

    const previous2hHigh = highest(
      candles.slice(0, -1),
      24
    );

    const previous2hLow = lowest(
      candles.slice(0, -1),
      24
    );

    const breakoutUp =
      current.close > previous2hHigh;

    const breakoutDown =
      current.close < previous2hLow;

    /* =====================================================
       STRATEGY 1
       2H BREAKOUT
    ===================================================== */

    let breakoutScore = 0;

    if (breakoutUp || breakoutDown) {
      breakoutScore += 35;
    }

    if (volumeRatio >= 1.5) {
      breakoutScore += 20;
    }

    if (current.close > ema20 && ema20 > ema50) {
      breakoutScore += 20;
    }

    if (current.close < ema20 && ema20 < ema50) {
      breakoutScore += 20;
    }

    if (
      breakoutUp &&
      currentRsi >= 55 &&
      currentRsi <= 78
    ) {
      breakoutScore += 15;
    }

    if (
      breakoutDown &&
      currentRsi <= 45 &&
      currentRsi >= 22
    ) {
      breakoutScore += 15;
    }

    /* =====================================================
       STRATEGY 2
       TREND MOMENTUM
    ===================================================== */

    let momentumScore = 0;

    const bullishTrend =
      current.close > ema20 &&
      ema20 > ema50 &&
      ema50 > ema100;

    const bearishTrend =
      current.close < ema20 &&
      ema20 < ema50 &&
      ema50 < ema100;

    if (bullishTrend || bearishTrend) {
      momentumScore += 35;
    }

    if (volumeRatio >= 1.25) {
      momentumScore += 20;
    }

    if (
      bullishTrend &&
      currentRsi >= 55 &&
      currentRsi <= 72
    ) {
      momentumScore += 25;
    }

    if (
      bearishTrend &&
      currentRsi <= 45 &&
      currentRsi >= 28
    ) {
      momentumScore += 25;
    }

    if (marketItem.change24h > 2 || marketItem.change24h < -2) {
      momentumScore += 20;
    }

    /* =====================================================
       STRATEGY 3
       VOLATILITY EXPANSION
    ===================================================== */

    let volatilityScore = 0;

    const recentCandles = candles.slice(-20);

    const recentRange =
      Math.max(...recentCandles.map(c => c.high)) -
      Math.min(...recentCandles.map(c => c.low));

    const atrPercentage =
      currentAtr && current.close > 0
        ? (currentAtr / current.close) * 100
        : 0;

    if (atrPercentage >= 0.25) {
      volatilityScore += 25;
    }

    if (volumeRatio >= 1.5) {
      volatilityScore += 30;
    }

    if (
      recentRange / current.close * 100 >= 1
    ) {
      volatilityScore += 25;
    }

    if (bullishTrend || bearishTrend) {
      volatilityScore += 20;
    }

    /* =====================================================
       BEST STRATEGY
    ===================================================== */

    const strategies = [
      {
        name: "2H BREAKOUT",
        score: breakoutScore,
        direction: breakoutUp
          ? "LONG"
          : breakoutDown
            ? "SHORT"
            : null
      },
      {
        name: "TREND MOMENTUM",
        score: momentumScore,
        direction: bullishTrend
          ? "LONG"
          : bearishTrend
            ? "SHORT"
            : null
      },
      {
        name: "VOLATILITY EXPANSION",
        score: volatilityScore,
        direction: bullishTrend
          ? "LONG"
          : bearishTrend
            ? "SHORT"
            : null
      }
    ];

    strategies.sort((a, b) => b.score - a.score);

    const best = strategies[0];

    if (!best.direction || best.score < 65) {
      return {
        symbol,
        price: number(current.close, 8),
        change24h: number(marketItem.change24h),
        volume24h: number(
          marketItem.volume24h / 1000000
        ),
        score: best.score,
        strategy: best.name,
        direction: null,
        rsi: number(currentRsi),
        volumeRatio: number(volumeRatio),
        breakout: false
      };
    }

    return {
      symbol,
      price: number(current.close, 8),
      change24h: number(marketItem.change24h),
      volume24h: number(
        marketItem.volume24h / 1000000
      ),
      score: best.score,
      strategy: best.name,
      direction: best.direction,
      rsi: number(currentRsi),
      volumeRatio: number(volumeRatio),
      breakout: breakoutUp || breakoutDown
    };

  } catch (error) {
    log("Coin analysis error " + symbol + ": " + error.message);
    return null;
  }
}

/* =========================================================
   FULL SCAN
========================================================= */

async function runScan() {
  if (scanRunning) {
    return cachedResult;
  }

  scanRunning = true;
  lastError = null;

  const started = Date.now();

  try {
    log("Starting new market discovery...");

    /*
      İLK AŞAMA:
      Tüm uygun USDT perpetual coinleri keşfet.
    */

    const market = await discoverMarket();

    /*
      İKİNCİ AŞAMA:
      Likidite + hareket açısından en önemli adayları
      detaylı teknik analize gönder.

      Bu eski sistemdeki sabit coin listesi mantığı değil.
      Piyasa her taramada yeniden keşfediliyor.
    */

    const candidates = market.slice(0, 80);

    const results = [];

    /*
      Binance'e aynı anda aşırı yük bindirmemek için
      küçük gruplar halinde tarıyoruz.
    */

    for (let i = 0; i < candidates.length; i += 8) {
      const batch = candidates.slice(i, i + 8);

      const batchResults = await Promise.all(
        batch.map(item => analyzeCoin(item))
      );

      for (const result of batchResults) {
        if (result) {
          results.push(result);
        }
      }

      await sleep(100);
    }

    results.sort((a, b) => b.score - a.score);

    const signals = results
      .filter(item => item.direction)
      .slice(0, 15);

    const elapsed =
      ((Date.now() - started) / 1000).toFixed(1);

    cachedResult = {
      success: true,
      system: SYSTEM_NAME,
      timestamp: new Date().toISOString(),

      marketDiscovery: {
        totalCoins: market.length,
        detailedCandidates: candidates.length
      },

      scan: {
        durationSeconds: Number(elapsed),
        analyzed: results.length
      },

      signals,

      watchlist: results
        .filter(item => !item.direction)
        .slice(0, 20),

      mode: "MANUAL TRADING ONLY"
    };

    lastScan = new Date().toISOString();

    log(
      "Scan completed. Coins: " +
      market.length +
      " | Candidates: " +
      candidates.length +
      " | Signals: " +
      signals.length
    );

    return cachedResult;

  } catch (error) {

    lastError = error.message;

    log("SCAN ERROR: " + error.message);

    return {
      success: false,
      error: error.message,
      system: SYSTEM_NAME
    };

  } finally {
    scanRunning = false;
  }
}

/* =========================================================
   WEB UI
========================================================= */

const HTML = `
<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">

<title>Sonny AI Signal Scanner V2</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #080d1d;
  color: #f1f5f9;
  font-family: Arial, Helvetica, sans-serif;
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
  color: #8ea0c4;
  margin-top: 6px;
}

.online {
  background: #0c2a1b;
  border: 1px solid #1c6b40;
  color: #48e28c;
  padding: 10px 15px;
  border-radius: 20px;
  font-weight: bold;
}

.grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 20px;
}

.card {
  background: #11182b;
  border: 1px solid #23304a;
  border-radius: 14px;
  padding: 18px;
}

.label {
  color: #7f92b8;
  font-size: 12px;
  text-transform: uppercase;
  margin-bottom: 8px;
}

.value {
  font-size: 24px;
  font-weight: 800;
}

.panel {
  background: #11182b;
  border: 1px solid #23304a;
  border-radius: 14px;
  padding: 20px;
  margin-bottom: 20px;
}

button {
  background: #f1f5f9;
  color: #08101f;
  border: 0;
  padding: 12px 18px;
  border-radius: 9px;
  font-weight: 800;
  cursor: pointer;
  margin-right: 8px;
}

button.secondary {
  background: #263551;
  color: white;
}

button:hover {
  opacity: 0.85;
}

.status {
  margin-top: 15px;
  background: #0d1527;
  border: 1px solid #2a3a59;
  border-radius: 9px;
  padding: 14px;
  color: #9fb0d0;
}

table {
  width: 100%;
  border-collapse: collapse;
}

th {
  color: #7185ac;
  font-size: 12px;
  text-align: left;
  padding: 12px 8px;
  border-bottom: 1px solid #26334d;
}

td {
  padding: 14px 8px;
  border-bottom: 1px solid #1d2940;
}

.signal-long {
  color: #42e88b;
  font-weight: 900;
}

.signal-short {
  color: #ff637d;
  font-weight: 900;
}

.score {
  font-weight: 900;
}

.good {
  color: #42e88b;
}

.medium {
  color: #f7c95c;
}

.muted {
  color: #7185ac;
}

.empty {
  text-align: center;
  padding: 35px;
  color: #7185ac;
}

.small {
  font-size: 12px;
  color: #7185ac;
}

@media(max-width: 800px) {
  .grid {
    grid-template-columns: repeat(2, 1fr);
  }

  .header {
    display: block;
  }

  .online {
    display: inline-block;
    margin-top: 15px;
  }

  table {
    font-size: 12px;
  }
}

</style>
</head>

<body>

<div class="container">

  <div class="header">

    <div>
      <div class="title">
        🚀 Sonny AI Signal Scanner
      </div>

      <div class="subtitle">
        Yeni nesil piyasa keşfi ve çoklu strateji analiz sistemi
      </div>
    </div>

    <div class="online">
      ● SYSTEM ONLINE
    </div>

  </div>

  <div class="grid">

    <div class="card">
      <div class="label">Piyasa</div>
      <div class="value" id="market">-</div>
    </div>

    <div class="card">
      <div class="label">Detaylı Analiz</div>
      <div class="value" id="analyzed">-</div>
    </div>

    <div class="card">
      <div class="label">Sinyal</div>
      <div class="value" id="signals">0</div>
    </div>

    <div class="card">
      <div class="label">Son Tarama</div>
      <div class="value" id="last">-</div>
    </div>

  </div>

  <div class="panel">

    <h2>Piyasa Motoru</h2>

    <p class="muted">
      Sistem sabit coin listesine bağlı değildir.
      Her taramada piyasayı yeniden keşfeder,
      likidite ve hareketliliği değerlendirir,
      ardından en güçlü adayları teknik stratejilere gönderir.
    </p>

    <button onclick="scan()">
      🔎 Şimdi Tara
    </button>

    <button class="secondary" onclick="loadStatus()">
      ↻ Durumu Yenile
    </button>

    <div class="status" id="status">
      Sistem hazır. İlk piyasa taramasını başlatabilirsiniz.
    </div>

  </div>

  <div class="panel">

    <h2>🔥 Aktif Sinyaller</h2>

    <div id="signalsTable">
      <div class="empty">
        Henüz tarama yapılmadı.
      </div>
    </div>

  </div>

  <div class="panel">

    <h2>👀 İzleme Listesi</h2>

    <div id="watchlist">
      <div class="empty">
        Tarama sonrası adaylar burada görünecek.
      </div>
    </div>

  </div>

  <div class="small">
    Sonny AI Signal Scanner V2 · Manual Trading Only
  </div>

</div>

<script>

function setStatus(text) {
  document.getElementById("status").innerText = text;
}

async function loadStatus() {

  try {

    const response =
      await fetch("/api/status");

    const data =
      await response.json();

    if (data.lastScan) {
      document.getElementById("last").innerText =
        new Date(data.lastScan).toLocaleTimeString("tr-TR");
    }

  } catch(error) {

    setStatus("Sunucu durumu alınamadı.");

  }

}

function renderSignals(signals) {

  const box =
    document.getElementById("signalsTable");

  if (!signals || signals.length === 0) {

    box.innerHTML =
      '<div class="empty">Şu anda güçlü sinyal bulunmuyor.</div>';

    return;
  }

  let html = "";

  html += "<table>";

  html += "<tr>";
  html += "<th>COIN</th>";
  html += "<th>YÖN</th>";
  html += "<th>PUAN</th>";
  html += "<th>STRATEJİ</th>";
  html += "<th>RSI</th>";
  html += "<th>VOL</th>";
  html += "<th>FİYAT</th>";
  html += "</tr>";

  signals.forEach(function(item) {

    const directionClass =
      item.direction === "LONG"
        ? "signal-long"
        : "signal-short";

    const scoreClass =
      item.score >= 80
        ? "good"
        : "medium";

    html += "<tr>";

    html += "<td><b>" + item.symbol + "</b></td>";

    html +=
      '<td class="' +
      directionClass +
      '">' +
      item.direction +
      "</td>";

    html +=
      '<td class="score ' +
      scoreClass +
      '">' +
      item.score +
      "</td>";

    html +=
      "<td>" +
      item.strategy +
      "</td>";

    html +=
      "<td>" +
      item.rsi +
      "</td>";

    html +=
      "<td>" +
      item.volumeRatio +
      "x</td>";

    html +=
      "<td>" +
      item.price +
      "</td>";

    html += "</tr>";

  });

  html += "</table>";

  box.innerHTML = html;
}

function renderWatchlist(items) {

  const box =
    document.getElementById("watchlist");

  if (!items || items.length === 0) {

    box.innerHTML =
      '<div class="empty">İzlenecek aday bulunamadı.</div>';

    return;
  }

  let html = "";

  html += "<table>";

  html += "<tr>";
  html += "<th>COIN</th>";
  html += "<th>PUAN</th>";
  html += "<th>STRATEJİ</th>";
  html += "<th>RSI</th>";
  html += "<th>24H</th>";
  html += "</tr>";

  items.forEach(function(item) {

    html += "<tr>";

    html +=
      "<td><b>" +
      item.symbol +
      "</b></td>";

    html +=
      "<td>" +
      item.score +
      "</td>";

    html +=
      "<td>" +
      item.strategy +
      "</td>";

    html +=
      "<td>" +
      item.rsi +
      "</td>";

    html +=
      "<td>" +
      item.change24h +
      "%</td>";

    html += "</tr>";

  });

  html += "</table>";

  box.innerHTML = html;
}

async function scan() {

  setStatus(
    "Piyasa keşfediliyor... Coinler taranıyor. Bu işlem biraz sürebilir."
  );

  try {

    const response =
      await fetch("/api/scan");

    const data =
      await response.json();

    if (!data.success) {

      setStatus(
        "Tarama hatası: " +
        data.error
      );

      return;
    }

    document.getElementById("market").innerText =
      data.marketDiscovery.totalCoins;

    document.getElementById("analyzed").innerText =
      data.scan.analyzed;

    document.getElementById("signals").innerText =
      data.signals.length;

    document.getElementById("last").innerText =
      new Date(data.timestamp).toLocaleTimeString("tr-TR");

    setStatus(
      "Tarama tamamlandı. " +
      data.marketDiscovery.totalCoins +
      " coin keşfedildi, " +
      data.marketDiscovery.detailedCandidates +
      " aday detaylı analiz edildi."
    );

    renderSignals(data.signals);

    renderWatchlist(data.watchlist);

  } catch(error) {

    setStatus(
      "Sunucu bağlantı hatası: " +
      error.message
    );

  }

}

</script>

</body>
</html>
`;

/* =========================================================
   ROUTES
========================================================= */

app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(HTML);
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "healthy",
    system: SYSTEM_NAME,
    uptime: process.uptime()
  });
});

app.get("/api/status", (req, res) => {
  res.json({
    success: true,
    system: SYSTEM_NAME,
    status: scanRunning ? "SCANNING" : "ONLINE",
    mode: "MANUAL TRADING ONLY",
    lastScan,
    error: lastError
  });
});

app.get("/api/scan", async (req, res) => {

  const result = await runScan();

  res.json(result);

});

app.get("/api/result", (req, res) => {

  if (!cachedResult) {

    return res.json({
      success: true,
      message: "Henüz tarama yapılmadı.",
      result: null
    });

  }

  res.json(cachedResult);

});

app.use((req, res) => {

  res.status(404).json({
    success: false,
    error: "Endpoint not found"
  });

});

/* =========================================================
   SERVER
========================================================= */

app.listen(PORT, "0.0.0.0", () => {

  log(SYSTEM_NAME + " started");

  log(
    "Server listening on port " +
    PORT
  );

});
