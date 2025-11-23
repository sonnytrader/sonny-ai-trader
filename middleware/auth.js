const jwt = require('jsonwebtoken');
const { User } = require('../models');

const authenticateToken = async (req, res, next) => {
  const header = req.headers['authorization'];
  const token = header && header.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, error: 'Erişim tokenı gereklidir' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findByPk(decoded.userId);
    if (!user) return res.status(401).json({ success: false, error: 'Kullanıcı bulunamadı' });
    if (user.status !== 'active' && user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Hesabınız aktif değil' });
    }
    req.user = user;
    next();
  } catch {
    return res.status(403).json({ success: false, error: 'Geçersiz token' });
  }
};

const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Admin erişimi gereklidir' });
  }
  next();
};

module.exports = { authenticateToken, requireAdmin };
