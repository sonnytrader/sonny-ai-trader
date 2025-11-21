const jwt = require('jsonwebtoken');
const { User } = require('../models/User');

const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ 
      success: false,
      error: 'Erişim tokenı gereklidir' 
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findByPk(decoded.userId);
    
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Kullanıcı bulunamadı'
      });
    }

    if (user.status !== 'active' && user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Hesabınız aktif değil veya onay bekliyor'
      });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(403).json({
      success: false,
      error: 'Geçersiz token'
    });
  }
};

const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      error: 'Admin erişimi gereklidir'
    });
  }
  next();
};

const optionalAuth = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findByPk(decoded.userId);
      if (user && user.status === 'active') {
        req.user = user;
      }
    } catch (error) {
      // Token is invalid, but we continue without user
    }
  }
  next();
};

module.exports = { authenticateToken, requireAdmin, optionalAuth };
