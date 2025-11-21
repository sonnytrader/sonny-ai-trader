const { DataTypes } = require('sequelize');
const { sequelize } = require('../database');

const Subscription = sequelize.define('Subscription', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  plan: {
    type: DataTypes.ENUM('basic', 'pro', 'elite'),
    allowNull: false
  },
  status: {
    type: DataTypes.ENUM('active', 'canceled', 'expired'),
    defaultValue: 'active'
  },
  amount: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false
  },
  currency: {
    type: DataTypes.STRING,
    defaultValue: 'USD'
  },
  interval: {
    type: DataTypes.ENUM('monthly', 'yearly'),
    defaultValue: 'monthly'
  },
  startDate: {
    type: DataTypes.DATE,
    allowNull: false
  },
  endDate: {
    type: DataTypes.DATE,
    allowNull: false
  },
  stripeSubscriptionId: {
    type: DataTypes.STRING
  },
  stripeCustomerId: {
    type: DataTypes.STRING
  }
});

// Pricing configuration
Subscription.PLANS = {
  basic: { monthly: 0, yearly: 0 },
  pro: { monthly: 49, yearly: 490 },
  elite: { monthly: 99, yearly: 990 }
};

module.exports = Subscription;
