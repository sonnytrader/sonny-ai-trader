require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);

// SQLite Database
const db = new sqlite3.Database('./alphason.db');

// Basit Database Setup
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE,
        password TEXT,
        fullName TEXT,
        strategy TEXT DEFAULT 'breakout',
        role TEXT DEFAULT 'user',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// KESİN ÇÖZÜM: Admin kullanıcı oluştur
const createAdminUser = () => {
    const plainPassword = 'admin123';
    const hashedPassword = bcrypt.hashSync(plainPassword, 12);
    
    db.run(
        `INSERT OR REPLACE INTO users (email, password, fullName, role) 
         VALUES (?, ?, ?, ?)`,
        ['admin@alphason.com', hashedPassword, 'System Admin', 'admin'],
        function(err) {
            if (err) {
                console.error('Admin oluşturma hatası:', err);
            } else {
                console.log('🎉 ADMIN HESABI HAZIR!');
                console.log('📧 Email: admin@alphason.com');
                console.log('🔑 Şifre: admin123');
            }
        }
    );
};

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// LOGIN ROUTE - Basit ve Çalışan
app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;
    
    console.log('Login attempt:', email); // Debug
    
    if (!email || !password) {
        return res.status(400).json({ 
            success: false, 
            error: 'Email ve şifre gereklidir' 
        });
    }

    db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ 
                success: false, 
                error: 'Database hatası' 
            });
        }
        
        if (!user) {
            console.log('Kullanıcı bulunamadı:', email);
            return res.status(400).json({ 
                success: false, 
                error: 'Geçersiz email veya şifre' 
            });
        }

        // Şifre kontrolü
        bcrypt.compare(password, user.password, (err, isMatch) => {
            if (err) {
                console.error('Şifre karşılaştırma hatası:', err);
                return res.status(500).json({ 
                    success: false, 
                    error: 'Şifre kontrol hatası' 
                });
            }
            
            if (!isMatch) {
                console.log('Şifre yanlış:', email);
                return res.status(400).json({ 
                    success: false, 
                    error: 'Geçersiz email veya şifre' 
                });
            }

            // BAŞARILI GİRİŞ
            const token = jwt.sign(
                { 
                    userId: user.id, 
                    email: user.email,
                    role: user.role 
                },
                'alphason-secret-key',
                { expiresIn: '7d' }
            );

            console.log('✅ BAŞARILI GİRİŞ:', email);
            
            res.json({
                success: true,
                message: 'Giriş başarılı!',
                token,
                user: {
                    id: user.id,
                    email: user.email,
                    fullName: user.fullName,
                    strategy: user.strategy,
                    role: user.role
                }
            });
        });
    });
});

// Frontend
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Server başlatma
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('🚀 AlphaSon Crypto Başlatılıyor...');
    createAdminUser(); // Admin kullanıcısını oluştur
    console.log(`📍 Port: ${PORT}`);
    console.log('🎯 Giriş Bilgileri: admin@alphason.com / admin123');
});
