require('dotenv').config();
const express = require('express');
const path = require('path');
const { sequelize } = require('./database');

// Routes
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const signalRoutes = require('./routes/signals');
const tradingRoutes = require('./routes/trading');
const adminRoutes = require('./routes/admin');

// Middleware
const { authenticateToken } = require('./middleware/auth');
const { checkSubscription } = require('./middleware/subscription');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Statik frontend
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use('/auth', authRoutes);
app.use('/user', authenticateToken, userRoutes);
app.use('/signals', authenticateToken, checkSubscription, signalRoutes);
app.use('/trading', authenticateToken, checkSubscription, tradingRoutes);
app.use('/admin', authenticateToken, adminRoutes);

// 404
app.use((req, res) => res.status(404).json({ error: 'Endpoint not found' }));

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// DB sync + start
sequelize.sync().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Alphason Trader çalışıyor: http://localhost:${PORT}`);
  });
}).catch(err => console.error('DB connection failed:', err));
