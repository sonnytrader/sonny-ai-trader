'use strict';
// ============================================================
// SONER TRADE v15 - SADE (TEK DOSYA)
// TEK STRATEJİ: "Kırılım" = 15m mum kapanışı son 8 saatin zirvesini/dibini aşar,
//   1H trend aynı yönde, hacim yüksek. PB / TB / üçgen / uyarı motoru KALDIRILDI.
// TEK LİSTE: Sinyal düşünce Sinyaller sekmesinde canlı fiyat + kâr/zarar (R ve %) görünür.
// "Yaklaşanlar" sekmesi sadece bilgi: kırılıma yakın coinler (sinyal değil, bildirim yok).
// Çıkış: -1R stop | 1.5R'de yarısı kâr alınır, stop girişe çekilir, kalan iz süren stop | 24 saat zaman aşımı
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const num = (k, d) => process.env[k] == null || process.env[k] === '' ? d : Number(process.env[k]);
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const SELF_URL = process.env.RENDER_EXTERNAL_URL || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const M15 = 15 * 60e3, H1 = 3600e3, D1 = 24 * H1;
const BTC = 'BTC/USDT:USDT', ETH = 'ETH/USDT:USDT';

const NON_CRYPTO = ['USDC','USDT','DAI','TUSD','BUSD','FDUSD','USDE','SUSDE','USDS','USD1','PYUSD','USDD','FRAX','LUSD','GUSD','BUIDL','USTC','USDP',
    'WBTC','WETH','WSTETH','STETH','RETH','CBETH','WBNB','WAVAX','WMATIC','PAXG','XAUT','XAU','XAG','XPT','XPD','GOLD','SILVER','OIL','WTI','BRENT','USOIL','UKOIL',
    'AAPL','MSFT','GOOGL','AMZN','META','TSLA','NVDA','AMD','INTC','ORCL','NFLX','COIN','HOOD','CRCL','MSTR','MARA','RIOT','PLTR','SPY','QQQ','SPCX','SNDK','ARM','SMCI','GME','AMC',
    'EUR','GBP','JPY','CHF','AUD','CAD','NZD','CNH','CNY','DXY','VIX','NASDAQ','SPX','NIKKEI','DAX','OPENAI','ANTHROPIC','SPACEX','XAI','SAMSUNG','HYNIX','SKHY','SKHYNIX'];

