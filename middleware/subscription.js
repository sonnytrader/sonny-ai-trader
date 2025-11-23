function checkSubscription(req, res, next) {
  const plan = req.user?.subscription;

  if (!plan) {
    return res.status(401).json({ error: 'Subscription not found' });
  }

  // Basic: only signals, 1 strategy (Breakout)
  if (plan === 'basic') {
    if (req.baseUrl.includes('/signals')) {
      req.allowedStrategies = ['breakout'];
      return next();
    }
    return res.status(403).json({ error: 'Basic plan does not allow trading' });
  }

  // Pro: signals + manual trade, 2 strategies
  if (plan === 'pro') {
    req.allowedStrategies = ['breakout', 'rsimacd'];
    return next();
  }

  // Elite: full access
  if (plan === 'elite') {
    req.allowedStrategies = ['breakout', 'rsimacd', 'pumpdetect'];
    return next();
  }

  return res.status(403).json({ error: 'Invalid subscription plan' });
}

module.exports = { checkSubscription };
