const express = require('express');
const { User } = require('../models');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// API Key'leri listele
router.get('/api-keys', authenticateToken, async (req, res) => {
  try {
    res.json({
      success: true,
      message: 'API key endpoint'
    });
  } catch (error) {
    console.error('API key hatası:', error);
    res.status(500).json({
      success: false,
      error: 'API key alınamadı'
    });
  }
});

// Profil bilgilerini getir
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    res.json({
      success: true,
      user: {
        id: req.user.id,
        email: req.user.email,
        fullName: req.user.fullName,
        strategy: req.user.strategy,
        subscription: req.user.subscription,
        role: req.user.role
      }
    });
  } catch (error) {
    console.error('Profil hatası:', error);
    res.status(500).json({
      success: false,
      error: 'Profil alınamadı'
    });
  }
});

module.exports = router;
