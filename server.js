'use strict';
// ============================================================
// SONER TRADE v35 — TEK DOSYA (v34 iskeleti + arayüzü korunarak)
//   Casus çıkarıldı. Yerine:
//     1) FADE  : aşırı uzamış hacimli 1 dk mum (spike) sonrası dönüş mumu TEYİT EDİLİNCE ters yönde sanal sinyal.
//     2) LAB   : her spike'tan sonra 5/15/30/60 dk getiriyi stop/TP'den bağımsız ölçer.
//     3) ÜÇGEN : v34'teki gibi korunur.
//     4) Karne : güven aralıklı gerçek skor.
//   Tüm işlemler SANAL takip edilir.
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ccxt = require('ccxt');

const clamp = (x, a = -1, b = 1) => Math.max(a, Math.min(b, x));
const th = Math.tanh;
function ema(v, p) { const k = 2 / (p + 1); let e = v[0]; const o = [e]; for (let i = 1; i < v.length; i++) { e = v[i] * k + e * (1 - k); o.push(e); } return o; }
const trAt = (c, i) => Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - c[i - 1][4]), Math.abs(c[i][3] - c[i - 1][4]));
const trMean = (c, n) => { let s = 0; for (let i = c.length - n; i < c.length; i++) s += trAt(c, i); return s / n; };
function trendScore(c) { const cl = c.map(x => x[4]), e21 = ema(cl, 21), e50 = ema(cl, 50), n = cl.length - 1; const a = trMean(c, 14) || 1e-9; return 0.4 * th((cl[n] - e50[n]) / a / 2) + 0.3 * th((e21[n] - e50[n]) / a) + 0.3 * th((e21[n] - e21[n - 3]) / a * 2); }
function effRatio(c, n) { const s = c.slice(-n - 1); let path = 0; for (let i = 1; i < s.length; i++) path += Math.abs(s[i][4] - s[i - 1][4]); return path ? Math.abs(s[s.length - 1][4] - s[0][4]) / path : 0; }
function createRegime() {
    const BTC = 'BTC/USDT:USDT', ETH = 'ETH/USDT:USDT';
    let state = null;
    async function tick(ex) {
        try {
            const c = (await ex.fetchOHLCV(BTC, '1m', undefined, 140)).filter(x => x[0] + 60e3 <= Date.now());
            const n = c.length; if (n < 100) return state;
            let pth = 0; for (let i = n - 60; i < n; i++) pth += Math.abs(c[i][4] - c[i - 1][4]);
            const er = pth ? Math.abs(c[n - 1][4] - c[n - 61][4]) / pth : 0;
            const ret60 = (c[n - 1][4] / c[n - 61][4] - 1) * 100;
            const a = trMean(c.slice(-30), 14), a0 = trMean(c.slice(-60, -30), 14), vr = a / (a0 || 1e-9);
            state = { tag: vr > 1.8 ? 'VOLATİL' : er < 0.25 ? 'YATAY' : 'TREND', er: Number(er.toFixed(3)), ret60: Number(ret60.toFixed(3)), vr: Number(vr.toFixed(3)), t: Date.now() };
        } catch (e) { }
        return state;
    }
    return { tick, get state() { return state; } };
}

const num = (k, d) => process.env[k] == null || process.env[k] === '' ? d : Number(process.env[k]);
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state35.json');
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const UI_KEY = process.env.UI_KEY || '';
const M1 = 60e3, M15 = 15 * M1, H1 = 3600e3;
const BTC = 'BTC/USDT:USDT', ETH = 'ETH/USDT:USDT';
const NON_CRYPTO = ['USDC','USDT','DAI','TUSD','BUSD','FDUSD','USDE','SUSDE','USDS','USD1','PYUSD','USDD','FRAX','LUSD','GUSD','BUIDL','USTC','USDP','WBTC','WETH','WSTETH','STETH','RETH','CBETH','WBNB','WAVAX','WMATIC','PAXG','XAUT','XAU','XAG','XPT','XPD','GOLD','SILVER','OIL','WTI','BRENT','USOIL','UKOIL','AAPL','MSFT','GOOGL','AMZN','META','TSLA','NVDA','AMD','INTC','ORCL','NFLX','COIN','HOOD','CRCL','MSTR','MARA','RIOT','PLTR','SPY','QQQ','SPCX','SNDK','ARM','SMCI','GME','AMC'];

const CFG = {
    UNIVERSE: num('UNIVERSE', 120), MIN_VOL: num('MIN_VOL', 10e6), MIN_LISTING_DAYS: num('MIN_LISTING_DAYS', 7),
    EXCLUDED: NON_CRYPTO.concat((process.env.EXCLUDE || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean)),
    SLIP_PCT: num('SLIP_PCT', 0.03), CONCURRENCY: num('SCAN_CONCURRENCY', 3),
    SNAP_MS: 15e3, HIST_MS: 40 * M1, S1_MOVE3: num('S1_MOVE3', 0.8), S1_MOVE15: num('S1_MOVE15', 2.0), S1_VOLX: num('S1_VOLX', 2.5),
    S2_MAX: num('S2_MAX', 20), S2_CD: num('S2_CD', 120e3),
    SPIKE_ATR: num('SPIKE_ATR', 2.5), SPIKE_VOLX: num('SPIKE_VOLX', 3.0), EXT_ATR: num('EXT_ATR', 4.0), SPIKE_MAXAGE: 4 * M1,
    WAIT_MIN: num('WAIT_MIN', 3), STOP_BUF_ATR: num('STOP_BUF_ATR', 0.3),
    MIN_RISK_PCT: num('MIN_RISK_PCT', 0.5), MAX_RISK_PCT: num('MAX_RISK_PCT', 2.0),
    MAX_COST_R: num('MAX_COST_R', 0.25), MIN_RETR_R: num('MIN_RETR_R', 1.5), TP1_R: num('TP1_R', 1.0), TP2_MAX_R: num('TP2_MAX_R', 3.0),
    TRAIL_R: num('TRAIL_R', 1.0), MAX_HOLD_MIN: num('MAX_HOLD_MIN', 45), FADE_CD_MIN: num('FADE_CD_MIN', 30),
    MAX_OPEN: num('MAX_OPEN', 12), MAX_DIR: num('MAX_DIR', 6), ALT_ON: num('ALT_ON', 1), MAX_ALT: num('MAX_ALT', 60),
    LAB_KEEP: num('LAB_KEEP', 2000),
    TRI_UNIVERSE: num('TRI_UNIVERSE', 60),
    TRI_K: 3, TRI_LOOK: 150, TRI_MIN_LEN: 15, TRI_MAX_LEN: 100, TRI_TOL_ATR: 0.30, TRI_WICK_ATR: 0.60, TRI_CLOSE_ATR: 0.20, TRI_MIN_TOUCH: 3, TRI_SQUEEZE: 0.85, TRI_FLAT: 0.12,
    NEAR_ATR: num('NEAR_ATR', 0.4), BRK_SEE: num('BRK_SEE', 0.8), BRK_ATR: num('BRK_ATR', 0.15), BRK_VOL: num('BRK_VOL', 1.3), FRESH_MIN: num('FRESH_MIN', 5), MAX_CHASE: num('MAX_CHASE', 0.6),
    BK_MAX_ATR15: 2.5, STOP_ATR15: num('STOP_ATR15', 2.0), STOP_MIN_PCT: num('STOP_MIN_PCT', 0.8), TRI_MIN_RISK: 0.3, TRI_MAX_RISK: 6.0,
    TRI_MAX_COST_R: num('TRI_MAX_COST_R', 0.35), TRI_MIN_RR: 0.8, TRI_TP2_MAX: 5, TRI_HOLD_H: num('TRI_HOLD_H', 12), TRI_CD_MIN: num('TRI_CD_MIN', 45), TRI_MAX_OPEN: num('TRI_MAX_OPEN', 10),
    GATE_TH: num('GATE_TH', 0.15), GATE_STRICT: num('GATE_STRICT', 0), GATE_BRK: num('GATE_BRK', 1), RADAR_LOCK_H: num('RADAR_LOCK_H', 6)
};
const HZ = [5, 15, 30, 60];

const log = (...a) => console.log('[SONER]', ...a);
const baseOf = s => s.split('/')[0];
const isMajor = s => /^(BTC|ETH)\//.test(s);
const r2 = x => Number(Number(x).toFixed(3));
const r3 = r2;
const trDay = t => new Date(t + 3 * H1).toISOString().slice(0, 10);
const costFor = vol => { const v = vol || 0; return v >= 200e6 ? 0.14 : v >= 50e6 ? 0.18 : v >= 10e6 ? 0.25 : 0.35; };
const closedOnly = (c, ms, now = Date.now()) => c.filter(x => x[0] + ms <= now);
const fmt = p => { const a = Math.abs(p); return a >= 1000 ? p.toFixed(2) : a >= 1 ? p.toFixed(4) : a >= 0.01 ? p.toFixed(5) : p.toFixed(7); };
const isOpen = s => s.status === 'OPEN' || s.status === 'TP1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const median = a => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const flatRatio = c => { const a = c.slice(-48); let f = 0; for (const x of a) if (x[2] === x[3] || !x[5]) f++; return a.length ? f / a.length : 1; };
const hasGap = (c, ms, n) => { const a = c.slice(-n); for (let i = 1; i < a.length; i++) if (a[i][0] - a[i - 1][0] !== ms) return true; return false; };
const atrMean = (c, p = 14) => { if (c.length <= p) return 0; let s = 0; for (let i = c.length - p; i < c.length; i++) s += trAt(c, i); return s / p; };
function atrSeries(c, p = 14) { const o = new Array(c.length).fill(null); if (c.length <= p) return o; let a = 0; for (let i = 1; i <= p; i++) a += trAt(c, i); a /= p; o[p] = a; for (let i = p + 1; i < c.length; i++) { a = (a * (p - 1) + trAt(c, i)) / p; o[i] = a; } return o; }
const aggregateN = (c, baseMs, n) => { const ms = baseMs * n, g = new Map(); for (const x of c) { const k = Math.floor(x[0] / ms) * ms; let a = g.get(k); if (!a) { a = [k, x[1], x[2], x[3], x[4], x[5], 1]; g.set(k, a); } else { a[2] = Math.max(a[2], x[2]); a[3] = Math.min(a[3], x[3]); a[4] = x[4]; a[5] += x[5]; a[6]++; } } return [...g.values()].filter(a => a[6] === n); };
const REQ = { last: 0, gap: num('REQ_GAP_MS', 250) };
async function safeFetch(ex, sym, tf, limit, since) { const wait = REQ.gap - (Date.now() - REQ.last); if (wait > 0) await sleep(wait); REQ.last = Date.now(); for (let attempt = 1; attempt <= 3; attempt++) { try { const r = await ex.fetchOHLCV(sym, tf, since, limit); REQ.last = Date.now(); return r; } catch (e) { const msg = String(e.message || e); if (msg.includes('429') || msg.includes('Too Many Requests') || msg.includes('rate limit')) { log('RATE LIMIT', sym, tf); await sleep(2000 * Math.pow(2, attempt - 1)); } else throw e; } } throw new Error('Rate limit: ' + sym + ' ' + tf); }

