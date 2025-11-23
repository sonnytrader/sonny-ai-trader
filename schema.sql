CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    plan TEXT DEFAULT 'basic',
    api_key TEXT,
    api_secret TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS signals (
    id TEXT PRIMARY KEY,
    symbol TEXT,
    strategy TEXT,
    direction TEXT,
    price REAL,
    confidence INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);