const CFG = {
    UNIVERSE: num('UNIVERSE', 100), MIN_VOL: num('MIN_VOL', 5e6), MIN_LISTING_DAYS: 14,
    EXCLUDED: NON_CRYPTO.concat((process.env.EXCLUDE || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean)),
    LOOK: num('LOOK', 32),            // kırılım penceresi (32 x 15m = 8 saat)
    VOL_MIN: num('VOL_MIN', 1.5),     // kırılım mumunun hacmi / 20 mum ortalaması
    MAX_EXT: num('MAX_EXT', 1.2),     // kapanış seviyeyi en fazla kaç ATR aşmış olabilir (geç kalma filtresi)
    MAX_RANGE: num('MAX_RANGE', 3),   // mum aralığı en fazla kaç ATR
    MIN_ADX: num('MIN_ADX', 18),
    MIN_RISK: num('MIN_RISK', 0.7), MAX_RISK: num('MAX_RISK', 6),   // risk % aralığı
    MAX_COST_R: num('MAX_COST_R', 0.25),
    TP1_R: num('TP1_R', 1.5), TRAIL_R: num('TRAIL_R', 1.0),
    MAX_HOLD_MS: num('MAX_HOLD_H', 24) * H1,
    COOLDOWN_MS: num('COOLDOWN_H', 4) * H1,
    MAX_OPEN: num('MAX_OPEN', 8), MAX_PER_SCAN: num('MAX_PER_SCAN', 3), DAY_STOP_R: num('DAY_STOP_R', -4),
    SCAN_DELAY_MS: 8e3, TICK_MS: 5e3, UNIVERSE_MS: 5 * 60e3, CONCURRENCY: 6, KEEP: 600
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const tickLoop = () => new Promise(r => setImmediate(r));
const log = (...a) => console.log('[SONER]', ...a);
const baseOf = s => s.split('/')[0];
const isMajor = s => /^(BTC|ETH)\//.test(s);
const last = a => a[a.length - 1];
const trDay = t => new Date(t + 3 * H1).toISOString().slice(0, 10);
const closedOnly = (c, ms, now = Date.now()) => c.filter(x => x[0] + ms <= now);
const costFor = v => (v || 0) >= 200e6 ? 0.14 : v >= 50e6 ? 0.18 : v >= 10e6 ? 0.25 : 0.35;   // gidiş-dönüş maliyet %
const fmt = p => { const a = Math.abs(p); return a >= 1000 ? p.toFixed(2) : a >= 1 ? p.toFixed(4) : a >= 0.01 ? p.toFixed(5) : p.toFixed(7); };
const isOpen = s => s.status === 'OPEN' || s.status === 'TP1';
const r2 = x => Number(x.toFixed(3));

// ------------------------- GÖSTERGELER -------------------------
function aggregateN(c, baseMs, n) {
    const ms = baseMs * n, g = new Map();
    for (const x of c) {
        const k = Math.floor(x[0] / ms) * ms; let a = g.get(k);
        if (!a) { a = [k, x[1], x[2], x[3], x[4], x[5], 1]; g.set(k, a); }
        else { a[2] = Math.max(a[2], x[2]); a[3] = Math.min(a[3], x[3]); a[4] = x[4]; a[5] += x[5]; a[6]++; }
    }
    return [...g.values()].filter(a => a[6] === n);
}
function emaSeries(v, p) {
    const out = new Array(v.length).fill(null); if (v.length < p) return out;
    let e = 0; for (let i = 0; i < p; i++) e += v[i]; e /= p; out[p - 1] = e;
    const k = 2 / (p + 1); for (let i = p; i < v.length; i++) { e = v[i] * k + e * (1 - k); out[i] = e; }
    return out;
}
const trAt = (c, i) => Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - c[i - 1][4]), Math.abs(c[i][3] - c[i - 1][4]));
function atrSeries(c, p = 14) {
    const o = new Array(c.length).fill(null); if (c.length <= p) return o;
    let a = 0; for (let i = 1; i <= p; i++) a += trAt(c, i); a /= p; o[p] = a;
    for (let i = p + 1; i < c.length; i++) { a = (a * (p - 1) + trAt(c, i)) / p; o[i] = a; }
    return o;
}
function rsiSeries(cl, p = 14) {
    const o = new Array(cl.length).fill(null); if (cl.length <= p) return o;
    let g = 0, l = 0;
    for (let i = 1; i <= p; i++) { const d = cl[i] - cl[i - 1]; if (d > 0) g += d; else l -= d; }
    g /= p; l /= p; o[p] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    for (let i = p + 1; i < cl.length; i++) {
        const d = cl[i] - cl[i - 1]; g = (g * (p - 1) + Math.max(d, 0)) / p; l = (l * (p - 1) + Math.max(-d, 0)) / p;
        o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
    return o;
}
function adxSeries(c, p = 14) {
    const n = c.length, o = new Array(n).fill(null); if (n < p * 2 + 2) return o;
    const dm = i => { const up = c[i][2] - c[i - 1][2], dn = c[i - 1][3] - c[i][3]; return [up > dn && up > 0 ? up : 0, dn > up && dn > 0 ? dn : 0]; };
    let trS = 0, pS = 0, mS = 0;
    for (let i = 1; i <= p; i++) { const m = dm(i); trS += trAt(c, i); pS += m[0]; mS += m[1]; }
    const dxAt = () => { const pd = trS ? 100 * pS / trS : 0, md = trS ? 100 * mS / trS : 0, s = pd + md; return s ? 100 * Math.abs(pd - md) / s : 0; };
    const dxs = [dxAt()]; let adx = null;
    for (let i = p + 1; i < n; i++) {
        const m = dm(i); trS = trS - trS / p + trAt(c, i); pS = pS - pS / p + m[0]; mS = mS - mS / p + m[1];
        dxs.push(dxAt()); const k = dxs.length;
        if (k === p) { adx = dxs.reduce((a, b) => a + b, 0) / p; o[i] = adx; }
        else if (k > p) { adx = (adx * (p - 1) + dxs[k - 1]) / p; o[i] = adx; }
    }
    return o;
}
function volSma(c, p = 20) {
    const o = new Array(c.length).fill(null); let s = 0;
    for (let i = 0; i < c.length; i++) { if (i >= p) { o[i] = s / p; s -= c[i - p][5]; } s += c[i][5]; }
    return o;
}
function feats(c) {
    const cl = c.map(x => x[4]);
    return { c, cl, e21: emaSeries(cl, 21), e50: emaSeries(cl, 50), atr: atrSeries(c), rsi: rsiSeries(cl), adx: adxSeries(c), vsma: volSma(c, 20) };
}
function trendSeries(f, minSpread) {
    const o = new Array(f.cl.length).fill(0);
    for (let i = 0; i < o.length; i++) {
        const a = f.e21[i], b = f.e50[i]; if (a == null || b == null) continue;
        const sp = (a - b) / f.cl[i] * 100;
        o[i] = sp >= minSpread && f.cl[i] > b ? 1 : sp <= -minSpread && f.cl[i] < b ? -1 : 0;
    }
    return o;
}
function ptrMap(c, cH, dur) {   // her 15m mum için, o an KAPANMIŞ son 1H mumun indeksi
    const o = new Array(c.length); let p = -1;
    for (let i = 0; i < c.length; i++) { const t = c[i][0] + M15; while (p + 1 < cH.length && cH[p + 1][0] + dur <= t) p++; o[i] = p; }
    return o;
}
function buildSym(c15) {
    const c1h = aggregateN(c15, M15, 4), f = feats(c15), f1 = feats(c1h);
    return { c: c15, f, t1h: trendSeries(f1, 0.10), p1h: ptrMap(c15, c1h, H1) };
}
const trendAt = (S, i) => { const p = S.p1h[i]; return p >= 0 ? S.t1h[p] : 0; };

// ------------------------- TEK STRATEJİ: KIRILIM -------------------------
// i. mum kapandığında sinyal var mı? Dönüş: { signal } veya { no: 'neden' }
function signalAt(S, i, ctx) {
    const c = S.c, f = S.f, N = CFG.LOOK;
    if (i < N + 55) return { no: 'veri az' };
    const a = f.atr[i], v = f.vsma[i]; if (!a || !v) return { no: 'veri az' };
    const k = c[i];
    let hi = -Infinity, lo = Infinity;
    for (let j = i - N; j < i; j++) { hi = Math.max(hi, c[j][2]); lo = Math.min(lo, c[j][3]); }
    let dir = 0, level = 0;
    if (k[4] > hi) { dir = 1; level = hi; } else if (k[4] < lo) { dir = -1; level = lo; } else return { no: 'kırılım yok' };
    const prev = c[i - 1][4];
    if (dir === 1 ? prev > level : prev < level) return { no: 'ilk kırılım değil' };
    if (trendAt(S, i) !== dir) return { no: '1H trend ters' };
    if (!isMajor(ctx.sym) && ctx.btcTr === -dir) return { no: 'BTC ters' };
    if ((k[2] - k[3]) / a > CFG.MAX_RANGE) return { no: 'mum çok büyük' };
    if (Math.abs(k[4] - level) / a > CFG.MAX_EXT) return { no: 'geç kalındı' };
    if (k[5] / v < CFG.VOL_MIN) return { no: 'hacim zayıf' };
    if ((f.adx[i] || 0) < CFG.MIN_ADX) return { no: 'trend zayıf (ADX)' };
    const rsi = f.rsi[i] || 50; if (dir === 1 ? rsi > 78 : rsi < 22) return { no: 'aşırı alım/satım' };
    const entry = k[4];
    let stop = dir === 1 ? Math.min(level - 0.5 * a, entry - 1.2 * a) : Math.max(level + 0.5 * a, entry + 1.2 * a);
    const minD = entry * CFG.MIN_RISK / 100;   // stop çok dar olmasın (gürültüye takılmasın): en az MIN_RISK %
    if (Math.abs(entry - stop) < minD) stop = entry - dir * minD;
    const risk = Math.abs(entry - stop), riskPct = risk / entry * 100;
    if (riskPct > CFG.MAX_RISK) return { no: 'risk çok geniş' };
    const costPct = ctx.costPct != null ? ctx.costPct : costFor(0), costR = costPct / riskPct;
    if (costR > CFG.MAX_COST_R) return { no: 'maliyet yüksek' };
    const t = k[0] + M15;
    return { signal: {
        id: ctx.sym + '|' + t, symbol: ctx.sym, base: baseOf(ctx.sym), dir: dir === 1 ? 'LONG' : 'SHORT',
        time: t, candleT: k[0], entry, stop, stop0: stop, tp1: entry + dir * CFG.TP1_R * risk, level, risk, riskPct: r2(riskPct),
        atr: a, volx: r2(k[5] / v), adx: r2(f.adx[i]), costR: r2(costR), status: 'OPEN', peak: entry, booked: 0, stopR: -1, lastPrice: entry, pnlR: 0
    } };
}

// ------------------------- POZİSYON TAKİBİ -------------------------
function curR(s, price) { const d = s.dir === 'LONG' ? 1 : -1; return d * (price - s.entry) / s.risk; }
const openPnlR = (s, price) => s.tp1Hit ? s.booked + 0.5 * curR(s, price) : curR(s, price);
function closeSig(s, status, gross, t) { s.status = status; s.grossR = r2(gross); s.netR = r2(gross - s.costR); s.closedAt = t; s.pnlR = s.netR; }
// price: anlık fiyat. Kapandıysa true döner.
function step(s, price, now) {
    const d = s.dir === 'LONG' ? 1 : -1, r = curR(s, price);
    s.lastPrice = price; s.peak = d === 1 ? Math.max(s.peak, price) : Math.min(s.peak, price);
    const pkR = d * (s.peak - s.entry) / s.risk;
    if (!s.tp1Hit) {
        if (r <= -1) { closeSig(s, 'STOP', Math.min(r, -1), now); return true; }
        if (r >= CFG.TP1_R) { s.tp1Hit = true; s.status = 'TP1'; s.booked = 0.5 * CFG.TP1_R; s.stopR = 0; s.stop = s.entry; s.tp1At = now; }
    } else {
        s.stopR = Math.max(0, pkR - CFG.TRAIL_R); s.stop = s.entry + d * s.stopR * s.risk;
        if (r <= s.stopR) { closeSig(s, 'KAR', s.booked + 0.5 * r, now); return true; }
    }
    if (now - s.time >= CFG.MAX_HOLD_MS) { closeSig(s, 'SÜRE', s.tp1Hit ? s.booked + 0.5 * r : r, now); return true; }
    s.pnlR = r2(openPnlR(s, price));
    return false;
}
// mum bazlı (backtest): aynı mumda stop ve hedef varsa STOP önce sayılır
function stepCandle(s, k) {
    const d = s.dir === 'LONG' ? 1 : -1, t = k[0] + M15;
    const worst = d === 1 ? k[3] : k[2], best = d === 1 ? k[2] : k[3];
    if (!s.tp1Hit) {
        if (curR(s, worst) <= -1) { closeSig(s, 'STOP', -1, t); return true; }
        if (curR(s, best) >= CFG.TP1_R) { s.tp1Hit = true; s.status = 'TP1'; s.booked = 0.5 * CFG.TP1_R; s.stopR = 0; s.peak = best; return false; }
    } else {
        if (curR(s, worst) <= s.stopR) { closeSig(s, 'KAR', s.booked + 0.5 * s.stopR, t); return true; }
        s.peak = d === 1 ? Math.max(s.peak, best) : Math.min(s.peak, best);
        s.stopR = Math.max(0, d * (s.peak - s.entry) / s.risk - CFG.TRAIL_R);
    }
    if (t - s.time >= CFG.MAX_HOLD_MS) { const r = curR(s, k[4]); closeSig(s, 'SÜRE', s.tp1Hit ? s.booked + 0.5 * r : r, t); return true; }
    return false;
}

// ------------------------- İSTATİSTİK -------------------------
function grp(list) {
    const n = list.length;
    if (!n) return { n: 0, win: 0, avgR: 0, totalR: 0, pf: 0, dd: 0, t: 0 };
    let tot = 0, w = 0, gp = 0, gl = 0, eq = 0, pk = 0, dd = 0, sq = 0;
    for (const s of list) { tot += s.netR; if (s.netR > 0) { w++; gp += s.netR; } else gl -= s.netR; eq += s.netR; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); sq += s.netR * s.netR; }
    const avg = tot / n; let t = 0;
    if (n > 1) { const v = Math.max(0, (sq - n * avg * avg) / (n - 1)), se = Math.sqrt(v / n); t = se > 0 ? avg / se : 0; }
    return { n, win: w / n, avgR: avg, totalR: tot, pf: gl > 0 ? gp / gl : (gp > 0 ? 99 : 0), dd, t: Number(t.toFixed(2)) };
}
function groupBy(list, fn) { const m = {}; for (const s of list) { const k = fn(s); (m[k] = m[k] || []).push(s); } const o = {}; Object.keys(m).sort().forEach(k => { o[k] = grp(m[k]); }); return o; }
const closedList = () => signals.filter(s => !isOpen(s) && s.netR != null);
const dayR = () => { const d = trDay(Date.now()); return closedList().filter(s => trDay(s.closedAt) === d).reduce((a, s) => a + s.netR, 0) + signals.filter(isOpen).filter(s => trDay(s.time) === d).reduce((a, s) => a + (s.pnlR || 0), 0) * 0; };