// ======================= ÜÇGEN ALGORİTMASI =======================
function pivots(c, end, K, from) { const hi = [], lo = []; for (let i = Math.max(K, from); i <= end - K; i++) { let isH = true, isL = true; for (let d = 1; d <= K && (isH || isL); d++) { if (c[i][2] <= c[i - d][2] || c[i][2] < c[i + d][2]) isH = false; if (c[i][3] >= c[i - d][3] || c[i][3] > c[i + d][3]) isL = false; } if (isH) hi.push({ i, p: c[i][2] }); if (isL) lo.push({ i, p: c[i][3] }); } return { hi, lo }; }
function fitLine(pts, c, end, atr, side, C) { const P = pts.slice(-8); let best = null; for (let a = 0; a < P.length - 1; a++) for (let b = a + 1; b < P.length; b++) { const A = P[a], B = P[b]; if (B.i - A.i < 3) continue; const s = (B.p - A.p) / (B.i - A.i); let ok = true; for (let x = A.i; x <= end; x++) { const ln = A.p + s * (x - A.i); if (side === 1 ? (c[x][4] > ln + C.TRI_CLOSE_ATR * atr || c[x][2] > ln + C.TRI_WICK_ATR * atr) : (c[x][4] < ln - C.TRI_CLOSE_ATR * atr || c[x][3] < ln - C.TRI_WICK_ATR * atr)) { ok = false; break; } } if (!ok) continue; const pts2 = []; for (const p of P) if (p.i >= A.i && Math.abs(p.p - (A.p + s * (p.i - A.i))) <= C.TRI_TOL_ATR * atr) pts2.push(p); if (pts2.length < 2) continue; const lastI = pts2[pts2.length - 1].i; if (end - lastI > 40) continue; const score = pts2.length * 1000 + (lastI - A.i) * 2; if (!best || score > best.score) best = { i0: A.i, p0: A.p, s, touches: pts2.length, last: lastI, score, pts: pts2 }; } return best; }
function detectTriangle(c, end, C) { if (end < 50) return null; const atr = atrSeries(c, 14)[end]; if (!(atr > 0)) return null; const pv = pivots(c, end, C.TRI_K, Math.max(1, end - C.TRI_LOOK)); if (pv.hi.length < 2 || pv.lo.length < 2) return null; const R = fitLine(pv.hi, c, end, atr, 1, C), S = fitLine(pv.lo, c, end, atr, -1, C); if (!R || !S) return null; if (R.touches + S.touches < C.TRI_MIN_TOUCH) return null; const xs = Math.max(R.i0, S.i0), len = end - xs; if (len < C.TRI_MIN_LEN || len > C.TRI_MAX_LEN) return null; const rv = x => R.p0 + R.s * (x - R.i0), sv = x => S.p0 + S.s * (x - S.i0); const w0 = rv(xs) - sv(xs), wN = rv(end) - sv(end); if (!(w0 > 0 && wN > 0)) return null; if (wN / w0 > C.TRI_SQUEEZE) return null; if (wN < 0.4 * atr) return null; const dsl = S.s - R.s; if (!(dsl > 0)) return null; const apex = end + wN / dsl; if (apex - end > 100) return null; const flatTol = C.TRI_FLAT * w0 / len; const rf = Math.abs(R.s) <= flatTol, sf = Math.abs(S.s) <= flatTol; let type = 'Simetrik'; if (rf && S.s > flatTol) type = 'Yükselen'; else if (sf && R.s < -flatTol) type = 'Alçalan'; else if (R.s > flatTol && S.s > flatTol) type = 'Yükselen Kama'; else if (R.s < -flatTol && S.s < -flatTol) type = 'Alçalan Kama'; return { type, end, atr, w0, wN, apex, len, R, S, touches: R.touches + S.touches, squeeze: wN / w0 }; }

// ======================= DURUM =======================
const ex = new ccxt.bitget({ enableRateLimit: true, options: { defaultType: 'swap' } });
const regime = createRegime(); let REG = null;
let universe = [], tickers = {}, market = { btc: null, eth: null, lastTick: 0 };
let dirty = false, lastSig = {};
let fade = [], fadeAlt = [], triPos = [], lab = [], shadow = [];
const hist = new Map(), watch = {}, seen = {}, spikeSeen = new Map(), candleCache = new Map(), c15Cache = new Map(), candleCacheFull = new Map();
const struct = {};
let triRadar = [], triScanInfo = { last: 0, ms: 0, n: 0, running: false }, lastTriSlot = 0;
const fc = { running: false, last: 0, ms: 0, dg: null }, tt = { running: false };
let tracking = false, tgTimes = [];
let live = { last: 0, ms: 0, n: 0, err: '' };

function loadState() { try { const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); fade = j.fade || []; fadeAlt = j.alt || []; triPos = j.tri || []; lab = j.lab || []; shadow = j.shadow || []; lastSig = j.lastSig || {}; log('durum:', fade.length, 'fade,', fadeAlt.length, 'ters,', triPos.length, 'üçgen,', lab.length, 'lab'); } catch (e) { log('temiz başlangıç (v35).'); } }
function saveState() { if (!dirty) return; dirty = false; try { const cut = Date.now() - 24 * H1; for (const k of Object.keys(lastSig)) if (lastSig[k] < cut) delete lastSig[k]; fs.mkdirSync(DATA_DIR, { recursive: true }); const tmp = STATE_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ fade: fade.slice(0, 300), alt: fadeAlt.slice(0, 400), tri: triPos.slice(0, 200), lab: lab.slice(0, CFG.LAB_KEEP), shadow: shadow.slice(0, 300), lastSig })); fs.renameSync(tmp, STATE_FILE); } catch (e) { log('kayıt hatası', e.message); } }
async function telegram(text) { if (!TG_TOKEN || !TG_CHAT) return; const now = Date.now(); tgTimes = tgTimes.filter(t => now - t < 60e3); if (tgTimes.length >= 18) return; tgTimes.push(now); try { await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true }) }); } catch (e) { } }
const tvLink = (base, iv) => 'https://www.tradingview.com/chart/?symbol=BITGET:' + base + 'USDT.P&interval=' + iv;

// ======================= POZİSYON =======================
function mkPos(o) { const L = o.dir === 'LONG' ? 1 : -1, riskAbs = L * (o.entry - o.stop), riskPct = riskAbs / o.entry * 100; return Object.assign({ id: o.id, strategy: o.strategy, symbol: o.sym, base: baseOf(o.sym), dir: o.dir, time: o.time, entry: o.entry, stop: o.stop, initialStop: o.stop, riskAbs, riskPct: r3(riskPct), costR: r3(o.costPct / riskPct), tp1R: o.tp1R, tp2R: o.tp2R, tp1: o.entry + L * riskAbs * o.tp1R, tp2: o.entry + L * riskAbs * o.tp2R, trail: CFG.TRAIL_R, maxHold: o.maxHold, status: 'OPEN', lastPrice: o.entry, mfe: 0, mae: 0, mfeP: 0, maeP: 0, trackedTo: Math.floor(o.time / M1) * M1 }, o.extra || {}); }
const curR = (s, price) => (s.dir === 'LONG' ? 1 : -1) * (price - s.entry) / Math.abs(s.entry - s.initialStop);
function closeSig(s, status, gross, t, px) { s.status = status; s.grossR = r3(gross); s.netR = r3(gross - s.costR); s.closedAt = t; s.exitPrice = px; }
function advance(s, k, dur) { dur = dur || M1; const L = s.dir === 'LONG', side = L ? 1 : -1, risk = Math.abs(s.entry - s.initialStop), end = k[0] + dur, el = k[0] - s.time; s.lastPrice = k[4]; s.mfe = Math.max(s.mfe || 0, side * (k[L ? 2 : 3] - s.entry) / risk); s.mae = Math.min(s.mae || 0, side * (k[L ? 3 : 2] - s.entry) / risk); s.mfeP = Math.max(s.mfeP || 0, side * (k[L ? 2 : 3] - s.entry) / s.entry * 100); s.maeP = Math.min(s.maeP || 0, side * (k[L ? 3 : 2] - s.entry) / s.entry * 100); if (s.status === 'OPEN') { if (L ? k[3] <= s.stop : k[2] >= s.stop) { closeSig(s, 'STOP', -1, end, s.stop); return true; } if (L ? k[2] >= s.tp1 : k[3] <= s.tp1) { s.status = 'TP1'; s.stop = s.entry; s.tp1At = k[0]; return false; } } else if (s.status === 'TP1' && k[0] > s.tp1At) { const prev = s.stop; if (L ? k[3] <= prev : k[2] >= prev) { closeSig(s, prev === s.entry ? 'BE' : 'TRAIL', 0.5 * s.tp1R + 0.5 * curR(s, prev), end, prev); return true; } const hh = L ? k[2] : k[3], ts = s.entry + side * Math.max(0, side * (hh - s.entry) / risk - s.trail) * risk; if (L ? ts > s.stop : ts < s.stop) s.stop = ts; if (L ? k[2] >= s.tp2 : k[3] <= s.tp2) { closeSig(s, 'TP2', 0.5 * s.tp1R + 0.5 * s.tp2R, end, s.tp2); return true; } } if (el >= s.maxHold && isOpen(s)) { const r = curR(s, k[4]); closeSig(s, 'SÜRE', s.status === 'TP1' ? 0.5 * s.tp1R + 0.5 * r : r, end, k[4]); return true; } return false; }

// ======================= LAB =======================
function labAdd(type, sym, dir, p0, extra) { const tk = tickers[sym] || {}, now = Date.now(); lab.unshift(Object.assign({ id: type + '_' + sym + '_' + now, type, symbol: sym, base: baseOf(sym), dir, t: now, p0, cost: costFor(tk.quoteVolume) + 2 * CFG.SLIP_PCT, reg: REG ? REG.tag : '-', r: {}, sk: {} }, extra || {})); if (lab.length > CFG.LAB_KEEP) lab.length = CFG.LAB_KEEP; dirty = true; }
function labFill(now) { for (const e of lab) { if (e.done) continue; const tk = tickers[e.symbol]; if (!tk || !tk.last) continue; const sgn = (e.dir === 'UP' || e.dir === 'LONG') ? 1 : -1; let all = true; for (const h of HZ) { if (e.r[h] != null || e.sk[h]) continue; const due = e.t + h * M1; if (now < due) { all = false; continue; } if (now - due > 3 * M1) { e.sk[h] = 1; continue; } e.r[h] = r3(sgn * (tk.last / e.p0 - 1) * 100); dirty = true; } if (all) e.done = true; } }

// ======================= İSTATİSTİK =======================
function grp(list) { const n = list.length; if (!n) return { n: 0, win: 0, avgR: 0, totalR: 0, pf: 0, dd: 0, t: 0, lo: 0, hi: 0 }; let tot = 0, w = 0, gp = 0, gl = 0, eq = 0, pk = 0, dd = 0, sq = 0; for (const s of list) { tot += s.netR; if (s.netR > 0) { w++; gp += s.netR; } else gl -= s.netR; eq += s.netR; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); sq += s.netR * s.netR; } const avg = tot / n; let t = 0, se = 0; if (n > 1) { const v = Math.max(0, (sq - n * avg * avg) / (n - 1)); se = Math.sqrt(v / n); t = se > 0 ? avg / se : 0; } const z = n >= 30 ? 1.96 : 2.3; return { n, win: w / n, avgR: avg, totalR: tot, pf: gl > 0 ? gp / gl : (gp > 0 ? 99 : 0), dd, t: Number(t.toFixed(2)), lo: avg - z * se, hi: avg + z * se }; }
function groupBy(list, fn) { const m = {}; for (const s of list) { const k = fn(s); (m[k] = m[k] || []).push(s); } const o = {}; Object.keys(m).sort().forEach(k => { o[k] = grp(m[k]); }); return o; }
const doneOf = list => list.filter(s => !isOpen(s) && s.netR != null);
function verdictOf(g) { if (g.n < 30) return { lvl: 'w', txt: 'Karne henüz oluşmadı (' + g.n + '/30 işlem). Sinyale güvenme, izle.' }; if (g.lo > 0) return { lvl: 'g', txt: 'Olumlu: ortalama ' + g.avgR.toFixed(2) + 'R, %95 aralığın alt sınırı pozitif (' + g.lo.toFixed(2) + ').' }; if (g.n >= 40 && g.hi < 0) return { lvl: 'r', txt: 'Kenar yok: ortalama ' + g.avgR.toFixed(2) + 'R ve aralığın üst sınırı negatif. Bu stratejiyle işlem açma.' }; return { lvl: 'w', txt: 'Belirsiz: ortalama ' + g.avgR.toFixed(2) + 'R ama aralık sıfırı kapsıyor [' + g.lo.toFixed(2) + ', ' + g.hi.toFixed(2) + '].' }; }
const memo = {};
function cached(key, ms, fn) { const now = Date.now(), h = memo[key]; if (h && now - h.t < ms) return h.v; const v = fn(); memo[key] = { t: now, v }; return v; }
const extB = s => s.ext == null ? '?' : s.ext < 6 ? 'uzama 4-6 ATR' : s.ext < 9 ? 'uzama 6-9 ATR' : 'uzama 9+ ATR';
const costB = s => s.costR <= 0.15 ? 'maliyet ≤0.15R' : s.costR <= 0.25 ? 'maliyet 0.15-0.25R' : 'maliyet >0.25R';
const retB = s => s.retR == null ? '?' : s.retR < 2 ? 'hedef 1.5-2R' : s.retR < 3 ? 'hedef 2-3R' : 'hedef 3R+';
function fadeStats() { return cached('fs', 8000, () => { const closed = doneOf(fade), altC = doneOf(fadeAlt), today = trDay(Date.now()), all = grp(closed); let oSum = 0, oN = 0; for (const s of fade.filter(isOpen)) { oSum += curR(s, s.lastPrice || s.entry) - (s.costR || 0); oN++; } return { all, today: grp(closed.filter(s => trDay(s.closedAt) === today)), verdict: verdictOf(all), open: oN, openAvg: oN ? oSum / oN : 0, byDir: groupBy(closed, s => s.dir), byReg: groupBy(closed, s => 'Piyasa ' + (s.reg || '?')), byExt: groupBy(closed, extB), byRet: groupBy(closed, retB), byCost: groupBy(closed, costB), byExit: groupBy(closed, s => s.status), byVariant: groupBy(closed.concat(altC), s => s.variant === 'TERS' ? 'Ters yön (kontrol)' : 'FADE (ana)') }; }); }
function triStats() { return cached('ts', 8000, () => { const closed = doneOf(triPos), all = grp(closed); return { all, verdict: verdictOf(all), byType: groupBy(closed, s => s.type), byDir: groupBy(closed, s => s.dir), byExit: groupBy(closed, s => s.status), open: triPos.filter(isOpen).length }; }); }
function ciOf(a) { const n = a.length; if (!n) return null; const m = a.reduce((x, y) => x + y, 0) / n; let v = 0; for (const x of a) v += (x - m) * (x - m); const se = n > 1 ? Math.sqrt(v / (n - 1) / n) : 0, z = n >= 30 ? 1.96 : 2.3; return { m: r3(m), lo: r3(m - z * se), hi: r3(m + z * se) }; }
function labStat(list, h) { const v = list.filter(e => e.r && e.r[h] != null), n = v.length; if (!n) return null; const cont = v.map(e => e.r[h]); return { n, mean: r3(cont.reduce((a, b) => a + b, 0) / n), med: r3(median(cont)), hit: cont.filter(x => x > 0).length / n, cont: ciOf(v.map(e => e.r[h] - e.cost)), fade: ciOf(v.map(e => -e.r[h] - e.cost)) }; }
function labView() { return cached('lab', 10000, () => { const S = e => e.type === 'SPIKE', defs = [['SPIKE (hepsi)', S], ['SPIKE • yukarı', e => S(e) && e.dir === 'UP'], ['SPIKE • aşağı', e => S(e) && e.dir === 'DOWN'], ['SPIKE • piyasa YATAY', e => S(e) && e.reg === 'YATAY'], ['SPIKE • piyasa TREND', e => S(e) && e.reg === 'TREND'], ['SPIKE • piyasa VOLATİL', e => S(e) && e.reg === 'VOLATİL'], ['SPIKE • uzama 4-6 ATR', e => S(e) && e.ext < 6], ['SPIKE • uzama 6-9 ATR', e => S(e) && e.ext >= 6 && e.ext < 9], ['SPIKE • uzama 9+ ATR', e => S(e) && e.ext >= 9], ['ÜÇGEN kırılımı', e => e.type === 'TRI']]; const rows = []; for (const [name, f] of defs) { const l = lab.filter(f); for (const h of (name.indexOf('hepsi') > 0 || name.indexOf('ÜÇGEN') === 0 ? HZ : [15, 30])) { const s = labStat(l, h); if (s) rows.push(Object.assign({ grp: name, h }, s)); } } return { rows, total: lab.length, pending: lab.filter(e => !e.done).length }; }); }

