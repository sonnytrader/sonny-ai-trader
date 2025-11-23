const express = require('express');
const { Op } = require('sequelize');
const { Signal } = require('../models');

const router = express.Router();

// List signals, restricted by subscription -> req.allowedStrategies
router.get('/', async (req, res) => {
  try {
    const strategies = Array.isArray(req.allowedStrategies)
      ? req.allowedStrategies
      : [req.allowedStrategies];

    const signals = await Signal.findAll({
      where: {
        strategy: { [Op.in]: strategies }
      },
      order: [['createdAt', 'DESC']],
      limit: 100
    });

    res.json(signals);
  } catch (err) {
    console.error('signals error:', err);
    res.status(500).json({ error: 'Failed to fetch signals' });
  }
});

module.exports = router;
