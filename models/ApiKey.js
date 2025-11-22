const { DataTypes } = require('sequelize');
const { sequelize } = require('../database');
const crypto = require('crypto');

const apikey = sequelize.define('apikey', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  exchange: {
    type: DataTypes.ENUM('bitget', 'binance'),
    allowNull: false
  },
  apiKey: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  secret: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  passphrase: {
    type: DataTypes.TEXT
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  },
  label: {
    type: DataTypes.STRING
  }
});

module.exports = apikey;
