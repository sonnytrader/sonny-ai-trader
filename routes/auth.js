const express = require('express');
const jwt = require('jsonwebtoken');
const { user } = require('../models/user');

const router = express.Router();

// Kayıt ol
router.post('/register', async (req, res) => {
  try {
    const { email, password, fullName, strategy = 'breakout' } = req.body;

    // E-posta kontrolü
    const existingUser = await user.findOne({ where: { email } });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        error: 'Bu e-posta adresi zaten kullanılıyor'
      });
    }

    // Kullanıcı oluştur
    const newUser = await user.create({
      email,
      password,
      fullName,
      strategy
    });

    // JWT token oluştur
    const token = jwt.sign(
      {
        userId: newUser.id,
        email: newUser.email,
        strategy: newUser.strategy,
        role: newUser.role
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      message: 'Kayıt başarılı',
      token,
      user: {
        id: newUser.id,
        email: newUser.email,
        fullName: newUser.fullName,
        strategy: newUser.strategy,
        role: newUser.role
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
    const foundUser = await user.findOne({ where: { email } });
    if (!foundUser) {
      return res.status(400).json({
        success: false,
        error: 'Geçersiz e-posta veya şifre'
      });
    }

    // Şifreyi kontrol et
    const validPassword = await foundUser.validatePassword(password);
    if (!validPassword) {
      return res.status(400).json({
        success: false,
        error: 'Geçersiz e-posta veya şifre'
      });
    }

    // JWT token oluştur
    const token = jwt.sign(
      {
        userId: foundUser.id,
        email: foundUser.email,
        strategy: foundUser.strategy,
        role: foundUser.role
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      message: 'Giriş başarılı',
      token,
      user: {
        id: foundUser.id,
        email: foundUser.email,
        fullName: foundUser.fullName,
        strategy: foundUser.strategy,
        role: foundUser.role,
        subscription: foundUser.subscription
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
    const foundUser = await user.findByPk(decoded.userId, {
      attributes: { exclude: ['password'] }
    });

    if (!foundUser) {
      return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });
    }

    res.json({
      success: true,
      user: foundUser
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Profil bilgileri alınamadı'
    });
  }
});

module.exports = router;
