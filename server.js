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
const DAYS = Number(process.argv[3] || 365), TOP = Number(process.argv[4] || 25);

async function history(sym, days) {
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
const pf = a => { const w = a.filter(x => x > 0).reduce((s, x) => s + x, 0), l = -a.filter(x => x <= 0).reduce((s, x) => s + x, 0); return l ? +(w / l).toFixed(2) : Infinity; };
function report(name, t) {
    if (!t.length) return console.log(`${name.padEnd(22)} işlem yok`);
    const r = t.map(x => x.netR), sum = r.reduce((s, x) => s + x, 0);
    let peak = 0, cum = 0, dd = 0; for (const x of r) { cum += x; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); }
    console.log(`${name.padEnd(22)} n=${String(t.length).padEnd(4)} kazanma=%${(r.filter(x => x > 0).length / r.length * 100).toFixed(1).padEnd(5)} ort=${(sum / r.length).toFixed(3)}R toplam=${sum.toFixed(1)}R PF=${pf(r)} maxDD=${dd.toFixed(1)}R`);
}

async function runBacktest() {
    await ex.loadMarkets();
    const tk = await ex.fetchTickers(undefined, { type: 'swap' });
    const syms = Object.values(tk).filter(t => t.symbol && ex.markets[t.symbol] && ex.markets[t.symbol].swap && ex.markets[t.symbol].quote === 'USDT' && !BAD.includes(t.symbol.split('/')[0]))
        .sort((a, b) => b.quoteVolume - a.quoteVolume).slice(0, TOP).map(t => t.symbol);
    console.log(`${syms.length} coin, ${DAYS} gün, maliyet %${CFG.COST_PCT}`);

    const btc = await history('BTC/USDT:USDT', DAYS + 45);
    const btcDir = new Map();                                   // her BTC mumu için 4h trend (bir kez hesaplanır)
    for (let i = 900; i < btc.length; i++) btcDir.set(btc[i][0], trend4h(btc.slice(i - 999 < 0 ? 0 : i - 999, i + 1)));

    let trades = []; const startT = Date.now() - DAYS * 24 * H1;
    for (const s of syms) {
        const c = await history(s, DAYS + 45);
        let i = 900;
        while (i < c.length - 2) {
            if (c[i][0] < startT) { i++; continue; }
            const sig = evaluate(c.slice(Math.max(0, i - 999), i + 1), btcDir.get(c[i][0]) || 0);
            if (!sig) { i++; continue; }
            const res = resolve(sig, c.slice(i + 1));
            if (!res.closed) break;
            trades.push({ symbol: s, dir: sig.dir, conf: sig.conf, t: sig.time, closedAt: res.closedAt, netR: res.netR });
            i = c.findIndex(x => x[0] === res.closedAt);        // aynı coinde işlem bitmeden yenisi açılmaz
            if (i < 0) break;
        }
        process.stdout.write('.');
    }
    trades.sort((a, b) => a.t - b.t);
    // Canlıdaki portföy kuralı: aynı yönde aynı anda en fazla L.MAX_OPEN_PER_DIR açık sinyal
    const openNow = [], taken = [];
    for (const tr of trades) {
        for (let k = openNow.length - 1; k >= 0; k--) if (openNow[k].closedAt <= tr.t) openNow.splice(k, 1);
        if (openNow.filter(o => o.dir === tr.dir).length >= L.MAX_OPEN_PER_DIR) continue;
        openNow.push(tr); taken.push(tr);
    }
    console.log(`\nham sinyal ${trades.length}, portföy limitinden sonra ${taken.length}`);
    trades = taken;
    const cut = Math.floor(trades.length * 0.7);
    console.log('\n');
    report('TÜMÜ', trades);
    report('ÖĞRENME (ilk %70)', trades.slice(0, cut));
    report('TEST (son %30)', trades.slice(cut));
    report('LONG', trades.filter(t => t.dir === 1));
    report('SHORT', trades.filter(t => t.dir === -1));
    for (let k = 0; k <= 5; k++) report(`confluence ${k}`, trades.filter(t => t.conf === k));
    console.log('\nKarar kuralı: TEST bölümünde ort > 0 ve n >= 100 değilse bu strateji henüz güvenilir değil.');
}

// ---------------- SUNUCU ----------------

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'signals.json');
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '', TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const L = {
    UNIVERSE: 30, MAX_OPEN_PER_DIR: 3, COOLDOWN_MS: 12 * H1,
    MAX_SIGNAL_AGE_MS: 15 * 60 * 1000,      // tetik mumu kapanalı 15 dk geçtiyse sinyal üretme
    TRACK_MS: 60 * 1000, UNIVERSE_MS: 60 * 60 * 1000, KEEP: 300
};
const BAD = ['USDC', 'USDT', 'DAI', 'TUSD', 'BUSD', 'FDUSD', 'WBTC', 'WETH', 'WSTETH', 'STETH'];

