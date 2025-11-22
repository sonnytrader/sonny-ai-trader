const User = require('./user.js');
const Signal = require('./signal.js');
const ApiKey = require('./apikey.js');

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
