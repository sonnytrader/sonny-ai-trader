const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcrypt');

const dbPath = path.join(__dirname, 'trading_bot.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('❌ Database connection error:', err.message);
    } else {
        console.log('✅ SQLite database connected');
        initializeDatabase();
    }
});

function initializeDatabase() {
    // Users table
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        plan TEXT DEFAULT 'basic',
        api_key TEXT,
        api_secret TEXT,
        api_passphrase TEXT,
        session_token TEXT,
        leverage INTEGER DEFAULT 10,
        margin_percent REAL DEFAULT 5.0,
        risk_level TEXT DEFAULT 'medium',
        daily_trade_limit INTEGER DEFAULT 10,
        max_positions INTEGER DEFAULT 3,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Signals table
    db.run(`CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        symbol TEXT NOT NULL,
        direction TEXT NOT NULL,
        entry_price REAL,
        tp_price REAL,
        sl_price REAL,
        confidence INTEGER,
        strategy TEXT,
        status TEXT DEFAULT 'active',
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id)
    )`);

    // Trades table
    db.run(`CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        symbol TEXT,
        direction TEXT,
        entry_price REAL,
        exit_price REAL,
        quantity REAL,
        pnl REAL,
        status TEXT,
        leverage INTEGER,
        margin_percent REAL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id)
    )`);

    // Settings table
    db.run(`CREATE TABLE IF NOT EXISTS user_settings (
        user_id INTEGER PRIMARY KEY,
        min_confidence INTEGER DEFAULT 65,
        autotrade_enabled BOOLEAN DEFAULT 0,
        order_type TEXT DEFAULT 'limit',
        strategies TEXT DEFAULT '{"breakout":true,"trendfollow":true,"pumpdump":true}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id)
    )`);

    console.log('✅ Database tables initialized');
}

// Helper functions
db.getUserByEmail = function(email) {
    return new Promise((resolve, reject) => {
        this.get("SELECT * FROM users WHERE email = ?", [email], (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
};

db.getUserByToken = function(token) {
    return new Promise((resolve, reject) => {
        this.get("SELECT * FROM users WHERE session_token = ?", [token], (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
};

db.createUser = function(email, password, plan = 'basic') {
    return new Promise(async (resolve, reject) => {
        try {
            const hashedPassword = await bcrypt.hash(password, 10);
            this.run(
                `INSERT INTO users (email, password, plan) VALUES (?, ?, ?)`,
                [email, hashedPassword, plan],
                function(err) {
                    if (err) reject(err);
                    else {
                        // Create default settings for user
                        const userId = this.lastID;
                        this.run(
                            `INSERT INTO user_settings (user_id) VALUES (?)`,
                            [userId],
                            (err) => {
                                if (err) reject(err);
                                else resolve(userId);
                            }
                        );
                    }
                }
            );
        } catch (error) {
            reject(error);
        }
    });
};

db.updateUserSession = function(userId, token) {
    return new Promise((resolve, reject) => {
        this.run(
            "UPDATE users SET session_token = ? WHERE id = ?",
            [token, userId],
            function(err) {
                if (err) reject(err);
                else resolve();
            }
        );
    });
};

db.getUserSettings = function(userId) {
    return new Promise((resolve, reject) => {
        this.get("SELECT * FROM user_settings WHERE user_id = ?", [userId], (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
};

db.updateUserSettings = function(userId, settings) {
    return new Promise((resolve, reject) => {
        this.run(
            `INSERT OR REPLACE INTO user_settings (user_id, min_confidence, autotrade_enabled, order_type, strategies) 
             VALUES (?, ?, ?, ?, ?)`,
            [userId, settings.min_confidence, settings.autotrade_enabled, settings.order_type, JSON.stringify(settings.strategies)],
            function(err) {
                if (err) reject(err);
                else resolve();
            }
        );
    });
};

module.exports = db;
