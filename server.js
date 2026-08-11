const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const SYSTEM_NAME = "Sonny AI Signal Scanner";

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

/* =========================================================
   DASHBOARD
========================================================= */

app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">

<title>Sonny AI Signal Scanner</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: Arial, Helvetica, sans-serif;
  background: #080b12;
  color: #ffffff;
}

.container {
  max-width: 1200px;
  margin: auto;
  padding: 25px;
}

/* HEADER */

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px 0 30px;
  border-bottom: 1px solid #202633;
}

.logo {
  font-size: 28px;
  font-weight: 800;
  letter-spacing: 1px;
}

.logo span {
  color: #00e5ff;
}

.subtitle {
  margin-top: 6px;
  color: #8d96a8;
  font-size: 13px;
}

.status {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #48e68a;
  font-weight: bold;
  font-size: 14px;
}

.status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #48e68a;
  box-shadow: 0 0 12px #48e68a;
}

/* CONTROL */

.control {
  margin-top: 25px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #10151f;
  border: 1px solid #202938;
  border-radius: 14px;
  padding: 20px;
}

.mode {
  color: #aab3c2;
  font-size: 14px;
}

.mode strong {
  color: #ffffff;
}

.scan-button {
  border: none;
  border-radius: 9px;
  padding: 13px 24px;
  background: #00e5ff;
  color: #061018;
  font-size: 15px;
  font-weight: 800;
  cursor: pointer;
}

.scan-button:hover {
  opacity: 0.85;
}

/* MARKET CARDS */

.market-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 18px;
  margin-top: 25px;
}

.card {
  background: #10151f;
  border: 1px solid #202938;
  border-radius: 14px;
  padding: 20px;
}

.card-title {
  color: #8d96a8;
  font-size: 13px;
  margin-bottom: 12px;
}

.coin {
  font-size: 20px;
  font-weight: 800;
}

.signal {
  margin-top: 18px;
  font-size: 25px;
  font-weight: 900;
}

.wait {
  color: #f2c94c;
}

.score {
  margin-top: 8px;
  color: #8d96a8;
}

.score strong {
  color: #ffffff;
  font-size: 22px;
}

/* SIGNAL PANEL */

.section {
  margin-top: 30px;
}

.section-title {
  font-size: 20px;
  font-weight: 800;
  margin-bottom: 15px;
}

.signal-panel {
  background: #10151f;
  border: 1px solid #202938;
  border-radius: 14px;
  overflow: hidden;
}

.signal-row {
  display: grid;
  grid-template-columns: 1.5fr 1fr 1fr 1fr 1fr;
  padding: 17px 20px;
  border-bottom: 1px solid #202633;
  font-size: 14px;
}

.signal-row:last-child {
  border-bottom: none;
}

.signal-header {
  color: #7f899b;
  font-size: 12px;
  text-transform: uppercase;
}

.empty {
  padding: 40px 20px;
  text-align: center;
  color: #737d8e;
}

/* FOOTER */

.footer {
  text-align: center;
  margin-top: 40px;
  padding: 20px;
  color: #596273;
  font-size: 12px;
}

/* MOBILE */

@media (max-width: 800px) {

  .market-grid {
    grid-template-columns: 1fr;
  }

  .header {
    flex-direction: column;
    align-items: flex-start;
    gap: 15px;
  }

  .control {
    flex-direction: column;
    align-items: flex-start;
    gap: 15px;
  }

  .signal-row {
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }

}

</style>
</head>

<body>

