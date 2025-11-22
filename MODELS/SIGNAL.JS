const { DataTypes } = require('sequelize');
const { sequelize } = require('../database');

const Signal = sequelize.define('Signal', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  symbol: {
    type: DataTypes.STRING,
    allowNull: false
  },
  direction: {
    type: DataTypes.ENUM('LONG', 'SHORT'),
    allowNull: false
  },
  entry: {
    type: DataTypes.DECIMAL(10, 4),
    allowNull: false
  },
  tp: {
    type: DataTypes.DECIMAL(10, 4),
    allowNull: false
  },
  sl: {
    type: DataTypes.DECIMAL(10, 4),
    allowNull: false
  },
  confidence: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  strategy: {
    type: DataTypes.ENUM('breakout', 'pumpdetect', 'rsimacd'),
    allowNull: false
  }
});

module.exports = Signal;