// ------------------------- DURUM -------------------------
const ex = new ccxt.bitget({ enableRateLimit: true, options: { defaultType: 'swap' } });
let signals = [], lastSig = {}, universe = [], tickers = {}, radar = [], market = { btc: null, eth: null, trend: 0 };
let scan = { last: 0, ms: 0, running: false, reasons: {}, total: 0, eligible: 0, suspect: 0, done: 0 }, dirty = false, lastScanSlot = 0, ticking = false;
let btJob = { running: false, msg: '', done: 0, total: 0, result: null, error: null };
const candleCache = new Map(), volMap = {};

function loadState() {
    try {
        const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        signals = (j.signals || []).filter(s => s && s.id && s.entry && s.risk && (s.status === 'OPEN' || s.status === 'TP1' || s.netR != null));
        lastSig = j.lastSig || {}; log('durum:', signals.length, 'sinyal');
    } catch (e) { log('temiz başlangıç.'); }
}
function saveState() {
    if (!dirty) return; dirty = false;
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        const tmp = STATE_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ v: 15, signals: signals.slice(0, CFG.KEEP), lastSig })); fs.renameSync(tmp, STATE_FILE);
    } catch (e) { log('kayıt hatası', e.message); }
}
async function telegram(text) {
    if (!TG_TOKEN || !TG_CHAT) return;
    try { await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: TG_CHAT, text }) }); } catch (e) { }
}
const tvLink = s => 'https://www.tradingview.com/chart/?symbol=BITGET:' + s.base + 'USDT.P&interval=15';
function sigMsg(s) {
    return '🚨 SİNYAL: ' + s.dir + ' ' + s.base + '\n' +
        'Giriş: ' + fmt(s.entry) + '\nStop: ' + fmt(s.stop0) + ' (risk %' + s.riskPct + ')\nHedef 1 (yarısını sat): ' + fmt(s.tp1) + '\n' +
        'Sonra: stop girişe çekilir, kalan iz süren stopla gider.\nHacim ' + s.volx + 'x | ADX ' + s.adx + '\n' + tvLink(s);
}
function isSuspect(sym) {
    if (isMajor(sym)) return false;
    const m = ex.markets[sym], inf = (m && m.info) || {};
    if (String(inf.isRwa || inf.rwa || '').toUpperCase() === 'YES') return true;
    const st = String(inf.symbolType || inf.category || '').toLowerCase();
    if (st && st !== 'perpetual' && st !== 'crypto') return true;
    const lt = Number(inf.launchTime || inf.onlineTime || 0);
    return lt > 1e12 && Date.now() - lt < CFG.MIN_LISTING_DAYS * D1;
}
async function refreshUniverse() {
    try {
        if (!Object.keys(ex.markets || {}).length) await ex.loadMarkets();
        tickers = await ex.fetchTickers();
        const all = Object.values(tickers).filter(t => t && t.symbol && t.symbol.endsWith(':USDT') && ex.markets[t.symbol] && ex.markets[t.symbol].linear);
        let suspect = 0;
        const ok = all.filter(t => {
            if (CFG.EXCLUDED.includes(baseOf(t.symbol).toUpperCase())) return false;
            if ((t.quoteVolume || 0) < CFG.MIN_VOL) return false;
            if (isSuspect(t.symbol)) { suspect++; return false; }
            return true;
        });
        const top = ok.slice().sort((x, y) => (y.quoteVolume || 0) - (x.quoteVolume || 0)).slice(0, CFG.UNIVERSE).map(t => t.symbol);
        for (const s of [BTC, ETH]) if (!top.includes(s)) top.push(s);
        universe = top; scan.total = all.length; scan.eligible = ok.length; scan.suspect = suspect;
        for (const t of all) volMap[t.symbol] = t.quoteVolume || 0;
        applyMarket();
    } catch (e) { log('evren hatası', e.message); }
}
function applyMarket() {
    for (const [s, k] of [[BTC, 'btc'], [ETH, 'eth']]) { const t = tickers[s]; if (t) market[k] = Object.assign(market[k] || {}, { price: t.last, chg: t.percentage }); }
}

// ------------------------- CANLI FİYAT + TAKİP (her 5 sn) -------------------------
async function liveTick() {
    if (ticking) return; ticking = true;
    try {
        tickers = await ex.fetchTickers(); applyMarket();
        const now = Date.now(); let changed = false;
        for (const s of signals) {
            if (!isOpen(s)) continue;
            const t = tickers[s.symbol]; if (!t || !t.last) continue;
            const was = s.status, closed = step(s, t.last, now); changed = true;
            if (was === 'OPEN' && s.status === 'TP1') telegram('✅ ' + s.base + ' ' + s.dir + ': Hedef 1 vuruldu (+' + CFG.TP1_R + 'R). Yarısını sat, stopu girişe (' + fmt(s.entry) + ') çek. Kalan iz süren stopla gidiyor.');
            if (closed) telegram((s.netR > 0 ? '💰 ' : '🛑 ') + s.base + ' ' + s.dir + ' kapandı: ' + s.status + ' | Net ' + (s.netR > 0 ? '+' : '') + s.netR + 'R');
        }
        if (changed) dirty = true;
    } catch (e) { } finally { ticking = false; }
}