const app = express(); app.use(cors()); app.use(express.json());
const ex = new ccxt.bitget({ enableRateLimit: true, options: { defaultType: 'swap' } });

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
        const btcDir = trend4h(btc);
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
                        entry: num(sig.entry), stop: num(sig.stop), tp1: num(sig.tp1), risk: sig.risk, riskPct: +sig.riskPct.toFixed(3), atr: sig.atr,
                        trailDist: num(CFG.TRAIL_ATR * sig.atr), conf: sig.conf, volRatio: sig.volRatio, roomR: sig.roomR, btcDir,
                        time: sig.time, status: 'OPEN', netR: null };
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
        const p = prices[s.symbol], o = { ...s, price: p || null };
        if (p && s.status === 'OPEN') {
            const moved = s.dir * (p - s.entry) / s.atr;
            o.entryHint = moved > 0.5 ? 'Fiyat uzaklaştı, kovalama' : moved < -0.3 ? 'Girişin altında/üstünde, stopa yakın' : 'Giriş bölgesinde';
        }
        if (p) o.pnlR = +(s.dir * (p - s.entry) / s.risk).toFixed(2);
        return o;
    });
}

app.get('/api/signals', (q, r) => r.json({ success: true, signals: view(), stats: stats(), scan: lastScanInfo, universe: universe.length }));
app.get('/api/stats', (q, r) => r.json({ success: true, ...stats() }));
app.get('/api/history', (q, r) => r.json({ success: true, history: signals.filter(s => s.netR != null) }));
app.get('/api/health', (q, r) => r.json({ ok: true, universe: universe.length, signals: signals.length, lastScan: lastScanInfo }));
app.get('/', (q, r) => r.type('html').send(HTML));

