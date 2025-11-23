-- SQLite şema (server.js zaten yaratıyor; istersen manuel çalıştır)
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE,
  password TEXT,
  fullName TEXT,
  role TEXT DEFAULT 'user',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  plan TEXT DEFAULT 'pro',
  status TEXT DEFAULT 'active',
  period_start DATETIME DEFAULT CURRENT_TIMESTAMP,
  period_end DATETIME,
  limits_json TEXT
);

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  exchange TEXT,
  api_key TEXT,
  secret TEXT,
  passphrase TEXT,
  is_active BOOLEAN DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_config (
  user_id INTEGER PRIMARY KEY,
  minConfidenceForAuto INTEGER DEFAULT 60,
  orderType TEXT DEFAULT 'limit',
  leverage INTEGER DEFAULT 10,
  marginPercent INTEGER DEFAULT 5,
  scalpMode INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  symbol TEXT,
  direction TEXT,
  entry REAL,
  tp REAL,
  sl REAL,
  confidence INTEGER,
  rr REAL,
  quality INTEGER,
  strategy TEXT,
  source TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  symbol TEXT,
  direction TEXT,
  entry_price REAL,
  quantity REAL,
  tp_price REAL,
  sl_price REAL,
  order_ids_json TEXT,
  pnl REAL,
  status TEXT DEFAULT 'open',
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);
