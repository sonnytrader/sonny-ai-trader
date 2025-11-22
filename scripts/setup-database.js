require('dotenv').config();
const { sequelize, testConnection } = require('../database');
const { User } = require('../models');

async function setupDatabase() {
  try {
    console.log('🔧 AlphaSon Crypto veritabanı kurulumu başlatılıyor...');
    
    // Bağlantıyı test et
    const connected = await testConnection();
    if (!connected) {
      console.error('❌ PostgreSQL bağlantısı başarısız');
      process.exit(1);
    }

    // Tabloları oluştur
    await sequelize.sync({ force: false, alter: true });
    console.log('✅ PostgreSQL tabloları oluşturuldu/güncellendi');

    // Admin kullanıcısı oluştur
    const adminExists = await User.findOne({ where: { email: process.env.ADMIN_EMAIL } });
    if (!adminExists) {
      await User.create({
        email: process.env.ADMIN_EMAIL,
        password: process.env.ADMIN_PASSWORD,
        fullName: 'AlphaSon Admin',
        role: 'admin',
        strategy: 'breakout',
        subscription: 'elite'
      });
      console.log('✅ Admin kullanıcısı oluşturuldu');
    } else {
      console.log('ℹ️ Admin kullanıcısı zaten mevcut');
    }

    console.log('🎉 AlphaSon Crypto veritabanı kurulumu tamamlandı!');
    process.exit(0);

  } catch (error) {
    console.error('❌ Veritabanı kurulum hatası:', error);
    process.exit(1);
  }
}

setupDatabase();
