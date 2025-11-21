const { DataTypes } = require('sequelize');
const { sequelize } = require('../database');
const crypto = require('crypto');

const ApiKey = sequelize.define('ApiKey', {
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
  },
  lastUsed: {
    type: DataTypes.DATE
  }
}, {
  hooks: {
    beforeCreate: (apiKey) => {
      // Basic encryption (in production use proper key management)
      if (apiKey.apiKey) {
        apiKey.apiKey = encrypt(apiKey.apiKey);
      }
      if (apiKey.secret) {
        apiKey.secret = encrypt(apiKey.secret);
      }
      if (apiKey.passphrase) {
        apiKey.passphrase = encrypt(apiKey.passphrase);
      }
    }
  }
});

// Simple encryption (replace with proper key management in production)
function encrypt(text) {
  const cipher = crypto.createCipher('aes-256-cbc', process.env.JWT_SECRET);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return encrypted;
}

ApiKey.prototype.decrypt = function() {
  return {
    apiKey: decrypt(this.apiKey),
    secret: decrypt(this.secret),
    passphrase: this.passphrase ? decrypt(this.passphrase) : null
  };
};

function decrypt(encryptedText) {
  const decipher = crypto.createDecipher('aes-256-cbc', process.env.JWT_SECRET);
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

module.exports = ApiKey;