const HTML = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Trend Sinyalleri</title>
<style>
:root{--bg:#f3f1ec;--ink:#1d2320;--mute:#6b736e;--line:#d9d5cb;--card:#fbfaf7;--long:#1f6f54;--short:#a3362f;--warn:#8a6a12}
@media(prefers-color-scheme:dark){:root{--bg:#141816;--ink:#e6e9e4;--mute:#8d968f;--line:#2a312d;--card:#1a1f1c;--long:#4fc99a;--short:#f0796f;--warn:#e2b84a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 "IBM Plex Sans",system-ui,sans-serif}
header{padding:18px 20px;border-bottom:1px solid var(--line);display:flex;flex-wrap:wrap;gap:8px 24px;align-items:baseline}
h1{font:600 20px "IBM Plex Serif",Georgia,serif;margin:0}.sub{color:var(--mute);font-size:12px}
main{display:grid;grid-template-columns:minmax(0,1fr);gap:16px;padding:16px 20px;max-width:1100px;margin:auto}
@media(min-width:900px){main{grid-template-columns:minmax(0,1fr) 300px}}
.card{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:14px;margin-bottom:12px}
.card.L{border-left:4px solid var(--long)}.card.S{border-left:4px solid var(--short)}.card.done{opacity:.6}
.top{display:flex;justify-content:space-between;align-items:baseline;gap:8px}.sym{font:600 17px "IBM Plex Serif",Georgia,serif}
.dir.L{color:var(--long)}.dir.S{color:var(--short)}.dir{font-weight:700}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:6px 14px;margin:10px 0;font-variant-numeric:tabular-nums}
.grid b{display:block;font-size:11px;color:var(--mute);font-weight:500}
.hint{font-size:12px;color:var(--warn)}.meta{font-size:12px;color:var(--mute)}
.plan{font-size:12px;border-top:1px dashed var(--line);margin-top:8px;padding-top:8px;color:var(--mute)}
h2{font:600 14px "IBM Plex Serif",Georgia,serif;margin:0 0 8px}table{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}
td,th{padding:4px 2px;text-align:right;border-bottom:1px solid var(--line)}th:first-child,td:first-child{text-align:left}th{color:var(--mute);font-weight:500}
.pos{color:var(--long)}.neg{color:var(--short)}a{color:inherit}.empty{color:var(--mute);padding:24px 0}
</style></head><body>
<header><h1>Trend Sinyalleri</h1><span class="sub">4h trend yönünde, 1h geri çekilme onayı. Sinyal mum kapanışında gelir.</span><span class="sub" id="scan"></span></header>
<main><section id="list"><div class="empty">Yükleniyor</div></section>
<aside><div class="card"><h2>Sonuçlar (maliyet düşülmüş)</h2><div id="stats"></div></div>
<div class="card"><h2>Uyum skoru</h2><div id="conf"></div><p class="meta">Uyum: BTC aynı yönde, hacim, derin geri çekilme, güçlü onay mumu, önü açık. Skor tahmindir; hangisinin işe yaradığını tablo gösterir.</p></div></aside></main>
<script>
function f(v){v=Number(v);if(!isFinite(v))return'-';return v>=1000?v.toFixed(2):v>=100?v.toFixed(3):v>=1?v.toFixed(4):v.toFixed(6)}
function ago(t){var m=Math.floor((Date.now()-t)/60000);return m<60?m+' dk önce':Math.floor(m/60)+' sa önce'}
var LBL={OPEN:'Açık',TP1_HIT:'TP1 alındı',STOP:'Stop',TRAIL_STOP:'İz süren stop',TIME_EXIT:'Süre doldu'};
function card(s){var c=s.dir===1?'L':'S',open=s.status==='OPEN'||s.status==='TP1_HIT';
var res=s.netR!=null?'<span class="'+(s.netR>0?'pos':'neg')+'">'+(s.netR>0?'+':'')+s.netR+'R</span>':(s.pnlR!=null?'<span class="'+(s.pnlR>=0?'pos':'neg')+'">'+(s.pnlR>0?'+':'')+s.pnlR+'R</span>':'');
return '<div class="card '+c+(open?'':' done')+'"><div class="top"><span class="sym">'+s.symbol.replace(':USDT','')+' <span class="dir '+c+'">'+s.direction+'</span></span><span>'+res+'</span></div>'
+'<div class="meta">'+LBL[s.status]+' · uyum '+s.conf+'/5 · '+ago(s.time)+'</div>'
+'<div class="grid"><div><b>Giriş</b>'+f(s.entry)+'</div><div><b>'+(s.tp1Hit?'Stop (iz süren)':'Stop')+'</b>'+f(s.stop)+' <span class="meta">%'+s.riskPct+'</span></div><div><b>TP1</b>'+f(s.tp1)+'</div><div><b>Güncel</b>'+(s.price?f(s.price):'-')+'</div></div>'
+(s.entryHint&&open?'<div class="hint">'+s.entryHint+'</div>':'')
+(open?'<div class="plan">TP1\\'de yarısını kapat, stopu girişe çek. Kalanı '+f(s.trailDist)+' mesafeli iz süren stopla sür (yeni tepenin/dibin '+f(s.trailDist)+' gerisi). Giriş bölgesi: '+f(s.entry)+' ± yarım ATR.</div>':'')
+'<div class="meta"><a target="_blank" href="https://www.tradingview.com/chart/?symbol=BITGET:'+s.symbol.replace('/USDT:USDT','USDT.P')+'&interval=60">TradingView\\'de aç</a></div></div>'}
function row(n,x){if(!x||!x.n)return'<tr><td>'+n+'</td><td colspan=4>-</td></tr>';return'<tr><td>'+n+'</td><td>'+x.n+'</td><td>%'+x.winRate+'</td><td class="'+(x.avgR>0?'pos':'neg')+'">'+x.avgR+'</td><td class="'+(x.totalR>0?'pos':'neg')+'">'+x.totalR+'</td></tr>'}
var H='<tr><th></th><th>n</th><th>kazanma</th><th>ort R</th><th>toplam</th></tr>';
function load(){fetch('/api/signals').then(function(r){return r.json()}).then(function(d){
var s=d.signals,o=s.filter(function(x){return x.status==='OPEN'||x.status==='TP1_HIT'}),c=s.filter(function(x){return!(x.status==='OPEN'||x.status==='TP1_HIT')}).slice(0,15);
document.getElementById('list').innerHTML=(o.length||c.length)?o.map(card).join('')+(c.length?'<h2>Kapananlar</h2>'+c.map(card).join(''):''):'<div class="empty">Şu an sinyal yok. Bu sistem az ama seçici çalışır; günde 0-3 sinyal normal.</div>';
document.getElementById('stats').innerHTML='<table>'+H+row('Tümü',d.stats.all)+row('Long',d.stats.long)+row('Short',d.stats.short)+'</table>'+(d.stats.all.n<100?'<p class="meta">'+d.stats.all.n+'/100 sinyal. Bu sayıdan önce sonuçlara güvenme.</p>':'');
document.getElementById('conf').innerHTML='<table>'+H+d.stats.byConf.map(function(x){return row(x.conf+'/5',x)}).join('')+'</table>';
document.getElementById('scan').textContent='Son tarama: '+(d.scan||'-');}).catch(function(){})}
load();setInterval(load,15000);
</script></body></html>`;

async function start() {
    load(); await ex.loadMarkets(); await refreshUniverse();
    setInterval(refreshUniverse, L.UNIVERSE_MS);
    setInterval(track, L.TRACK_MS);
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
