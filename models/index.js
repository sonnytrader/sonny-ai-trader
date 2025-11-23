const User = require('./User');
const Subscription = require('./Subscription');
const Payment = require('./Payment');
const ApiKey = require('./ApiKey');
const Signal = require('./Signal');

// İlişkiler
User.hasMany(Subscription, { foreignKey: 'userId' });
Subscription.belongsTo(User, { foreignKey: 'userId' });

User.hasMany(Payment, { foreignKey: 'userId' });
Payment.belongsTo(User, { foreignKey: 'userId' });

User.hasMany(ApiKey, { foreignKey: 'userId' });
ApiKey.belongsTo(User, { foreignKey: 'userId' });

User.hasMany(Signal, { foreignKey: 'userId' });
Signal.belongsTo(User, { foreignKey: 'userId' });

module.exports = { User, Subscription, Payment, ApiKey, Signal };