// ======================= EVREN =======================
function isSuspect(sym) { if (isMajor(sym)) return false; const m = ex.markets[sym], inf = (m && m.info) || {}; if (String(inf.isRwa || inf.rwa || '').toUpperCase() === 'YES') return true; const st = String(inf.symbolType || inf.category || '').toLowerCase(); if (st && st !== 'perpetual' && st !== 'crypto') return true; const lt = Number(inf.launchTime || inf.onlineTime || 0); return lt > 1e12 && Date.now() - lt < CFG.MIN_LISTING_DAYS * 86400e3; }
async function refreshUniverse() { try { if (!Object.keys(ex.markets || {}).length) await ex.loadMarkets(); await sleep(300); tickers = await ex.fetchTickers(); market.lastTick = Date.now(); const all = Object.values(tickers).filter(t => t && t.symbol && t.symbol.endsWith(':USDT') && ex.markets[t.symbol] && ex.markets[t.symbol].linear); const ok = all.filter(t => !CFG.EXCLUDED.includes(baseOf(t.symbol).toUpperCase()) && (t.quoteVolume || 0) >= CFG.MIN_VOL && !isSuspect(t.symbol)); const top = ok.slice().sort((x, y) => (y.quoteVolume || 0) - (x.quoteVolume || 0)).slice(0, CFG.UNIVERSE).map(t => t.symbol); for (const s of [BTC, ETH]) if (!top.includes(s)) top.push(s); universe = top; const set = new Set(universe); for (const k of hist.keys()) if (!set.has(k)) hist.delete(k); for (const s of [BTC, ETH]) { const t = tickers[s]; if (t) market[s === BTC ? 'btc' : 'eth'] = { price: t.last, chg: t.percentage }; } } catch (e) { log('evren hatası', e.message); } }
function snap(t, now) { for (const sym of universe) { const k = t[sym]; if (!k || !k.last) continue; let h = hist.get(sym); if (!h) { h = []; hist.set(sym, h); } if (h.length && now - h[h.length - 1][0] < CFG.SNAP_MS) continue; h.push([now, k.last, k.quoteVolume || 0]); while (h.length && now - h[0][0] > CFG.HIST_MS) h.shift(); } }
async function refreshTickers() { try { await sleep(200); const t = await ex.fetchTickers(); tickers = t; const now = Date.now(); market.lastTick = now; for (const s of [BTC, ETH]) if (t[s]) market[s === BTC ? 'btc' : 'eth'] = { price: t[s].last, chg: t[s].percentage }; for (const list of [fade, fadeAlt, triPos, shadow]) for (const s of list) if (isOpen(s) && t[s.symbol] && t[s.symbol].last) s.lastPrice = t[s.symbol].last; snap(t, now); labFill(now); } catch (e) { } }

// ======================= FADE =======================
function fHistAt(h, now, ms) { const tgt = now - ms; for (let i = h.length - 1; i >= 0; i--) if (h[i][0] <= tgt) return (tgt - h[i][0] <= Math.max(30e3, ms * 0.5)) ? h[i] : null; return null; }
function fStage1(sym, now) { const h = hist.get(sym); if (!h || h.length < 3) return null; const a = h[h.length - 1]; if (now - a[0] > 45e3) return null; const p = a[1], qv = a[2], x3 = fHistAt(h, now, 180e3), x15 = fHistAt(h, now, 900e3); const ret = x => x ? (p / x[1] - 1) * 100 : null, r3m = ret(x3), r15 = ret(x15), avgMin = qv / 1440; const vm3 = (x3 && avgMin > 0 && qv !== x3[2]) ? Math.max(0, 1 + (qv - x3[2]) / (3 * avgMin)) : null; const fm = r3m != null && Math.abs(r3m) >= CFG.S1_MOVE3, fm15 = r15 != null && Math.abs(r15) >= CFG.S1_MOVE15, fv = vm3 != null && vm3 >= CFG.S1_VOLX; const score = (fv ? Math.min(3, vm3 / CFG.S1_VOLX) : 0) + (fm || fm15 ? 1 + Math.min(2, Math.abs(r3m || 0) / CFG.S1_MOVE3 * 0.5) : 0); return { sym, price: p, vol24: qv, r3: r3m, r15, vm3, flag: fm || fm15 || fv, score }; }
async function candles1m(sym, now) { const hit = candleCache.get(sym); if (hit && now - hit.t < 20e3) return hit.c; const c = closedOnly(await safeFetch(ex, sym, '1m', 130), M1, now); candleCache.set(sym, { t: now, c }); if (candleCache.size > 200) { const old = [...candleCache.entries()].sort((a, b) => a[1].t - b[1].t).slice(0, 60); for (const o of old) candleCache.delete(o[0]); } return c; }
function detectSpike(c, now) { const n = c.length; if (n < 60) return null; const atr = atrSeries(c, 14), vols = c.map(x => x[5]); for (let j = n - 1; j >= n - 3; j--) { if (j < 40 || now - (c[j][0] + M1) > CFG.SPIKE_MAXAGE) continue; const a = atr[j - 1]; if (!(a > 0)) continue; const b = c[j], rng = b[2] - b[3]; if (!(rng > 0)) continue; const mv = median(vols.slice(j - 30, j)); if (!(mv > 0)) continue; const vx = b[5] / mv; if (rng < CFG.SPIKE_ATR * a || vx < CFG.SPIKE_VOLX) continue; const d = b[4] >= b[1] ? 1 : -1, ext = d * (b[4] - c[j - 10][4]) / a; if (ext < CFG.EXT_ATR) continue; return { t: b[0], dir: d === 1 ? 'UP' : 'DOWN', hi: b[2], lo: b[3], open: b[1], close: b[4], atr: a, vx: r3(vx), rngAtr: r3(rng / a), ext: r3(ext) }; } return null; }
function confirmSpike(w, c) { const up = w.dir === 'UP', after = c.filter(k => k[0] > w.t); for (const k of after.slice(0, CFG.WAIT_MIN)) { if (up ? k[2] > w.hi + 0.1 * w.atr : k[3] < w.lo - 0.1 * w.atr) return { st: 'extended' }; const rng = (k[2] - k[3]) || 1e-12, pos = (k[4] - k[3]) / rng; if (up ? (k[4] < w.close && pos <= 0.5) : (k[4] > w.close && pos >= 0.5)) return { st: 'ok', k }; } return { st: after.length >= CFG.WAIT_MIN ? 'expired' : 'wait' }; }
function fadePlan(w, price, vol24) { const dir = w.dir === 'UP' ? 'SHORT' : 'LONG', L = dir === 'LONG' ? 1 : -1; const stop = L === 1 ? w.lo - CFG.STOP_BUF_ATR * w.atr : w.hi + CFG.STOP_BUF_ATR * w.atr; const risk = L * (price - stop); if (!(risk > 0)) return { skip: 'geometry' }; const riskPct = risk / price * 100; if (riskPct < CFG.MIN_RISK_PCT || riskPct > CFG.MAX_RISK_PCT) return { skip: 'risk' }; const costPct = costFor(vol24) + 2 * CFG.SLIP_PCT, costR = costPct / riskPct; if (costR > CFG.MAX_COST_R) return { skip: 'cost' }; const retR = L * (w.open - price) / risk; if (retR < CFG.MIN_RETR_R) return { skip: 'rr' }; return { dir, L, stop, risk, riskPct, costPct, costR, retR, tp2R: Math.min(retR, CFG.TP2_MAX_R) }; }
function recordOf(g) { return g.n ? 'Sistem karnesi: ' + g.n + ' işlem • ort ' + (g.avgR > 0 ? '+' : '') + g.avgR.toFixed(2) + 'R • PF ' + g.pf.toFixed(2) : 'Sistem karnesi: henüz kapanan işlem yok'; }
function fadeMsg(p) { const fs = fadeStats(); return '⚡ FADE ' + (p.dir === 'LONG' ? '🟢 LONG ' : '🔴 SHORT ') + p.base + ' (aşırı ' + (p.dir === 'LONG' ? 'düşüş' : 'yükseliş') + ' sonrası dönüş teyitli)\nGiriş ' + fmt(p.entry) + ' • Stop ' + fmt(p.stop) + ' (%' + p.riskPct.toFixed(2) + ') • TP1 ' + fmt(p.tp1) + ' • TP2 ' + fmt(p.tp2) + '\nMaliyet ' + p.costR.toFixed(2) + 'R • uzama ' + p.ext + ' ATR • hacim ' + p.volX + 'x • piyasa ' + p.reg + '\n' + recordOf(fs.all) + ' — ' + fs.verdict.txt + '\n📈 ' + tvLink(p.base, 1); }
async function openFade(sym, w, now, dg) { const tk = tickers[sym]; if (!tk || !tk.last) { dg.skip.price = (dg.skip.price || 0) + 1; return; } const sk = 'F|' + sym, sk2 = (n) => dg.skip[n] = (dg.skip[n] || 0) + 1; if (now - (lastSig[sk] || 0) < CFG.FADE_CD_MIN * M1) return sk2('cooldown'); if (fade.some(x => x.symbol === sym && isOpen(x))) return sk2('open'); if (fade.filter(isOpen).length >= CFG.MAX_OPEN) return sk2('cap'); const pl = fadePlan(w, tk.last, tk.quoteVolume); if (pl.skip) return sk2(pl.skip); if (fade.filter(x => isOpen(x) && x.dir === pl.dir).length >= CFG.MAX_DIR) return sk2('dir'); const extra = { variant: 'ANA', ext: w.ext, volX: w.vx, rngAtr: w.rngAtr, retR: r3(pl.retR), reg: REG ? REG.tag : '-', spikeAt: w.t, spikeHi: w.hi, spikeLo: w.lo }; const pos = mkPos({ id: 'FADE_' + sym.replace(/[^A-Z0-9]/g, '') + '_' + now, strategy: 'FADE', sym, dir: pl.dir, time: now, entry: tk.last, stop: pl.stop, tp1R: CFG.TP1_R, tp2R: pl.tp2R, costPct: pl.costPct, maxHold: CFG.MAX_HOLD_MIN * M1, extra }); fade.unshift(pos); if (fade.length > 300) fade.length = 300; if (CFG.ALT_ON && fadeAlt.filter(isOpen).length < CFG.MAX_ALT) { const od = pl.dir === 'LONG' ? 'SHORT' : 'LONG', L2 = od === 'LONG' ? 1 : -1; fadeAlt.unshift(mkPos({ id: pos.id + '_TERS', strategy: 'FADE', sym, dir: od, time: now, entry: tk.last, stop: tk.last - L2 * pl.risk, tp1R: CFG.TP1_R, tp2R: pl.tp2R, costPct: pl.costPct, maxHold: CFG.MAX_HOLD_MIN * M1, extra: Object.assign({}, extra, { variant: 'TERS', parent: pos.id }) })); if (fadeAlt.length > 400) fadeAlt.length = 400; } lastSig[sk] = now; dirty = true; dg.trades++; log('FADE', pos.dir, pos.base, 'uzama', w.ext, 'hacim', w.vx, 'risk %' + pos.riskPct, 'maliyet', pos.costR + 'R', 'hedef', r3(pl.retR) + 'R'); telegram(fadeMsg(pos)); }
async function handleWatch(sym, w, now, dg, cIn) { let c = cIn; if (!c) { try { c = await candles1m(sym, now); } catch (e) { dg.err++; return; } } const r = confirmSpike(w, c); if (r.st === 'wait') return; delete watch[sym]; if (r.st === 'ok') await openFade(sym, w, now, dg); else dg.skip[r.st] = (dg.skip[r.st] || 0) + 1; }
async function fadeCycle() { if (fc.running || !universe.length || !market.lastTick || Date.now() - market.lastTick > 60e3) return; fc.running = true; const t0 = Date.now(); const dg = { n: 0, flag: 0, fetched: 0, spikes: 0, trades: 0, watching: 0, err: 0, skip: {}, t: t0 }; try { for (const sym of Object.keys(watch)) { if (t0 > watch[sym].exp) { delete watch[sym]; continue; } await handleWatch(sym, watch[sym], Date.now(), dg); } const cands = []; for (const sym of universe) { const s1 = fStage1(sym, t0); if (!s1) continue; dg.n++; if (s1.flag && !watch[sym]) cands.push(s1); } cands.sort((a, b) => b.score - a.score); dg.flag = cands.length; for (const s1 of cands.filter(s => t0 - (seen[s.sym] || 0) >= CFG.S2_CD).slice(0, CFG.S2_MAX)) { const sym = s1.sym; seen[sym] = Date.now(); let c; try { c = await candles1m(sym, Date.now()); } catch (e) { dg.err++; continue; } dg.fetched++; const sp = detectSpike(c, Date.now()); if (!sp) continue; const key = sym + '|' + sp.t; if (spikeSeen.has(key)) continue; spikeSeen.set(key, Date.now()); dg.spikes++; const tk = tickers[sym] || {}; labAdd('SPIKE', sym, sp.dir, tk.last || sp.close, { ext: sp.ext, vx: sp.vx, rngAtr: sp.rngAtr }); watch[sym] = Object.assign({ sym, exp: sp.t + (CFG.WAIT_MIN + 2) * M1 }, sp); await handleWatch(sym, watch[sym], Date.now(), dg, c); } dg.watching = Object.keys(watch).length; for (const k of Object.keys(seen)) if (t0 - seen[k] > 10 * 60e3) delete seen[k]; for (const [k, v] of spikeSeen) if (t0 - v > 30 * 60e3) spikeSeen.delete(k); if (dg.spikes || dg.trades) log('FADE tarama:', dg.n, 'coin • bayraklı', dg.flag, '• spike', dg.spikes, '• işlem', dg.trades, '• elenen', JSON.stringify(dg.skip)); } catch (e) { log('fade hata', e.message); dg.err++; } finally { fc.dg = dg; fc.last = Date.now(); fc.ms = fc.last - t0; fc.running = false; } }

