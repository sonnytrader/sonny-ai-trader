require('dotenv').config();
const { sequelize, testConnection } = require('../database');
const { User, Subscription, Payment, ApiKey } = require('../models');

async function setupDatabase() {
  try {
    console.log('🔧 Veritabanı kurulumu başlatılıyor...');
    
    // Bağlantıyı test et
    const connected = await testConnection();
    if (!connected) {
      console.error('❌ Veritabanı bağlantısı başarısız');
      process.exit(1);
    }

    // Tabloları oluştur
    await sequelize.sync({ force: false, alter: true });
    console.log('✅ Tablolar oluşturuldu/güncellendi');

    // Admin kullanıcısı oluştur
    const adminExists = await User.findOne({ where: { email: process.env.ADMIN_EMAIL } });
    if (!adminExists) {
      await User.create({
        email: process.env.ADMIN_EMAIL,
        password: process.env.ADMIN_PASSWORD,
        fullName: 'System Administrator',
        role: 'admin',
        status: 'active',
        subscriptionPlan: 'elite',
        subscriptionStatus: 'active'
      });
      console.log('✅ Admin kullanıcısı oluşturuldu');
    } else {
      console.log('ℹ️ Admin kullanıcısı zaten mevcut');
    }

    console.log('🎉 Veritabanı kurulumu tamamlandı!');
    process.exit(0);

  } catch (error) {
    console.error('❌ Veritabanı kurulum hatası:', error);
    process.exit(1);
  }
}

setupDatabase();
