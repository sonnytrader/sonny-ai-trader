const { DataTypes } = require('sequelize');
const { sequelize } = require('../database');

const ApiKey = sequelize.define('ApiKey', {
  userId: { type: DataTypes.INTEGER },
  key: { type: DataTypes.STRING }
});

module.exports = ApiKey;
