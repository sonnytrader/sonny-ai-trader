const User = require('./User');
const Signal = require('./Signal');
const ApiKey = require('./ApiKey');

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
