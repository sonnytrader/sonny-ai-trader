'use strict';
// ============================================================
// TREND SİNYALLERİ — TEK DOSYA (server.js)
//   node server.js                  -> canlı sinyal sunucusu + panel
//   node server.js backtest 365 25  -> backtest (365 gün, 25 coin)
// Bağımlılıklar: express cors ccxt   (Node 18+)
// Opsiyonel env: PORT, DATA_DIR, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
// ============================================================
const express = require('express');
const cors = require('cors');
const ccxt = require('ccxt');
const fs = require('fs');
const path = require('path');

// ---------------- STRATEJİ ----------------
// ============================================================
// TREND PULLBACK — ortak strateji modülü (canlı + backtest aynı kodu kullanır)
// Mantık: 4h trend yönünde, 1h geri çekilme sonrası onaylı dönüş.
// Mumlar: [t, o, h, l, c, v] — sadece KAPANMIŞ mumlar verilmeli.
// ============================================================
const H1 = 3600e3, H4 = 4 * H1;

const CFG = {
    TREND_MIN_SPREAD_PCT: 0.8,   // 4h EMA50-EMA200 arası min açıklık (%)
    SLOPE_BARS: 6,
    PULL_LOOKBACK: 8,            // geri çekilme aranan son 1h mum sayısı
    RSI_PULL_LONG: 45, RSI_PULL_SHORT: 55,
    MIN_BODY_RATIO: 0.4,         // onay mumunun gövde/menzil oranı
    MAX_CHASE_ATR: 1.5,          // EMA21'den max uzaklık (kovalama engeli)
    STOP_BUFFER_ATR: 0.2, MIN_STOP_ATR: 1.0, MAX_STOP_ATR: 2.5,
    ROOM_LOOKBACK: 100, MIN_ROOM_R: 1.5,   // hedefe kadar önünde engel yok
    TP1_R: 1.5, TP1_FRACTION: 0.5, TRAIL_ATR: 3,
    MAX_HOLD_MS: 72 * H1,
    COST_PCT: 0.16,             // gidiş-dönüş komisyon + slippage (fiyatın %'si)
    MIN_CANDLES: 900
};

