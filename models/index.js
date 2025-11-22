const User = require('./User.js');      // ✅ User.js (büyük harf)
const Signal = require('./signal.js');
const ApiKey = require('./ApiKey.js');  // ✅ ApiKey.js (büyük harf)

// Associations
User.hasMany(Signal, { foreignKey: 'userId' });
Signal.belongsTo(User, { foreignKey: 'userId' });

User.hasMany(ApiKey, { foreignKey: 'userId' });
ApiKey.belongsTo(User, { foreignKey: 'userId' });

module.exports = {
  User,
  Signal,
  ApiKey
};