// ------------------------- TARAMA (her 15m kapanışta) -------------------------
async function getC15(sym) {
    const get = () => ex.fetchOHLCV(sym, '15m', undefined, 500);
    let d; try { d = await get(); } catch (e) { await sleep(400); d = await get(); }
    return closedOnly(d, M15);
}
async function runScan() {
    if (scan.running) return; scan.running = true; scan.done = 0;
    const t0 = Date.now(), reasons = {}, newRadar = [], found = [];
    try {
        await refreshUniverse();
        const list = universe.slice(), data = {};
        let idx = 0;
        const worker = async () => {
            while (idx < list.length) {
                const sym = list[idx++];
                try { data[sym] = await getC15(sym); } catch (e) { reasons['veri hatası'] = (reasons['veri hatası'] || 0) + 1; }
                scan.done++;
            }
        };
        await Promise.all(Array.from({ length: CFG.CONCURRENCY }, worker));
        const B = data[BTC] && data[BTC].length > 150 ? buildSym(data[BTC]) : null;
        const btcTr = B ? trendAt(B, B.c.length - 1) : 0;
        market.trend = btcTr;
        const now = Date.now();
        for (const sym of list) {
            const c = data[sym]; if (!c || c.length < 150) continue;
            if (now - last(c)[0] > 2 * M15 + 60e3) { reasons['bayat veri'] = (reasons['bayat veri'] || 0) + 1; continue; }
            await tickLoop();
            const S = buildSym(c), i = c.length - 1, a = S.f.atr[i];
            // Yaklaşanlar: 1H trend yönünde, seviyeye 1 ATR'den yakın
            if (a) {
                let hi = -Infinity, lo = Infinity; for (let j = i - CFG.LOOK + 1; j <= i; j++) { hi = Math.max(hi, c[j][2]); lo = Math.min(lo, c[j][3]); }
                const tr = trendAt(S, i), px = c[i][4];
                if (tr === 1 && (hi - px) / a <= 1) newRadar.push({ symbol: sym, base: baseOf(sym), dir: 'LONG', level: hi, atr: a });
                else if (tr === -1 && (px - lo) / a <= 1) newRadar.push({ symbol: sym, base: baseOf(sym), dir: 'SHORT', level: lo, atr: a });
            }
            const r = signalAt(S, i, { sym, btcTr, costPct: costFor(volMap[sym]) });
            if (!r.signal) { reasons[r.no] = (reasons[r.no] || 0) + 1; continue; }
            found.push(r.signal);
        }
        radar = newRadar;
        // sinyal kabul: tekrar, cooldown, açık limit, günlük stop, tarama başına limit
        found.sort((x, y) => y.volx - x.volx);
        let added = 0;
        const openN = () => signals.filter(isOpen).length, today = trDay(now);
        const todayR = closedList().filter(s => trDay(s.closedAt) === today).reduce((q, s) => q + s.netR, 0);
        for (const s of found) {
            const why = signals.some(x => x.id === s.id) ? 'zaten var' : signals.some(x => isOpen(x) && x.symbol === s.symbol) ? 'coin zaten açık'
                : (lastSig[s.symbol] && now - lastSig[s.symbol] < CFG.COOLDOWN_MS) ? 'bekleme süresi' : openN() >= CFG.MAX_OPEN ? 'açık limit dolu'
                : todayR <= CFG.DAY_STOP_R ? 'günlük stop' : added >= CFG.MAX_PER_SCAN ? 'tarama limiti' : null;
            if (why) { reasons['(' + why + ')'] = (reasons['(' + why + ')'] || 0) + 1; continue; }
            const t = tickers[s.symbol]; if (t && t.last) s.lastPrice = t.last;
            signals.unshift(s); lastSig[s.symbol] = now; added++; dirty = true;
            telegram(sigMsg(s)); log('SİNYAL', s.dir, s.base, fmt(s.entry));
        }
        if (signals.length > CFG.KEEP) signals.length = CFG.KEEP;
        reasons['SİNYAL'] = added;
    } catch (e) { log('tarama hatası', e.message); }
    scan.reasons = reasons; scan.last = Date.now(); scan.ms = Date.now() - t0; scan.running = false;
    log('tarama bitti', scan.ms + 'ms', JSON.stringify(reasons));
}

// ------------------------- API -------------------------
function pnlView(s) {
    const d = s.dir === 'LONG' ? 1 : -1, px = isOpen(s) ? (tickers[s.symbol] && tickers[s.symbol].last) || s.lastPrice : s.lastPrice;
    const pct = px ? d * (px - s.entry) / s.entry * 100 : 0;
    return Object.assign({}, s, { price: px, pnlPct: r2(pct), pnlR: isOpen(s) ? r2(openPnlR(s, px)) : s.netR });
}
function radarView() {
    return radar.map(r => {
        const t = tickers[r.symbol], px = t && t.last, d = r.dir === 'LONG' ? 1 : -1;
        if (!px) return null;
        const dist = d * (r.level - px) / r.atr;   // >0: henüz aşılmadı, <0: seviye aşıldı
        return { symbol: r.symbol, base: r.base, dir: r.dir, level: r.level, price: px, distAtr: r2(dist), broke: dist <= 0, chg24: t.percentage };
    }).filter(Boolean).sort((a, b) => Math.abs(a.distAtr) - Math.abs(b.distAtr)).slice(0, 30);
}
function apiState() {
    const now = Date.now(), cl = closedList(), today = trDay(now);
    const open = signals.filter(isOpen).map(pnlView), closed = signals.filter(s => !isOpen(s) && s.netR != null).slice(0, 60).map(pnlView);
    let e = 0; const eq = cl.slice().sort((a, b) => a.closedAt - b.closedAt).slice(-200).map(s => (e += s.netR));
    const tR = cl.filter(s => trDay(s.closedAt) === today).reduce((q, s) => q + s.netR, 0);
    return { now, mode: 'v15 SADE - Kırılım', market, open, closed, radar: radarView(), equity: eq,
        stats: { all: grp(cl), today: grp(cl.filter(s => trDay(s.closedAt) === today)), byDir: groupBy(cl, s => s.dir), byExit: groupBy(cl, s => s.status) },
        openPnlR: r2(open.reduce((q, s) => q + s.pnlR, 0)), todayR: r2(tR), dayStop: tR <= CFG.DAY_STOP_R,
        cfg: { look: CFG.LOOK, volMin: CFG.VOL_MIN, tp1: CFG.TP1_R, trail: CFG.TRAIL_R, maxOpen: CFG.MAX_OPEN, dayStop: CFG.DAY_STOP_R, holdH: CFG.MAX_HOLD_MS / H1 },
        scan: { last: scan.last, ms: scan.ms, running: scan.running, reasons: scan.reasons, universe: universe.length, eligible: scan.eligible, suspect: scan.suspect, tg: !!(TG_TOKEN && TG_CHAT) } };
}
async function apiCandles(sym) {
    if (!ex.markets[sym]) throw new Error('bilinmeyen sembol');
    const hit = candleCache.get(sym); if (hit && Date.now() - hit.t < 4000) return hit.d;
    const c = await ex.fetchOHLCV(sym, '15m', undefined, 200), cl = c.map(x => x[4]), e21 = emaSeries(cl, 21), e50 = emaSeries(cl, 50), cut = Math.max(0, c.length - 100);
    const d = { c: c.slice(cut), e21: e21.slice(cut), e50: e50.slice(cut), price: tickers[sym] && tickers[sym].last, dur: M15 };
    candleCache.set(sym, { t: Date.now(), d });
    if (candleCache.size > 200) { for (const k of [...candleCache.keys()].slice(0, 60)) candleCache.delete(k); }
    return d;
}