function emaSeries(v, p) {
    const out = new Array(v.length).fill(null);
    if (v.length < p) return out;
    let e = 0; for (let i = 0; i < p; i++) e += v[i]; e /= p; out[p - 1] = e;
    const k = 2 / (p + 1);
    for (let i = p; i < v.length; i++) { e = v[i] * k + e * (1 - k); out[i] = e; }
    return out;
}
function atrLast(c, p = 14) {
    if (c.length < p + 1) return null;
    const tr = [];
    for (let i = 1; i < c.length; i++) tr.push(Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - c[i - 1][4]), Math.abs(c[i][3] - c[i - 1][4])));
    let a = tr.slice(0, p).reduce((s, x) => s + x, 0) / p;
    for (let i = p; i < tr.length; i++) a = (a * (p - 1) + tr[i]) / p;
    return a;
}
function rsiSeries(cl, p = 14) {
    const out = new Array(cl.length).fill(null);
    if (cl.length < p + 1) return out;
    let g = 0, l = 0;
    for (let i = 1; i <= p; i++) { const d = cl[i] - cl[i - 1]; d >= 0 ? g += d : l -= d; }
    g /= p; l /= p;
    out[p] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    for (let i = p + 1; i < cl.length; i++) {
        const d = cl[i] - cl[i - 1];
        g = (g * (p - 1) + Math.max(0, d)) / p; l = (l * (p - 1) + Math.max(0, -d)) / p;
        out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
    return out;
}
function aggregate4h(c) {
    const m = new Map();
    for (const x of c) {
        const k = Math.floor(x[0] / H4) * H4;
        let g = m.get(k);
        if (!g) { g = { t: k, h: x[2], l: x[3], c: x[4], n: 0 }; m.set(k, g); }
        g.h = Math.max(g.h, x[2]); g.l = Math.min(g.l, x[3]); g.c = x[4]; g.n++;
    }
    return [...m.values()].filter(g => g.n === 4);   // sadece tamamlanmış 4h mumlar
}
// +1 yukarı trend, -1 aşağı trend, 0 belirsiz
function trend4h(c1h) {
    const g = aggregate4h(c1h);
    if (g.length < 210) return 0;
    const cl = g.map(x => x.c), e50 = emaSeries(cl, 50), e200 = emaSeries(cl, 200), n = g.length - 1;
    const a = e50[n], b = e200[n];
    if (a == null || b == null) return 0;
    const spread = Math.abs(a - b) / b * 100, slope = a - e50[n - CFG.SLOPE_BARS];
    if (spread < CFG.TREND_MIN_SPREAD_PCT) return 0;
    if (a > b && cl[n] > b && slope > 0) return 1;
    if (a < b && cl[n] < b && slope < 0) return -1;
    return 0;
}

// c: kapanmış 1h mumlar (sonuncusu tetik mumu). btcDir: BTC 4h trendi (yoksa 0)
function evaluate(c, btcDir = 0) {
    if (c.length < CFG.MIN_CANDLES) return null;
    const dir = trend4h(c);
    if (!dir) return null;
    if (btcDir === -dir) return null;                         // BTC ters yönde → alma

    const n = c.length - 1, cl = c.map(x => x[4]);
    const e21 = emaSeries(cl, 21), e50 = emaSeries(cl, 50), rs = rsiSeries(cl, 14);
    const a = atrLast(c.slice(-200), 14);
    const x = c[n], prev = c[n - 1], o = x[1], h = x[2], l = x[3], close = x[4];
    const rng = h - l;
    if (!a || rng <= 0 || e21[n] == null || e50[n] == null) return null;
    const body = Math.abs(close - o) / rng, lb = CFG.PULL_LOOKBACK, from = n - lb + 1;
    const win = c.slice(from, n + 1), rw = rs.slice(from, n + 1);

    let ok, stopBase, rsiExt;
    if (dir === 1) {
        const touched = win.some((z, j) => z[3] <= e21[from + j] + 0.25 * a);
        rsiExt = Math.min(...rw);
        ok = touched && rsiExt <= CFG.RSI_PULL_LONG && close > o && close > prev[2] && close > e21[n] && close > e50[n];
        stopBase = Math.min(...win.map(z => z[3])) - CFG.STOP_BUFFER_ATR * a;
    } else {
        const touched = win.some((z, j) => z[2] >= e21[from + j] - 0.25 * a);
        rsiExt = Math.max(...rw);
        ok = touched && rsiExt >= CFG.RSI_PULL_SHORT && close < o && close < prev[3] && close < e21[n] && close < e50[n];
        stopBase = Math.max(...win.map(z => z[2])) + CFG.STOP_BUFFER_ATR * a;
    }
    if (!ok || body < CFG.MIN_BODY_RATIO) return null;
    if (Math.abs(close - e21[n]) > CFG.MAX_CHASE_ATR * a) return null;

    const entry = close;
    let stop = stopBase, risk = Math.abs(entry - stop);
    if (risk < CFG.MIN_STOP_ATR * a) { risk = CFG.MIN_STOP_ATR * a; stop = entry - dir * risk; }
    if (risk > CFG.MAX_STOP_ATR * a) return null;

    // önde yakın engel (son 100 mumun tepe/dibi) var mı?
    const look = c.slice(n - CFG.ROOM_LOOKBACK, n);
    let roomR = 99;
    if (dir === 1) { const hh = Math.max(...look.map(z => z[2])); if (hh > entry) roomR = (hh - entry) / risk; }
    else { const ll = Math.min(...look.map(z => z[3])); if (ll < entry) roomR = (entry - ll) / risk; }
    if (roomR < CFG.MIN_ROOM_R) return null;

    const vol = c.slice(n - 20, n).reduce((s, z) => s + z[5], 0) / 20;
    const volRatio = vol > 0 ? x[5] / vol : 1;
    const conf = [btcDir === dir, volRatio >= 1.2, dir === 1 ? rsiExt <= 38 : rsiExt >= 62, body >= 0.6, roomR >= 3].filter(Boolean).length;

    return {
        dir, entry, stop, risk, atr: a,
        riskPct: risk / entry * 100,
        tp1: entry + dir * CFG.TP1_R * risk,
        conf, volRatio: +volRatio.toFixed(2), roomR: +Math.min(roomR, 99).toFixed(1),
        candleT: x[0], time: x[0] + H1     // sinyal, tetik mumu kapanınca doğar
    };
}

// Sinyalin sonucu: sig.time'dan sonraki kapanmış mumlarla sıfırdan hesaplanır (durumsuz, hata riski az).
// Aynı mumda stop ve hedef birlikte görülürse STOP sayılır (muhafazakâr).
function resolve(sig, candles) {
    const d = sig.dir, F = CFG.TP1_FRACTION;
    let stop = sig.stop, tp1Hit = false, best = sig.entry;
    const fin = (status, px, t) => {
        const rExit = d * (px - sig.entry) / sig.risk;
        const gross = tp1Hit ? F * CFG.TP1_R + (1 - F) * rExit : rExit;
        const net = gross - CFG.COST_PCT / sig.riskPct;
        return { closed: true, status, tp1Hit, exitPrice: px, grossR: +gross.toFixed(3), netR: +net.toFixed(3), closedAt: t, stop };
    };
    for (const c of candles) {
        if (c[0] < sig.time) continue;
        const o = c[1], h = c[2], l = c[3];
        if (c[0] - sig.time >= CFG.MAX_HOLD_MS) return fin('TIME_EXIT', o, c[0]);
        if (d === 1 ? l <= stop : h >= stop) {
            const px = d === 1 ? Math.min(stop, o) : Math.max(stop, o);
            return fin(tp1Hit ? 'TRAIL_STOP' : 'STOP', px, c[0]);
        }
        if (!tp1Hit && (d === 1 ? h >= sig.tp1 : l <= sig.tp1)) { tp1Hit = true; stop = sig.entry; }
        if (tp1Hit) {
            best = d === 1 ? Math.max(best, h) : Math.min(best, l);
            const t = best - d * CFG.TRAIL_ATR * sig.atr;
            if (d * (t - stop) > 0) stop = t;
        }
    }
    return { closed: false, status: tp1Hit ? 'TP1_HIT' : 'OPEN', tp1Hit, stop };
}


// ---------------- BACKTEST ----------------
const tick = () => new Promise(r => setImmediate(r));
function btRow(name, t) {
    if (!t.length) return { name, n: 0 };
    const r = t.map(x => x.netR), sum = r.reduce((s, x) => s + x, 0);
    const w = r.filter(x => x > 0).reduce((s, x) => s + x, 0), l = -r.filter(x => x <= 0).reduce((s, x) => s + x, 0);
    let peak = 0, cum = 0, dd = 0; for (const x of r) { cum += x; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); }
    return { name, n: t.length, winRate: +(r.filter(x => x > 0).length / r.length * 100).toFixed(1), avgR: +(sum / r.length).toFixed(3),
        totalR: +sum.toFixed(1), pf: l ? +(w / l).toFixed(2) : null, maxDD: +dd.toFixed(1) };
}
async function btHistory(sym, days) {
    let since = Date.now() - days * 24 * H1, all = [], guard = 0;
    while (since < Date.now() - H1 && guard++ < 200) {
        const r = await ex.fetchOHLCV(sym, '1h', since, 200);
        if (!r || !r.length) break;
        const fresh = r.filter(x => !all.length || x[0] > all[all.length - 1][0]);
        if (!fresh.length) break;
        all.push(...fresh); since = fresh[fresh.length - 1][0] + 1;
    }
    return all.filter(x => x[0] + H1 <= Date.now());
}
async function backtestCore(DAYS, TOP, progress = () => {}) {
    if (!Object.keys(ex.markets || {}).length) await ex.loadMarkets();
    const tk = await ex.fetchTickers(undefined, { type: 'swap' });
    const syms = Object.values(tk).filter(t => t.symbol && ex.markets[t.symbol] && ex.markets[t.symbol].swap && ex.markets[t.symbol].quote === 'USDT' && !BAD.includes(t.symbol.split('/')[0]))
        .sort((a, b) => b.quoteVolume - a.quoteVolume).slice(0, TOP).map(t => t.symbol);
    progress('BTC verisi indiriliyor');
    const btc = await btHistory('BTC/USDT:USDT', DAYS + 45);
    const btcDirMap = new Map();
    for (let i = 900; i < btc.length; i++) { btcDirMap.set(btc[i][0], trend4h(btc.slice(Math.max(0, i - 999), i + 1))); if (i % 60 === 0) await tick(); }
    let trades = []; const startT = Date.now() - DAYS * 24 * H1;
    for (let k = 0; k < syms.length; k++) {
        const s = syms[k]; progress(`${k + 1}/${syms.length} ${s.replace(':USDT', '')}`);
        const c = await btHistory(s, DAYS + 45);
        let i = 900;
        while (i < c.length - 2) {
            if (i % 40 === 0) await tick();
            if (c[i][0] < startT) { i++; continue; }
            const sig = evaluate(c.slice(Math.max(0, i - 999), i + 1), btcDirMap.get(c[i][0]) || 0);
            if (!sig) { i++; continue; }
            const res = resolve(sig, c.slice(i + 1));
            if (!res.closed) break;
            trades.push({ symbol: s, dir: sig.dir, conf: sig.conf, t: sig.time, closedAt: res.closedAt, netR: res.netR });
            let j = i + 1; while (j < c.length && c[j][0] < res.closedAt) j++;   // aynı coinde işlem bitmeden yenisi açılmaz
            i = Math.max(j, i + 1);
        }
    }
    trades.sort((a, b) => a.t - b.t);
    const raw = trades.length, openNow = [], taken = [];
    for (const tr of trades) {                          // canlıdaki portföy limiti: aynı yönde en fazla MAX_OPEN_PER_DIR
        for (let k = openNow.length - 1; k >= 0; k--) if (openNow[k].closedAt <= tr.t) openNow.splice(k, 1);
        if (openNow.filter(o => o.dir === tr.dir).length >= L.MAX_OPEN_PER_DIR) continue;
        openNow.push(tr); taken.push(tr);
    }
    const cut = Math.floor(taken.length * 0.7), test = taken.slice(cut);
    const rows = [btRow('TÜMÜ', taken), btRow('ÖĞRENME (ilk %70)', taken.slice(0, cut)), btRow('TEST (son %30)', test),
        btRow('LONG', taken.filter(t => t.dir === 1)), btRow('SHORT', taken.filter(t => t.dir === -1))];
    for (let k = 0; k <= 5; k++) rows.push(btRow(`uyum ${k}/5`, taken.filter(t => t.conf === k)));
    const tr = rows[2];
    const verdict = tr.n < 100 ? `TEST bölümünde yalnızca ${tr.n} işlem var: sonuç için örnek az, güvenme.`
        : tr.avgR > 0 ? `TEST bölümü pozitif (ort ${tr.avgR}R, ${tr.n} işlem). Umut verici ama gerçek sonuç garantisi değil; önce izleyerek doğrula.`
        : `TEST bölümü negatif (ort ${tr.avgR}R). Bu ayarlarla stratejiye güvenme.`;
    return { days: DAYS, coins: syms.length, cost: CFG.COST_PCT, raw, taken: taken.length, rows, verdict };
}
async function runBacktest() {
    const res = await backtestCore(Number(process.argv[3] || 365), Number(process.argv[4] || 25), m => console.log(m));
    console.log(`\nham ${res.raw}, limit sonrası ${res.taken}, maliyet %${res.cost}\n`);
    for (const r of res.rows) console.log(r.n ? `${r.name.padEnd(20)} n=${r.n} kazanma=%${r.winRate} ort=${r.avgR}R toplam=${r.totalR}R PF=${r.pf} maxDD=${r.maxDD}R` : `${r.name.padEnd(20)} işlem yok`);
    console.log('\n' + res.verdict);
}

