// database.js
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcrypt');

const dbPath = path.join(__dirname, 'trading.db');
const db = new sqlite3.Database(dbPath);

// Tabloları oluştur
db.serialize(() => {
  // Kullanıcılar tablosu
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    plan TEXT DEFAULT 'basic',
    api_key TEXT DEFAULT '',
    api_secret TEXT DEFAULT '',
    api_passphrase TEXT DEFAULT '',
    session_token TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Varsayılan kullanıcıyı oluştur
  const defaultPassword = bcrypt.hashSync('123', 10);
  
  db.get("SELECT id FROM users WHERE email = ?", ['admin@alphason.com'], (err, row) => {
    if (err) console.error('DB error:', err);
    if (!row) {
      db.run(
        "INSERT INTO users (email, password, plan) VALUES (?, ?, ?)",
        ['admin@alphason.com', defaultPassword, 'elite'],
        function(err) {
          if (err) console.error('Kullanıcı oluşturma hatası:', err);
          else console.log('✅ Varsayılan kullanıcı oluşturuldu: admin@alphason.com / 123');
        }
      );
    } else {
      console.log('✅ Varsayılan kullanıcı zaten mevcut');
    }
  });
});

module.exports = db;
