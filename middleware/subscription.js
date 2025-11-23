function checkSubscription(req, res, next) {
  const plan = req.user.subscription;

  // Basic → sadece sinyal, 1 strateji
  if (req.baseUrl.includes('/signals') && plan === 'basic') {
    req.allowedStrategies = ['breakout'];
    return next();
  }

  // Pro → sinyal + manuel trade, 2 strateji
  if (plan === 'pro') {
    req.allowedStrategies = ['breakout', 'rsimacd'];
    return next();
  }

  // Elite → full erişim
  if (plan === 'elite') {
    req.allowedStrategies = ['breakout', 'rsimacd', 'pumpdetect'];
    return next();
  }

  return res.status(403).json({ error: 'Subscription not valid for this action' });
}

module.exports = { checkSubscription };
