const express = require('express');
const jwt = require('jsonwebtoken');
const { User } = require('../models/User');

const router = express.Router();

// Kayıt ol
router.post('/register', async (req, res) => {
  try {
    const { email, password, fullName, strategy = 'breakout' } = req.body;

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
      strategy
    });

    // JWT token oluştur
    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        strategy: user.strategy,
        role: user.role
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      message: 'Kayıt başarılı',
      token,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        strategy: user.strategy,
        role: user.role
      }
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

    // JWT token oluştur
    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        strategy: user.strategy,
        role: user.role
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
        strategy: user.strategy,
        role: user.role,
        subscription: user.subscription
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
router.get('/profile', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ success: false, error: 'Token gereklidir' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findByPk(decoded.userId, {
      attributes: { exclude: ['password'] }
    });

    if (!user) {
      return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });
    }

    res.json({
      success: true,
      user
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Profil bilgileri alınamadı'
    });
  }
});

module.exports = router;
