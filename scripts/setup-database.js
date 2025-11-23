const { sequelize } = require('../database');
const { User, Subscription } = require('../models');

(async () => {
  await sequelize.sync({ force: true });
  console.log('Database reset ✅');

  await Subscription.bulkCreate([
    { name: 'basic', features: { strategies: 1 } },
    { name: 'pro', features: { strategies: 2 } },
    { name: 'elite', features: { strategies: 'all' } }
  ]);

  console.log('Subscriptions seeded ✅');
})();
