// routes/auth.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../database');

// JWT için basit bir gizli anahtar (Gerçek projede .env'den alınmalı)
const JWT_SECRET = process.env.JWT_SECRET || 'your_very_secret_key_123';

// Kayıt İşlemi
router.post('/register', async (req, res) => {
    const { email, password, apiKey, apiSecret, apiPassphrase, plan = 'basic' } = req.body;
    
    if (!email || !password) {
        return res.status(400).json({ success: false, error: "Email ve şifre zorunludur." });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const sql = `INSERT INTO users (email, password, plan, api_key, api_secret, api_passphrase) VALUES (?, ?, ?, ?, ?, ?)`;
        
        db.run(sql, [email, hashedPassword, plan, apiKey || '', apiSecret || '', apiPassphrase || ''], function(err) {
            if (err) {
                if (err.message.includes('UNIQUE constraint failed')) {
                    return res.status(409).json({ success: false, error: "Bu email adresi zaten kayıtlı." });
                }
                console.error("Kayıt hatası:", err.message);
                return res.status(500).json({ success: false, error: "Sunucu hatası: Kayıt yapılamadı." });
            }
            res.json({ success: true, message: "Kayıt başarılı." });
        });

    } catch (e) {
        res.status(500).json({ success: false, error: "Şifre hashleme hatası." });
    }
});

// Giriş İşlemi
router.post('/login', (req, res) => {
    const { email, password } = req.body;
    
    db.get("SELECT * FROM users WHERE email = ?", [email], async (err, user) => {
        if (err) {
            console.error("DB hatası:", err.message);
            return res.status(500).json({ success: false, error: "Sunucu hatası." });
        }
        
        if (!user) {
            return res.status(401).json({ success: false, error: "Kullanıcı bulunamadı." });
        }

        const match = await bcrypt.compare(password, user.password);
        
        if (!match) {
            return res.status(401).json({ success: false, error: "Yanlış şifre." });
        }

        // Token oluştur
        const token = jwt.sign({ userId: user.id, email: user.email, plan: user.plan }, JWT_SECRET, { expiresIn: '1d' });

        res.json({ 
            success: true, 
            token: token,
            user: { email: user.email, plan: user.plan }
        });
    });
});

module.exports = router;