// ======================= ÜÇGEN =======================
async function triScan() { if (triScanInfo.running) return; triScanInfo.running = true; const t0 = Date.now(); try { const list = universe.slice(0, CFG.TRI_UNIVERSE), S = {}; let idx = 0; const worker = async () => { while (idx < list.length) { const sym = list[idx++]; try { const c = closedOnly(await safeFetch(ex, sym, '1h', 400), H1); if (c.length < 60 || hasGap(c, H1, CFG.TRI_LOOK) || (!isMajor(sym) && flatRatio(c) >= 0.08)) { S[sym] = false; continue; } S[sym] = c; } catch (e) { } } }; await Promise.all(Array.from({ length: CFG.CONCURRENCY }, worker)); for (const sym of list) { const c = S[sym]; if (c === false) { delete struct[sym]; continue; } if (!c) continue; const det = detectTriangle(c, c.length - 1, CFG); if (det) struct[sym] = { t: t0, tBase: c[c.length - 1][0], lastI: c.length - 1, atr: det.atr, w0: det.w0, touches: det.touches, squeeze: Number(det.squeeze.toFixed(2)), type: det.type, R: { p0: det.R.p0, s: det.R.s, i0: det.R.i0 }, S: { p0: det.S.p0, s: det.S.s, i0: det.S.i0 } }; else if (!(struct[sym] && t0 - struct[sym].t < 30 * M1)) delete struct[sym]; } for (const k of Object.keys(struct)) if (!universe.includes(k)) delete struct[k]; triScanInfo.n = Object.keys(struct).length; log('üçgen taraması:', triScanInfo.n, 'formasyon'); } catch (e) { log('üçgen tarama hatası', e.message); } triScanInfo.last = Date.now(); triScanInfo.ms = triScanInfo.last - t0; triScanInfo.running = false; }
const lineVal = (L, st, t) => L.p0 + L.s * ((st.lastI + (t - st.tBase) / H1) - L.i0);
async function candles15(sym, now) { const hit = c15Cache.get(sym); if (hit && now - hit.t < 15e3) return hit.c; const c = closedOnly(await safeFetch(ex, sym, '15m', 40), M15, now); c15Cache.set(sym, { t: now, c }); if (c15Cache.size > 120) { const old = [...c15Cache.entries()].sort((a, b) => a[1].t - b[1].t).slice(0, 40); for (const o of old) c15Cache.delete(o[0]); } return c; }
function triMsg(p) { const ts = triStats(); return '🔔 ÜÇGEN KIRILIM ' + (p.dir === 'LONG' ? '🟢 LONG ' : '🔴 SHORT ') + p.base + ' — ' + p.type + ' üçgen\nGiriş ' + fmt(p.entry) + ' • Stop ' + fmt(p.stop) + ' (%' + p.riskPct.toFixed(2) + ') • TP1 ' + fmt(p.tp1) + ' • TP2 ' + fmt(p.tp2) + '\nHacim ' + p.volX + 'x • maliyet ' + p.costR.toFixed(2) + 'R • piyasa ' + p.reg + '\n' + recordOf(ts.all) + '\n📈 ' + tvLink(p.base, 15); }
async function triTick() { if (tt.running || !Object.keys(struct).length || Date.now() - market.lastTick > 60e3) return; tt.running = true; const now = Date.now(), rad = []; try { for (const sym of Object.keys(struct)) { const st = struct[sym], tk = tickers[sym]; if (!tk || !tk.last || now - st.t > 4 * H1) continue; const R = lineVal(st.R, st, now), S = lineVal(st.S, st, now); if (!(R > S)) continue; const P = tk.last, atr = st.atr; for (const dir of ['LONG', 'SHORT']) { const L = dir === 'LONG' ? 1 : -1, ln = L === 1 ? st.R : st.S, line = L === 1 ? R : S, d = L * (P - line) / atr; if (Math.abs(d) <= CFG.NEAR_ATR || (d > 0 && d <= CFG.BRK_SEE)) rad.push({ symbol: sym, base: baseOf(sym), dir, price: P, line, d: r3(d), type: st.type, broke: d > 0.05 }); if (d < 0.05 || d > CFG.MAX_CHASE) continue; const sk = 'T|' + sym + '|' + dir; if (now - (lastSig[sk] || 0) < CFG.TRI_CD_MIN * M1) continue; if (triPos.some(x => x.symbol === sym && isOpen(x))) continue; let c; try { c = await candles15(sym, now); } catch (e) { continue; } if (!c || c.length < 30) continue; const n = c.length, bk = c[n - 1], pv = c[n - 2], a15 = atrMean(c, 14); if (!(a15 > 0)) continue; const pw = c.slice(-21, -1), avgV = pw.reduce((a, x) => a + x[5], 0) / pw.length, vx = avgV > 0 ? bk[5] / avgV : 0; const dBk = L * (bk[4] - lineVal(ln, st, bk[0] + M15)), dPv = L * (pv[4] - lineVal(ln, st, pv[0] + M15)), rng = (bk[2] - bk[3]) || 1e-9; const q = L === 1 ? (bk[4] - bk[3]) / rng : (bk[2] - bk[4]) / rng; if (dBk < CFG.BRK_ATR * atr || dPv > 0.05 * atr || q < 0.55 || rng > CFG.BK_MAX_ATR15 * a15 || vx < CFG.BRK_VOL || now - (bk[0] + M15) > CFG.FRESH_MIN * M1) continue; lastSig[sk] = now; dirty = true; labAdd('TRI', sym, dir, P, { vx: r3(vx), triType: st.type }); const stop = L === 1 ? Math.min(line - CFG.STOP_ATR15 * a15, P - P * CFG.STOP_MIN_PCT / 100) : Math.max(line + CFG.STOP_ATR15 * a15, P + P * CFG.STOP_MIN_PCT / 100); const risk = L * (P - stop); if (!(risk > 0)) continue; const riskPct = risk / P * 100; if (riskPct < CFG.TRI_MIN_RISK || riskPct > CFG.TRI_MAX_RISK) continue; const costPct = costFor(tk.quoteVolume) + 2 * CFG.SLIP_PCT; if (costPct / riskPct > CFG.TRI_MAX_COST_R) continue; const rawR = L * (line + L * st.w0 - P) / risk; if (rawR < CFG.TRI_MIN_RR) continue; if (triPos.filter(isOpen).length >= CFG.TRI_MAX_OPEN) continue; const pos = mkPos({ id: 'TRI_' + sym.replace(/[^A-Z0-9]/g, '') + '_' + now, strategy: 'TRI', sym, dir, time: now, entry: P, stop, tp1R: 1, tp2R: Math.min(Math.max(rawR, 2), CFG.TRI_TP2_MAX), costPct, maxHold: CFG.TRI_HOLD_H * H1, extra: { type: st.type, touches: st.touches, squeeze: st.squeeze, volX: r3(vx), reg: REG ? REG.tag : '-' } }); triPos.unshift(pos); if (triPos.length > 200) triPos.length = 200; log('ÜÇGEN', dir, pos.base, st.type, 'hacim', vx.toFixed(1), 'risk %' + pos.riskPct); telegram(triMsg(pos)); } } triRadar = rad.sort((a, b) => Math.abs(a.d) - Math.abs(b.d)).slice(0, 30); } catch (e) { log('üçgen canlı hata', e.message); } tt.running = false; }

// ======================= TAKİP =======================
function onClose(s) { dirty = true; if (s.variant === 'TERS') return; telegram((s.netR > 0 ? '✅ ' : s.netR < 0 ? '❌ ' : '➖ ') + s.strategy + ' ' + s.dir + ' ' + s.base + ' kapandı: ' + s.status + ' • net ' + (s.netR > 0 ? '+' : '') + s.netR.toFixed(2) + 'R'); }
async function track() { if (tracking) return; tracking = true; try { const open = fade.concat(fadeAlt, triPos, shadow).filter(isOpen); if (!open.length) { tracking = false; return; } const bySym = {}; for (const s of open) (bySym[s.symbol] = bySym[s.symbol] || []).push(s); for (const sym of Object.keys(bySym)) { try { const list = bySym[sym], since = Math.min(...list.map(x => x.trackedTo)); const c = closedOnly(await safeFetch(ex, sym, '1m', 500, since), M1); for (const s of list) { if (!isOpen(s)) continue; for (const k of c) { if (k[0] <= s.trackedTo) continue; s.trackedTo = k[0]; dirty = true; if (advance(s, k, M1) && !isOpen(s)) { onClose(s); break; } } } } catch (e) { } } } catch (e) { } tracking = false; }

