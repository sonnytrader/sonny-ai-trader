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

async function initializeDatabase() {
    // Users table
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        plan TEXT DEFAULT 'premium',
        api_key TEXT,
        api_secret TEXT,
        api_passphrase TEXT,
        session_token TEXT,
        leverage INTEGER DEFAULT 10,
        margin_percent REAL DEFAULT 5.0,
        risk_level TEXT DEFAULT 'medium',
        daily_trade_limit INTEGER DEFAULT 50,
        max_positions INTEGER DEFAULT 10,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, async (err) => {
        if (err) {
            console.error('❌ Users table error:', err);
        } else {
            console.log('✅ Users table ready');
            
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
            )`, (err) => {
                if (err) console.error('❌ Signals table error:', err);
                else console.log('✅ Signals table ready');
            });

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
            )`, (err) => {
                if (err) console.error('❌ Trades table error:', err);
                else console.log('✅ Trades table ready');
            });

            // Settings table
            db.run(`CREATE TABLE IF NOT EXISTS user_settings (
                user_id INTEGER PRIMARY KEY,
                min_confidence INTEGER DEFAULT 65,
                autotrade_enabled BOOLEAN DEFAULT 0,
                order_type TEXT DEFAULT 'limit',
                strategies TEXT DEFAULT '{"breakout":true,"trendfollow":true,"pumpdump":true}',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id)
            )`, async (err) => {
                if (err) {
                    console.error('❌ Settings table error:', err);
                } else {
                    console.log('✅ Settings table ready');
                    // Tüm tablolar hazır olduğunda admin kullanıcısını oluştur
                    setTimeout(() => {
                        createAdminUser();
                    }, 1000);
                }
            });
        }
    });
}

async function createAdminUser() {
    const adminEmail = 'admin@alphason.com';
    const adminPassword = '123';
    
    try {
        const existingUser = await new Promise((resolve, reject) => {
            db.get("SELECT id FROM users WHERE email = ?", [adminEmail], (err, row) => {
                if (err) {
                    console.log('⏳ Users table not ready yet, retrying...');
                    resolve(null);
                } else {
                    resolve(row);
                }
            });
        });

        if (!existingUser) {
            const hashedPassword = await bcrypt.hash(adminPassword, 10);
            await new Promise((resolve, reject) => {
                db.run(
                    `INSERT INTO users (email, password, plan, leverage, margin_percent, daily_trade_limit, max_positions) 
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [adminEmail, hashedPassword, 'premium', 10, 5.0, 999, 50],
                    function(err) {
                        if (err) {
                            console.error('Admin insert error:', err);
                            reject(err);
                        } else {
                            const userId = this.lastID;
                            // Admin için settings oluştur
                            db.run(
                                `INSERT INTO user_settings (user_id, min_confidence, autotrade_enabled, order_type) 
                                 VALUES (?, ?, ?, ?)`,
                                [userId, 65, false, 'limit'],
                                (err) => {
                                    if (err) {
                                        console.error('Admin settings error:', err);
                                        reject(err);
                                    } else {
                                        console.log('✅ Admin kullanıcısı oluşturuldu: admin@alphason.com / 123');
                                        resolve();
                                    }
                                }
                            );
                        }
                    }
                );
            });
        } else {
            console.log('✅ Admin kullanıcısı zaten mevcut');
        }
    } catch (error) {
        console.error('❌ Admin kullanıcısı oluşturma hatası:', error);
    }
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
