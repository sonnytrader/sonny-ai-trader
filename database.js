const { Sequelize } = require('sequelize');
const fs = require('fs');

const dbPath = process.env.NODE_ENV === 'production'
  ? '/opt/render/project/src/alphason.db'
  : './alphason.db';

if (!fs.existsSync(dbPath)) {
  fs.writeFileSync(dbPath, '');
}

const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: dbPath,
  logging: process.env.NODE_ENV === 'development' ? console.log : false,
  pool: { max: 5, min: 0, acquire: 30000, idle: 10000 }
});

async function testConnection() {
  try {
    await sequelize.authenticate();
    console.log('✅ SQLite bağlantısı başarılı');
    await sequelize.query('PRAGMA journal_mode=WAL;');
    await sequelize.query('PRAGMA busy_timeout=3000;');
    return true;
  } catch (error) {
    console.error('❌ SQLite bağlantı hatası:', error);
    return false;
  }
}

module.exports = { sequelize, testConnection };