// ======================= API =======================
function settingsView() { const pick = (o, ks) => { const r = {}; for (const k of ks) r[k] = o[k]; return r; }; return { 'Evren': pick(CFG, ['UNIVERSE', 'MIN_VOL', 'SLIP_PCT']), 'Spike (aşama 2)': pick(CFG, ['SPIKE_ATR', 'SPIKE_VOLX', 'EXT_ATR', 'WAIT_MIN', 'S1_MOVE3', 'S1_MOVE15', 'S1_VOLX', 'S2_MAX']), 'FADE işlem': pick(CFG, ['STOP_BUF_ATR', 'MIN_RISK_PCT', 'MAX_RISK_PCT', 'MAX_COST_R', 'MIN_RETR_R', 'TP1_R', 'TP2_MAX_R', 'TRAIL_R', 'MAX_HOLD_MIN', 'FADE_CD_MIN', 'MAX_OPEN', 'MAX_DIR', 'ALT_ON']), 'Üçgen': pick(CFG, ['TRI_UNIVERSE', 'NEAR_ATR', 'BRK_SEE', 'BRK_ATR', 'BRK_VOL', 'FRESH_MIN', 'MAX_CHASE', 'STOP_ATR15', 'STOP_MIN_PCT', 'TRI_MAX_COST_R', 'TRI_HOLD_H', 'TRI_CD_MIN']) }; }
async function apiCandles(sym, reqTf) { if (!Object.prototype.hasOwnProperty.call(ex.markets || {}, sym)) throw new Error('bilinmeyen sembol'); const useTf = reqTf || '15m'; const key = sym + '|' + useTf, hit = candleCacheFull.get(key); if (hit && Date.now() - hit.t < 8000) return hit.d; let c, dur, tf; if (useTf === '1m') { c = await safeFetch(ex, sym, '1m', 400); dur = M1; tf = '1m'; } else if (useTf === '5m') { c = await safeFetch(ex, sym, '5m', 400); dur = 5 * M1; tf = '5m'; } else if (useTf === '15m') { c = await safeFetch(ex, sym, '15m', 400); dur = M15; tf = '15m'; } else if (useTf === '2h') { const c1h = await safeFetch(ex, sym, '1h', 500); c = aggregateN(c1h, H1, 2); dur = 2 * H1; tf = '2H'; } else { c = await safeFetch(ex, sym, '1h', 400); dur = H1; tf = '1H'; } const cl = c.map(x => x[4]); const e21 = ema(cl, 21), e50 = ema(cl, 50); const vs = new Array(c.length).fill(null); let s = 0; for (let i = 0; i < c.length; i++) { if (i >= 20) { vs[i] = s / 20; s -= c[i - 20][5]; } s += c[i][5]; } let tri = null; if (useTf !== '1m' && c.length > 50) { const t = detectTriangle(c, c.length - 1, CFG) || detectTriangle(c, c.length - 2, CFG); if (t) tri = { type: t.type, touches: t.touches, squeeze: Number(t.squeeze.toFixed(2)), res: [[c[Math.max(0, Math.round(t.R.i0))][0], t.R.p0], [c[c.length - 1][0] + 15 * dur, t.R.p0 + t.R.s * (c.length - 1 + 15 - t.R.i0)]], sup: [[c[Math.max(0, Math.round(t.S.i0))][0], t.S.p0], [c[c.length - 1][0] + 15 * dur, t.S.p0 + t.S.s * (c.length - 1 + 15 - t.S.i0)]] }; } const cut = Math.max(0, c.length - 130); const d = { c: c.slice(cut), e21: e21.slice(cut), e50: e50.slice(cut), vsma: vs.slice(cut), tf, dur, tri }; candleCacheFull.set(key, { t: Date.now(), d }); if (candleCacheFull.size > 300) { const old = [...candleCacheFull.entries()].sort((a, b) => a[1].t - b[1].t).slice(0, 100); for (const o of old) candleCacheFull.delete(o[0]); } return d; }
function apiState() { const now = Date.now(), px = {}; for (const x of fade.slice(0, 80).concat(triPos.slice(0, 80), triRadar, fadeAlt.slice(0, 40))) { const t = tickers[x.symbol]; if (t && t.last) px[x.symbol] = t.last; } const wl = Object.values(watch).map(w => ({ symbol: w.sym, base: baseOf(w.sym), dir: w.dir, ext: w.ext, vx: w.vx, left: Math.max(0, Math.round((w.exp - now) / 1000)) })); return { now, mode: 'v35 • FADE + Lab + Üçgen', px, market, regime: REG, fade: { open: fade.filter(isOpen), closed: fade.filter(s => !isOpen(s)).slice(0, 40), watching: wl, stats: fadeStats(), dg: fc.dg, last: fc.last, ms: fc.ms }, tri: { open: triPos.filter(isOpen), closed: triPos.filter(s => !isOpen(s)).slice(0, 30), radar: triRadar, stats: triStats(), formations: triScanInfo.n, scanLast: triScanInfo.last }, lab: labView(), settings: settingsView(), tgOn: !!(TG_TOKEN && TG_CHAT), universe: universe.length, live: { last: live.last, err: live.err, symbols: live.n } }; }

