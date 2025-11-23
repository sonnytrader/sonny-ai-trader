const express = require('express');
const router = express.Router();
const db = require('../database');
const bcrypt = require('bcrypt'); // Terminalde: npm install bcrypt
const jwt = require('jsonwebtoken'); // Terminalde: npm install jsonwebtoken

const SECRET_KEY = process.env.JWT_SECRET || 'gizli_kelime_degistir';

// KAYIT OL
router.post('/register', async (req, res) => {
    const { email, password, plan, apiKey, apiSecret } = req.body;
    
    if(!email || !password) return res.status(400).json({ error: 'Email ve şifre zorunlu' });

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const sql = `INSERT INTO users (email, password, plan, api_key, api_secret) VALUES (?, ?, ?, ?, ?)`;
        
        db.run(sql, [email, hashedPassword, plan, apiKey, apiSecret], function(err) {
            if (err) {
                if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Email zaten kayıtlı.' });
                return res.status(500).json({ error: err.message });
            }
            res.json({ success: true, message: 'Kayıt başarılı' });
        });
    } catch (e) {
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// GİRİŞ YAP
router.post('/login', (req, res) => {
    const { email, password } = req.body;

    db.get(`SELECT * FROM users WHERE email = ?`, [email], async (err, user) => {
        if (err || !user) return res.status(401).json({ error: 'Kullanıcı bulunamadı' });

        const validPass = await bcrypt.compare(password, user.password);
        if (!validPass) return res.status(401).json({ error: 'Hatalı şifre' });

        const token = jwt.sign({ id: user.id, email: user.email }, SECRET_KEY, { expiresIn: '24h' });
        res.json({ success: true, token, user: { email: user.email, plan: user.plan } });
    });
});

module.exports = router;
