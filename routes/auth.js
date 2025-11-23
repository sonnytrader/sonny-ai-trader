const express = require('express');
const jwt = require('jsonwebtoken');
const { User } = require('../models');

const router = express.Router();

router.post('/register', async (req, res) => {
  try {
    const { email, password, fullName, strategy = 'breakout' } = req.body;
    const existing = await User.findOne({ where: { email } });
    if (existing) return res.status(400).json({ success: false, error: 'Bu e-posta adresi zaten kullanılıyor' });

    const user = await User.create({ email, password, fullName, strategy, status: 'pending' });
    const token = jwt.sign({ userId: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.json({ success: true, message: 'Kayıt başarılı, admin onayı bekleniyor', token, user: { id: user.id, email: user.email, fullName: user.fullName, role: user.role } });
  } catch {
    res.status(500).json({ success: false, error: 'Kayıt sırasında bir hata oluştu' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ where: { email } });
    if (!user || !(await user.validatePassword(password))) {
      return res.status(400).json({ success: false, error: 'Geçersiz e-posta veya şifre' });
    }
    user.lastLogin = new Date(); user.loginCount += 1; await user.save();
    const token = jwt.sign({ userId: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.json({ success: true, message: 'Giriş başarılı', token, user: { id: user.id, email: user.email, fullName: user.fullName, role: user.role, subscriptionPlan: user.subscriptionPlan, subscriptionStatus: user.subscriptionStatus } });
  } catch {
    res.status(500).json({ success: false, error: 'Giriş sırasında bir hata oluştu' });
  }
});

module.exports = router;
