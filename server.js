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
const adminRoutes = require('./routes/admin');
const userRoutes = require('./routes/user');
const tradingRoutes = require('./routes/trading');

// Middleware imports
const { authenticateToken, optionalAuth } = require('./middleware/auth');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
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
app.use('/api/admin', adminRoutes);
app.use('/api/user', userRoutes);
app.use('/api/trading', tradingRoutes);

// Stripe webhook (raw body required)
app.post('/webhook/stripe', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = require('stripe').webhooks.constructEvent(
      req.body, 
      sig, 
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed.', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'payment_intent.succeeded':
        await handlePaymentSuccess(event.data.object);
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdate(event.data.object);
        break;
      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Webhook handling error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

async function handlePaymentSuccess(paymentIntent) {
  const { User, Payment, Subscription } = require('./models');
  
  const payment = await Payment.findOne({ 
    where: { transactionId: paymentIntent.id } 
  });
  
  if (payment) {
    payment.status = 'completed';
    await payment.save();

    const user = await User.findByPk(payment.userId);
    if (user) {
      user.subscriptionStatus = 'active';
      user.status = 'active'; // Ödeme yapan kullanıcıyı otomatik aktif et
      user.subscriptionEndDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await user.save();

      // Abonelik kaydı oluştur
      await Subscription.create({
        userId: user.id,
        plan: user.subscriptionPlan,
        amount: payment.amount,
        currency: payment.currency,
        startDate: new Date(),
        endDate: user.subscriptionEndDate,
        stripeSubscriptionId: paymentIntent.subscription || paymentIntent.id
      });
    }
  }
}

async function handleSubscriptionUpdate(subscription) {
  // Subscription management logic
  console.log('Subscription updated:', subscription.id);
}

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// WebSocket for real-time signals
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');

  if (!token) {
    ws.close(1008, 'Authentication required');
    return;
  }

  const jwt = require('jsonwebtoken');
  jwt.verify(token, process.env.JWT_SECRET, async (err, decoded) => {
    if (err) {
      ws.close(1008, 'Invalid token');
      return;
    }

    const { User } = require('./models');
    const user = await User.findByPk(decoded.userId);
    
    if (!user || user.status !== 'active') {
      ws.close(1008, 'User not active');
      return;
    }

    ws.user = user;
    
    ws.send(JSON.stringify({ 
      type: 'connected', 
      message: 'WebSocket connected',
      user: { email: user.email, subscription: user.subscriptionPlan }
    }));

    // Handle client messages
    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        console.log('WebSocket message:', data);
      } catch (error) {
        console.error('WebSocket message error:', error);
      }
    });

    // Send periodic updates
    const interval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'ping',
          timestamp: Date.now()
        }));
      } else {
        clearInterval(interval);
      }
    }, 30000);

    ws.on('close', () => {
      clearInterval(interval);
    });
  });
});

// Global error handler
app.use((error, req, res, next) => {
  console.error('Global error handler:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
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
    console.log('✅ Database synchronized');

    // Start server
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      console.log(`
🚀 TrendMaster AI Multi-User System Started!
📍 Port: ${PORT}
📊 Environment: ${process.env.NODE_ENV}
🔗 API: http://localhost:${PORT}/api
🌐 WebSocket: ws://localhost:${PORT}
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