// ---------------- SUNUCU ----------------

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'signals.json');
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '', TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const L = {
    UNIVERSE: 30, MAX_OPEN_PER_DIR: 3, COOLDOWN_MS: 12 * H1,
    MAX_SIGNAL_AGE_MS: 15 * 60 * 1000,      // tetik mumu kapanalı 15 dk geçtiyse sinyal üretme
    TRACK_MS: 60 * 1000, UNIVERSE_MS: 60 * 60 * 1000, KEEP: 150
};
const BAD = ['USDC', 'USDT', 'DAI', 'TUSD', 'BUSD', 'FDUSD', 'WBTC', 'WETH', 'WSTETH', 'STETH'];

const app = express(); app.use(cors()); app.use(express.json());
const ex = new ccxt.bitget({ enableRateLimit: true, options: { defaultType: 'swap' } });

let market = {}, ethDirNow = 0, btcDirNow = 0, bt = { running: false, progress: '', result: null, error: null };
let universe = [], signals = [], prices = {}, lastScanHour = 0, scanning = false, lastScanInfo = 'henüz taranmadı';
const log = (...a) => console.log(new Date().toISOString(), ...a);
const isOpen = s => s.status === 'OPEN' || s.status === 'TP1_HIT';
const num = (v, d = 6) => Number(Number(v).toPrecision(d + 2));

function load() { try { if (fs.existsSync(STATE_FILE)) signals = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { log('load', e.message); } }
function save() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(signals)); fs.renameSync(STATE_FILE + '.tmp', STATE_FILE); } catch (e) { log('save', e.message); } }
async function notify(t) {
    if (!TG_TOKEN || !TG_CHAT) return;
    try { await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: TG_CHAT, text: t, disable_web_page_preview: true }) }); } catch (e) { log('tg', e.message); }
}
function chartCandles(c) {
    const cl = c.map(x => x[4]), e21 = emaSeries(cl, 21), e50 = emaSeries(cl, 50), from = c.length - 60;
    return c.slice(from).map((x, j) => ({ t: x[0], o: x[1], h: x[2], l: x[3], c: x[4], e21: e21[from + j], e50: e50[from + j] }));
}
const closedOnly = (r, tfMs) => (r || []).filter(c => c[0] + tfMs <= Date.now());

async function refreshUniverse() {
    try {
        if (!Object.keys(ex.markets || {}).length) await ex.loadMarkets();
        const tk = await ex.fetchTickers(undefined, { type: 'swap' });
        universe = Object.values(tk).filter(t => t.symbol && ex.markets[t.symbol] && ex.markets[t.symbol].swap && ex.markets[t.symbol].quote === 'USDT' && ex.markets[t.symbol].active && !BAD.includes(t.symbol.split('/')[0]))
            .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume)).slice(0, L.UNIVERSE).map(t => t.symbol);
        log(`evren: ${universe.length} coin`);
    } catch (e) { log('universe', e.message); }
}

async function scan() {
    if (scanning || !universe.length) return;
    scanning = true;
    const stat = { taranan: 0, sinyal: 0, sinirDolu: 0, cooldown: 0, hata: 0 };
    try {
        const btc = closedOnly(await ex.fetchOHLCV('BTC/USDT:USDT', '1h', undefined, 1000), H1);
        const btcDir = trend4h(btc); btcDirNow = btcDir;
        try { ethDirNow = trend4h(closedOnly(await ex.fetchOHLCV('ETH/USDT:USDT', '1h', undefined, 1000), H1)); } catch (e) {}
        let idx = 0;
        const worker = async () => {
            while (idx < universe.length) {
                const sym = universe[idx++];
                try {
                    const c = closedOnly(await ex.fetchOHLCV(sym, '1h', undefined, 1000), H1);
                    stat.taranan++;
                    if (!c.length || Date.now() - (c[c.length - 1][0] + H1) > L.MAX_SIGNAL_AGE_MS) continue;
                    const sig = evaluate(c, sym === 'BTC/USDT:USDT' ? 0 : btcDir);
                    if (!sig) continue;
                    const dirTxt = sig.dir === 1 ? 'LONG' : 'SHORT';
                    if (signals.some(s => s.symbol === sym && isOpen(s))) continue;
                    if (signals.some(s => s.symbol === sym && s.direction === dirTxt && Date.now() - s.time < L.COOLDOWN_MS)) { stat.cooldown++; continue; }
                    if (signals.filter(s => isOpen(s) && s.direction === dirTxt).length >= L.MAX_OPEN_PER_DIR) { stat.sinirDolu++; continue; }
                    const s = { id: `${sym.replace(/\W/g, '')}_${dirTxt}_${sig.time}`, symbol: sym, direction: dirTxt, dir: sig.dir,
                        entry: num(sig.entry), stop: num(sig.stop), initialStop: num(sig.stop), tp1: num(sig.tp1), risk: sig.risk, riskPct: +sig.riskPct.toFixed(3), atr: sig.atr,
                        trailDist: num(CFG.TRAIL_ATR * sig.atr), conf: sig.conf, volRatio: sig.volRatio, roomR: sig.roomR, btcDir,
                        time: sig.time, status: 'OPEN', netR: null, candles: chartCandles(c) };
                    signals.unshift(s); stat.sinyal++;
                    notify(`${sig.dir === 1 ? '🟢' : '🔴'} ${sym.replace(':USDT', '')} ${dirTxt} | uyum ${s.conf}/5\nGiriş: ${s.entry}\nStop: ${s.stop} (%${s.riskPct})\nTP1 (%50 kapat, stopu girişe çek): ${s.tp1}\nKalan: ${CFG.TRAIL_ATR}xATR (${s.trailDist}) iz süren stop\nGiriş bölgesi: ${s.entry} ± ${num(0.3 * sig.atr)}. Uzaktaysa kovalama.`);
                    log(`SİNYAL ${dirTxt} ${sym} uyum=${s.conf}`);
                } catch (e) { stat.hata++; }
            }
        };
        await Promise.all([worker(), worker(), worker()]);
        signals = signals.slice(0, L.KEEP); save();
    } catch (e) { log('scan', e.message); }
    lastScanInfo = `${new Date().toISOString()} | taranan ${stat.taranan}, yeni ${stat.sinyal}, limit dolu ${stat.sinirDolu}, bekleme ${stat.cooldown}, hata ${stat.hata}`;
    log('tarama:', lastScanInfo);
    scanning = false;
}

