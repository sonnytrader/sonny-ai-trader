// UT Bot için ATR hesaplama (kapalı mumlar üzerinden, closed çağırmaz)
function atrUT(candles, p = 10) {
    if (!Array.isArray(candles) || candles.length < p + 1) return 0;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
        const h = n(candles[i][2]);
        const lo = n(candles[i][3]);
        const pc = n(candles[i - 1][4]);
        trs.push(Math.max(h - lo, Math.abs(h - pc), Math.abs(lo - pc)));
    }
    return avg(trs.slice(-p));
}

function computeUT(candles) {
    const c = closed(candles);
    if (c.length < 11) { // ATR(10) için en az 11 kapalı mum gerekli
        return { buy: false, sell: false, stop: 0, pos: 0, src: c.length ? n(c[c.length - 1][4]) : 0 };
    }

    let stop = 0;
    let pos = 0;
    let prevSrc = 0;
    let prevStop = 0;
    let buy = false;
    let sell = false;

    for (let i = 10; i < c.length; i++) { // i 10'dan başlat (11. mum indeksi 10)
        const src = n(c[i][4]);

        // ATR(10) için son 11 mumu al (i-10'dan i'ye)
        const slice = c.slice(i - 10, i + 1); // 11 mum
        const atr10 = atrUT(slice, 10);
        const nLoss = atr10; // a = 1

        // Trailing stop
        let newStop;
        if (src > prevStop && prevSrc > prevStop) {
            newStop = Math.max(prevStop, src - nLoss);
        } else if (src < prevStop && prevSrc < prevStop) {
            newStop = Math.min(prevStop, src + nLoss);
        } else if (src > prevStop) {
            newStop = src - nLoss;
        } else {
            newStop = src + nLoss;
        }
        stop = newStop;

        // Pozisyon
        if (prevSrc < prevStop && src > prevStop) {
            pos = 1;
        } else if (prevSrc > prevStop && src < prevStop) {
            pos = -1;
        }

        // Buy / Sell (crossover mantığı)
        buy = (src > stop && prevSrc <= prevStop);
        sell = (src < stop && prevSrc >= prevStop);

        // Bir sonraki adım için
        prevStop = stop;
        prevSrc = src;
    }

    return { buy, sell, stop, pos, src: prevSrc };
}
