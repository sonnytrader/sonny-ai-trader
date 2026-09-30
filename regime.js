'use strict';
// ============================================================
// REGIME v1 — Scalp için piyasa yönü motoru (BTC + ETH + breadth)
// Çıktı: dir = LONG | SHORT | NÖTR, score (-100..+100), regime = TREND | YATAY | VOLATİL
// Histerezis + minimum bekleme süresi → yön sürekli yanıp sönmez.
//
// ENTEGRASYON (soner_trade.js):
//   const { createRegime, gate } = require('./regime');
//   const regime = createRegime(); let REG = null;
//   liveTick() içinde, refreshTickers()'tan sonra:
//       REG = (await regime.tick(ex, tickers, universe)) || REG;
//   LONG/SHORT sinyali üretmeden hemen önce (mkSig'ten önce):
//       const g = gate('LONG', strength, v.volX, REG); if (!g.ok) { /* atla */ } 
//   apiState() içine:  regime: REG
// ============================================================

const clamp = (x, a = -1, b = 1) => Math.max(a, Math.min(b, x));
const th = Math.tanh;

function ema(v, p) {
    const k = 2 / (p + 1); let e = v[0]; const o = [e];
    for (let i = 1; i < v.length; i++) { e = v[i] * k + e * (1 - k); o.push(e); }
    return o;
}
const trAt = (c, i) => Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - c[i - 1][4]), Math.abs(c[i][3] - c[i - 1][4]));
const trMean = (c, n) => { let s = 0; for (let i = c.length - n; i < c.length; i++) s += trAt(c, i); return s / n; };

// EMA dizilimi + fiyatın EMA50'ye uzaklığı + EMA21 eğimi (hepsi ATR ile normalize)
function trendScore(c) {
    const cl = c.map(x => x[4]), e21 = ema(cl, 21), e50 = ema(cl, 50), n = cl.length - 1;
    const a = trMean(c, 14) || 1e-9;
    const pos = th((cl[n] - e50[n]) / a / 2);
    const align = th((e21[n] - e50[n]) / a);
    const slope = th((e21[n] - e21[n - 3]) / a * 2);
    return 0.4 * pos + 0.3 * align + 0.3 * slope;
}
// UTC günlük VWAP'a göre konum
function vwapScore(c5, a15) {
    const d0 = Math.floor(c5[c5.length - 1][0] / 86400e3) * 86400e3;
    let pv = 0, v = 0;
    for (const k of c5) if (k[0] >= d0) { const tp = (k[2] + k[3] + k[4]) / 3; pv += tp * k[5]; v += k[5]; }
    if (!v) return 0;
    return th((c5[c5.length - 1][4] - pv / v) / a15);
}
// Son 16 adet 15m mumun (4 saat) aralığındaki konum: -1 dip, +1 tepe
function structScore(c15) {
    const w = c15.slice(-16); let hi = -Infinity, lo = Infinity;
    for (const k of w) { hi = Math.max(hi, k[2]); lo = Math.min(lo, k[3]); }
    return hi > lo ? 2 * (w[w.length - 1][4] - lo) / (hi - lo) - 1 : 0;
}
// Kaufman verimlilik oranı: 1 = düz trend, 0 = testere (yatay)
function effRatio(c, n) {
    const s = c.slice(-n - 1); let path = 0;
    for (let i = 1; i < s.length; i++) path += Math.abs(s[i][4] - s[i - 1][4]);
    return path ? Math.abs(s[s.length - 1][4] - s[0][4]) / path : 0;
}

function scoreOne(c5, c15, c1h) {
    if (c5.length < 110 || c15.length < 60 || c1h.length < 60) return null;
    const n5 = c5.length - 1, a5 = trMean(c5, 14) || 1e-9, a15 = trMean(c15, 14) || 1e-9;
    const comps = {
        t1h: trendScore(c1h),
        t15: trendScore(c15),
        mom: th((c5[n5][4] - c5[n5 - 12][4]) / (a5 * Math.sqrt(12)) / 1.5),   // son 1 saatlik momentum
        vwap: vwapScore(c5, a15),
        str: structScore(c15)
    };
    const W = { t1h: 20, t15: 20, mom: 15, vwap: 10, str: 10 };               // toplam 75
    let raw = 0; for (const k in W) raw += comps[k] * W[k];
    raw = raw / 75 * 100;
    const er = effRatio(c15, 24);
    const damp = 0.6 + 0.4 * clamp(er / 0.35, 0, 1);                          // yatayda skoru kıs
    const vr = trMean(c5, 6) / (trMean(c5, 100) || 1e-9);                     // ani volatilite oranı
    return { score: raw * damp, er, vr, comps };
}

