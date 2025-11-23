const express = require('express');
const router = express.Router();

// Manuel trade (Pro)
router.post('/manual', (req, res) => {
  res.json({ message: 'Manual trade executed via BiTGET API' });
});

// Otomatik trade (Elite)
router.post('/auto', (req, res) => {
  res.json({ message: 'Auto trade executed via BiTGET API' });
});

module.exports = router;
