const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

/* In-memory datastore (replace with DB in production) */
const db = {
  admin: { email: "admin@alphason.com", passHash: null },
  users: [],               // { id, email, passHash, plan, strategies, apiKeys? }
  sessions: new Map(),     // token -> { userId, email, isAdmin, createdAt }
  config: {                // global config
    minConfidence: 60,
    orderType: "limit",
    leverage: 10,
    marginPercent: 5,
    riskProfile: "balanced",
    scalpMode: false,
    autoTrade: false,
    strategies: { breakout: true, trend: true, pump: true }
  },
  signals: [
    { symbol: "BTCUSDT", side: "LONG", confidence: 78 },
    { symbol: "ETHUSDT", side: "SHORT", confidence: 65 },
    { symbol: "SOLUSDT", side: "LONG", confidence: 72 }
  ],
  positions: [
    { id: "pos_1", symbol: "BTCUSDT", side: "LONG", pnl: 1.24, openedAt: Date.now() }
  ],
  logs: []
};

/* Helpers */
const hash = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const newId = (p) => `${p}_${crypto.randomBytes(6).toString("hex")}`;
const newToken = () => crypto.randomBytes(24).toString("hex");
const now = () => new Date().toISOString();

function auth(req, res, next) {
  const t = req.headers["x-auth"] || req.headers["authorization"];
  if (!t) return res.status(401).json({ message: "Yetkisiz" });
  const s = db.sessions.get(t);
  if (!s) return res.status(401).json({ message: "Oturum geçersiz" });
  req.session = s;
  next();
}

/* Admin: set via UI */
app.post("/api/set-admin", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ message: "Email ve şifre gerekli" });
  db.admin.email = email;
  db.admin.passHash = hash(password);
  db.logs.push({ id: newId("log"), t: now(), type: "admin_set", email });
  return res.status(200).json({ message: "Admin bilgileri ayarlandı" });
});

/* Auth: login, logout */
app.post("/api/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ message: "Eksik bilgi" });
  const passHash = hash(password);

  // Admin login
  if (email === db.admin.email && passHash === db.admin.passHash) {
    const token = newToken();
    db.sessions.set(token, { token, userId: null, email, isAdmin: true, createdAt: Date.now() });
    return res.status(200).json({ message: "Admin girişi başarılı", token, role: "admin" });
  }

  // User login
  const user = db.users.find(u => u.email === email && u.passHash === passHash);
  if (!user) return res.status(401).json({ message: "Geçersiz giriş" });
  const token = newToken();
  db.sessions.set(token, { token, userId: user.id, email, isAdmin: false, createdAt: Date.now() });
  return res.status(200).json({ message: "Giriş başarılı", token, role: "user", plan: user.plan });
});

app.post("/api/logout", auth, (req, res) => {
  db.sessions.delete(req.session.token);
  return res.status(200).json({ message: "Çıkış yapıldı" });
});

/* Register + plans + strategies */
app.post("/api/register", (req, res) => {
  const { email, password, plan, strategies, apiKey, apiSecret, apiPass } = req.body || {};
  if (!email || !password) return res.status(400).json({ message: "Email ve şifre zorunlu" });
  if (db.users.some(u => u.email === email)) return res.status(409).json({ message: "Email zaten kayıtlı" });
  const user = {
    id: newId("usr"),
    email,
    passHash: hash(password),
    plan: plan || "basic",
    strategies: {
      breakout: !!strategies?.breakout,
      trend: !!strategies?.trend,
      pump: !!strategies?.pump
    },
    api: apiKey && apiSecret ? { apiKey, apiSecret, apiPass: apiPass || "" } : null,
    createdAt: Date.now()
  };
  db.users.push(user);
  db.logs.push({ id: newId("log"), t: now(), type: "user_register", email, plan: user.plan });
  return res.status(201).json({ message: "Kayıt başarılı", userId: user.id });
});

/* Config get/save (admin only) */
app.get("/api/config", auth, (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ message: "Yetki yok" });
  return res.json(db.config);
});

