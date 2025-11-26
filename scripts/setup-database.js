const db = require('../database');

console.log('📦 Database kurulumu başlatılıyor...');

// Database tabloları otomatik olarak oluşturulacak
// Bu script sadece kontrol amaçlı

db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='users'", (err, row) => {
    if (err) {
        console.error('❌ Database hatası:', err);
    } else if (row) {
        console.log('✅ Database tabloları hazır');
        
        // Örnek kullanıcı sayısını göster
        db.get("SELECT COUNT(*) as count FROM users", (err, row) => {
            if (!err) {
                console.log(`📊 Toplam kullanıcı: ${row.count}`);
            }
        });
    } else {
        console.log('❌ Database tabloları oluşturulamadı');
    }
});

setTimeout(() => {
    console.log('🚀 Kurulum tamamlandı!');
    process.exit(0);
}, 2000);