// ------------------------- GEÇMİŞ TEST (aynı sinyal kodu) -------------------------
async function fetchHistory15(sym, days) {
    const total = days + 4; let since = Date.now() - total * D1, all = [], guard = 0;
    while (since < Date.now() - M15 && guard++ < 120) {
        let r = null, retry = 0;
        while (retry < 4) { try { r = await ex.fetchOHLCV(sym, '15m', since, 1000); break; } catch (e) { retry++; await sleep(800 * retry); } }
        if (!r || !r.length) break;
        all = all.concat(r); const l = last(r)[0]; if (l <= since) break; since = l + M15; await sleep(100);
    }
    const seen = new Set();
    return closedOnly(all, M15).filter(x => !seen.has(x[0]) && seen.add(x[0])).sort((a, b) => a[0] - b[0]);
}
async function runBacktest(days, coins, costMult) {
    if (btJob.running) return;
    btJob = { running: true, msg: 'Veri indiriliyor', done: 0, total: 0, result: null, error: null };
    try {
        const use = universe.filter(s => !isMajor(s)).slice(0, coins); if (!use.includes(BTC)) use.unshift(BTC);
        btJob.total = use.length;
        const data = {}, skipped = [];
        for (const s of use) {
            try { const c = await fetchHistory15(s, days); if (c.length > 400) data[s] = c; else skipped.push(baseOf(s)); } catch (e) { skipped.push(baseOf(s)); }
            btJob.done++;
        }
        btJob.msg = 'Simülasyon';
        const bc = data[BTC], BS = bc ? buildSym(bc) : null, btcMap = new Map();
        if (BS) for (let i = 0; i < bc.length; i++) btcMap.set(bc[i][0], trendAt(BS, i));
        const startT = Date.now() - days * D1, raw = [], funnel = {};
        for (const sym of Object.keys(data)) {
            if (sym === BTC && !use.includes(BTC)) continue;
            const c = data[sym], S = buildSym(c); let busy = 0;
            for (let i = 80; i < c.length - 1; i++) {
                const t = c[i][0]; if (t < startT || t < busy) continue;
                if (i % 1500 === 0) await tickLoop();
                const r = signalAt(S, i, { sym, btcTr: btcMap.get(t) || 0, costPct: costFor(volMap[sym]) * costMult });
                if (!r.signal) { if (r.no !== 'veri az' && r.no !== 'kırılım yok') funnel[r.no] = (funnel[r.no] || 0) + 1; continue; }
                const s = r.signal; s.costR = r2(s.costR);
                for (let j = i + 1; j < c.length; j++) if (stepCandle(s, c[j])) break;
                if (isOpen(s)) continue;
                raw.push({ base: s.base, dir: s.dir, time: s.time, closedAt: s.closedAt, netR: s.netR, status: s.status });
                busy = Math.max(s.closedAt, s.time + CFG.COOLDOWN_MS); funnel.sinyal = (funnel.sinyal || 0) + 1;
            }
        }
        raw.sort((a, b) => a.time - b.time);
        const trades = [], openL = []; let blocked = 0;
        for (const t of raw) {   // canlıdaki gibi portföy limiti
            for (let q = openL.length - 1; q >= 0; q--) if (openL[q].closedAt <= t.time) openL.splice(q, 1);
            if (openL.length >= CFG.MAX_OPEN) { blocked++; continue; }
            openL.push(t); trades.push(t);
        }
        const n = trades.length, h = Math.floor(n / 2), sorted = trades.map(t => t.netR).sort((a, b) => a - b);
        btJob.result = { days, coins: Object.keys(data).length, skipped, costMult, blocked, funnel, all: grp(trades), first: grp(trades.slice(0, h)), second: grp(trades.slice(h)),
            median: n ? sorted[Math.floor(n / 2)] : 0, perDay: n / days, byDir: groupBy(trades, s => s.dir), byExit: groupBy(trades, s => s.status), byCoin: groupBy(trades, s => s.base) };
        btJob.msg = 'Tamamlandı';
    } catch (e) { btJob.error = 'Test hatası: ' + e.message; log('BT hata', e.message); }
    btJob.running = false;
}

