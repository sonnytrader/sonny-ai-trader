// database.js
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./trade.db', (err) => {
    if (err) {
        console.error("Veritabanı bağlantı hatası:", err.message);
    } else {
        console.log("SQLite Veritabanına bağlanıldı.");
    }
});

module.exports = db;
