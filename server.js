const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const SYSTEM_NAME = "Sonny AI Signal Scanner";

let lastScan = null;
let scanCount = 0;
let signals = [];

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function getStatus() {
  return {
    success: true,
    system: SYSTEM_NAME,
    status: "online",
    mode: "MANUAL TRADING ONLY",
    lastScan,
    scanCount,
    signalCount: signals.length,
    timestamp: new Date().toISOString()
  };
}

// ===============================
// DASHBOARD
// ===============================

app.get("/", (req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${SYSTEM_NAME}</title>

  <style>
    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      font-family: Arial, Helvetica, sans-serif;
      background: #0b1020;
      color: #f4f7fb;
    }

    .wrap {
      max-width: 1200px;
      margin: auto;
      padding: 28px 18px 50px;
    }

    .top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 20px;
      margin-bottom: 24px;
      flex-wrap: wrap;
    }

    .brand h1 {
      margin: 0;
      font-size: 28px;
    }

    .brand p {
      margin: 7px 0 0;
      color: #9ca8bd;
      font-size: 14px;
    }

    .status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      border: 1px solid #24422f;
      border-radius: 999px;
      background: #102318;
      color: #71e39a;
      font-size: 13px;
      font-weight: 700;
    }

    .dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: #41d97c;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 14px;
      margin-bottom: 18px;
    }

    .card {
      background: #12192b;
      border: 1px solid #202b42;
      border-radius: 16px;
      padding: 18px;
    }

    .label {
      color: #8996ad;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: .08em;
      margin-bottom: 10px;
    }

    .value {
      font-size: 21px;
      font-weight: 700;
    }

    .main {
      display: grid;
      grid-template-columns: 1.7fr .9fr;
      gap: 18px;
    }

    .panel {
      background: #12192b;
      border: 1px solid #202b42;
      border-radius: 16px;
      padding: 20px;
    }

    .panel h2 {
      margin: 0 0 7px;
      font-size: 19px;
    }

    .muted {
      color: #8996ad;
      font-size: 13px;
    }

    .actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin: 18px 0;
    }

    button {
      border: 0;
      border-radius: 10px;
      padding: 12px 17px;
      font-weight: 700;
      cursor: pointer;
      background: #f2f5fa;
      color: #0b1020;
    }

    button.secondary {
      background: #202b42;
      color: #f4f7fb;
    }

    button:disabled {
      opacity: .55;
      cursor: not-allowed;
    }

    .notice {
      padding: 14px;
      border-radius: 12px;
      background: #171f33;
      border: 1px solid #273550;
      color: #bdc7d8;
      font-size: 14px;
      line-height: 1.55;
    }

    .signals {
      margin-top: 15px;
    }

    .signal {
      border: 1px solid #25314a;
      background: #0f1627;
      border-radius: 12px;
      padding: 14px;
      margin-top: 10px;
    }

    .signal-head {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
    }

    .signal-symbol {
      font-weight: 800;
      font-size: 16px;
    }

    .badge {
      border-radius: 999px;
      padding: 5px 9px;
      font-size: 11px;
      font-weight: 800;
      background: #242f45;
      color: #b9c5d8;
    }

    .empty {
      text-align: center;
      padding: 45px 20px;
      color: #7e8aa0;
    }

    .side-row {
      display: flex;
      justify-content: space-between;
      padding: 12px 0;
      border-bottom: 1px solid #202b42;
      font-size: 14px;
    }

    .side-row:last-child {
      border-bottom: 0;
    }

    .safe {
      color: #71e39a;
      font-weight: 700;
    }

    footer {
      text-align: center;
      color: #69758a;
      font-size: 12px;
      margin-top: 25px;
    }

    @media (max-width: 850px) {
      .grid {
        grid-template-columns: repeat(2, 1fr);
      }

      .main {
        grid-template-columns: 1fr;
      }
    }

    @media (max-width: 520px) {
      .grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>

<body>

  <div class="wrap">

    <div class="top">

      <div class="brand">
        <h1>🚀 Sonny AI Signal Scanner</h1>
        <p>Manuel trading için sinyal analiz merkezi</p>
      </div>

      <div class="status">
        <span class="dot"></span>
        SYSTEM ONLINE
      </div>

    </div>

    <div class="grid">

      <div class="card">
        <div class="label">Sistem</div>
        <div class="value" id="systemStatus">ONLINE</div>
      </div>

      <div class="card">
        <div class="label">Mod</div>
        <div class="value">MANUAL</div>
      </div>

      <div class="card">
        <div class="label">Tarama</div>
        <div class="value" id="scanCount">0</div>
      </div>

      <div class="card">
        <div class="label">Aktif Sinyal</div>
        <div class="value" id="signalCount">0</div>
      </div>

    </div>

    <div class="main">

      <section class="panel">

        <h2>Sinyal Scanner</h2>

        <div class="muted">
          Güçlü sinyaller burada gösterilecek. Sistem otomatik işlem açmaz.
        </div>

        <div class="actions">

          <button id="scanBtn" onclick="runScan()">
            🔎 Piyasayı Tara
          </button>

          <button class="secondary" onclick="refreshStatus()">
            ↻ Durumu Yenile
          </button>

        </div>

        <div class="notice" id="message">
          Sistem hazır. Canlı piyasa veri bağlantısı ve gerçek sinyal motoru
          bir sonraki aşamada eklenecek.
        </div>

        <div class="signals" id="signals">

          <div class="empty">
            Henüz sinyal bulunmuyor.
          </div>

        </div>

      </section>

      <aside class="panel">

        <h2>Sistem Bilgisi</h2>

        <div class="side-row">
          <span>Sunucu</span>
          <span class="safe">ONLINE</span>
        </div>

        <div class="side-row">
          <span>Otomatik işlem</span>
          <span class="safe">KAPALI</span>
        </div>

        <div class="side-row">
          <span>Risk yönetimi</span>
          <span>MANUEL</span>
        </div>

        <div class="side-row">
          <span>Son tarama</span>
          <span id="lastScan">Yok</span>
        </div>

        <div class="side-row">
          <span>API</span>
          <span class="safe">READY</span>
        </div>

      </aside>

    </div>

    <footer>
      Sonny AI Signal Scanner · Manual Trading Only
    </footer>

  </div>

  <script>

    async function refreshStatus() {

      try {

        const response = await fetch("/api/status");
        const data = await response.json();

        document.getElementById("systemStatus").textContent =
          data.status ? data.status.toUpperCase() : "ONLINE";

        document.getElementById("scanCount").textContent =
          data.scanCount || 0;

        document.getElementById("signalCount").textContent =
          data.signalCount || 0;

        document.getElementById("lastScan").textContent =
          data.lastScan
            ? new Date(data.lastScan).toLocaleString("tr-TR")
            : "Yok";

      } catch (error) {

        document.getElementById("systemStatus").textContent = "OFFLINE";

      }

    }

    async function runScan() {

      const button = document.getElementById("scanBtn");
      const message = document.getElementById("message");

      button.disabled = true;
      button.textContent = "⏳ Tarama yapılıyor...";
      message.textContent = "Scanner çalışıyor...";

      try {

        const response = await fetch("/api/scan");
        const data = await response.json();

        message.textContent =
          data.message || "Tarama tamamlandı.";

        const container =
          document.getElementById("signals");

        if (!data.signals || data.signals.length === 0) {

          container.innerHTML =
            '<div class="empty">Bu taramada güçlü sinyal bulunamadı.</div>';

        } else {

          container.innerHTML =
            data.signals.map(function(signal) {

              return (
                '<div class="signal">' +
                  '<div class="signal-head">' +
                    '<span class="signal-symbol">' +
                      escapeHtml(signal.symbol) +
                    '</span>' +
                    '<span class="badge">' +
                      escapeHtml(signal.direction) +
                    '</span>' +
                  '</div>' +
                  '<div class="muted" style="margin-top:8px;">Güç: ' +
                    escapeHtml(String(signal.strength)) +
                  '</div>' +
                '</div>'
              );

            }).join("");

        }

        await refreshStatus();

      } catch (error) {

        message.textContent =
          "Tarama sırasında bağlantı hatası oluştu.";

      } finally {

        button.disabled = false;
        button.textContent = "🔎 Piyasayı Tara";

      }

    }

    function escapeHtml(value) {

      return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");

    }

    refreshStatus();

  </script>

</body>
</html>`);
});

// ===============================
// HEALTH
// ===============================

app.get("/health", (req, res) => {

  res.json({
    success: true,
    status: "healthy",
    system: SYSTEM_NAME,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });

});

// ===============================
// STATUS API
// ===============================

app.get("/api/status", (req, res) => {

  res.json(getStatus());

});

// ===============================
// SCANNER API
// ===============================

app.get("/api/scan", (req, res) => {

  scanCount++;

  lastScan = new Date().toISOString();

  signals = [];

  res.json({

    success: true,

    system: SYSTEM_NAME,

    status: "ready",

    message:
      "Tarama tamamlandı. Canlı piyasa veri kaynağı henüz bağlanmadığı için güçlü sinyal üretilmedi.",

    mode: "MANUAL TRADING ONLY",

    signals: signals,

    scannedAt: lastScan,

    scanCount: scanCount

  });

});

// ===============================
// 404
// ===============================

app.use((req, res) => {

  res.status(404).json({
    success: false,
    error: "Endpoint not found"
  });

});

// ===============================
// START
// ===============================

app.listen(PORT, "0.0.0.0", () => {

  log(`${SYSTEM_NAME} started`);

  log(`Server listening on port ${PORT}`);

});
