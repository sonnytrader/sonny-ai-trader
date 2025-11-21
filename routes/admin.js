const express = require('express');
const { User, Payment, Subscription, ApiKey } = require('../models');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Tüm kullanıcıları listele
router.get('/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const users = await User.findAll({
      attributes: { exclude: ['password'] },
      order: [['createdAt', 'DESC']]
    });

    res.json({
      success: true,
      users
    });
  } catch (error) {
    console.error('Kullanıcı listeleme hatası:', error);
    res.status(500).json({
      success: false,
      error: 'Kullanıcılar listelenemedi'
    });
  }
});

// Kullanıcı onayla
router.post('/users/:userId/approve', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const user = await User.findByPk(req.params.userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'Kullanıcı bulunamadı'
      });
    }

    user.status = 'active';
    await user.save();

    res.json({
      success: true,
      message: 'Kullanıcı başarıyla onaylandı',
      user: {
        id: user.id,
        email: user.email,
        status: user.status
      }
    });
  } catch (error) {
    console.error('Kullanıcı onaylama hatası:', error);
    res.status(500).json({
      success: false,
      error: 'Kullanıcı onaylanamadı'
    });
  }
});

// Kullanıcı reddet
router.post('/users/:userId/reject', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const user = await User.findByPk(req.params.userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'Kullanıcı bulunamadı'
      });
    }

    user.status = 'rejected';
    await user.save();

    res.json({
      success: true,
      message: 'Kullanıcı başarıyla reddedildi',
      user: {
        id: user.id,
        email: user.email,
        status: user.status
      }
    });
  } catch (error) {
    console.error('Kullanıcı reddetme hatası:', error);
    res.status(500).json({
      success: false,
      error: 'Kullanıcı reddedilemedi'
    });
  }
});

// Ödemeleri listele
router.get('/payments', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const payments = await Payment.findAll({
      include: [{
        model: User,
        attributes: ['id', 'email', 'fullName']
      }],
      order: [['createdAt', 'DESC']]
    });

    res.json({
      success: true,
      payments
    });
  } catch (error) {
    console.error('Ödeme listeleme hatası:', error);
    res.status(500).json({
      success: false,
      error: 'Ödemeler listelenemedi'
    });
  }
});

// Sistem istatistikleri
router.get('/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const totalUsers = await User.count();
    const activeUsers = await User.count({ where: { status: 'active' } });
    const pendingUsers = await User.count({ where: { status: 'pending' } });
    
    const totalPayments = await Payment.count();
    const completedPayments = await Payment.count({ where: { status: 'completed' } });
    
    const totalRevenue = await Payment.sum('amount', { 
      where: { status: 'completed' } 
    }) || 0;

    res.json({
      success: true,
      stats: {
        totalUsers,
        activeUsers,
        pendingUsers,
        totalPayments,
        completedPayments,
        totalRevenue: parseFloat(totalRevenue)
      }
    });
  } catch (error) {
    console.error('İstatistik hatası:', error);
    res.status(500).json({
      success: false,
      error: 'İstatistikler alınamadı'
    });
  }
});

module.exports = router;
