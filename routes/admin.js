const express = require('express');
const { User } = require('../models');
const router = express.Router();

router.get('/users', async (req, res) => {
  const users = await User.findAll();
  res.json(users);
});

module.exports = router;
