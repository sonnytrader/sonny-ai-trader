const { User } = require('../models/User');

const requireSubscription = (requiredPlan = 'basic') => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Kimlik doğrulama gereklidir'
      });
    }

    // Admin her şeye erişebilir
    if (req.user.role === 'admin') {
      return next();
    }

    // Kullanıcı aktif değilse
    if (req.user.status !== 'active') {
      return res.status(403).json({
        success: false,
        error: 'Hesabınız aktif değil veya onay bekliyor'
      });
    }

    // Abonelik kontrolü
    if (!req.user.isSubscriptionActive()) {
      return res.status(402).json({
        success: false,
        error: 'Aktif aboneliğiniz bulunmamaktadır',
        code: 'SUBSCRIPTION_REQUIRED'
      });
    }

    // Plan seviyesi kontrolü
    const planLevels = { basic: 1, pro: 2, elite: 3 };
    const userPlanLevel = planLevels[req.user.subscriptionPlan] || 0;
    const requiredPlanLevel = planLevels[requiredPlan] || 0;

    if (userPlanLevel < requiredPlanLevel) {
      return res.status(402).json({
        success: false,
        error: `Bu özellik için ${requiredPlan} aboneliği gereklidir`,
        code: 'UPGRADE_REQUIRED'
      });
    }

    next();
  };
};

const requireTradingAccess = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      error: 'Kimlik doğrulama gereklidir'
    });
  }

  if (!req.user.hasTradingAccess()) {
    return res.status(402).json({
      success: false,
      error: 'Trading erişiminiz bulunmamaktadır',
      code: 'TRADING_ACCESS_REQUIRED'
    });
  }

  next();
};

module.exports = { requireSubscription, requireTradingAccess };
