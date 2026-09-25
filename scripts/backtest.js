'use strict';

// Basit offline backtest:
// data/history_dump.json'u okur, farklı STOP_ATR_MULT değerleri için
// "bu parametre şu olsaydı toplam R ne olurdu" hesaplar.
//
// NOT: Bu, gerçek bir backtest değil — sadece kaba bir duyarlılık analizi.
// Gerçek backtest için geçmiş mum verisi + simülasyon gerekir.

const fs = require('fs');
const path = require('path');

const DUMP = path.join(__dirname, '..', 'data', 'history_dump.json');

if (!fs.existsSync(DUMP)) {
    console.error(`history_dump.json bulunamadi: ${DUMP}`);
    console.error('Once sunucuyu calistirip en az birkac sinyal uretmesini bekleyin.');
    process.exit(1);
}

const dump = JSON.parse(fs.readFileSync(DUMP, 'utf8'));
const history = dump.history || [];

console.log(`Toplam kapanmis sinyal: ${history.length}`);
console.log(`Dump tarihi: ${new Date(dump.dumpedAt).toISOString()}`);
console.log('');

function stats(hist) {
    const closed = hist.length;
    const wins = hist.filter(x => Number(x.resultR) > 0).length;
    const totalR = hist.reduce((a, x) => a + (Number(x.resultR) || 0), 0);
    const longT = hist.filter(x => x.direction === 'LONG');
    const shortT = hist.filter(x => x.direction === 'SHORT');
    return {
        closed, wins,
        winRate: closed ? (wins / closed * 100).toFixed(1) : '-',
        totalR: totalR.toFixed(2),
        longCount: longT.length,
        longR: longT.reduce((a, x) => a + (Number(x.resultR) || 0), 0).toFixed(2),
        shortCount: shortT.length,
        shortR: shortT.reduce((a, x) => a + (Number(x.resultR) || 0), 0).toFixed(2)
    };
}

const s = stats(history);
console.log('=== GERÇEK SONUÇ (mevcut parametreler) ===');
console.log(`Kapali: ${s.closed} | Kazanan: ${s.wins} | WinRate: ${s.winRate}%`);
console.log(`Toplam R: ${s.totalR}`);
console.log(`LONG: ${s.longCount} islem | ${s.longR}R`);
console.log(`SHORT: ${s.shortCount} islem | ${s.shortR}R`);
console.log('');

console.log('=== STOP_ATR_MULT DUYARLILIK ANALIZI ===');
console.log('(Not: Bu, geçmiş mum verisi olmadan yapılan kaba bir tahmindir)');
console.log('');

// Kaba tahmin: stop mesafesi değişince FAKEOUT oranı da değişir varsayımı
// Gerçek backtest değil — sadece yön göstergesi.
const stopMults = [0.5, 0.75, 1.0, 1.25, 1.5];
const currentStop = dump.config.STOP_ATR_MULT || 0.75;

stopMults.forEach(mult => {
    const ratio = currentStop / mult;  // stop ne kadar genişlerse fakeout o kadar azalır
    const fakeoutReduction = Math.min(0.5, (1 - ratio) * 0.6);  // kaba tahmin
    const adjustedHistory = history.map(h => {
        if (h.status === 'FAKEOUT') {
            // Fakeout'ların bir kısmı kurtulur (BE_STOP'a döner = +0.75R)
            if (Math.random() < fakeoutReduction) return { ...h, resultR: 0.75, status: 'BE_STOP' };
        }
        return h;
    });
    const adj = stats(adjustedHistory);
    const diff = (Number(adj.totalR) - Number(s.totalR)).toFixed(2);
    console.log(`STOP_ATR_MULT=${mult} → tahmini toplam R: ${adj.totalR} (fark: ${diff >= 0 ? '+' : ''}${diff})`);
});

console.log('');
console.log('UYARI: Yuksek degerler gercek backtest degildir. Canliya almadan once');
console.log('en az 1 hafta kagit uzerinde (paper trading) dogrulayin.');
