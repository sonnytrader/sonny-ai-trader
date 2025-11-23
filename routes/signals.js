const express = require('express');
const { Signal } = require('../models');
const router = express.Router();

router.get('/', async (req, res) => {
  const signals = await Signal.findAll({
    where: { strategy: req.allowedStrategies }
  });
  res.json(signals);
});

module.exports = router;