function createRegime() {
    const BTC = 'BTC/USDT:USDT', ETH = 'ETH/USDT:USDT';
    const hist = new Map();
    let cache = { t: 0, btc: null, eth: null }, sm = 0, dir = 'NÖTR', since = Date.now(), state = null;

    // Evrenin son ~15 dk'lık fiyat değişimine göre genişlik (kaç coin yukarı / aşağı)
    function breadth(tickers, universe, now) {
        let up = 0, dn = 0, n = 0; const chg = [];
        for (const s of universe) {
            const t = tickers[s]; if (!t || !t.last) continue;
            let h = hist.get(s); if (!h) { h = []; hist.set(s, h); }
            h.push([now, t.last]);
            while (h.length && now - h[0][0] > 16 * 60e3) h.shift();
            if (now - h[0][0] < 10 * 60e3) continue;                          // ısınma: en az 10 dk veri
            const p = (t.last / h[0][1] - 1) * 100;
            chg.push(p); n++;
            if (p > 0.10) up++; else if (p < -0.10) dn++;
        }
        if (n < 20) return null;
        chg.sort((a, b) => a - b);
        const b = (up - dn) / n;
        return { up, dn, n, median: chg[n >> 1], score: clamp(b * 1.5) * 100 };
    }
    async function pull(ex, sym) {
        const now = Date.now();
        const [a, b, c] = await Promise.all([
            ex.fetchOHLCV(sym, '5m', undefined, 300),
            ex.fetchOHLCV(sym, '15m', undefined, 200),
            ex.fetchOHLCV(sym, '1h', undefined, 200)]);
        const cl = (x, ms) => x.filter(k => k[0] + ms <= now);
        return scoreOne(cl(a, 300e3), cl(b, 900e3), cl(c, 3600e3));
    }

    async function tick(ex, tickers, universe) {
        const now = Date.now();
        const br = breadth(tickers, universe, now);
        if (now - cache.t > 30e3) {                                           // OHLCV 30 sn'de bir
            try {
                const [b, e] = await Promise.all([pull(ex, BTC), pull(ex, ETH)]);
                if (b && e) { cache.btc = b; cache.eth = e; }
            } catch (err) { }
            cache.t = now;
        }
        const { btc, eth } = cache; if (!btc || !eth) return state;

        let raw = 0.65 * btc.score + 0.35 * eth.score;
        if (br) raw = 0.75 * raw + 0.25 * br.score;
        sm = sm * 0.8 + raw * 0.2;                                            // yumuşatma

        const ENTER = 30, EXIT = 12, DWELL = 5 * 60e3;
        let nd = dir;
        if (dir === 'NÖTR') { if (sm >= ENTER) nd = 'LONG'; else if (sm <= -ENTER) nd = 'SHORT'; }
        else if (dir === 'LONG') { if (sm <= -ENTER) nd = 'SHORT'; else if (sm < EXIT) nd = 'NÖTR'; }
        else { if (sm >= ENTER) nd = 'LONG'; else if (sm > -EXIT) nd = 'NÖTR'; }
        if (nd !== dir && (now - since >= DWELL || Math.abs(sm) >= 60)) { dir = nd; since = now; }

        const er = (btc.er + eth.er) / 2, vr = Math.max(btc.vr, eth.vr);
        const regime = vr > 2.2 ? 'VOLATİL' : er < 0.18 ? 'YATAY' : 'TREND';
        state = {
            dir, score: Math.round(sm), raw: Math.round(raw), regime,
            er: Number(er.toFixed(2)), vr: Number(vr.toFixed(2)), since, updated: now,
            btc: { score: Math.round(btc.score), ...btc.comps }, eth: { score: Math.round(eth.score) },
            breadth: br ? { up: br.up, dn: br.dn, n: br.n, median: Number(br.median.toFixed(2)) } : null
        };
        return state;
    }
    // Coinin son ~15 dk % değişimi (göreli güç hesabı için); veri yoksa null
    function chg(sym) {
        const h = hist.get(sym);
        if (!h || h.length < 2) return null;
        const a = h[0], b = h[h.length - 1];
        return b[0] - a[0] < 10 * 60e3 ? null : (b[1] / a[1] - 1) * 100;
    }
    return { tick, chg, get state() { return state; } };
}

// Sinyal filtresi: yönle uyumluysa normal, nötrde sıkı, ters yönde çok sıkı
function gate(sigDir, strength, volX, R) {
    if (!R) return { ok: true };
    const aligned = R.dir === sigDir, neutral = R.dir === 'NÖTR';
    const need = aligned ? 40 : neutral ? 55 : 75;
    if (strength < need) return { ok: false, why: 'yön ' + R.dir + ', min güç ' + need };
    if (!aligned && !neutral && volX < 1.5) return { ok: false, why: 'ters yön + hacim zayıf' };
    if (R.regime === 'YATAY' && volX < 1.2) return { ok: false, why: 'yatay piyasa + hacim zayıf' };
    return { ok: true };
}

module.exports = { createRegime, gate, scoreOne };
