const express = require('express');
const { User } = require('../models');
const router = express.Router();

router.get('/profile', async (req, res) => {
  const user = await User.findByPk(req.user.id);
  res.json(user);
});

module.exports = router;
