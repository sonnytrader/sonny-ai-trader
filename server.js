require('dotenv').config();
const express = require('express');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
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

// Güvenlik ve JSON parse
app.use(helmet());
app.use(express.json());
app.use(rateLimit({
  windowMs: 1 * 60 * 1000, // 1 dakika
  max: 100 // her IP için 100 istek
}));

// Statik frontend (public klasörü)
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use('/auth', authRoutes);
app.use('/user', authenticateToken, userRoutes);
app.use('/signals', authenticateToken, checkSubscription, signalRoutes);
app.use('/trading', authenticateToken, checkSubscription, tradingRoutes);
app.use('/admin', authenticateToken, adminRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('❌ Error:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// Veritabanı bağlantısı ve sunucu başlatma
sequelize.sync().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Alphason Trader çalışıyor: http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Database connection failed:', err);
});