// ======================= ARAYÜZ =======================
const HTML = String.raw`<!DOCTYPE html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SONER TRADE</title>
<style>
:root{--bg:#0c1117;--p1:#141b24;--p2:#1a2430;--ln:#243040;--tx:#e6ebf2;--dm:#8593a5;--lg:#3ddc97;--st:#ff6b7a;--am:#f2b84b;--bl:#5aa9ff}
*{box-sizing:border-box;margin:0;padding:0}body{background:var(--bg);color:var(--tx);font:13px/1.45 system-ui,sans-serif;font-variant-numeric:tabular-nums}
button,input,select{font:inherit;color:inherit}button{cursor:pointer}
.app{display:flex;flex-direction:column;height:100vh}
.top{display:flex;align-items:center;gap:10px;padding:9px 14px;background:var(--p1);border-bottom:1px solid var(--ln);flex-wrap:wrap}
.brand{font-weight:800;font-size:15px}.brand small{color:var(--am);margin-left:8px;font-size:11px}
.chip{background:var(--bg);border:1px solid var(--ln);padding:4px 9px;border-radius:6px;font-size:12px}.chip b{color:var(--dm);font-weight:600}
.up{color:var(--lg)}.dn{color:var(--st)}.fl{color:var(--dm)}.grow{flex:1}
.dot{width:8px;height:8px;border-radius:50%;background:var(--st);display:inline-block;margin-right:5px}.dot.on{background:var(--lg)}
.body{flex:1;display:flex;min-height:0}
.side{width:440px;flex-shrink:0;background:var(--p1);border-right:1px solid var(--ln);display:flex;flex-direction:column;min-height:0}
.tabs{display:flex;border-bottom:1px solid var(--ln)}.tab{flex:1;padding:11px 2px;background:none;border:none;border-bottom:2px solid transparent;color:var(--dm);font-weight:700;font-size:11px}
.tab.a{color:var(--tx);border-bottom-color:var(--am)}
.list{flex:1;overflow:auto;padding:8px}.main{flex:1;overflow:auto;padding:16px;min-width:0}
.card{background:var(--p2);border:1px solid var(--ln);border-radius:8px;padding:10px 12px;margin-bottom:8px;cursor:pointer}
.card.sel{border-color:var(--am);box-shadow:0 0 0 1px var(--am)}.card.closed{opacity:.7}
.card.L{border-left:5px solid var(--lg);background:linear-gradient(90deg,rgba(61,220,151,.09),var(--p2) 45%)}
.card.S{border-left:5px solid var(--st);background:linear-gradient(90deg,rgba(255,107,122,.09),var(--p2) 45%)}
.r1{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dirb{font-weight:800;font-size:13px;padding:4px 12px;border-radius:5px;letter-spacing:.3px}
.dirb.L{background:var(--lg);color:#08130d}.dirb.S{background:var(--st);color:#1a0508}
.strat{font-weight:800;font-size:11px;padding:3px 9px;border-radius:5px;border:1px solid}
.strat.cas{color:#b794f4;border-color:#b794f4;background:rgba(183,148,244,.10)}
.strat.tri{color:var(--bl);border-color:var(--bl);background:rgba(90,169,255,.10)}
.strat.rad{color:var(--dm);border-color:var(--dm)}
.coin{font-weight:800;font-size:14px}.sc{margin-left:auto;font-weight:800;font-size:15px}.sc small{font-size:11px;opacity:.85}
.kar{color:var(--lg)}.zarar{color:var(--st)}
.sub{color:var(--dm);font-size:11px;margin-top:4px;display:flex;gap:8px;flex-wrap:wrap}.sub b{color:var(--tx)}
.tag{font-size:10px;padding:1px 6px;border-radius:4px;background:var(--bg);border:1px solid var(--ln);color:var(--dm)}
.tag.w{color:var(--am);border-color:rgba(242,184,75,.4)}.tag.g{color:var(--lg);border-color:rgba(61,220,151,.4)}.tag.r{color:var(--st);border-color:rgba(255,107,122,.4)}
h2{font-size:15px;margin-bottom:10px}h3{font-size:12px;color:var(--dm);font-weight:700;margin:14px 0 6px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:12px}
.tile{background:var(--p2);border:1px solid var(--ln);border-radius:8px;padding:9px 12px}.tile .k{color:var(--dm);font-size:11px}.tile .v{font-size:21px;font-weight:800;margin-top:2px}
.box{background:var(--p2);border:1px solid var(--ln);border-radius:8px;padding:12px;margin-bottom:12px}
.box.g{border-color:var(--lg)}.box.r{border-color:var(--st)}.box.w{border-color:var(--am)}
table{width:100%;border-collapse:collapse}th{color:var(--dm);font-weight:600;text-align:left;font-size:11px;padding:4px 6px;border-bottom:1px solid var(--ln)}
td{padding:5px 6px;border-bottom:1px solid rgba(36,48,64,.6)}td.n,th.n{text-align:right}
.lv{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:8px;margin:10px 0}
.lv div{background:var(--bg);border:1px solid var(--ln);border-radius:6px;padding:6px 8px}.lv span{display:block;font-size:10px;color:var(--dm)}.lv b{font-size:14px}
.pnl{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;padding:10px 14px;border-radius:8px;border:2px solid var(--ln);margin-bottom:10px;background:var(--p2)}
.pnl.kar{border-color:var(--lg);background:rgba(61,220,151,.08)}.pnl.zarar{border-color:var(--st);background:rgba(255,107,122,.08)}
.pnl b{font-size:22px;display:block}.pnl .pl{font-size:10px;color:var(--dm);text-transform:uppercase;letter-spacing:.4px}
.why{background:var(--bg);border:1px solid var(--ln);border-radius:6px;padding:8px 10px;margin:10px 0;font-size:12px;color:var(--dm)}.why b{color:var(--tx)}
canvas{width:100%;height:470px;display:block;background:var(--bg);border:2px solid var(--ln);border-radius:8px}
.frm{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0;align-items:center}
.frm input{background:var(--bg);border:1px solid var(--ln);border-radius:6px;padding:6px 8px;width:100px}
.btn{background:var(--am);color:#1a1405;border:none;border-radius:6px;padding:7px 12px;font-weight:800}
.btn.tv{background:#2962ff;color:#fff;text-decoration:none;display:inline-block}
.tfb{display:inline-flex;gap:0;margin-left:auto}.tfb button{background:var(--bg);border:1px solid var(--ln);padding:5px 10px;font-weight:700;font-size:11px;color:var(--dm)}
.tfb button.a{background:var(--am);color:#1a1405;border-color:var(--am)}
.note{font-size:11px;color:var(--dm);margin-top:8px}
#toast{position:fixed;top:12px;right:12px;z-index:99;background:#f2b84b;color:#1a1405;padding:12px 16px;border-radius:8px;font-weight:800;cursor:pointer;display:none}
@media(max-width:900px){body{overflow:auto}.app{height:auto}.body{flex-direction:column}.side{width:100%;height:46vh}canvas{height:320px}}
</style></head><body>
<div class="app">
 <div class="top">
  <div class="brand">SONER TRADE<small id="modeB">v35</small></div>
  <div class="chip" id="cReg"></div><div class="chip" id="cB"></div><div class="chip" id="cE"></div><div class="chip" id="cMkt"></div><div class="chip" id="cH"></div>
  <div class="grow"></div><span><span class="dot" id="dot"></span><span id="conn">Bağlanıyor</span></span>
 </div>
 <div class="body">
  <div class="side"><div class="tabs" id="tabs"></div><div class="list" id="list"></div></div>
  <div class="main" id="main"></div>
 </div>
</div>
<div id="toast"></div>
<script>
var TABS=[['sig','Sinyaller'],['stat','Karne'],['lab','Lab'],['bt','Backtest'],['set','Ayarlar']];
var KEY=new URLSearchParams(location.search).get('key')||'';
function api(p){return KEY?p+(p.indexOf('?')>=0?'&':'?')+'key='+encodeURIComponent(KEY):p}
var S=null,tab='sig',sel=null,tfSel=null,chartCache={},chartFor='',cfgC={bal:1000,risk:0.5},actx=null,lastFadeT=0,lastTriT=0,toastT=null;
try{cfgC=JSON.parse(localStorage.getItem('st_calc')||'{"bal":1000,"risk":0.5}')}catch(e){}
function $(id){return document.getElementById(id)}
function fp(p){if(p==null||isNaN(p))return'-';p=Number(p);var a=Math.abs(p);return a>=1000?p.toFixed(2):a>=1?p.toFixed(4):a>=0.01?p.toFixed(5):p.toFixed(7)}
function f2(x,d){d=d==null?2:d;return x==null||isNaN(x)?'-':Number(x).toFixed(d)}
function sg(x,d){d=d==null?2:d;if(x==null||isNaN(x))return'-';x=Number(x);return(x>0?'+':'')+x.toFixed(d)}
function cl(x){return x>0?'kar':x<0?'zarar':'fl'}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])})}
function ago(ts){var m=Math.floor((Date.now()-ts)/60000);return m<1?'şimdi':m<60?m+' dk':Math.floor(m/60)+'s '+(m%60)+'dk'}
function clk(ts){var d=new Date(ts);return('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2)}
function isOp(x){return x.status==='OPEN'||x.status==='TP1'}
function beep(){try{actx=actx||new(window.AudioContext||window.webkitAudioContext)();var o=actx.createOscillator(),g=actx.createGain();o.connect(g);g.connect(actx.destination);o.frequency.value=880;g.gain.value=0.1;o.start();o.stop(actx.currentTime+0.35)}catch(e){}}
addEventListener('pointerdown',function(){try{actx=actx||new(window.AudioContext||window.webkitAudioContext)();if(actx.state==='suspended')actx.resume()}catch(e){}},{once:true});
function showToast(txt,fn){var t=$('toast');t.textContent=txt;t.style.display='block';t.onclick=function(){t.style.display='none';fn&&fn()};clearTimeout(toastT);toastT=setTimeout(function(){t.style.display='none'},25000)}
function pick(kind,id,sym){sel={kind:kind,id:id||'',sym:sym};tfSel=null;chartFor='';$('main').removeAttribute('data-view')}
function dirBadge(d){return '<span class="dirb '+(d==='LONG'?'L':'S')+'">'+(d==='LONG'?'▲ LONG':'▼ SHORT')+'</span>'}
function stratTag(k){return k==='fade'?'<span class="strat cas">⚡ FADE</span>':k==='tri'?'<span class="strat tri">△ ÜÇGEN KIRILIM</span>':'<span class="strat rad">◎ RADAR</span>'}
function stratName(k){return k==='fade'?'FADE':k==='tri'?'ÜÇGEN KIRILIM':'ÜÇGEN RADAR'}
function tvl(sym,iv){return '<a target="_blank" style="color:var(--bl);font-weight:700;font-size:11px;text-decoration:none" href="https://www.tradingview.com/chart/?symbol=BITGET:'+esc(sym.split('/')[0])+'USDT.P&interval='+iv+'" onclick="event.stopPropagation()">📈 TV</a>'}
var ST={OPEN:['AÇIK','w'],TP1:['TP1 ✓ AÇIK','g'],TP2:['TP2 ✓','g'],TRAIL:['TRAIL ✓','g'],BE:['BE','w'],STOP:['STOP','r'],'SÜRE':['SÜRE','w']};
function check(){var a=(S.fade.open||[]).concat(S.tri.open||[]),mx=a.reduce(function(m,x){return Math.max(m,x.time||0)},0);
 if(!lastFadeT){lastFadeT=mx||Date.now();return}
 var nw=a.filter(function(x){return x.time>lastFadeT});if(mx>lastFadeT)lastFadeT=mx;
 if(nw.length){beep();setTimeout(beep,400);var e=nw[0];showToast((e.strategy==='FADE'?'⚡ FADE ':'🔔 ÜÇGEN ')+e.dir+' '+e.base,function(){tab='sig';pick(e.strategy==='FADE'?'fade':'tri',e.id,e.symbol);renderAll()})}}

function posInfo(o){if(!o||o.entry==null||!o.riskAbs)return null;var L=o.dir==='LONG'?1:-1,px=(S.px&&S.px[o.symbol])||o.lastPrice||o.entry,open=isOp(o),fin=!open&&o.netR!=null;var r=fin?o.netR:L*(px-o.entry)/o.riskAbs;var pct=fin?((o.grossR!=null?o.grossR:o.netR)*(o.riskPct||0)):L*(px-o.entry)/o.entry*100;return{L:L,px:px,open:open,fin:fin,r:r,pct:pct,levels:{entry:o.entry,stop:o.stop,tp1:o.tp1,tp2:o.tp2,t:o.time}}}

function renderTop(){var m=S.market,R=S.regime,fs=S.fade.stats,T=S.tri.stats;
 var R2=R?'<b>Piyasa</b> <span class="'+(R.tag==='TREND'?'up':R.tag==='VOLATİL'?'dn':'fl')+'" style="font-weight:800">'+R.tag+'</span> <span class="fl">60dk '+sg(R.ret60)+'%</span>':'<b>Piyasa</b> <span class="fl">…</span>';
 $('cReg').innerHTML=R2;
 $('cB').innerHTML=m.btc?'<b>BTC</b> '+fp(m.btc.price)+' <span class="'+cl(m.btc.chg)+'">'+sg(m.btc.chg)+'%</span>':'';
 $('cE').innerHTML=m.eth?'<b>ETH</b> '+fp(m.eth.price)+' <span class="'+cl(m.eth.chg)+'">'+sg(m.eth.chg)+'%</span>':'';
 $('cMkt').innerHTML='<b>Evren</b> '+S.universe+' coin';
 $('cH').innerHTML='<b>FADE</b> <span class="'+(fs.verdict.lvl==='g'?'up':fs.verdict.lvl==='r'?'dn':'fl')+'">'+(fs.verdict.lvl==='g'?'OLUMLU':fs.verdict.lvl==='r'?'KENAR YOK':'KANIT YOK')+'</span> <span class="fl">| Bugün</span> <span class="'+cl(fs.today.totalR)+'">'+sg(fs.today.totalR,1)+'R</span>';
 $('modeB').textContent=S.mode}

function renderTabs(){var fo=(S.fade.open||[]).filter(isOp).length,to=(S.tri.open||[]).filter(isOp).length,tn=(S.tri.radar||[]).length;
 $('tabs').innerHTML=TABS.map(function(t){var cnt=t[0]==='sig'?' ('+(fo+to)+')':t[0]==='bt'?'':'';
  return '<button class="tab'+(tab===t[0]?' a':'')+'" data-t="'+t[0]+'">'+t[1]+cnt+'</button>'}).join('');
 Array.prototype.forEach.call($('tabs').children,function(b){b.onclick=function(){tab=b.dataset.t;sel=null;$('main').removeAttribute('data-view');renderAll()}})}

function posCard(kind,o){var P=posInfo(o),L=o.dir==='LONG'?1:-1,op=isOp(o),st=ST[o.status]||['?',''];
 var pn=P?'<span class="sc '+cl(P.r)+'">'+sg(P.r)+'R <small>'+sg(P.pct)+'%</small></span>':'';
 var tags=kind==='fade'?'<span class="tag w">uzama '+f2(o.ext,1)+' ATR</span><span class="tag">hacim '+f2(o.volX,1)+'x</span>':'<span class="tag w">'+esc(o.type||'')+'</span>';
 return '<div class="card '+(L===1?'L':'S')+(op?'':' closed')+(sel&&sel.kind===kind&&sel.id===o.id?' sel':'')+'" data-kind="'+kind+'" data-id="'+esc(o.id)+'" data-sym="'+esc(o.symbol)+'"><div class="r1">'+dirBadge(o.dir)+'<span class="coin">'+esc(o.base)+'</span><span class="tag '+st[1]+'">'+st[0]+'</span>'+pn+'</div><div class="r1" style="margin-top:5px">'+stratTag(kind)+tags+'</div><div class="sub"><span>Sinyal <b>'+clk(o.time)+'</b> ('+ago(o.time)+' önce)</span>'+(op?'':'<span>Kapandı <b>'+clk(o.closedAt)+'</b></span>')+'<span>Giriş <b>'+fp(o.entry)+'</b></span><span>Stop <b class="zarar">'+fp(o.stop)+'</b> (%'+f2(o.riskPct)+')</span><span>TP1 <b class="kar">'+fp(o.tp1)+'</b></span><span>TP2 <b class="kar">'+fp(o.tp2)+'</b></span><span>Maliyet <b>'+f2(o.costR)+'R</b></span>'+tvl(o.symbol,kind==='fade'?1:15)+'</div></div>'}

function radarRow(r){return '<div class="card '+(r.bias==='LONG'?'L':'S')+'" data-kind="rad" data-id="" data-sym="'+esc(r.symbol)+'"><div class="r1">'+dirBadge(r.bias)+'<span class="coin">'+esc(r.base)+'</span><span class="fl">'+fp(r.price)+'</span><span class="tag '+(r.broke?'w':'')+'">'+(r.broke?'KIRILDI (onaysız)':'hazır')+'</span></div><div class="r1" style="margin-top:5px">'+stratTag('rad')+'<span class="tag">'+esc(r.type)+'</span><span class="tag">'+sg(r.d,2)+' ATR</span></div></div>'}

function renderList(){var h='',L=$('list'),sc=L.scrollTop;
 if(tab==='sig'){var F=S.fade,T=S.tri;
  h='<div class="note" style="padding:6px 8px">⚡ <b>FADE</b>: spike sonrası dönüş mumu teyit edilince ters yönde sanal sinyal. △ <b>ÜÇGEN</b>: 1h formasyon kırılımı.</div>';
  if(F.open.length)h+='<h3>FADE açık ('+F.open.length+')</h3>'+F.open.map(function(o){return posCard('fade',o)}).join('');
  if(T.open.length)h+='<h3>Üçgen açık ('+T.open.length+')</h3>'+T.open.map(function(o){return posCard('tri',o)}).join('');
  if(F.watching.length){h+='<h3>Teyit bekleyen spike ('+F.watching.length+')</h3>';h+=F.watching.map(function(w){return '<div class="card"><div class="r1"><span class="coin">'+esc(w.base)+'</span>'+(w.dir==='UP'?'<span class="tag r">yukarı → SHORT adayı</span>':'<span class="tag g">aşağı → LONG adayı</span>')+'<span class="tag">uzama '+f2(w.ext,1)+' ATR</span><span class="tag">'+f2(w.vx,1)+'x</span></div></div>'}).join('')}
  var fc=F.closed,tc=T.closed;
  if(fc.length)h+='<h3>FADE kapanan ('+fc.length+')</h3>'+fc.slice(0,15).map(function(o){return posCard('fade',o)}).join('');
  if(tc.length)h+='<h3>Üçgen kapanan ('+tc.length+')</h3>'+tc.slice(0,10).map(function(o){return posCard('tri',o)}).join('');
  if(T.radar.length)h+='<h3>Üçgen radarı ('+T.radar.length+')</h3>'+T.radar.slice(0,10).map(radarRow).join('');
  if(!F.open.length&&!T.open.length&&!F.watching.length&&!T.radar.length)h+='<div class="note" style="padding:10px">Sinyal yok. FADE spike bekliyor, Üçgen formasyon tarıyor.</div>'}
 else h='<div class="note" style="padding:10px">Detaylar sağda.</div>';
 L.innerHTML=h;L.scrollTop=sc;
 Array.prototype.forEach.call(L.querySelectorAll('.card'),function(e){e.onclick=function(){pick(e.dataset.kind,e.dataset.id,e.dataset.sym);renderList();renderMain()}})}

function calc(e,s){var bal=+cfgC.bal||0,rk=Math.min(2,+cfgC.risk||0),ru=bal*rk/100,d=Math.abs(e-s);if(!d||!bal)return null;var q=ru/d;return{ru:ru,q:q,n:q*e,lev:q*e/bal}}
function calcBox(e,s){return '<div class="box"><h3 style="margin-top:0">Pozisyon hesabı</h3><div class="frm"><label class="fl">Bakiye<br><input id="cBal" type="number" value="'+cfgC.bal+'"></label><label class="fl">Risk %<br><input id="cRisk" type="number" step="0.1" value="'+cfgC.risk+'"></label><label class="fl">Giriş<br><input id="cE" type="number" step="any" value="'+(e||'')+'"></label><label class="fl">Stop<br><input id="cS" type="number" step="any" value="'+(s||'')+'"></label></div><div id="cOut" class="note" style="color:var(--tx);font-size:13px"></div></div>'}
function bindCalc(){var upd=function(){cfgC.bal=+$('cBal').value;cfgC.risk=Math.min(2,+$('cRisk').value);try{localStorage.setItem('st_calc',JSON.stringify(cfgC))}catch(e){}var c=calc(+$('cE').value,+$('cS').value);$('cOut').innerHTML=c?'1R = <b>'+f2(c.ru)+' USDT</b> | Miktar <b>'+f2(c.q,4)+'</b> | Poz <b>'+f2(c.n,1)+'</b> | Kald <b>'+f2(c.lev,1)+'x</b>':'Değer gir.'};
 ['cBal','cRisk','cE','cS'].forEach(function(i){var e=$(i);if(e)e.oninput=upd});if($('cOut'))upd()}

var tbl=function(t,title){var k=Object.keys(t||{});if(!k.length)return'';return'<h3>'+title+'</h3><table><tr><th>Grup</th><th class="n">N</th><th class="n">Win%</th><th class="n">OrtR</th><th class="n">%95</th><th class="n">TopR</th><th class="n">PF</th><th class="n">t</th></tr>'+k.map(function(g){var x=t[g];return'<tr><td>'+esc(g)+'</td><td class="n">'+x.n+'</td><td class="n">'+f2(x.win*100,0)+'</td><td class="n '+cl(x.avgR)+'">'+sg(x.avgR)+'</td><td class="n fl">['+sg(x.lo)+','+sg(x.hi)+']</td><td class="n '+cl(x.totalR)+'">'+sg(x.totalR,1)+'</td><td class="n">'+f2(x.pf)+'</td><td class="n">'+f2(x.t)+'</td></tr>'}).join('')+'</table>'};
function statView(){var fs=S.fade.stats,ts=S.tri.stats,h='<h2>Karne</h2>';
 h+='<div class="box '+fs.verdict.lvl+'"><b>⚡ FADE:</b> '+esc(fs.verdict.txt)+'<div class="note">Açık '+fs.open+' • anlık ortalama '+sg(fs.openAvg)+'R</div></div>';
 h+=tbl({'Tümü':fs.all,'Bugün':fs.today},'FADE genel')+tbl(fs.byVariant,'FADE ana ↔ ters')+tbl(fs.byDir,'Yön')+tbl(fs.byReg,'Piyasa rejimi')+tbl(fs.byExt,'Spike uzama')+tbl(fs.byCost,'Maliyet/risk')+tbl(fs.byExit,'Çıkış');
 h+='<div class="note">Karar için en az 30-50 kapanmış işlem ve alt sınırın sıfırın üstünde olması beklenir.</div>';
 h+='<h2 style="margin-top:22px">△ Üçgen kırılım</h2><div class="box '+ts.verdict.lvl+'">'+esc(ts.verdict.txt)+'</div>'+tbl({'Tümü':ts.all},'Genel')+tbl(ts.byType,'Tip')+tbl(ts.byDir,'Yön')+tbl(ts.byExit,'Çıkış');
 return h}
function ci(c){if(!c)return'-';var k=c.lo>0?'kar':c.hi<0?'zarar':'fl';return'<span class="'+k+'">'+sg(c.m,3)+'</span> <span class="fl">['+sg(c.lo,3)+','+sg(c.hi,3)+']</span>'}
function labView(){var L=S.lab,h='<h2>Lab — sinyalin kendisi</h2><div class="box"><div class="note" style="color:var(--tx);margin:0">Spike ve üçgen kırılımından sonra fiyatın 5/15/30/60 dk sonra nereye gittiği. <b>Devam net</b>=spike yönünde, <b>Dönüş net</b>=tersine. Toplam '+L.total+' olay, bekleyen '+L.pending+'.</div></div>';
 if(!L.rows.length)return h+'<div class="note">Henüz ölçüm yok (5 dk sonra gelir).</div>';
 h+='<table><tr><th>Grup</th><th class="n">Ufuk</th><th class="n">N</th><th class="n">Ort%</th><th class="n">Devam%</th><th class="n">Devam net</th><th class="n">Dönüş net</th></tr>'+L.rows.map(function(r){return'<tr><td>'+esc(r.grp)+'</td><td class="n">'+r.h+'dk</td><td class="n">'+r.n+'</td><td class="n '+cl(r.mean)+'">'+sg(r.mean,3)+'</td><td class="n">'+f2(r.hit*100,0)+'</td><td class="n">'+ci(r.cont)+'</td><td class="n">'+ci(r.fade)+'</td></tr>'}).join('')+'</table>';return h}
function setView(){var st=S.settings,h='<h2>Ayarlar</h2><div class="note">Salt okunur. Değerleri Render ortam değişkenleriyle değiştir.</div>';
 Object.keys(st).forEach(function(g){h+='<h3>'+esc(g)+'</h3><table><tr><th>Değişken</th><th class="n">Değer</th></tr>'+Object.keys(st[g]).map(function(k){return'<tr><td>'+esc(k)+'</td><td class="n">'+esc(String(st[g][k]))+'</td></tr>'}).join('')+'</table>'});
 var dg=S.fade.dg;if(dg)h+='<h3>Son tarama</h3><div class="box note" style="color:var(--tx)">Coin '+dg.n+'/'+S.universe+' • bayraklı '+dg.flag+' • spike '+dg.spikes+' • işlem '+dg.trades+' • elenen '+esc(JSON.stringify(dg.skip))+'</div>';
 return h}
function btView(){return '<h2>Backtest</h2><div class="box note">Backtest bu sürümde devre dışı (FADE spike geçmişi tutulmuyor). Canlı sanal takip kullan.</div>'}

var CW='⚡ FADE: spike ucundan stop, spike gövdesinden hedef. Dönüş mumu gelince girer, yeni uç yapılırsa vazgeçer. Karar sende.';
function whyText(o,kind){if(!o)return'Bu sinyal artık listede değil.';
 if(kind==='fade')return '<b>FADE gözlemi:</b> aşırı uzamış (uzama '+f2(o.ext,1)+' ATR) ve hacimli ('+f2(o.volX,1)+'x) spike sonrası dönüş mumu teyit edildi. Giriş '+o.dir+' yönünde. Stop spike ucunun ötesi (%'+f2(o.riskPct)+'), hedef spike gövdesi (net hedef '+f2(o.retR,2)+'R). Maliyet '+f2(o.costR)+'R. Piyasa: '+esc(o.reg)+'. <b>Bu al/sat sinyali değil, sanal gözlemdir.</b>';
 if(kind==='tri')return '<b>Üçgen kırılım (onaylı):</b> '+esc(o.type)+' üçgen çizgisi 15m kapanış + hacimle kırıldı. Hacim '+f2(o.volX,1)+'x, maliyet '+f2(o.costR)+'R. TP1 alınınca stop girişe çekilir.';
 if(kind==='rad'&&o.broke)return '<b>Radar — onaysız kırılım.</b> Fiyat çizgiyi aştı ama 15m/hacim onayı yok. R çizgi seviyesinden sanal hesaplanır.';
 return '<b>Radar:</b> formasyon yaklaşıyor, henüz kırılmadı.'}

function loadChart(sym,tf){fetch(api('/api/candles?symbol='+encodeURIComponent(sym)+'&tf='+tf)).then(function(r){return r.json()}).then(function(d){if(d.error)return;chartCache[sym+'|'+tf]=d;if(sel&&sel.sym===sym)renderMain()}).catch(function(){})}
function setTf(v){tfSel=v;chartFor='';$('main').removeAttribute('data-view');renderMain()}
function selData(){if(!sel||!sel.sym)return null;if(sel.kind==='fade')return(S.fade.open||[]).concat(S.fade.closed||[]).find(function(x){return x.id===sel.id})||null;if(sel.kind==='tri')return(S.tri.open||[]).concat(S.tri.closed||[]).find(function(x){return x.id===sel.id})||null;return(S.tri.radar||[]).find(function(x){return x.symbol===sel.sym})||null}

function drawChart(d,V,cid){var c=$(cid);if(!c||!d||!d.c.length)return;var W=c.clientWidth,H=c.clientHeight,dp=window.devicePixelRatio||1;if(c.width!==Math.round(W*dp)||c.height!==Math.round(H*dp)){c.width=Math.round(W*dp);c.height=Math.round(H*dp)}var x=c.getContext('2d');x.setTransform(dp,0,0,dp,0,0);x.clearRect(0,0,W,H);
 var dc=V&&V.dir?(V.dir==='LONG'?'#3ddc97':'#ff6b7a'):'#243040';c.style.borderColor=dc;var lv=V&&V.levels,tri=d.tri,nc=d.c.length,n=nc+(tri?15:4);var L=8,R=112,T=42,B=18,volH=56,PW=W-L-R,PH=H-T-B-volH-8;
 var ti=function(t){return (t-d.c[0][0])/d.dur};var px=(V&&V.px!=null)?V.px:d.c[nc-1][4];var hi=-1e99,lo=1e99;d.c.forEach(function(k){hi=Math.max(hi,k[2]);lo=Math.min(lo,k[3])});hi=Math.max(hi,px);lo=Math.min(lo,px);
 if(lv)[lv.entry,lv.stop,lv.tp1,lv.tp2].forEach(function(q){if(q==null)return;var v=Number(q);if(isFinite(v)){hi=Math.max(hi,v);lo=Math.min(lo,v)}});
 var pad=(hi-lo)*.07;hi+=pad;lo-=pad;var Y=function(p){return T+(hi-p)/(hi-lo)*PH},X=function(k){return L+(k+.5)/n*PW},cw=Math.max(2,PW/n*.7);
 var labs=[];if(lv){labs.push({p:lv.entry,col:'#f2b84b',t:'GİRİŞ'});labs.push({p:lv.stop,col:'#ff6b7a',t:'STOP'});if(lv.tp1!=null)labs.push({p:lv.tp1,col:'#3ddc97',t:'TP1'});if(lv.tp2!=null)labs.push({p:lv.tp2,col:'#5aa9ff',t:'TP2'})}labs.push({p:px,col:'#e6ebf2',t:'',cur:1});labs.forEach(function(l){l.y=Y(l.p);l.yy=l.y});labs.sort(function(a,b){return a.y-b.y});for(var i=1;i<labs.length;i++){if(labs[i].yy-labs[i-1].yy<16)labs[i].yy=labs[i-1].yy+16}
 x.font='10px system-ui';for(var g=0;g<=5;g++){var gy=T+PH*g/5,gp=hi-(hi-lo)*g/5;x.strokeStyle='rgba(255,255,255,.05)';x.lineWidth=1;x.beginPath();x.moveTo(L,gy);x.lineTo(W-R,gy);x.stroke();var near=labs.some(function(l){return Math.abs(l.yy-gy)<10});if(!near){x.fillStyle='#6f7e91';x.fillText(fp(gp),W-R+8,gy+3)}}
 var line=function(arr,col,w){if(!arr)return;x.strokeStyle=col;x.lineWidth=w;x.beginPath();var st=false;arr.forEach(function(v,k){if(v==null)return;st?x.lineTo(X(k),Y(v)):(x.moveTo(X(k),Y(v)),st=true)});x.stroke()};line(d.e50,'#b794f4',1.1);line(d.e21,'#5aa9ff',1.1);
 d.c.forEach(function(k,i){var up=k[4]>=k[1],col=up?'#3ddc97':'#ff6b7a';x.strokeStyle=col;x.fillStyle=col;x.lineWidth=1;x.beginPath();x.moveTo(X(i),Y(k[2]));x.lineTo(X(i),Y(k[3]));x.stroke();x.fillRect(X(i)-cw/2,Math.min(Y(k[1]),Y(k[4])),cw,Math.max(1,Math.abs(Y(k[4])-Y(k[1]))))});
 var vmax=Math.max.apply(null,d.c.map(function(k){return k[5]}))||1,vTop=T+PH+8;x.strokeStyle='rgba(255,255,255,.08)';x.beginPath();x.moveTo(L,vTop);x.lineTo(W-R,vTop);x.stroke();d.c.forEach(function(k,i){var col=k[4]>=k[1]?'#3ddc97':'#ff6b7a',h=(k[5]/vmax)*(volH-4);x.fillStyle=col;x.globalAlpha=0.55;x.fillRect(X(i)-cw/2,vTop+volH-h,cw,h);x.globalAlpha=1});
 x.save();x.beginPath();x.rect(L,T,W-R-L,PH);x.clip();labs.forEach(function(l){if(l.cur)return;x.strokeStyle=l.col;x.lineWidth=1.3;x.globalAlpha=.85;x.setLineDash([6,4]);x.beginPath();x.moveTo(L,l.y);x.lineTo(W-R,l.y);x.stroke();x.setLineDash([]);x.globalAlpha=1});x.restore();
 x.strokeStyle='rgba(255,255,255,.7)';x.lineWidth=1;x.setLineDash([1,3]);x.beginPath();x.moveTo(L,Y(px));x.lineTo(W-R,Y(px));x.stroke();x.setLineDash([]);
 labs.forEach(function(l){var y=Math.max(T-4,Math.min(T+PH+4,l.yy)),txt=(l.t?l.t+' ':'')+fp(l.p);x.fillStyle=l.col;x.fillRect(W-R+2,y-8,R-4,16);x.fillStyle='#0c1117';x.font='bold 10px system-ui';x.fillText(txt,W-R+6,y+3.5)});
 x.fillStyle='#6f7e91';x.font='10px system-ui';var stp=Math.max(1,Math.ceil(nc/7));for(var q=0;q<nc;q+=stp){var dt=new Date(d.c[q][0]),hh=('0'+dt.getHours()).slice(-2)+':'+('0'+dt.getMinutes()).slice(-2);x.fillText(hh,X(q)-12,H-5)}
 if(V&&V.dir){var isLg=V.dir==='LONG';x.fillStyle=dc;x.fillRect(8,7,96,26);x.fillStyle='#0c1117';x.font='bold 14px system-ui';x.fillText(isLg?'▲ LONG':'▼ SHORT',18,25);if(V.strat){x.fillStyle='#e6ebf2';x.font='bold 12px system-ui';x.fillText(V.strat,114,25)}}}

function renderMain(){var M=$('main');
 if(tab==='stat'){M.removeAttribute('data-view');M.innerHTML=statView();return}
 if(tab==='lab'){M.removeAttribute('data-view');M.innerHTML=labView();return}
 if(tab==='set'){M.removeAttribute('data-view');M.innerHTML=setView();return}
 if(tab==='bt'){M.removeAttribute('data-view');M.innerHTML=btView();return}
 if(sel&&sel.sym){var kind=sel.kind,o=selData(),tf=tfSel||(kind==='rad'?'15m':(kind==='fade'?'1m':'15m'));var P=(o&&(kind==='fade'||kind==='tri'||(kind==='rad'&&o.broke)))?posInfo(o):null;var dir=o?(o.dir||o.bias):null;var vk=kind+'|'+sel.sym+'|'+(sel.id||'')+'|'+tf;
  if(M.getAttribute('data-view')!==vk){M.setAttribute('data-view',vk);var tfs=['1m','5m','15m','1h'].map(function(t){return '<button class="'+(t===tf?'a':'')+'" onclick="setTf(\''+t+'\')">'+t.toUpperCase()+'</button>'}).join('');
   M.innerHTML='<div class="r1" style="margin-bottom:8px"><h2 style="margin:0">'+esc(sel.sym.split('/')[0])+'</h2><span id="hdrTags" class="r1"></span><span class="tfb">'+tfs+'</span><a class="btn tv" style="margin-left:8px" href="https://www.tradingview.com/chart/?symbol=BITGET:'+sel.sym.split('/')[0]+'USDT.P&interval='+({'1m':'1','5m':'5','15m':'15','1h':'60'}[tf]||'15')+'" target="_blank">📈 TV</a></div><div id="pnlB"></div><canvas id="cv"></canvas><div id="lvB"></div><div id="why" class="why"></div><div id="calcWrap">'+calcBox(P?P.levels.entry:'',P?P.levels.stop:'')+'</div>';bindCalc()}
  $('hdrTags').innerHTML=(dir?dirBadge(dir):'')+stratTag(kind)+(kind==='fade'&&o?'<span class="tag w">uzama '+f2(o.ext,1)+' ATR</span>':'' )+(kind==='tri'&&o?'<span class="tag w">'+esc(o.type||'')+'</span>':'');
  if(P){var ru=(+cfgC.bal||0)*Math.min(2,+cfgC.risk||0)/100,usd=P.r*ru,virt=(kind==='rad');var stTxt=P.fin?('KAPANDI • '+(ST[o.status]||[o.status])[0]):(virt?'ÇİZGİDEN BERİ • ONAYSIZ':(o.status==='TP1'?'CANLI • TP1_ALINDI':'CANLI'));
   $('pnlB').innerHTML='<div class="pnl '+cl(P.r)+'"><div><span class="pl">'+stTxt+'</span><b class="'+cl(P.r)+'">'+sg(P.r)+'R</b></div><div><span class="pl">Fiyat farkı</span><b class="'+cl(P.pct)+'">'+sg(P.pct)+'%</b></div><div><span class="pl">≈ K/Z (sanal)</span><b class="'+cl(usd)+'">'+sg(usd)+' USDT</b></div><div><span class="pl">Sinyal / süre</span><b style="font-size:16px">'+(o.time?clk(o.time)+' • '+ago(o.time):'-')+'</b></div><div><span class="pl">En iyi / kötü</span><b style="font-size:16px">'+(o.mfe!=null?f2(o.mfe,1)+' / '+f2(o.mae||0,1)+'R':'-')+'</b></div></div>';
   $('lvB').innerHTML='<div class="lv"><div><span>'+(P.fin?'Çıkış':'Anlık')+'</span><b>'+fp(P.fin&&o.exitPrice?o.exitPrice:P.px)+'</b></div><div><span>Giriş</span><b>'+fp(o.entry)+'</b></div><div><span>Stop</span><b class="zarar">'+fp(o.stop)+'</b></div><div><span>TP1</span><b class="kar">'+fp(o.tp1)+'</b></div><div><span>TP2</span><b class="kar">'+fp(o.tp2)+'</b></div><div><span>Risk</span><b>'+f2(o.riskPct)+'%</b></div>'+(o.costR!=null?'<div><span>Maliyet</span><b>'+f2(o.costR)+'R</b></div>':'')+'</div>'}
  else $('pnlB').innerHTML='';
  $('why').innerHTML=whyText(o,kind);
  var k=sel.sym+'|'+tf;if(chartCache[k]){drawChart(chartCache[k],{dir:dir,levels:P?P.levels:null,virtual:(kind==='rad'),px:(S.px&&S.px[sel.sym])||(o&&o.price)||null,strat:stratName(kind)},'cv')}
  if(chartFor!==k){chartFor=k;loadChart(sel.sym,tf)}return}
 var fs=S.fade.stats,R=S.regime,T=S.tri;
 M.innerHTML='<h2>Panel</h2><div class="tiles">'+
  '<div class="tile"><div class="k">FADE açık</div><div class="v">'+(S.fade.open||[]).filter(isOp).length+'</div></div>'+
  '<div class="tile"><div class="k">FADE bugün</div><div class="v '+cl(fs.today.totalR)+'">'+sg(fs.today.totalR,1)+'R</div></div>'+
  '<div class="tile"><div class="k">Teyit bekleyen spike</div><div class="v">'+(S.fade.watching||[]).length+'</div></div>'+
  '<div class="tile"><div class="k">Üçgen açık</div><div class="v">'+(S.tri.open||[]).filter(isOp).length+'</div></div>'+
  '<div class="tile"><div class="k">Üçgen radar</div><div class="v">'+(S.tri.radar||[]).length+'</div></div>'+
  '<div class="tile"><div class="k">Formasyon</div><div class="v">'+(S.tri.formations||0)+'</div></div></div>'+
  '<div class="box '+fs.verdict.lvl+'"><h3 style="margin-top:0">FADE karnesi</h3>'+esc(fs.verdict.txt)+'<div class="note">Açık '+fs.open+' • anlık ortalama '+sg(fs.openAvg)+'R</div></div>'+
  '<div class="box"><h3 style="margin-top:0">Sistem</h3>'+(R?'<div class="note" style="color:var(--tx)"><b>Piyasa:</b> '+R.tag+' (60dk '+sg(R.ret60)+'%, ER '+f2(R.er)+')</div>':'')+'<div class="note" style="color:var(--tx)">⚡ FADE • △ ÜÇGEN • 📊 LAB. Sinyaller sanal takiptir.</div></div>'}

function renderAll(){renderTop();renderTabs();renderList();renderMain()}
function poll(){fetch(api('/api/state')).then(function(r){return r.json()}).then(function(d){if(d&&d.error){$('dot').className='dot';$('conn').textContent='Hata';return}S=d;$('dot').className='dot on';$('conn').textContent='Bağlı';try{check();renderAll()}catch(e){console.error(e);$('conn').textContent='Bağlı (arayüz hatası)'}}).catch(function(){$('dot').className='dot';$('conn').textContent='Bağlantı yok'})}
addEventListener('resize',function(){if(S)try{renderMain()}catch(e){}});
setInterval(poll,3000);
setInterval(function(){if((tab==='sig')&&sel&&sel.sym){loadChart(sel.sym,tfSel||(sel.kind==='fade'?'1m':'15m'))}},8000);
poll();
</script></body></html>`;

