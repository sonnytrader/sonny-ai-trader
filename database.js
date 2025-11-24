// database.js
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'alphason.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Database connection error:', err.message);
  } else {
    console.log('SQLite database connected:', dbPath);
  }
});

// Hata yönetimi
db.on('error', (err) => {
  console.error('Database error:', err);
});

module.exports = db;