async function track() {
    const open = signals.filter(isOpen);
    if (!open.length) return;
    try { const tk = await ex.fetchTickers(open.map(s => s.symbol)); for (const s of open) if (tk[s.symbol]) prices[s.symbol] = Number(tk[s.symbol].last); } catch (e) {}
    let changed = false;
    for (const s of open) {
        try {
            const raw = closedOnly(await ex.fetchOHLCV(s.symbol, '15m', s.time, 500), 15 * 60 * 1000);
            const r = resolve(s, raw);
            s.after = raw.filter(x => x[0] >= s.time).slice(-96).map(x => x[4]);
            const wasTp1 = s.status === 'TP1_HIT';
            s.status = r.status; s.stop = num(r.stop); s.tp1Hit = r.tp1Hit;
            if (r.tp1Hit && !wasTp1) { changed = true; notify(`💰 ${s.symbol.replace(':USDT', '')} ${s.direction} TP1 vuruldu. %50 kapat, stopu girişe çek. Yeni stop: ${s.stop}`); }
            if (r.closed) {
                s.netR = r.netR; s.grossR = r.grossR; s.closedAt = r.closedAt; s.exitPrice = num(r.exitPrice); changed = true;
                notify(`${r.netR > 0 ? '✅' : '❌'} ${s.symbol.replace(':USDT', '')} ${s.direction} kapandı: ${r.status} | net ${r.netR}R`);
            }
        } catch (e) {}
    }
    if (changed) save();
}

function summarize(list) {
    if (!list.length) return { n: 0 };
    const r = list.map(s => s.netR), sum = r.reduce((a, b) => a + b, 0);
    const w = r.filter(x => x > 0).reduce((a, b) => a + b, 0), l = -r.filter(x => x <= 0).reduce((a, b) => a + b, 0);
    return { n: list.length, winRate: +(r.filter(x => x > 0).length / r.length * 100).toFixed(1), totalR: +sum.toFixed(2), avgR: +(sum / r.length).toFixed(3), profitFactor: l ? +(w / l).toFixed(2) : null };
}
function stats() {
    const closed = signals.filter(s => s.netR != null);
    return { all: summarize(closed), long: summarize(closed.filter(s => s.dir === 1)), short: summarize(closed.filter(s => s.dir === -1)),
        byConf: [0, 1, 2, 3, 4, 5].map(k => ({ conf: k, ...summarize(closed.filter(s => s.conf === k)) })),
        note: 'Net R: komisyon+slippage düşülmüş. Karar için en az 100 kapanmış sinyal gerekir.' };
}
function view() {
    return signals.slice(0, 60).map(s => {
        const { candles, after, ...rest } = s; const p = prices[s.symbol], o = { ...rest, price: p || null };
        if (p && s.status === 'OPEN') {
            const moved = s.dir * (p - s.entry) / s.atr;
            o.entryHint = moved > 0.5 ? 'Fiyat uzaklaştı, kovalama' : moved < -0.3 ? 'Girişin altında/üstünde, stopa yakın' : 'Giriş bölgesinde';
        }
        if (p) o.pnlR = +(s.dir * (p - s.entry) / s.risk).toFixed(2);
        return o;
    });
}

function dailyR() { const d0 = new Date(); d0.setUTCHours(0, 0, 0, 0); return +signals.filter(s => s.netR != null && s.closedAt >= d0.getTime()).reduce((a, s) => a + s.netR, 0).toFixed(2); }
async function refreshMarket() {
    try {
        const tk = await ex.fetchTickers(['BTC/USDT:USDT', 'ETH/USDT:USDT']);
        const m = x => ({ price: x ? Number(x.last) : null, chg: x && x.percentage != null ? +Number(x.percentage).toFixed(2) : null });
        market = { btc: { ...m(tk['BTC/USDT:USDT']), dir: btcDirNow }, eth: { ...m(tk['ETH/USDT:USDT']), dir: ethDirNow }, at: Date.now() };
    } catch (e) {}
}
app.get('/api/signals', (q, r) => r.json({ success: true, signals: view(), stats: stats(), scan: lastScanInfo, universe: universe.length, market, daily: dailyR() }));
app.get('/api/signal/:id', (q, r) => { const s = signals.find(x => x.id === q.params.id); r.json(s ? { success: true, signal: { ...s, price: prices[s.symbol] || null } } : { success: false }); });
app.get('/api/backtest', (q, r) => r.json({ success: true, ...bt }));
app.post('/api/backtest', (q, r) => {
    if (!bt.running) {
        const days = Math.min(365, Math.max(30, Number((q.body || {}).days) || 180)), top = Math.min(30, Math.max(5, Number((q.body || {}).top) || 15));
        bt = { running: true, progress: 'Başlıyor', result: null, error: null };
        backtestCore(days, top, m => { bt.progress = m; }).then(res => { bt.result = res; bt.running = false; bt.progress = 'Bitti'; }).catch(e => { bt.error = e.message; bt.running = false; });
    }
    r.json({ success: true, ...bt });
});
app.get('/api/stats', (q, r) => r.json({ success: true, ...stats() }));
app.get('/api/history', (q, r) => r.json({ success: true, history: signals.filter(s => s.netR != null) }));
app.get('/api/health', (q, r) => r.json({ ok: true, universe: universe.length, signals: signals.length, lastScan: lastScanInfo }));
app.get('/', (q, r) => r.type('html').send(HTML));

