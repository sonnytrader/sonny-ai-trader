const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

const SYSTEM_NAME = "Sonny AI Signal Scanner";

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

app.get("/", (req, res) => {
  res.json({
    success: true,
    system: SYSTEM_NAME,
    status: "online",
    mode: "MANUAL TRADING ONLY",
    lastScan: null
  });
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
    status: "online",
    mode: "MANUAL TRADING ONLY",
    lastScan: null,
    timestamp: new Date().toISOString()
  });
});

app.get("/api/scan", (req, res) => {
  res.json({
    success: true,
    system: SYSTEM_NAME,
    status: "ready",
    message: "Scanner is ready. Market scanning engine will be added next.",
    mode: "MANUAL TRADING ONLY",
    signals: []
  });
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Endpoint not found"
  });
});

app.listen(PORT, "0.0.0.0", () => {
  log(`${SYSTEM_NAME} started`);
  log(`Server listening on port ${PORT}`);
});