// ------------------------- ARAYÜZ -------------------------
const HTML = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>SONER TRADE v15</title>
<style>
:root{--bg:#0e1116;--card:#171b23;--bd:#262c38;--tx:#e8ecf3;--mu:#8b95a7;--g:#22c55e;--r:#ef4444;--y:#eab308;--b:#3b82f6}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:14px system-ui,sans-serif;padding-bottom:40px}
.top{position:sticky;top:0;background:#0b0e13;border-bottom:1px solid var(--bd);padding:10px 12px;z-index:5}
.top b{font-size:15px}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.mu{color:var(--mu);font-size:12px}
.g{color:var(--g)}.r{color:var(--r)}.y{color:var(--y)}
.tabs{display:flex;gap:6px;padding:10px 12px}.tab{flex:1;text-align:center;padding:10px 4px;border:1px solid var(--bd);border-radius:10px;background:var(--card);color:var(--mu);cursor:pointer;font-weight:600}
.tab.on{background:var(--b);color:#fff;border-color:var(--b)}
.wrap{padding:0 12px;max-width:900px;margin:auto}
.card{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:12px;margin-bottom:10px;cursor:pointer}
.card.sel{border-color:var(--b)}
.big{font-size:22px;font-weight:700}.badge{padding:2px 8px;border-radius:6px;font-weight:700;font-size:12px}
.L{background:#0f3d24;color:var(--g)}.S{background:#421414;color:var(--r)}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:8px}.grid div{background:#0f131a;border-radius:8px;padding:6px 8px}.grid .k{color:var(--mu);font-size:11px}
canvas{width:100%;height:260px;background:#0f131a;border-radius:10px;display:block;margin:8px 0}
.note{background:#0f131a;border-radius:8px;padding:10px;color:var(--mu);font-size:13px;line-height:1.5;margin:8px 0}
input,select,button{background:#0f131a;color:var(--tx);border:1px solid var(--bd);border-radius:8px;padding:8px}button{cursor:pointer;background:var(--b);border:0;font-weight:600}
table{width:100%;border-collapse:collapse}td,th{padding:6px;border-bottom:1px solid var(--bd);text-align:right;font-size:13px}td:first-child,th:first-child{text-align:left}
h3{margin:14px 0 6px}
</style></head><body>
<div class="top"><div class="row"><b>SONER TRADE v15</b><span class="mu" id="conn">bağlanıyor…</span><span class="mu" id="mk"></span></div><div class="row" id="sum" style="margin-top:6px"></div></div>
<div class="tabs"><div class="tab on" data-t="sig">Sinyaller</div><div class="tab" data-t="near">Yaklaşanlar</div><div class="tab" data-t="stat">İstatistik</div><div class="tab" data-t="bt">Test</div></div>
<div class="wrap" id="main"></div>
<script>
let S=null,tab='sig',sel=null,cd=null,lastTop=null,actx=null,key=localStorage.getItem('st_key')||'',bt=null;
const $=id=>document.getElementById(id),esc=x=>String(x).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fp=p=>{p=+p;const a=Math.abs(p);return a>=1000?p.toFixed(2):a>=1?p.toFixed(4):a>=0.01?p.toFixed(5):p.toFixed(7)};
const sg=(x,d=2)=>(x>0?'+':'')+(+x).toFixed(d),cl=x=>x>0?'g':x<0?'r':'';
function beep(){try{actx=actx||new (window.AudioContext||window.webkitAudioContext)();[880,1100].forEach((f,i)=>{const o=actx.createOscillator(),g=actx.createGain();o.connect(g);g.connect(actx.destination);o.frequency.value=f;g.gain.value=0.1;o.start(actx.currentTime+i*0.25);o.stop(actx.currentTime+i*0.25+0.2)})}catch(e){}}
document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>{tab=t.dataset.t;sel=null;document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('on',x===t));render();if(tab==='bt')pollBt()});
document.addEventListener('click',()=>{try{actx=actx||new (window.AudioContext||window.webkitAudioContext)()}catch(e){}},{once:true});

function sigCard(s){const open=s.status==='OPEN'||s.status==='TP1',c=cl(s.pnlR);
 const st={OPEN:'AÇIK',TP1:'AÇIK • Hedef 1 alındı',STOP:'STOP oldu',KAR:'KÂRLA kapandı',SÜRE:'Süre doldu'}[s.status]||s.status;
 return '<div class="card'+(sel===s.id?' sel':'')+'" data-id="'+esc(s.id)+'"><div class="row"><span class="badge '+(s.dir==='LONG'?'L':'S')+'">'+s.dir+'</span><b style="font-size:16px">'+esc(s.base)+'</b><span class="mu">'+st+'</span><span style="margin-left:auto" class="big '+c+'">'+sg(s.pnlR)+'R</span></div>'
 +'<div class="row mu" style="margin-top:4px"><span>Giriş '+fp(s.entry)+'</span><span>Şimdi <b style="color:var(--tx)">'+fp(s.price||s.lastPrice)+'</b></span><span class="'+cl(s.pnlPct)+'">'+sg(s.pnlPct)+'%</span><span>'+ago(s.time)+'</span></div></div>'}
function ago(t){const m=Math.max(0,Math.round((Date.now()-t)/60000));return m<60?m+' dk önce':Math.floor(m/60)+' sa '+(m%60)+' dk önce'}
function guide(s){
 if(s.status==='STOP')return 'Stop oldu: -1R civarı kayıp. Bu normal, strateji her işlemi kazanmaz.';
 if(s.status==='KAR')return 'Kâr alındı ve iz süren stop çıkışı yaptı.';
 if(s.status==='SÜRE')return 'Zaman aşımıyla kapandı.';
 if(s.status==='TP1')return 'YAPILACAK: yarım pozisyon zaten satılmış olmalı, stop girişte ('+fp(s.entry)+'). Kalan için iz süren stop: '+fp(s.stop)+'. Stopu borsada bu seviyeye yükseltmeyi unutma.';
 return 'YAPILACAK: '+s.dir+' aç, stop '+fp(s.stop0)+' koy (risk %'+s.riskPct+'). Fiyat '+fp(s.tp1)+' olunca pozisyonun yarısını sat, stopu girişe çek. Fiyat girişten çok uzaklaştıysa (yarım R üstü) girme, sonrakini bekle.'}
function calcBox(s){const bal=+localStorage.getItem('st_bal')||1000,rk=+localStorage.getItem('st_rk')||0.5;
 return '<div class="note"><b style="color:var(--tx)">Pozisyon hesabı</b><div class="row" style="margin-top:6px">Bakiye <input id="cb" type="number" value="'+bal+'" style="width:90px"> Risk % <input id="cr" type="number" step="0.1" value="'+rk+'" style="width:70px"></div><div id="co" style="margin-top:6px;color:var(--tx)"></div></div>'}
function calcUpd(s){const bal=+$('cb').value,rk=Math.min(2,+$('cr').value);localStorage.setItem('st_bal',bal);localStorage.setItem('st_rk',rk);const ru=bal*rk/100,q=ru/Math.abs(s.entry-s.stop0);$('co').textContent='1R = '+ru.toFixed(2)+' USDT | Miktar '+q.toFixed(4)+' | Pozisyon '+(q*s.entry).toFixed(1)+' USDT | Kaldıraç '+(q*s.entry/bal).toFixed(1)+'x'}
function detail(s){const c=cl(s.pnlR);
 return '<div class="card" style="cursor:default"><div class="row"><span class="badge '+(s.dir==='LONG'?'L':'S')+'">'+s.dir+'</span><b style="font-size:18px">'+esc(s.base)+'</b><span style="margin-left:auto" class="big '+c+'" id="dR">'+sg(s.pnlR)+'R</span></div>'
 +'<div class="row" style="margin-top:6px"><span class="big" id="dP">'+fp(s.price||s.lastPrice)+'</span><span class="'+cl(s.pnlPct)+'" id="dPct" style="font-weight:700">'+sg(s.pnlPct)+'%</span><span class="mu">(girişe göre, kaldıraçsız)</span></div>'
 +'<canvas id="cv"></canvas>'
 +'<div class="grid"><div><div class="k">Giriş</div>'+fp(s.entry)+'</div><div><div class="k">Stop</div><span class="r">'+fp(s.stop)+'</span></div><div><div class="k">Hedef 1 ('+(S.cfg.tp1)+'R)</div><span class="g">'+fp(s.tp1)+'</span></div><div><div class="k">Risk</div>'+s.riskPct+'%</div><div><div class="k">Hacim</div>'+s.volx+'x</div><div><div class="k">Kırılan seviye</div>'+fp(s.level)+'</div></div>'
 +'<div class="note">'+esc(guide(s))+'</div>'
 +(s.status==='OPEN'||s.status==='TP1'?calcBox(s):'')
 +'<a class="mu" target="_blank" href="https://www.tradingview.com/chart/?symbol=BITGET:'+s.base+'USDT.P&interval=15">TradingView\\'de aç</a></div>'}

function drawChart(d,s){const cv=$('cv');if(!cv||!d)return;const W=cv.clientWidth,H=cv.clientHeight,dp=devicePixelRatio||1;cv.width=W*dp;cv.height=H*dp;const x=cv.getContext('2d');x.scale(dp,dp);
 const c=d.c,n=c.length,pad=56,lv=[];const px=S.open.concat(S.closed).find(q=>q.id===sel);const price=(px&&px.price)||d.price||c[n-1][4];
 if(s){lv.push([s.entry,'#8b95a7','GİRİŞ'],[s.stop,'#ef4444','STOP'],[s.tp1,'#22c55e','HEDEF1'])}
 let mn=1e99,mx=-1e99;c.forEach(k=>{mn=Math.min(mn,k[3]);mx=Math.max(mx,k[2])});lv.forEach(l=>{mn=Math.min(mn,l[0]);mx=Math.max(mx,l[0])});mn=Math.min(mn,price);mx=Math.max(mx,price);const sp=(mx-mn)||1;mn-=sp*.05;mx+=sp*.05;
 const Y=p=>H-8-(p-mn)/(mx-mn)*(H-16),bw=(W-pad)/n;
 c.forEach((k,i)=>{const cx=i*bw+bw/2,up=k[4]>=k[1];x.strokeStyle=x.fillStyle=up?'#22c55e':'#ef4444';x.beginPath();x.moveTo(cx,Y(k[2]));x.lineTo(cx,Y(k[3]));x.stroke();const y1=Y(Math.max(k[1],k[4])),y2=Y(Math.min(k[1],k[4]));x.fillRect(cx-bw*.35,y1,bw*.7,Math.max(1,y2-y1))});
 [['e21','#3b82f6'],['e50','#eab308']].forEach(a=>{x.strokeStyle=a[1];x.lineWidth=1;x.beginPath();let f=1;d[a[0]].forEach((v,i)=>{if(v==null)return;const cx=i*bw+bw/2;f?(x.moveTo(cx,Y(v)),f=0):x.lineTo(cx,Y(v))});x.stroke()});
 x.font='11px system-ui';x.lineWidth=1;lv.forEach(l=>{x.strokeStyle=x.fillStyle=l[1];x.setLineDash([5,4]);x.beginPath();x.moveTo(0,Y(l[0]));x.lineTo(W-pad,Y(l[0]));x.stroke();x.setLineDash([]);x.fillText(l[2]+' '+fp(l[0]),W-pad+3,Y(l[0])+4)});
 x.strokeStyle=x.fillStyle='#fff';x.setLineDash([2,2]);x.beginPath();x.moveTo(0,Y(price));x.lineTo(W-pad,Y(price));x.stroke();x.setLineDash([]);x.font='bold 12px system-ui';x.fillText(fp(price),W-pad+3,Y(price)+4)}
function loadChart(sym){fetch('/api/candles?symbol='+encodeURIComponent(sym)).then(r=>r.json()).then(d=>{cd={sym:sym,d:d};const s=S.open.concat(S.closed).find(q=>q.id===sel);if($('cv'))drawChart(d,s)}).catch(()=>{})}

function nearCard(r){const t=r.broke?'<span class="y">SEVİYE AŞILDI - mum kapanışını bekle</span>':'kırılıma '+r.distAtr.toFixed(2)+' ATR var';
 return '<div class="card" style="cursor:default"><div class="row"><span class="badge '+(r.dir==='LONG'?'L':'S')+'">'+r.dir+'</span><b>'+esc(r.base)+'</b><span style="margin-left:auto">'+fp(r.price)+'</span></div><div class="row mu" style="margin-top:4px"><span>'+(r.dir==='LONG'?'Direnç ':'Destek ')+fp(r.level)+'</span><span>'+t+'</span></div></div>'}
function tbl(o){const k=Object.keys(o||{});if(!k.length)return '<div class="note">Henüz veri yok.</div>';return '<table><tr><th></th><th>İşlem</th><th>Kazanç%</th><th>Ort R</th><th>Toplam R</th><th>PF</th></tr>'+k.map(n=>{const g=o[n];return '<tr><td>'+esc(n)+'</td><td>'+g.n+'</td><td>'+(g.win*100).toFixed(0)+'</td><td class="'+cl(g.avgR)+'">'+sg(g.avgR)+'</td><td class="'+cl(g.totalR)+'">'+sg(g.totalR,1)+'</td><td>'+g.pf.toFixed(2)+'</td></tr>'}).join('')+'</table>'}

function render(){if(!S)return;const m=$('main');
 if(tab==='sig'){
  const open=S.open,cls=S.closed;let h='';
  if(S.dayStop)h+='<div class="note y">Günlük zarar limiti doldu ('+S.cfg.dayStop+'R). Yarına kadar yeni sinyal gelmez.</div>';
  if(sel){const s=open.concat(cls).find(q=>q.id===sel);if(s){h+='<div class="row" style="margin-bottom:8px"><button id="back">← Listeye dön</button></div>'+detail(s);m.innerHTML=h;$('back').onclick=()=>{sel=null;render()};if($('cb')){$('cb').oninput=$('cr').oninput=()=>calcUpd(s);calcUpd(s)}if(cd&&cd.sym===s.symbol)drawChart(cd.d,s);loadChart(s.symbol);return}}
  h+='<h3>Açık işlemler ('+open.length+')</h3>'+(open.length?open.map(sigCard).join(''):'<div class="note">Şu an açık sinyal yok. Yeni sinyal 15 dakikalık mum kapanışında düşer, ses çıkar ve Telegram gelir.</div>');
  h+='<h3>Kapananlar</h3>'+(cls.length?cls.slice(0,30).map(sigCard).join(''):'<div class="note">Henüz kapanan işlem yok.</div>');
  m.innerHTML=h;m.querySelectorAll('.card[data-id]').forEach(c=>c.onclick=()=>{sel=c.dataset.id;cd=null;render()});
 }else if(tab==='near'){
  m.innerHTML='<div class="note">Bunlar SİNYAL DEĞİL, sadece bilgi: 1H trendi yönünde, son 8 saatin zirvesine/dibine yakın coinler. Gerçek sinyal, 15 dakikalık mum seviyenin ötesinde KAPANIRSA ve hacim yeterliyse düşer.</div>'+(S.radar.length?S.radar.map(nearCard).join(''):'<div class="note">Şu an yaklaşan yok.</div>');
 }else if(tab==='stat'){
  const a=S.stats.all,t=S.stats.today;
  m.innerHTML='<h3>Genel (kapanan işlemler, maliyet düşülmüş)</h3>'+tbl({'Bugün':t,'Tümü':a})+'<h3>Yöne göre</h3>'+tbl(S.stats.byDir)+'<h3>Çıkışa göre</h3>'+tbl(S.stats.byExit)+'<div class="note">R = riskin katı. -1R = stopta kayıp, +1.5R = hedef 1. En az 100 kapanan işlem olmadan strateji hakkında hüküm verme. Son taramada elenme nedenleri: '+esc(Object.entries(S.scan.reasons||{}).map(e=>e[0]+' '+e[1]).join(' • '))+'</div><canvas id="eq" style="height:140px"></canvas>';
  const c=$('eq');if(c&&S.equity.length){const W=c.clientWidth,H=c.clientHeight,dp=devicePixelRatio||1;c.width=W*dp;c.height=H*dp;const x=c.getContext('2d');x.scale(dp,dp);const v=S.equity,mn=Math.min(0,...v),mx=Math.max(.1,...v),Y=q=>H-10-(q-mn)/(mx-mn)*(H-20);x.strokeStyle='#3b82f6';x.beginPath();v.forEach((q,i)=>{const X=i/(Math.max(1,v.length-1))*W;i?x.lineTo(X,Y(q)):x.moveTo(X,Y(q))});x.stroke();x.strokeStyle='#444';x.beginPath();x.moveTo(0,Y(0));x.lineTo(W,Y(0));x.stroke()}
 }else if(tab==='bt'){btView()}}

function btView(){const m=$('main');const R=bt&&bt.result;
 let h='<div class="note">Geçmiş testi: aynı sinyal kodu geçmiş 15m mumlarda çalıştırılır. Aynı mumda stop ve hedef varsa stop önce sayılır (kötümser).</div><div class="row"><select id="bd"><option>14</option><option selected>30</option><option>60</option><option>90</option></select> gün <select id="bc"><option>20</option><option selected>40</option><option>80</option><option>100</option></select> coin <select id="bm"><option value="1">Maliyet x1</option><option value="2">Maliyet x2 (stres)</option></select><button id="bg">Testi başlat</button></div>';
 if(bt&&bt.running)h+='<div class="note">'+esc(bt.msg)+' '+bt.done+'/'+bt.total+'</div>';
 if(bt&&bt.error)h+='<div class="note r">'+esc(bt.error)+'</div>';
 if(R){const a=R.all;h+='<h3>Sonuç ('+R.days+' gün, '+R.coins+' coin)</h3>'+tbl({'Tümü':R.all,'İlk yarı':R.first,'İkinci yarı':R.second})+'<div class="note">Günde '+R.perDay.toFixed(1)+' işlem | medyan '+sg(R.median)+'R | t-değeri '+a.t+' | maks düşüş '+a.dd.toFixed(1)+'R<br><b style="color:var(--tx)">'+(a.n<100?'Örnek küçük (100 işlem altı): karar verme.':a.avgR<=0?'Ortalama R negatif: strateji bu dönemde kazandırmadı.':(R.first.avgR>0&&R.second.avgR>0&&a.t>=2)?'İki yarı da pozitif ve t≥2: umut verici, ama önce canlı ileri test yap.':'Belirsiz: yarılar tutarsız ya da t düşük.')+'</b></div><h3>Yöne göre</h3>'+tbl(R.byDir)+'<h3>Çıkışa göre</h3>'+tbl(R.byExit)+'<div class="note">Eleme nedenleri: '+esc(Object.entries(R.funnel).map(e=>e[0]+' '+e[1]).join(' • '))+(R.skipped.length?'<br>Verisi yetersiz atlanan: '+esc(R.skipped.join(', ')):'')+'</div>'}
 m.innerHTML=h;const g=$('bg');if(g)g.onclick=()=>{fetch('/api/backtest?key='+encodeURIComponent(key),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({days:+$('bd').value,coins:+$('bc').value,costMult:+$('bm').value})}).then(r=>{if(r.status===401){key=prompt('Yönetici anahtarı (ADMIN_KEY):')||'';localStorage.setItem('st_key',key)}else setTimeout(pollBt,800)})}}
function pollBt(){fetch('/api/backtest').then(r=>r.json()).then(d=>{bt=d;if(tab==='bt'){const t=document.activeElement&&document.activeElement.tagName;if(t!=='SELECT'&&t!=='INPUT')btView()}if(d.running)setTimeout(pollBt,3000)})}

function top(){const M=S.market,f=(x,k)=>x?k+' '+fp(x.price)+' <span class="'+cl(x.chg)+'">'+sg(x.chg||0,1)+'%</span>':'';
 $('mk').innerHTML=f(M.btc,'BTC')+' &nbsp; '+f(M.eth,'ETH')+' &nbsp; <span class="mu">BTC 1H '+(M.trend===1?'YUKARI':M.trend===-1?'AŞAĞI':'YATAY')+'</span>';
 $('sum').innerHTML='<span>Açık kâr/zarar: <b class="'+cl(S.openPnlR)+'">'+sg(S.openPnlR)+'R</b></span><span>Bugün kapanan: <b class="'+cl(S.todayR)+'">'+sg(S.todayR)+'R</b></span><span class="mu">Açık '+S.open.length+'/'+S.cfg.maxOpen+'</span>'}
function poll(){fetch('/api/state').then(r=>r.json()).then(d=>{S=d;$('conn').textContent='Bağlı';$('conn').className='mu g';
  const newest=d.open.concat(d.closed).reduce((a,s)=>Math.max(a,s.time),0);if(lastTop!==null&&newest>lastTop){beep();document.title='🚨 YENİ SİNYAL';setTimeout(()=>document.title='SONER TRADE v15',8000);tab='sig';sel=null;document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('on',x.dataset.t==='sig'))}lastTop=newest;
  top();const t=document.activeElement&&document.activeElement.tagName;
  if(tab==='sig'&&sel&&$('dP')){const s=d.open.concat(d.closed).find(q=>q.id===sel);if(s){$('dP').textContent=fp(s.price||s.lastPrice);$('dR').textContent=sg(s.pnlR)+'R';$('dR').className='big '+cl(s.pnlR);$('dPct').textContent=sg(s.pnlPct)+'%';$('dPct').className=cl(s.pnlPct);if(cd&&cd.sym===s.symbol)drawChart(cd.d,s)}return}
  if(t==='INPUT'||t==='SELECT')return;render()}).catch(()=>{$('conn').textContent='Bağlantı yok';$('conn').className='mu r'})}
setInterval(poll,3000);setInterval(()=>{if(tab==='sig'&&sel&&S){const s=S.open.concat(S.closed).find(q=>q.id===sel);if(s)loadChart(s.symbol)}},6000);poll();
</script></body></html>`;

// ------------------------- HTTP -------------------------
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise(r => { let b = ''; req.on('data', d => { b += d; if (b.length > 1e5) { r({}); req.destroy(); } }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch (e) { r({}); } }); req.on('error', () => r({})); });
const authed = u => !ADMIN_KEY || u.searchParams.get('key') === ADMIN_KEY;

const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    try {
        if (u.pathname === '/' || u.pathname === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(HTML); }
        if (u.pathname === '/health') return json(res, 200, { ok: true, lastScan: scan.last, universe: universe.length });
        if (u.pathname === '/api/state') return json(res, 200, apiState());
        if (u.pathname === '/api/candles') return json(res, 200, await apiCandles(u.searchParams.get('symbol') || ''));
        if (u.pathname === '/api/export') return json(res, 200, { signals, lastSig });
        if (u.pathname === '/api/backtest' && req.method === 'GET') return json(res, 200, btJob);
        if (u.pathname === '/api/backtest' && req.method === 'POST') {
            if (!authed(u)) return json(res, 401, { error: 'yetkisiz' });
            const b = await readBody(req);
            const days = [14, 30, 60, 90].includes(b.days) ? b.days : 30, coins = [20, 40, 80, 100].includes(b.coins) ? b.coins : 40, costMult = b.costMult === 2 ? 2 : 1;
            if (!btJob.running) runBacktest(days, coins, costMult);
            return json(res, 200, { started: true });
        }
        if (u.pathname === '/api/reset' && req.method === 'POST') {
            if (!ADMIN_KEY) return json(res, 403, { error: 'ADMIN_KEY tanımlı değil; sıfırlama kapalı' });
            if (!authed(u)) return json(res, 401, { error: 'yetkisiz' });
            signals = []; lastSig = {}; dirty = true; saveState(); return json(res, 200, { ok: true });
        }
        json(res, 404, { error: 'yok' });
    } catch (e) { json(res, 500, { error: e.message }); }
});

async function start() {
    try {
        loadState();
        await ex.loadMarkets(); log('marketler:', Object.keys(ex.markets).length);
        await refreshUniverse(); log('evren:', universe.length, 'coin');
        setInterval(refreshUniverse, CFG.UNIVERSE_MS); setInterval(liveTick, CFG.TICK_MS);
        setInterval(saveState, 10e3); setInterval(async () => { if (SELF_URL) { try { await fetch(SELF_URL + '/health'); } catch (e) { } } }, 10 * 60e3);
        lastScanSlot = Math.floor((Date.now() - CFG.SCAN_DELAY_MS) / M15);
        runScan();
        setInterval(() => { const slot = Math.floor((Date.now() - CFG.SCAN_DELAY_MS) / M15); if (slot > lastScanSlot && !scan.running) { lastScanSlot = slot; runScan(); } }, 3000);
        log('SONER TRADE v15 hazır | Kırılım stratejisi | pencere ' + CFG.LOOK + ' mum | hacim>=' + CFG.VOL_MIN + 'x');
    } catch (e) { log('başlatma hatası', e.message); setTimeout(start, 30000); }
}
function shutdown() { dirty = true; saveState(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

if (require.main === module) server.listen(PORT, '0.0.0.0', () => { log('PORT', PORT); start(); });
module.exports = { signalAt, step, stepCandle, buildSym, grp };
