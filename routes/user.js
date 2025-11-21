const express = require('express');
const { ApiKey, Subscription, Payment } = require('../models');
const { authenticateToken } = require('../middleware/auth');
const { requireSubscription } = require('../middleware/subscription');

const router = express.Router();

// API Key'leri listele
router.get('/api-keys', authenticateToken, async (req, res) => {
  try {
    const apiKeys = await ApiKey.findAll({
      where: { userId: req.user.id },
      attributes: ['id', 'exchange', 'label', 'isActive', 'lastUsed', 'createdAt']
    });

    res.json({
      success: true,
      apiKeys
    });
  } catch (error) {
    console.error('API key listeleme hatası:', error);
    res.status(500).json({
      success: false,
      error: 'API key\'ler alınamadı'
    });
  }
});

// API Key ekle/güncelle
router.post('/api-keys', authenticateToken, requireSubscription('pro'), async (req, res) => {
  try {
    const { exchange, apiKey, secret, passphrase, label } = req.body;

    if (!['bitget', 'binance'].includes(exchange)) {
      return res.status(400).json({
        success: false,
        error: 'Geçersiz exchange'
      });
    }

    // Mevcut key'i kontrol et
    const existingKey = await ApiKey.findOne({
      where: { userId: req.user.id, exchange }
    });

    if (existingKey) {
      // Güncelle
      await existingKey.update({
        apiKey,
        secret,
        passphrase,
        label,
        lastUsed: new Date()
      });
    } else {
      // Yeni oluştur
      await ApiKey.create({
        userId: req.user.id,
        exchange,
        apiKey,
        secret,
        passphrase,
        label
      });
    }

    res.json({
      success: true,
      message: 'API key başarıyla kaydedildi'
    });
  } catch (error) {
    console.error('API key kaydetme hatası:', error);
    res.status(500).json({
      success: false,
      error: 'API key kaydedilemedi'
    });
  }
});

// API Key sil
router.delete('/api-keys/:id', authenticateToken, async (req, res) => {
  try {
    const apiKey = await ApiKey.findOne({
      where: { id: req.params.id, userId: req.user.id }
    });

    if (!apiKey) {
      return res.status(404).json({
        success: false,
        error: 'API key bulunamadı'
      });
    }

    await apiKey.destroy();

    res.json({
      success: true,
      message: 'API key başarıyla silindi'
    });
  } catch (error) {
    console.error('API key silme hatası:', error);
    res.status(500).json({
      success: false,
      error: 'API key silinemedi'
    });
  }
});

// Abonelik geçmişi
router.get('/subscriptions', authenticateToken, async (req, res) => {
  try {
    const subscriptions = await Subscription.findAll({
      where: { userId: req.user.id },
      order: [['createdAt', 'DESC']]
    });

    res.json({
      success: true,
      subscriptions
    });
  } catch (error) {
    console.error('Abonelik geçmişi hatası:', error);
    res.status(500).json({
      success: false,
      error: 'Abonelik geçmişi alınamadı'
    });
  }
});

// Ödeme geçmişi
router.get('/payments', authenticateToken, async (req, res) => {
  try {
    const payments = await Payment.findAll({
      where: { userId: req.user.id },
      order: [['createdAt', 'DESC']]
    });

    res.json({
      success: true,
      payments
    });
  } catch (error) {
    console.error('Ödeme geçmişi hatası:', error);
    res.status(500).json({
      success: false,
      error: 'Ödeme geçmişi alınamadı'
    });
  }
});

module.exports = router;
