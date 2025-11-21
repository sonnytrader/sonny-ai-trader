const { DataTypes } = require('sequelize');
const { sequelize } = require('../database');
const bcrypt = require('bcryptjs');

const User = sequelize.define('User', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  email: {
    type: DataTypes.STRING,
    unique: true,
    allowNull: false,
    validate: {
      isEmail: true
    }
  },
  password: {
    type: DataTypes.STRING,
    allowNull: false
  },
  fullName: {
    type: DataTypes.STRING,
    allowNull: false
  },
  phone: {
    type: DataTypes.STRING
  },
  role: {
    type: DataTypes.ENUM('user', 'admin'),
    defaultValue: 'user'
  },
  status: {
    type: DataTypes.ENUM('pending', 'active', 'suspended', 'rejected'),
    defaultValue: 'pending'
  },
  subscriptionPlan: {
    type: DataTypes.ENUM('basic', 'pro', 'elite'),
    defaultValue: 'basic'
  },
  subscriptionStatus: {
    type: DataTypes.ENUM('active', 'inactive', 'canceled', 'expired'),
    defaultValue: 'inactive'
  },
  subscriptionEndDate: {
    type: DataTypes.DATE
  },
  trialEndDate: {
    type: DataTypes.DATE,
    defaultValue: () => new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) // 3 days trial
  },
  lastLogin: {
    type: DataTypes.DATE
  },
  loginCount: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  }
}, {
  hooks: {
    beforeCreate: async (user) => {
      if (user.password) {
        user.password = await bcrypt.hash(user.password, 12);
      }
    },
    beforeUpdate: async (user) => {
      if (user.changed('password')) {
        user.password = await bcrypt.hash(user.password, 12);
      }
    }
  }
});

// Instance methods
User.prototype.validatePassword = async function(password) {
  return await bcrypt.compare(password, this.password);
};

User.prototype.isSubscriptionActive = function() {
  if (this.role === 'admin') return true;
  if (this.subscriptionStatus === 'active' && this.subscriptionEndDate > new Date()) return true;
  if (this.trialEndDate > new Date()) return true;
  return false;
};

User.prototype.hasTradingAccess = function() {
  return this.isSubscriptionActive() && this.status === 'active';
};

module.exports = User;