// ======================= HTTP =======================
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const authed = u => !!ADMIN_KEY && safeEq(u.searchParams.get('key') || '', ADMIN_KEY);
const uiOk = u => !UI_KEY || safeEq(u.searchParams.get('key') || '', UI_KEY);
const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    try {
        if (u.pathname === '/health') return json(res, 200, { ok: true, version: 'v35', universe: universe.length, regime: REG, watching: Object.keys(watch).length, fade: { total: fade.length, open: fade.filter(isOpen).length, alt: fadeAlt.length }, tri: { total: triPos.length, open: triPos.filter(isOpen).length, formations: Object.keys(struct).length }, lab: lab.length });
        if (u.pathname === '/api/reset' && req.method === 'POST') { if (!authed(u)) return json(res, 401, { error: 'yetkisiz' }); fade = []; fadeAlt = []; triPos = []; lab = []; shadow = []; lastSig = {}; dirty = true; saveState(); return json(res, 200, { ok: true }); }
        if (['/', '/index.html', '/api/state', '/api/candles'].includes(u.pathname) && !uiOk(u)) return json(res, 401, { error: 'yetkisiz' });
        if (u.pathname === '/' || u.pathname === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(HTML); }
        if (u.pathname === '/api/state') return json(res, 200, apiState());
        if (u.pathname === '/api/candles') { return json(res, 200, await apiCandles(u.searchParams.get('symbol') || '', u.searchParams.get('tf') || '')); }
        json(res, 404, { error: 'yok' });
    } catch (e) { json(res, 500, { error: e.message }); }
});

