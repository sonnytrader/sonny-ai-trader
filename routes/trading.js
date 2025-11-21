const express = require('express');
const ccxt = require('ccxt');
const { ApiKey } = require('../models');
const { authenticateToken } = require('../middleware/auth');
const { requireTradingAccess } = require('../middleware/subscription');

const router = express.Router();

// Sinyalleri getir
router.get('/signals', authenticateToken, async (req, res) => {
  try {
    // Bu kısım mevcut sinyal üretim mantığınızla entegre edilecek
    // Şimdilik mock data döndürüyoruz
    
    const mockSignals = [
      {
        id: 1,
        symbol: 'BTC/USDT',
        direction: 'LONG',
        entry: 42000,
        tp: 45000,
        sl: 41000,
        confidence: 85,
        timestamp: new Date()
      }
    ];

    res.json({
      success: true,
      signals: mockSignals
    });
  } catch (error) {
    console.error('Sinyal getirme hatası:', error);
    res.status(500).json({
      success: false,
      error: 'Sinyaller alınamadı'
    });
  }
});

// Manuel trade yürüt
router.post('/execute', authenticateToken, requireTradingAccess, async (req, res) => {
  try {
    const { symbol, side, amount, orderType = 'market', price } = req.body;

    // Kullanıcının API key'lerini al
    const apiKey = await ApiKey.findOne({
      where: { userId: req.user.id, exchange: 'bitget', isActive: true }
    });

    if (!apiKey) {
      return res.status(400).json({
        success: false,
        error: 'API key bulunamadı. Lütfen API key\'lerinizi ekleyin.'
      });
    }

    // API key'leri decrypt et
    const credentials = apiKey.decrypt();

    // Exchange'i başlat
    const exchange = new ccxt.bitget({
      apiKey: credentials.apiKey,
      secret: credentials.secret,
      password: credentials.passphrase,
      options: { defaultType: 'swap' },
      enableRateLimit: true
    });

    // Trade işlemini yürüt
    let order;
    if (orderType === 'market') {
      order = await exchange.createOrder(symbol, 'market', side, amount);
    } else {
      order = await exchange.createOrder(symbol, 'limit', side, amount, price);
    }

    // API key son kullanım tarihini güncelle
    await apiKey.update({ lastUsed: new Date() });

    res.json({
      success: true,
      message: 'Trade başarıyla yürütüldü',
      order
    });

  } catch (error) {
    console.error('Trade yürütme hatası:', error);
    res.status(500).json({
      success: false,
      error: `Trade yürütülemedi: ${error.message}`
    });
  }
});

// Pozisyonları getir
router.get('/positions', authenticateToken, requireTradingAccess, async (req, res) => {
  try {
    const apiKey = await ApiKey.findOne({
      where: { userId: req.user.id, exchange: 'bitget', isActive: true }
    });

    if (!apiKey) {
      return res.json({
        success: true,
        positions: []
      });
    }

    const credentials = apiKey.decrypt();
    const exchange = new ccxt.bitget({
      apiKey: credentials.apiKey,
      secret: credentials.secret,
      password: credentials.passphrase,
      options: { defaultType: 'swap' }
    });

    const positions = await exchange.fetchPositions();
    const openPositions = positions.filter(p => parseFloat(p.contracts) > 0);

    // API key son kullanım tarihini güncelle
    await apiKey.update({ lastUsed: new Date() });

    res.json({
      success: true,
      positions: openPositions
    });

  } catch (error) {
    console.error('Pozisyon getirme hatası:', error);
    res.status(500).json({
      success: false,
      error: `Pozisyonlar alınamadı: ${error.message}`
    });
  }
});

module.exports = router;
