const user = require('./user');
const signal = require('./signal');
const apikey = require('./apikey');

// Associations
user.hasMany(signal, { foreignKey: 'userId' });
signal.belongsTo(user, { foreignKey: 'userId' });

user.hasMany(apikey, { foreignKey: 'userId' });
apikey.belongsTo(user, { foreignKey: 'userId' });

module.exports = {
  user,
  signal,
  apikey
};