const HTML = `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TREND SİNYAL</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0e14;color:#e9eef5;font-family:-apple-system,Arial,sans-serif;font-size:13px;line-height:1.4;overflow:hidden}
.app{display:flex;flex-direction:column;height:100vh;width:100vw}
.bar{display:flex;align-items:center;justify-content:space-between;padding:8px 16px;background:#0d1219;border-bottom:1px solid #1c2634;gap:12px;flex-wrap:wrap}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.brand{font-size:14px;font-weight:900}.brand span{color:#17d7a0}
.badge{font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px;background:#2a2410;color:#f6c453;margin-left:6px}
.mi{display:flex;align-items:center;gap:6px;padding:5px 10px;background:#0a0e14;border-radius:5px;font-size:11px}
.mi .sym{font-weight:700;color:#8b97a5}.mi b{font-weight:700}
.chg{padding:1px 5px;border-radius:3px;font-weight:700;font-size:10px}
.up{background:rgba(0,255,157,.15);color:#00ff9d}.down{background:rgba(255,56,96,.15);color:#ff3860}.flat{background:#1c2634;color:#8b97a5}
.btn{background:#1a2331;border:1px solid #2c3a4f;color:#e9eef5;padding:7px 12px;border-radius:6px;cursor:pointer;font-size:11px;font-weight:700;font-family:inherit;text-decoration:none}
.btn.pri{background:#17d7a0;border-color:#17d7a0;color:#0a0e14}.btn.tv{background:#2962ff;border-color:#2962ff;color:#fff}
.conn{padding:4px 10px;border-radius:4px;font-size:10px;font-weight:700;background:#1c2634;color:#8b97a5}
.conn.on{background:rgba(0,255,157,.15);color:#00ff9d}.conn.off{background:rgba(255,56,96,.15);color:#ff3860}
.content{display:flex;flex:1;overflow:hidden}
.sidebar{width:390px;background:#0d1219;border-right:1px solid #1c2634;display:flex;flex-direction:column;flex-shrink:0}
.tabs{display:flex;background:#0a0e14;border-bottom:1px solid #1c2634}
.tab{flex:1;padding:12px 4px;text-align:center;cursor:pointer;font-size:10px;font-weight:800;text-transform:uppercase;color:#5e6b7c;background:transparent;border:none;border-bottom:2px solid transparent;font-family:inherit}
.tab.active{color:#00ff9d;border-bottom-color:#00ff9d}
.tab .n{display:inline-block;font-size:9px;padding:1px 5px;border-radius:10px;background:#1c2634;color:#c5cfdd;margin-left:3px}
.tab.active .n{background:#00ff9d;color:#0a0e14}
.list{flex:1;overflow-y:auto;padding:8px}
.list::-webkit-scrollbar{width:6px}.list::-webkit-scrollbar-thumb{background:#2c3a4f;border-radius:3px}
.card{margin-bottom:10px;padding:12px;border-radius:10px;cursor:pointer;background:#0f1620;border:1px solid #1c2634}
.card:hover{background:#141d28}.card.sel{background:#141d28;border-color:#17d7a0;box-shadow:0 0 0 2px rgba(23,215,160,.4)}
.card.L{border-left:4px solid #00ff9d}.card.S{border-left:4px solid #ff3860}.card.done{opacity:.6}
.head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px}
.sym2{font-size:16px;font-weight:900}
.dir{display:inline-block;font-size:13px;font-weight:900;padding:5px 14px;border-radius:6px}
.dir.L{background:#00ff9d;color:#0a0e14}.dir.S{background:#ff3860;color:#fff}
.tags{display:flex;gap:5px;align-items:center;flex-wrap:wrap;margin-bottom:6px}
.tag{display:inline-block;font-size:9px;font-weight:800;padding:3px 8px;border-radius:4px}
.t-open{background:rgba(0,255,157,.2);color:#00ff9d;border:1px solid #00ff9d}.t-tp1{background:#2962ff;color:#fff}
.t-trail{background:#8a5cff;color:#fff}.t-stop{background:#ff3860;color:#fff}.t-time{background:#5e6b7c;color:#fff}
.t-up{background:rgba(0,255,157,.2);color:#00ff9d}.t-dn{background:rgba(255,56,96,.2);color:#ff3860}.t-fl{background:rgba(246,196,83,.2);color:#f6c453}
.t-q{background:rgba(246,196,83,.2);color:#f6c453}
.grid{margin-top:10px;display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:11px}
.gi{display:flex;justify-content:space-between;padding:5px 8px;background:#0a0e14;border-radius:4px}
.gi .k{color:#5e6b7c}.gi .v{font-weight:700;color:#c5cfdd}
.gi.e .v{color:#4a7cff}.gi.s .v{color:#ff3860}.gi.t .v{color:#00ff9d}.gi.r .v{color:#8a5cff}
.price{margin-top:10px;display:flex;justify-content:space-between;align-items:center;padding-top:8px;border-top:1px solid #1c2634}
.price .cur{font-weight:700;font-size:15px}
.pnl{padding:3px 8px;border-radius:4px;font-weight:800;font-size:12px}
.pos{background:rgba(0,255,157,.15);color:#00ff9d}.neg{background:rgba(255,56,96,.15);color:#ff3860}
.hint{margin-top:6px;font-size:11px;color:#f6c453;font-weight:700}
.meta{margin-top:8px;font-size:10px;color:#5e6b7c;display:flex;gap:10px;flex-wrap:wrap}
.main{flex:1;display:flex;flex-direction:column;overflow:hidden;background:#0a0e14}
.pad{padding:20px;overflow-y:auto;flex:1}
.pad h2{font-size:16px;margin-bottom:10px}.pad p{color:#8b97a5;margin-bottom:10px;max-width:640px}
.chead{padding:12px 16px;border-bottom:1px solid #1c2634;display:flex;justify-content:space-between;align-items:center;background:#0d1219;flex-wrap:wrap;gap:10px}
.csym{font-size:20px;font-weight:900}
.cwrap{flex:1;position:relative;background:#070b11;min-height:200px}
#cv{width:100%;height:100%;display:block}
.info{padding:12px 16px;background:#0d1219;border-top:1px solid #1c2634;display:grid;grid-template-columns:repeat(6,1fr);gap:10px}
.ii{display:flex;flex-direction:column;gap:3px;padding:10px;background:#0a0e14;border-radius:6px}
.ii .l{color:#5e6b7c;text-transform:uppercase;font-size:9px;font-weight:700}.ii .v{font-weight:800;font-size:14px}
.plan{padding:10px 16px;background:#0d1219;border-top:1px solid #1c2634;font-size:12px;color:#8b97a5}
table{border-collapse:collapse;width:100%;max-width:640px;font-size:12px;margin-bottom:14px}
td,th{padding:6px 8px;text-align:right;border-bottom:1px solid #1c2634}th:first-child,td:first-child{text-align:left}th{color:#5e6b7c;font-weight:600}
td.p{color:#00ff9d}td.n{color:#ff3860}
select{background:#0a0e14;color:#e9eef5;border:1px solid #2c3a4f;border-radius:6px;padding:7px;font-family:inherit}
.verdict{padding:10px 14px;border-radius:6px;background:#141d28;border:1px solid #2c3a4f;max-width:640px;margin-bottom:14px}
@media(max-width:800px){.content{flex-direction:column}.sidebar{width:100%;height:45%}.info{grid-template-columns:repeat(3,1fr)}body{overflow:auto}.app{height:auto;min-height:100vh}}
</style></head><body><div class="app">
<div class="bar"><div class="row">
<div class="brand">TREND <span>SİNYAL</span><span class="badge">4h TREND • 1h GERİ ÇEKİLME</span></div>
<div class="mi"><span class="sym">BTC</span><b id="btcP">-</b><span class="chg flat" id="btcC">-</span><span class="chg flat" id="btcT">-</span></div>
<div class="mi"><span class="sym">ETH</span><b id="ethP">-</b><span class="chg flat" id="ethC">-</span><span class="chg flat" id="ethT">-</span></div>
<div class="mi"><span class="sym">SONUÇ</span><b id="perf">-</b></div>
<div class="mi"><span class="sym">GÜNLÜK</span><b id="daily">-</b></div>
</div><div class="row"><button class="btn" id="btBtn">🧪 Backtest</button><div class="conn" id="conn">Bağlanıyor</div></div></div>
<div class="content"><div class="sidebar">
<div class="tabs"><button class="tab active" id="tA">🎯 AÇIK <span class="n" id="nA">0</span></button><button class="tab" id="tC">📁 KAPANAN <span class="n" id="nC">0</span></button></div>
<div class="list" id="list"></div></div>
<div class="main">
<div class="pad" id="vEmpty"></div>
<div id="vChart" style="display:none;flex-direction:column;flex:1;min-height:0">
<div class="chead"><div class="row"><div class="csym" id="cSym">-</div><span id="cDir"></span><span id="cTags"></span></div><a class="btn tv" id="tv" target="_blank">📈 TradingView</a></div>
<div class="cwrap"><canvas id="cv"></canvas></div>
<div class="plan" id="plan"></div>
<div class="info">
<div class="ii"><div class="l">Giriş</div><div class="v" style="color:#4a7cff" id="iE">-</div></div>
<div class="ii"><div class="l">Stop</div><div class="v" style="color:#ff3860" id="iS">-</div></div>
<div class="ii"><div class="l">TP1</div><div class="v" style="color:#00ff9d" id="iT">-</div></div>
<div class="ii"><div class="l">İz süren mesafe</div><div class="v" style="color:#8a5cff" id="iR">-</div></div>
<div class="ii"><div class="l">Stop uzaklığı</div><div class="v" style="color:#f6c453" id="iP">-</div></div>
<div class="ii"><div class="l">Uyum</div><div class="v" id="iQ">-</div></div>
</div></div>
<div class="pad" id="vBt" style="display:none"></div>
</div></div></div>
<script>
var D={signals:[],market:null,stats:null,daily:0},sel=null,tab="open",view="main",detail={},btPoll=null;
function fmt(v){v=Number(v);if(!isFinite(v))return"-";return v>=1000?v.toFixed(2):v>=100?v.toFixed(3):v>=1?v.toFixed(4):v.toFixed(6)}
function isOpen(s){return s.status==="OPEN"||s.status==="TP1_HIT"}
function ago(t){var m=Math.floor((Date.now()-t)/60000);return m<60?m+" dk":Math.floor(m/60)+" sa"}
function $(i){return document.getElementById(i)}
var ST={OPEN:["t-open","● AÇIK"],TP1_HIT:["t-tp1","✓ TP1"],STOP:["t-stop","✗ STOP"],TRAIL_STOP:["t-trail","↗ İZ SÜREN"],TIME_EXIT:["t-time","⏱ SÜRE"]};
function stag(s){var x=ST[s.status]||["",""];return '<span class="tag '+x[0]+'">'+x[1]+'</span>'}
function ttag(d){return d===1?'<span class="tag t-up">4h ⬆</span>':d===-1?'<span class="tag t-dn">4h ⬇</span>':'<span class="tag t-fl">4h ⬌</span>'}
function card(s){var c=s.dir===1?"L":"S",v=s.netR!=null?s.netR:s.pnlR,o=isOpen(s);
var pill=v!=null?'<span class="pnl '+(v>=0?"pos":"neg")+'">'+(v>0?"+":"")+v+"R</span>":"";
return '<div class="card '+c+(s.id===sel?" sel":"")+(o?"":" done")+'" data-id="'+s.id+'">'
+'<div class="head"><div class="sym2">'+s.symbol.replace(":USDT","")+'</div><div class="dir '+c+'">'+s.direction+'</div></div>'
+'<div class="tags">'+stag(s)+ttag(s.dir)+'<span class="tag t-q">Uyum '+s.conf+'/5</span></div>'
+'<div class="grid"><div class="gi e"><span class="k">Giriş</span><span class="v">'+fmt(s.entry)+'</span></div>'
+'<div class="gi s"><span class="k">'+(s.tp1Hit?"İz süren":"Stop")+'</span><span class="v">'+fmt(s.stop)+'</span></div>'
+'<div class="gi t"><span class="k">TP1</span><span class="v">'+fmt(s.tp1)+'</span></div>'
+'<div class="gi r"><span class="k">Stop %</span><span class="v">'+s.riskPct+'</span></div></div>'
+'<div class="price"><span class="cur">'+fmt(s.price||s.entry)+'</span>'+pill+'</div>'
+(o&&s.entryHint?'<div class="hint">'+s.entryHint+'</div>':'')
+'<div class="meta"><span>📊 '+s.volRatio+'x hacim</span><span>🚧 önü '+(s.roomR>=99?"açık":s.roomR+"R")+'</span><span>⏱ '+ago(s.time)+'</span></div></div>'}
function renderList(){var el=$("list"),st=el.scrollTop;var a=D.signals.filter(isOpen),c=D.signals.filter(function(s){return!isOpen(s)});
$("nA").textContent=a.length;$("nC").textContent=c.length;
var L=tab==="open"?a:c;
el.innerHTML=L.length?L.map(card).join(""):'<div style="padding:30px 12px;text-align:center;color:#5e6b7c;line-height:1.8">'+(tab==="open"?"Şu an açık sinyal yok.<br>Günde 0-3 sinyal normal.<br>Tarama her saat başı yapılır.":"Henüz kapanan sinyal yok.")+"</div>";
el.scrollTop=st;
Array.prototype.forEach.call(el.querySelectorAll(".card"),function(e){e.onclick=function(){sel=e.getAttribute("data-id");view="main";renderList();renderMain();loadDetail()}})}
function row(n,x){if(!x||!x.n)return"<tr><td>"+n+'</td><td colspan="4">-</td></tr>';return"<tr><td>"+n+"</td><td>"+x.n+"</td><td>%"+x.winRate+"</td><td class="+(x.avgR>0?"p":"n")+">"+x.avgR+"</td><td class="+(x.totalR>0?"p":"n")+">"+x.totalR+"</td></tr>"}
var TH="<tr><th></th><th>n</th><th>kazanma</th><th>ort R</th><th>toplam R</th></tr>";
function renderEmpty(){var s=D.stats;if(!s)return;
$("vEmpty").innerHTML='<h2>Nasıl kullanılır</h2><p>Soldan bir sinyal seç. Grafikte giriş (mavi), stop (kırmızı), TP1 (yeşil) görürsün. Kartta "Fiyat uzaklaştı" yazıyorsa girme.</p><p>Kural: riskin hesabının %0.5\\'i. Miktar = risk ÷ (giriş − stop). Stop\\'u hemen borsaya gir. TP1\\'de yarısını kapat, stopu girişe çek, kalanı iz süren stopla sür.</p><h2>Sonuçlar (maliyet düşülmüş)</h2><table>'+TH+row("Tümü",s.all)+row("Long",s.long)+row("Short",s.short)+"</table>"+(s.all.n<100?"<p>"+s.all.n+"/100 sinyal. Bu sayıdan önce sonuçlara güvenme.</p>":"")+"<h2>Uyum skoru</h2><table>"+TH+s.byConf.map(function(x){return row(x.conf+"/5",x)}).join("")+"</table>"}
function renderMain(){var show=function(id,d){$(id).style.display=d};
show("vBt",view==="bt"?"block":"none");
var s=sel&&D.signals.filter(function(x){return x.id===sel})[0];
if(view==="bt"){show("vEmpty","none");show("vChart","none");return}
if(!s){show("vEmpty","block");show("vChart","none");renderEmpty();return}
show("vEmpty","none");show("vChart","flex");
var c=s.dir===1?"L":"S";
$("cSym").textContent=s.symbol.replace(":USDT","");$("cDir").innerHTML='<span class="dir '+c+'">'+s.direction+"</span>";
$("cTags").innerHTML=stag(s)+ttag(s.dir)+'<span class="tag t-q">Uyum '+s.conf+"/5</span>";
$("tv").href="https://www.tradingview.com/chart/?symbol=BITGET:"+s.symbol.replace("/USDT:USDT","USDT.P")+"&interval=60";
$("iE").textContent=fmt(s.entry);$("iS").textContent=fmt(s.tp1Hit?s.stop:s.initialStop);$("iT").textContent=fmt(s.tp1);
$("iR").textContent=fmt(s.trailDist);$("iP").textContent="%"+s.riskPct;$("iQ").textContent=s.conf+"/5";
$("plan").textContent=s.tp1Hit?"TP1 alındı. Kalan yarıyı iz süren stopla sür: stop tepenin/dibin "+fmt(s.trailDist)+" gerisinde, sadece kâr yönünde ilerler.":"Plan: TP1'de yarısını kapat, stopu girişe çek. Kalanı "+fmt(s.trailDist)+" mesafeli iz süren stopla sür. Giriş bölgesi: giriş ± yarım ATR. Uzaktaysa kovalama.";
var d=detail[s.id];if(d)setTimeout(function(){draw(Object.assign({},d,s))},20)}
function loadDetail(){if(!sel)return;fetch("/api/signal/"+encodeURIComponent(sel)).then(function(r){return r.json()}).then(function(r){if(r.signal){detail[sel]=r.signal;renderMain()}})}
function draw(s){var cv=$("cv"),p=cv.parentElement,W=p.clientWidth,H=p.clientHeight,dpr=window.devicePixelRatio||1;
cv.width=W*dpr;cv.height=H*dpr;cv.style.width=W+"px";cv.style.height=H+"px";
var x=cv.getContext("2d");x.setTransform(dpr,0,0,dpr,0,0);x.fillStyle=s.dir===1?"#08120d":"#12080c";x.fillRect(0,0,W,H);
var cs=s.candles;if(!cs||!cs.length)return;
var af=[];if(s.after&&s.after.length){var k=Math.ceil(s.after.length/24);for(var i=0;i<s.after.length;i+=k)af.push(s.after[i])}
var total=cs.length+24,mn=1e99,mx=-1e99;
cs.forEach(function(c){mn=Math.min(mn,c.l);mx=Math.max(mx,c.h)});
var lv=[["TP1",s.tp1,"#00ff9d",[4,4]],["STOP",s.initialStop,"#ff3860",[6,3]],["GİRİŞ",s.entry,"#2962ff",[]]];
if(s.tp1Hit)lv.push(["İZ",s.stop,"#8a5cff",[4,4]]);
lv.forEach(function(l){mn=Math.min(mn,l[1]);mx=Math.max(mx,l[1])});af.forEach(function(v){mn=Math.min(mn,v);mx=Math.max(mx,v)});
var pad=(mx-mn)*.06||1;mn-=pad;mx+=pad;
var LEFT=130,RIGHT=20,TOP=30,BOT=30,PW=W-LEFT-RIGHT,PH=H-TOP-BOT;
function X(i){return LEFT+i*PW/(total-1)}function Y(v){return TOP+(mx-v)/(mx-mn)*PH}
x.strokeStyle="rgba(255,255,255,.05)";x.lineWidth=1;for(var g=0;g<=5;g++){var yy=TOP+PH*g/5;x.beginPath();x.moveTo(LEFT,yy);x.lineTo(W-RIGHT,yy);x.stroke()}
[["e50","#8b97a5"],["e21","#f6c453"]].forEach(function(e){x.strokeStyle=e[1];x.lineWidth=1.2;x.beginPath();var st=false;cs.forEach(function(c,i){if(c[e[0]]==null)return;if(!st){x.moveTo(X(i),Y(c[e[0]]));st=true}else x.lineTo(X(i),Y(c[e[0]]))});x.stroke()});
lv.forEach(function(l){x.save();x.strokeStyle=l[2];x.lineWidth=2;if(l[3].length)x.setLineDash(l[3]);x.beginPath();x.moveTo(LEFT,Y(l[1]));x.lineTo(W-RIGHT,Y(l[1]));x.stroke();x.restore()});
var ls=lv.map(function(l){return{t:l[0]+" "+fmt(l[1]),c:l[2],y:Y(l[1])}}).sort(function(a,b){return a.y-b.y}),py=-100;
ls.forEach(function(l){l.ly=Math.max(l.y,py+14);py=l.ly;x.fillStyle=l.c;x.font="bold 12px Arial";x.textAlign="right";x.fillText(l.t,LEFT-10,l.ly+4)});
var cw=Math.max(3,Math.min(14,PW/total*.7));
cs.forEach(function(c,i){var col=c.c>=c.o?"#00ff9d":"#ff3860";x.strokeStyle=col;x.fillStyle=col;x.beginPath();x.moveTo(X(i),Y(c.h));x.lineTo(X(i),Y(c.l));x.stroke();var a=Y(c.o),b=Y(c.c);x.fillRect(X(i)-cw/2,Math.min(a,b),cw,Math.max(1,Math.abs(b-a)))});
var x0=X(cs.length-1)+cw;x.save();x.strokeStyle="#5e6b7c";x.setLineDash([2,3]);x.beginPath();x.moveTo(x0,TOP);x.lineTo(x0,H-BOT);x.stroke();x.restore();
x.fillStyle="#5e6b7c";x.font="10px Arial";x.textAlign="left";x.fillText("sinyal ▸ sonrası (15dk kapanışlar)",x0+4,TOP+10);
if(af.length){x.strokeStyle="#e9eef5";x.lineWidth=1.8;x.beginPath();af.forEach(function(v,i){var px=x0+(i+1)*(W-RIGHT-x0)/25;i?x.lineTo(px,Y(v)):x.moveTo(px,Y(v))});x.stroke()}
if(s.price){x.save();x.strokeStyle="#f6c453";x.lineWidth=1.5;x.beginPath();x.moveTo(LEFT,Y(s.price));x.lineTo(W-RIGHT,Y(s.price));x.stroke();x.restore()}}
function mk(m,k){if(!m||!m[k])return;var b=m[k],p=k==="btc"?"btc":"eth";$(p+"P").textContent=fmt(b.price);
var c=$(p+"C");if(b.chg!=null){c.textContent=(b.chg>=0?"+":"")+b.chg+"%";c.className="chg "+(b.chg>=0?"up":"down")}
var t=$(p+"T");t.textContent=b.dir===1?"4h ⬆":b.dir===-1?"4h ⬇":"4h ⬌";t.className="chg "+(b.dir===1?"up":b.dir===-1?"down":"flat")}
function apply(d){D=d;var a=d.stats.all;mk(d.market,"btc");mk(d.market,"eth");
$("perf").textContent=a.n?a.n+" işlem • "+(a.totalR>=0?"+":"")+a.totalR+"R":"-";
var dl=$("daily");dl.textContent=(d.daily>=0?"+":"")+d.daily+"R";dl.style.color=d.daily<0?"#ff3860":"#00ff9d";
document.title=(d.signals.filter(isOpen).length?"("+d.signals.filter(isOpen).length+") ":"")+"TREND SİNYAL";
renderList();renderMain();if(sel&&detail[sel])loadDetail()}
function load(){fetch("/api/signals?t="+Date.now(),{cache:"no-store"}).then(function(r){return r.json()}).then(function(d){$("conn").className="conn on";$("conn").textContent="Bağlı";apply(d)}).catch(function(){$("conn").className="conn off";$("conn").textContent="Bağlantı yok"})}
$("tA").onclick=function(){tab="open";$("tA").className="tab active";$("tC").className="tab";renderList()};
$("tC").onclick=function(){tab="closed";$("tC").className="tab active";$("tA").className="tab";renderList()};
$("btBtn").onclick=function(){view=view==="bt"?"main":"bt";renderMain();if(view==="bt")btLoad()};
function btLoad(){fetch("/api/backtest").then(function(r){return r.json()}).then(function(d){renderBt(d);if(d.running&&!btPoll)btPoll=setInterval(btLoad,3000);if(!d.running&&btPoll){clearInterval(btPoll);btPoll=null}})}
function btStart(){fetch("/api/backtest",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({days:+$("btD").value,top:+$("btT").value})}).then(btLoad)}
function renderBt(d){var h='<h2>🧪 Backtest</h2><p>Aynı stratejiyi geçmiş veride, komisyon ve slippage dahil çalıştırır. <b>TEST</b> satırı en önemlisi: strateji o bölümü hiç görmeden ayarlandı. Bu satırda ortalama R pozitif ve işlem sayısı 100+ değilse stratejiye güvenme.</p>'
+'<div class="row" style="margin-bottom:14px"><select id="btD"><option value="90">90 gün</option><option value="180" selected>180 gün</option><option value="365">365 gün</option></select><select id="btT"><option value="10">10 coin</option><option value="15" selected>15 coin</option><option value="25">25 coin</option></select><button class="btn pri" id="btGo"'+(d.running?" disabled":"")+">"+(d.running?"Çalışıyor...":"Başlat")+'</button></div>';
if(d.running)h+="<p>⏳ "+d.progress+" (birkaç dakika sürebilir, sayfayı kapatabilirsin)</p>";
if(d.error)h+='<p style="color:#ff3860">Hata: '+d.error+"</p>";
if(d.result){var r=d.result;h+='<div class="verdict">'+r.verdict+'</div><p>'+r.days+" gün, "+r.coins+" coin, maliyet %"+r.cost+". Ham sinyal "+r.raw+", portföy limitinden sonra "+r.taken+".</p><table><tr><th></th><th>n</th><th>kazanma</th><th>ort R</th><th>toplam R</th><th>PF</th><th>maxDD</th></tr>"
+r.rows.map(function(x){return x.n?"<tr><td>"+x.name+"</td><td>"+x.n+"</td><td>%"+x.winRate+"</td><td class="+(x.avgR>0?"p":"n")+">"+x.avgR+"</td><td class="+(x.totalR>0?"p":"n")+">"+x.totalR+"</td><td>"+x.pf+"</td><td>"+x.maxDD+"</td></tr>":"<tr><td>"+x.name+'</td><td colspan="6">işlem yok</td></tr>'}).join("")+"</table>"}
$("vBt").innerHTML=h;if($("btGo"))$("btGo").onclick=btStart}
window.addEventListener("resize",function(){if(sel&&detail[sel]&&view==="main")renderMain()});
load();setInterval(load,15000);
</script></body></html>`;

async function start() {
    load(); await ex.loadMarkets(); await refreshUniverse();
    setInterval(refreshUniverse, L.UNIVERSE_MS);
    setInterval(track, L.TRACK_MS);
    setInterval(refreshMarket, 30000); refreshMarket();
    setInterval(() => {                      // her saat kapanışından 20 sn sonra bir kez tara
        const h = Math.floor((Date.now() - 20000) / H1);
        if (h > lastScanHour) { lastScanHour = h; scan(); }
    }, 10000);
    lastScanHour = Math.floor((Date.now() - 20000) / H1); scan();
    log('hazır');
}

if (process.argv[2] === 'backtest') {
    runBacktest().catch(e => { console.error(e); process.exit(1); });
} else {
    process.on('uncaughtException', e => log('uncaught', e.message));
    process.on('unhandledRejection', e => log('unhandled', e && e.message));
    app.listen(PORT, '0.0.0.0', () => { log('PORT', PORT); start().catch(e => log('start', e.message)); });

}
