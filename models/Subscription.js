const { DataTypes } = require('sequelize');
const { sequelize } = require('../database');

const Subscription = sequelize.define('Subscription', {
  name: { type: DataTypes.STRING },
  features: { type: DataTypes.JSON }
});

module.exports = Subscription;
