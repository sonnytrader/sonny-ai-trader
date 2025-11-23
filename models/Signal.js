const { DataTypes } = require('sequelize');
const { sequelize } = require('../database');

const Signal = sequelize.define('Signal', {
  userId: { type: DataTypes.INTEGER },
  strategy: { type: DataTypes.STRING },
  symbol: { type: DataTypes.STRING },
  signalType: { type: DataTypes.STRING },
  confidence: { type: DataTypes.FLOAT }
});

module.exports = Signal;
