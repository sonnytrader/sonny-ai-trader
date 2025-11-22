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
const authRoutes = require('./routes/auth.js');
const signalsModule = require('./routes/signals.js');

// Model imports
const { User, Signal } = require('./models');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// TRUST PROXY - RATE LIMIT'DEN ÖNCE
app.set('trust proxy', 1);

// Rate limiting - IP bazlı
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  keyGenerator: (req) => {
    return req.ip;
  },
  message: { 
    success: false, 
    error: 'Çok fazla istek gönderdiniz' 
  }
});

// Helmet CSP ayarları - DÜZELTİLDİ
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://cdnjs.cloudflare.com"],
      connectSrc: ["'self'", "ws:", "wss:"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  crossOriginEmbedderPolicy: false
}));

// Middleware
app.use(limiter);
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/signals', signalsModule.router);

// WebSocket for real-time signals
wss.on('connection', async (ws, req) => {
  console.log('🔌 AlphaSon Crypto WebSocket bağlandı');

  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');

  if (!token) {
    ws.send(JSON.stringify({ 
      type: 'error', 
      message: 'Token gereklidir' 
    }));
    ws.close(1008, 'Authentication required');
    return;
  }

  const jwt = require('jsonwebtoken');
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const foundUser = await User.findByPk(decoded.userId);
    
    if (!foundUser || foundUser.status !== 'active') {
      ws.send(JSON.stringify({ 
        type: 'error', 
        message: 'Kullanıcı aktif değil veya bulunamadı' 
      }));
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

    let interval;
    const sendSignals = async () => {
      try {
        if (ws.readyState !== ws.OPEN) {
          if (interval) clearInterval(interval);
          return;
        }

        const symbols = ['BTC/USDT', 'ETH/USDT', 'ADA/USDT'];
        const userStrategy = foundUser.strategy || 'breakout';

        for (let symbol of symbols) {
          const signalData = await signalsModule.strategies[userStrategy](symbol);
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
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Sinyal üretim hatası' 
          }));
        }
      }
    };

    interval = setInterval(sendSignals, 30000);
    sendSignals();

    ws.on('close', () => {
      if (interval) clearInterval(interval);
      console.log('🔌 AlphaSon Crypto WebSocket bağlantısı kesildi');
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      if (interval) clearInterval(interval);
    });

  } catch (error) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ 
        type: 'error', 
        message: 'Geçersiz token veya yetkilendirme hatası' 
      }));
    }
    ws.close(1008, 'Invalid token');
  }
});

// Frontend route - SPA için
app.get('/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Initialize server
async function startServer() {
  try {
    const connected = await testConnection();
    if (!connected) {
      throw new Error('Database connection failed');
    }

    await sequelize.sync({ alter: true });
    console.log('✅ SQLite database synchronized');

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

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  await sequelize.close();
  server.close(() => {
    console.log('Process terminated');
  });
});

startServer();
