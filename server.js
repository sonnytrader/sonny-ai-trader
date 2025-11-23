require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const app = express();
const server = http.createServer(app);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const db = new sqlite3.Database('./alphason.db');

const JWT_SECRET = process.env.JWT_SECRET || 'secret';
const ENC_KEY = process.env.ENC_KEY || '12345678901234567890123456789012';
const ENC_IV = process.env.ENC_IV || '1234567890123456';
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.example.com',
  port: process.env.SMTP_PORT || 587,
  auth: { user: process.env.SMTP_USER || 'user', pass: process.env.SMTP_PASS || 'pass' }
});
const SMTP_FROM = process.env.SMTP_FROM || 'noreply@alphason.com';

function encrypt(text) {
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(ENC_KEY), Buffer.from(ENC_IV));
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([enc, tag]).toString('base64');
}
function decrypt(b64) {
  const data = Buffer.from(b64, 'base64');
  const enc = data.slice(0, data.length - 16);
  const tag = data.slice(data.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(ENC_KEY), Buffer.from(ENC_IV));
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString('utf8');
}

// DB schema
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE, password TEXT, fullName TEXT,
    role TEXT DEFAULT 'user',
    verified INTEGER DEFAULT 0,
    verify_code TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER, plan TEXT, status TEXT,
    period_start DATETIME DEFAULT CURRENT_TIMESTAMP, period_end DATETIME
  )`);
});

// Admin seed
(async () => {
  const email = 'admin@alphason.com';
  db.get('SELECT id FROM users WHERE email = ?', [email], async (err, row) => {
    if (!row) {
      const hash = await bcrypt.hash('admin123', 12);
      db.run('INSERT INTO users (email, password, fullName, role, verified) VALUES (?, ?, ?, ?, ?)',
        [email, hash, 'System Admin', 'admin', 1]);
      db.run('INSERT INTO subscriptions (user_id, plan, status) VALUES ((SELECT id FROM users WHERE email=?), ?, ?)',
        [email, 'elite', 'active']);
    }
  });
})();

// Auth helpers
function authenticateToken(req, res, next) {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token) return res.status(401).json({ success:false, error:'Token gerekli' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(403).json({ success:false, error:'Geçersiz token' }); }
}

// SMTP send
async function sendVerifyEmail(email, code) {
  const mail = {
    from: SMTP_FROM,
    to: email,
    subject: 'Alphason doğrulama kodu',
    text: `Doğrulama kodunuz: ${code}`
  };
  await transporter.sendMail(mail);
}

// Register
app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body;
  const hash = await bcrypt.hash(password, 12);
  const code = Math.floor(100000 + Math.random()*900000).toString();
  db.run('INSERT INTO users (email, password, role, verified, verify_code) VALUES (?, ?, ?, ?, ?)',
    [email, hash, 'user', 0, code],
    async function(err) {
      if (err) return res.status(500).json({ success:false, error:'Kayıt hatası' });
      try { await sendVerifyEmail(email, code); } catch(e){}
      const token = jwt.sign({ userId: this.lastID, email, role: 'user' }, JWT_SECRET, { expiresIn: '1h' });
      res.json({ success:true, token });
    });
});

// Verify
app.post('/api/auth/verify', authenticateToken, (req, res) => {
  const { code } = req.body;
  db.get('SELECT verify_code FROM users WHERE id=?', [req.user.userId], (err, row) => {
    if (!row || row.verify_code !== code) return res.status(400).json({ success:false, error:'Kod hatalı' });
    db.run('UPDATE users SET verified=1, verify_code=NULL WHERE id=?', [req.user.userId]);
    res.json({ success:true });
  });
});

// Login
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  db.get('SELECT * FROM users WHERE email=?', [email], async (err, user) => {
    if (!user) return res.status(400).json({ success:false, error:'Geçersiz email/şifre' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(400).json({ success:false, error:'Geçersiz email/şifre' });
    const token = jwt.sign({ userId: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ success:true, token });
  });
});

// Default route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
