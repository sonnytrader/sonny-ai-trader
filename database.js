const { Sequelize } = require('sequelize');
const path = require('path');

// SQLite database path - Render'da kalıcı
const dbPath = process.env.NODE_ENV === 'production' 
  ? '/opt/render/project/src/alphason.db'
  : './alphason.db';

const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: dbPath,
  logging: process.env.NODE_ENV === 'development' ? console.log : false,
  pool: {
    max: 5,
    min: 0,
    acquire: 30000,
    idle: 10000
  }
});

// Test database connection
async function testConnection() {
  try {
    await sequelize.authenticate();
    console.log('✅ SQLite bağlantısı başarılı');
    return true;
  } catch (error) {
    console.error('❌ SQLite bağlantı hatası:', error);
    return false;
  }
}

module.exports = { sequelize, testConnection };
