const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Veritabanı dosyasının yolu
const dbPath = path.resolve(__dirname, 'trade.db');

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Veritabanı bağlantı hatası:', err.message);
  } else {
    console.log('SQL Veritabanına bağlanıldı.');
  }
});

module.exports = db;
