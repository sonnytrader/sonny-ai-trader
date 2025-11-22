const jwt = require('jsonwebtoken');
const { user } = require('../models/user');

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
    const user = await user.findByPk(decoded.userId);
    
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Kullanıcı bulunamadı'
      });
    }

    if (user.status !== 'active') {
      return res.status(403).json({
        success: false,
        error: 'Hesabınız aktif değil'
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

module.exports = { authenticateToken, requireAdmin };
