require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { sequelize, testConnection } = require('./database');

// Route imports
const authRoutes = require('./routes/auth');
const signalsRoutes = require('./routes/signals');

// Model imports
const { User, Signal } = require('./models');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware - TRUST PROXY EKLE
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { success: false, error: 'Çok fazla istek gönderdiniz' }
});
app.use(limiter);

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/signals', signalsRoutes);

// ALPHASON CRYPTO - 3 TEKNİK STRATEJİ (WebSocket için)
const strategies = signalsRoutes.strategies;

// WebSocket for real-time signals
wss.on('connection', async (ws, req) => {
  console.log('🔌 AlphaSon Crypto WebSocket bağlandı');

  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');

  if (!token) {
    ws.close(1008, 'Authentication required');
    return;
  }

  const jwt = require('jsonwebtoken');
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const foundUser = await User.findByPk(decoded.userId);
    
    if (!foundUser || foundUser.status !== 'active') {
      ws.close(1008, 'User not active');
      return;
    }

    ws.user = foundUser;
    
    ws.send(JSON.stringify({ 
      type: 'connected', 
      message: 'AlphaSon Crypto WebSocket bağlantısı başarılı',
      user: { 
        email: foundUser.email, 
        strategy: foundUser.strategy,
        subscription: foundUser.subscription 
      }
    }));

    const sendSignals = async () => {
      try {
        const symbols = ['BTC/USDT', 'ETH/USDT', 'ADA/USDT'];
        const userStrategy = foundUser.strategy || 'breakout';

        for (let symbol of symbols) {
          const signalData = await strategies[userStrategy](symbol);
          if (signalData && ws.readyState === ws.OPEN) {
            const signalMessage = {
              type: 'signal',
              strategy: userStrategy,
              symbol: symbol,
              direction: signalData.direction,
              entry: signalData.entry,
              tp: signalData.tp,
              sl: signalData.sl,
              confidence: signalData.confidence,
              timestamp: new Date()
            };
            
            ws.send(JSON.stringify(signalMessage));

            // Save to database
            await Signal.create({
              userId: foundUser.id,
              symbol,
              direction: signalData.direction,
              entry: signalData.entry,
              tp: signalData.tp,
              sl: signalData.sl,
              confidence: signalData.confidence,
              strategy: userStrategy
            });
          }
        }
      } catch (error) {
        console.error('WebSocket signal error:', error);
      }
    };

    // Her 30 saniyede bir sinyal taraması
    const interval = setInterval(sendSignals, 30000);
    sendSignals(); // İlk çalıştırma

    ws.on('close', () => {
      clearInterval(interval);
      console.log('🔌 AlphaSon Crypto WebSocket bağlantısı kesildi');
    });

  } catch (error) {
    ws.close(1008, 'Invalid token');
  }
});

// Frontend route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Initialize server
async function startServer() {
  try {
    // Test database connection
    const connected = await testConnection();
    if (!connected) {
      throw new Error('Database connection failed');
    }

    // Sync database
    await sequelize.sync({ alter: true });
    console.log('✅ PostgreSQL database synchronized');

    // Start server
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      console.log(`
🚀 ALPHASON CRYPTO - SAF TEKNİK ANALİZ SİSTEMİ
📍 Port: ${PORT}
🎯 Stratejiler: KIRILIM + PUMP/DETECTOR + RSI/MACD
💚 Renkler: Huba Yeşili (#10B981) + Klasik Kırmızı (#EF4444)
🗄️  Database: SQLite
🌐  WebSocket: Aktif
🔐  Authentication: JWT
      `);
    });

  } catch (error) {
    console.error('❌ Server startup failed:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  await sequelize.close();
  server.close(() => {
    console.log('Process terminated');
  });
});

startServer();