// ======================= BAŞLAT =======================
let tickBusy = false;
async function priceLoop() { if (tickBusy) return; tickBusy = true; try { await refreshTickers(); } finally { tickBusy = false; } }
async function start() {
    try {
        loadState();
        await ex.loadMarkets(); log('marketler:', Object.keys(ex.markets).length);
        await refreshUniverse(); log('evren:', universe.length, 'coin');
        setInterval(refreshUniverse, 5 * 60e3);
        setInterval(priceLoop, 4000);
        setInterval(fadeCycle, 10e3);
        setInterval(track, 15e3);
        setInterval(triTick, 10e3);
        setInterval(async () => { try { REG = (await regime.tick(ex)) || REG; } catch (e) { } }, 60e3); regime.tick(ex).then(r => REG = r || REG).catch(() => { });
        setInterval(saveState, 15e3);
        lastTriSlot = Math.floor((Date.now() - 8000) / M15); triScan();
        setInterval(() => { const slot = Math.floor((Date.now() - 8000) / M15); if (slot > lastTriSlot && !triScanInfo.running) { lastTriSlot = slot; triScan(); } }, 3000);
        log('SONER TRADE v35 hazır • FADE + Lab + Üçgen • sanal takip');
    } catch (e) { log('başlatma hatası', e.message); setTimeout(start, 30000); }
}
function shutdown() { dirty = true; saveState(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
if (require.main === module) server.listen(PORT, '0.0.0.0', () => { log('PORT', PORT); start(); });
module.exports = { detectSpike, confirmSpike, fadePlan, advance, mkPos, grp, verdictOf, labStat, detectTriangle, fStage1, CFG, HTML, setHist: (s, h) => hist.set(s, h), costFor, ciOf };
