const { DataTypes } = require('sequelize');
const { sequelize } = require('../database');

const Payment = sequelize.define('Payment', {
  userId: { type: DataTypes.INTEGER },
  amount: { type: DataTypes.FLOAT },
  status: { type: DataTypes.STRING }
});

module.exports = Payment;
