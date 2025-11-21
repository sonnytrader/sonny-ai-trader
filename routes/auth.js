const express = require('express');
const jwt = require('jsonwebtoken');
const { User, Subscription, Payment } = require('../models');
const { authenticateToken, optionalAuth } = require('../middleware/auth');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const router = express.Router();

// Kayıt ol
router.post('/register', async (req, res) => {
  try {
    const { email, password, fullName, phone, plan = 'basic', interval = 'monthly' } = req.body;

    // E-posta kontrolü
    const existingUser = await User.findOne({ where: { email } });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        error: 'Bu e-posta adresi zaten kullanılıyor'
      });
    }

    // Kullanıcı oluştur
    const user = await User.create({
      email,
      password,
      fullName,
      phone,
      subscriptionPlan: plan,
      status: 'pending' // Admin onayı bekleyecek
    });

    // Ücretli plan için Stripe ödemesi oluştur
    if (plan !== 'basic') {
      const amount = Subscription.PLANS[plan][interval];
      
      const paymentIntent = await stripe.paymentIntents.create({
        amount: amount * 100, // Cent cinsinden
        currency: 'usd',
        metadata: {
          userId: user.id,
          plan: plan,
          interval: interval
        },
        description: `TrendMaster AI ${plan} plan - ${interval}`
      });

      // Ödeme kaydı oluştur
      await Payment.create({
        userId: user.id,
        amount: amount,
        currency: 'USD',
        provider: 'stripe',
        transactionId: paymentIntent.id,
        status: 'pending',
        description: `${plan} plan - ${interval}`
      });

      return res.json({
        success: true,
        message: 'Kayıt başarılı. Ödeme bekleniyor.',
        user: { id: user.id, email: user.email },
        payment: {
          clientSecret: paymentIntent.client_secret,
          amount: amount,
          currency: 'USD'
        }
      });
    }

    // Ücretsiz plan için
    res.json({
      success: true,
      message: 'Kayıt başarılı. Admin onayı bekleniyor.',
      user: { id: user.id, email: user.email }
    });

  } catch (error) {
    console.error('Kayıt hatası:', error);
    res.status(500).json({
      success: false,
      error: 'Kayıt sırasında bir hata oluştu'
    });
  }
});

// Giriş yap
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Kullanıcıyı bul
    const user = await User.findOne({ where: { email } });
    if (!user) {
      return res.status(400).json({
        success: false,
        error: 'Geçersiz e-posta veya şifre'
      });
    }

    // Şifreyi kontrol et
    const validPassword = await user.validatePassword(password);
    if (!validPassword) {
      return res.status(400).json({
        success: false,
        error: 'Geçersiz e-posta veya şifre'
      });
    }

    // Giriş bilgilerini güncelle
    user.lastLogin = new Date();
    user.loginCount += 1;
    await user.save();

    // JWT token oluştur
    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        role: user.role,
        subscription: user.subscriptionPlan
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      message: 'Giriş başarılı',
      token,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        status: user.status,
        subscriptionPlan: user.subscriptionPlan,
        subscriptionStatus: user.subscriptionStatus,
        hasTradingAccess: user.hasTradingAccess()
      }
    });

  } catch (error) {
    console.error('Giriş hatası:', error);
    res.status(500).json({
      success: false,
      error: 'Giriş sırasında bir hata oluştu'
    });
  }
});

// Profil bilgileri
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    res.json({
      success: true,
      user: {
        id: req.user.id,
        email: req.user.email,
        fullName: req.user.fullName,
        phone: req.user.phone,
        role: req.user.role,
        status: req.user.status,
        subscriptionPlan: req.user.subscriptionPlan,
        subscriptionStatus: req.user.subscriptionStatus,
        subscriptionEndDate: req.user.subscriptionEndDate,
        trialEndDate: req.user.trialEndDate,
        lastLogin: req.user.lastLogin,
        loginCount: req.user.loginCount,
        hasTradingAccess: req.user.hasTradingAccess()
      }
    });
  } catch (error) {
    console.error('Profil hatası:', error);
    res.status(500).json({
      success: false,
      error: 'Profil bilgileri alınamadı'
    });
  }
});

module.exports = router;