<div class="container">

  <!-- HEADER -->

  <div class="header">

    <div>
      <div class="logo">
        SONNY <span>AI</span> SIGNAL SCANNER
      </div>

      <div class="subtitle">
        Intelligent Market Opportunity Detection System
      </div>
    </div>

    <div class="status">
      <div class="status-dot"></div>
      SYSTEM ONLINE
    </div>

  </div>


  <!-- CONTROL -->

  <div class="control">

    <div class="mode">
      Trading Mode:
      <strong>MANUAL TRADING ONLY</strong>
      <br>
      <span id="lastScan">
        Last scan: Not scanned yet
      </span>
    </div>

    <button class="scan-button" onclick="scanMarket()">
      SCAN MARKET
    </button>

  </div>


  <!-- MARKET -->

  <div class="market-grid">

    <div class="card">

      <div class="card-title">
        MARKET
      </div>

      <div class="coin">
        BTC / USDT
      </div>

      <div class="signal wait">
        WAIT
      </div>

      <div class="score">
        Sonny Score:
        <strong>--</strong> / 100
      </div>

    </div>


    <div class="card">

      <div class="card-title">
        MARKET
      </div>

      <div class="coin">
        ETH / USDT
      </div>

      <div class="signal wait">
        WAIT
      </div>

      <div class="score">
        Sonny Score:
        <strong>--</strong> / 100
      </div>

    </div>


    <div class="card">

      <div class="card-title">
        MARKET
      </div>

      <div class="coin">
        SOL / USDT
      </div>

      <div class="signal wait">
        WAIT
      </div>

      <div class="score">
        Sonny Score:
        <strong>--</strong> / 100
      </div>

    </div>

  </div>


  <!-- SIGNALS -->

  <div class="section">

    <div class="section-title">
      SONNY SIGNALS
    </div>

    <div class="signal-panel">

      <div class="signal-row signal-header">
        <div>Asset</div>
        <div>Signal</div>
        <div>Score</div>
        <div>Trend</div>
        <div>Risk</div>
      </div>

      <div id="signals">

        <div class="empty">
          Henüz piyasa taraması yapılmadı.
          <br><br>
          SCAN MARKET butonuna basarak taramayı başlat.
        </div>

      </div>

    </div>

  </div>


  <!-- FOOTER -->

  <div class="footer">
    SONNY AI SIGNAL SCANNER © 2026
    <br>
    Manual Trading Only — No Automatic Orders
  </div>

</div>


<script>

async function scanMarket() {

  const button = document.querySelector(".scan-button");
  const signals = document.getElementById("signals");
  const lastScan = document.getElementById("lastScan");

  button.disabled = true;
  button.innerText = "SCANNING...";

  signals.innerHTML = `
    <div class="empty">
      Market scanning engine çalışıyor...
    </div>
  `;

  try {

    const response = await fetch("/api/scan");
    const data = await response.json();

    lastScan.innerText =
      "Last scan: " + new Date().toLocaleTimeString("tr-TR");

    if (data.signals && data.signals.length > 0) {

      signals.innerHTML = data.signals.map(signal => `

        <div class="signal-row">

          <div>
            <strong>${signal.symbol}</strong>
          </div>

          <div>
            ${signal.signal}
          </div>

          <div>
            ${signal.score}/100
          </div>

          <div>
            ${signal.trend}
          </div>

          <div>
            ${signal.risk}
          </div>

        </div>

      `).join("");

    } else {

      signals.innerHTML = `
        <div class="empty">
          Şu anda güçlü sinyal bulunamadı.
          <br><br>
          Scanner hazır. Gerçek piyasa motoru bir sonraki aşamada bağlanacak.
        </div>
      `;

    }

  } catch (error) {

    signals.innerHTML = `
      <div class="empty">
        Scanner bağlantı hatası.
      </div>
    `;

    console.error(error);

  }

  button.disabled = false;
  button.innerText = "SCAN MARKET";

}

</script>

</body>
</html>
  `);
});


/* =========================================================
   HEALTH
========================================================= */

app.get("/health", (req, res) => {

  res.json({
    success: true,
    status: "healthy",
    system: SYSTEM_NAME,
    uptime: process.uptime()
  });

});


/* =========================================================
   STATUS API
========================================================= */

app.get("/api/status", (req, res) => {

  res.json({
    success: true,
    system: SYSTEM_NAME,
    status: "online",
    mode: "MANUAL TRADING ONLY",
    lastScan: null,
    timestamp: new Date().toISOString()
  });

});


/* =========================================================
   SCANNER API
========================================================= */

app.get("/api/scan", (req, res) => {

  res.json({

    success: true,

    system: SYSTEM_NAME,

    status: "ready",

    message:
      "Scanner is ready. Market scanning engine will be added next.",

    mode: "MANUAL TRADING ONLY",

    signals: []

  });

});


/* =========================================================
   404
========================================================= */

app.use((req, res) => {

  res.status(404).json({
    success: false,
    error: "Endpoint not found"
  });

});


/* =========================================================
   START SERVER
========================================================= */

app.listen(PORT, "0.0.0.0", () => {

  log(`${SYSTEM_NAME} started`);
  log(`Server listening on port ${PORT}`);

});