app.post("/api/config", auth, (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ message: "Yetki yok" });
  const cfg = req.body || {};
  db.config = {
    minConfidence: Number(cfg.minConfidence ?? db.config.minConfidence),
    orderType: cfg.orderType ?? db.config.orderType,
    leverage: Number(cfg.leverage ?? db.config.leverage),
    marginPercent: Number(cfg.marginPercent ?? db.config.marginPercent),
    riskProfile: cfg.riskProfile ?? db.config.riskProfile,
    scalpMode: !!cfg.scalpMode,
    autoTrade: !!cfg.autoTrade,
    strategies: {
      breakout: !!cfg.strategies?.breakout,
      trend: !!cfg.strategies?.trend,
      pump: !!cfg.strategies?.pump
    }
  };
  db.logs.push({ id: newId("log"), t: now(), type: "config_update" });
  return res.status(200).json({ message: "Ayarlar kaydedildi" });
});

/* Signals: list + scan trigger (admin or user) */
app.get("/api/signals", auth, (req, res) => {
  const minConf = db.config.minConfidence || 0;
  const filtered = db.signals.filter(s => s.confidence >= minConf);
  return res.json(filtered);
});

app.post("/api/scan", auth, (req, res) => {
  // Demo scan: produce based on strategies
  const st = db.config.strategies;
  const out = [];
  if (st.breakout) out.push({ symbol: "BTCUSDT", side: "LONG", confidence: 80 });
  if (st.trend) out.push({ symbol: "ETHUSDT", side: "SHORT", confidence: 68 });
  if (st.pump) out.push({ symbol: "SOLUSDT", side: "LONG", confidence: 74 });
  out.push({ symbol: "BNBUSDT", side: "LONG", confidence: 63 });
  db.signals = out;
  db.logs.push({ id: newId("log"), t: now(), type: "scan_run", count: out.length });
  return res.status(200).json({ message: "Tarama tamamlandı", count: out.length });
});

/* Positions: list */
app.get("/api/positions", auth, (req, res) => {
  return res.json(db.positions);
});

/* Manual trade: create position (respect order type) */
app.post("/api/manual-trade", auth, (req, res) => {
  const { symbol, side, amount, price, type } = req.body || {};
  if (!symbol || !side || !amount) return res.status(400).json({ message: "Eksik alanlar" });
  const pos = { id: newId("pos"), symbol, side, pnl: 0, openedAt: Date.now(), order: { type: type || "market", price: Number(price || 0), amount: Number(amount) } };
  db.positions.push(pos);
  db.logs.push({ id: newId("log"), t: now(), type: "manual_trade", symbol, side, amount });
  return res.status(200).json({ message: "Emir alındı", positionId: pos.id });
});

/* User strategies update (user can set own prefs) */
app.post("/api/user/strategies", auth, (req, res) => {
  if (req.session.isAdmin) return res.status(400).json({ message: "Admin için geçerli değil" });
  const u = db.users.find(x => x.id === req.session.userId);
  if (!u) return res.status(404).json({ message: "Kullanıcı bulunamadı" });
  const st = req.body?.strategies || {};
  u.strategies = { breakout: !!st.breakout, trend: !!st.trend, pump: !!st.pump };
  return res.status(200).json({ message: "Kullanıcı stratejileri güncellendi", strategies: u.strategies });
});

/* Plans: upgrade/downgrade */
app.post("/api/user/plan", auth, (req, res) => {
  if (req.session.isAdmin) return res.status(400).json({ message: "Admin için geçerli değil" });
  const u = db.users.find(x => x.id === req.session.userId);
  if (!u) return res.status(404).json({ message: "Kullanıcı bulunamadı" });
  const plan = req.body?.plan;
  if (!["basic","pro","elite"].includes(plan)) return res.status(400).json({ message: "Geçersiz plan" });
  u.plan = plan;
  return res.status(200).json({ message: "Plan güncellendi", plan });
});

/* Logs */
app.get("/api/logs", auth, (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ message: "Yetki yok" });
  return res.json(db.logs.slice(-200));
});

/* SPA fallback */
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/videos/") || req.path === "/styles.css") return next();
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server çalışıyor: http://localhost:${PORT}`));
