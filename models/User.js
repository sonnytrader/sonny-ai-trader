const { DataTypes } = require('sequelize');
const { sequelize } = require('../database');
const bcrypt = require('bcryptjs');

const User = sequelize.define('User', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  email: { type: DataTypes.STRING, unique: true, allowNull: false, validate: { isEmail: true } },
  password: { type: DataTypes.STRING, allowNull: false },
  fullName: { type: DataTypes.STRING, allowNull: false },
  strategy: { type: DataTypes.ENUM('breakout', 'pumpdetect', 'rsimacd'), defaultValue: 'breakout' },
  role: { type: DataTypes.ENUM('user', 'admin'), defaultValue: 'user' },
  status: { type: DataTypes.ENUM('pending', 'active', 'inactive', 'rejected'), defaultValue: 'pending' },
  subscriptionPlan: { type: DataTypes.ENUM('basic', 'pro', 'elite'), defaultValue: 'basic' },
  subscriptionStatus: { type: DataTypes.ENUM('none', 'active', 'canceled', 'expired', 'past_due'), defaultValue: 'none' },
  subscriptionEndDate: { type: DataTypes.DATE },
  trialEndDate: { type: DataTypes.DATE },
  lastLogin: { type: DataTypes.DATE },
  loginCount: { type: DataTypes.INTEGER, defaultValue: 0 }
}, {
  hooks: {
    beforeCreate: async (user) => {
      if (user.password) user.password = await bcrypt.hash(user.password, 12);
    },
    beforeUpdate: async (user) => {
      if (user.changed('password')) user.password = await bcrypt.hash(user.password, 12);
    }
  }
});

User.prototype.validatePassword = async function (password) {
  return await bcrypt.compare(password, this.password);
};

User.prototype.isSubscriptionActive = function () {
  if (this.subscriptionPlan === 'basic') return true;
  return this.subscriptionStatus === 'active' && (!this.subscriptionEndDate || new Date() < new Date(this.subscriptionEndDate));
};

User.prototype.hasTradingAccess = function () {
  return (this.subscriptionPlan === 'pro' || this.subscriptionPlan === 'elite') && this.isSubscriptionActive();
};

module.exports = User;
