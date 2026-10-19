'use strict';
// AlphaSon v61.1 — AlgoCoinism Edition (Grafik & Detay Düzeltmeleri)
// LT Üçgen, Chart Çizimi ve TRF Trend KORUNDU. Detay panelleri ve anlık PnL eklendi.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ccxt = require('ccxt');

const num = (k, d) => process.env[k] == null || process.env[k] === '' ? d : Number(process.env[k]);
const PORT = Number(process.env.PORT || 10000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';

const M1 = 60e3, M5 = 5*M1, M15 = 15*M1, H1 = 3600e3, H2 = 2*H1, H4 = 4*H1;
const BTC = 'BTC/USDT:USDT', ETH = 'ETH/USDT:USDT';
const TRI_TF = (process.env.TRI_TF || '2h').toLowerCase();
const TRI_MS = TRI_TF === '2h' ? H2 : TRI_TF === '1h' ? H1 : M15;
const NON_CRYPTO = ['USDC','USDT','DAI','TUSD','BUSD','FDUSD','USDE','SUSDE','USDS','USD1','PYUSD','USDD','FRAX','LUSD','GUSD','BUIDL','USTC','USDP','WBTC','WETH','WSTETH','STETH','RETH','CBETH','WBNB','WAVAX','WMATIC','PAXG','XAUT','XAU','XAG','XPT','XPD','GOLD','SILVER','OIL','WTI','BRENT','USOIL','UKOIL','AAPL','MSFT','GOOGL','AMZN','META','TSLA','NVDA','AMD','INTC','ORCL','NFLX','COIN','HOOD','CRCL','MSTR','MARA','RIOT','PLTR','SPY','QQQ','SPCX','SNDK','ARM','SMCI','GME','AMC'];

const CFG_LT = {
    LOG: num('TRI_LOG', 0), TRI_K: num('TRI_LT_K', 3), TRI_LOOK: num('TRI_LT_LOOK', 200),
    TRI_MIN_LEN: num('TRI_LT_MIN_LEN', 20), TRI_MAX_LEN: num('TRI_LT_MAX_LEN', 300),
    TRI_TOL_ATR: num('TRI_LT_TOL_ATR', 0.40), TRI_WICK_ATR: num('TRI_LT_WICK_ATR', 1.50),
    TRI_CLOSE_ATR: num('TRI_LT_CLOSE_ATR', 0.35), TRI_MIN_TOUCH: num('TRI_LT_MIN_TOUCH', 5),
    TRI_LINE_TOUCH: num('TRI_LT_LINE_TOUCH', 3), TRI_TOUCH_SEP: num('TRI_LT_TOUCH_SEP', 4),
    TRI_SQUEEZE: num('TRI_LT_SQUEEZE', 0.88), TRI_FLAT: num('TRI_LT_FLAT', 0.10),
    TRI_MIN_W0_ATR: num('TRI_LT_MIN_W0_ATR', 2.5), TRI_MIN_MAT: num('TRI_LT_MIN_MAT', 0.45),
    TRI_BACK: num('TRI_LT_BACK', 3), TRI_MAX_APEX: num('TRI_LT_MAX_APEX', 500),
    TRI_MAX_MAT: num('TRI_LT_MAX_MAT', 0.98), TRI_FRESH: num('TRI_LT_FRESH', 150),
    TRI_CAND: num('TRI_LT_CAND', 10), GRACE_MIN: num('TRI_LT_GRACE_MIN', 90)
};
const HIST_NEED = CFG_LT.TRI_LOOK * 2 + 120;
const CFG = {
    UNIVERSE: num('UNIVERSE', 1500), MIN_VOL_USDT: num('MIN_VOL', 1e6),
    FLAT_MAX: 0.08, MIN_LISTING_DAYS: num('MIN_LISTING_DAYS', 7),
    EXCLUDED: NON_CRYPTO.concat((process.env.EXCLUDE || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean)),
    CONCURRENCY: num('SCAN_CONCURRENCY', 5), UNIVERSE_MS: 5 * 60e3, KEEP: 500, SCAN_DELAY_MS: 8000,
    NEAR_ATR: num('NEAR_ATR', 1.2), BRK_SEE: num('BRK_SEE', 3.0), FRESH_ENTRY_MIN: num('FRESH_ENTRY_MIN', 10),
    BRK_TP1_FIB: num('BRK_TP1_FIB', 1.618), BRK_TP2_FIB: num('BRK_TP2_FIB', 2.618),
    BRK_EXPIRE_H: num('BRK_EXPIRE_H', 72), BRK_COOLDOWN_H: num('BRK_COOLDOWN_H', 1),
    BRK_MIN_EXT: num('BRK_MIN_EXT', 0.10), BRK_MAX_EXT: num('BRK_MAX_EXT', 99.0),
    BRK_MIN_VOL: num('BRK_MIN_VOL', 1.5), MIN_STRENGTH: num('MIN_STRENGTH', 40),
    MIN_SIG_VOL: num('MIN_SIG_VOL', 1e6), SLIP_PCT: num('SLIP_PCT', 0.03),
    MIN_RISK_PCT: num('MIN_RISK_PCT', 0.5), MAX_RISK_PCT: num('MAX_RISK_PCT', 3.0),
    LATE_EXT: num('LATE_EXT', 0.8), LT_TRAIL_R: num('LT_TRAIL_R', 1.5),
    PUMP_MIN_VOL: num('PUMP_MIN_VOL', 4.0), PUMP_TAKER: num('PUMP_TAKER', 0.75),
    ZONE_TOL: num('ZONE_TOL', 0.008), ZONE_LOOKBACK: num('ZONE_LOOKBACK', 150),
    SMC_LOOKBACK: num('SMC_LOOKBACK', 80)
};
const TR = { ON: 1, MIN_VOL: 1e6, TOP: 400, NOTIFY: 50, MAX_OPEN: 15, KEEP: 300, TG: 1 };
const TREND = { ON: 1, TOP: 1500, MIN_VOL: 1e6, TP1_FIB: 1.618, TP2_FIB: 2.618, COOLDOWN_H: 2, MAX_PER_SCAN: 3, FRESH_MIN: 30, MAX_DIR: 3, TF: (process.env.TREND_TF || '15m').toLowerCase() };
const TREND_MS = TREND.TF === '5m' ? M5 : TREND.TF === '15m' ? M15 : TREND.TF === '1h' ? H1 : H4;
const TRF = { PER1: 27, MULT1: 1.6, PER2: 55, MULT2: 2.0 };

const log = (...a) => console.log('[ALPHASON]', ...a);
const baseOf = s => s.split('/')[0];
const isMajor = s => /^(BTC|ETH)\//.test(s);
const closedOnly = (c, ms, now = Date.now()) => c.filter(x => x[0] + ms <= now);
const fmt = p => { const a = Math.abs(p); return a >= 1000 ? p.toFixed(2) : a >= 1 ? p.toFixed(4) : a >= 0.01 ? p.toFixed(5) : p.toFixed(7); };
const isOpen = s => s.status === 'OPEN' || s.status === 'TP1';
const r2 = x => Number((Number(x) || 0).toFixed(3));
const atrMean = (c, p = 14) => { if (c.length <= p) return 0; let s = 0; for (let i = c.length - p; i < c.length; i++) s += Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - c[i - 1][4]), Math.abs(c[i][3] - c[i - 1][4])); return s / p; };
const atrAt = (c, n, p = 14) => { let s = 0; for (let i = n - p + 1; i <= n; i++) s += Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - c[i - 1][4]), Math.abs(c[i][3] - c[i - 1][4])); return s / p; };
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function emaN(v, p) { const o = new Array(v.length).fill(null); let s0 = 0; while (s0 < v.length && v[s0] == null) s0++; if (v.length - s0 < p) return o; let e = 0; for (let i = s0; i < s0 + p; i++) e += v[i]; e /= p; o[s0 + p - 1] = e; const k = 2 / (p + 1); for (let i = s0 + p; i < v.length; i++) { e = v[i] * k + e * (1 - k); o[i] = e; } return o; }
function atrSeries(c, p = 14) { const o = new Array(c.length).fill(null); if (c.length <= p) return o; let a = 0; for (let i = 1; i <= p; i++) a += Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - c[i - 1][4]), Math.abs(c[i][3] - c[i - 1][4])); a /= p; o[p] = a; for (let i = p + 1; i < c.length; i++) { const tr = Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - c[i - 1][4]), Math.abs(c[i][3] - c[i - 1][4])); a = (a * (p - 1) + tr) / p; o[i] = a; } return o; }
function rsiSeries(cl, p = 14) { const o = new Array(cl.length).fill(null); if (cl.length <= p) return o; let g = 0, l = 0; for (let i = 1; i <= p; i++) { const d = cl[i] - cl[i - 1]; if (d > 0) g += d; else l -= d; } g /= p; l /= p; o[p] = 100 - 100 / (1 + g / (l || 1e-9)); for (let i = p + 1; i < cl.length; i++) { const d = cl[i] - cl[i - 1]; g = (g * (p - 1) + (d > 0 ? d : 0)) / p; l = (l * (p - 1) + (d < 0 ? -d : 0)) / p; o[i] = 100 - 100 / (1 + g / (l || 1e-9)); } return o; }
function volSma(c, p = 20) { const o = new Array(c.length).fill(null); let s = 0; for (let i = 0; i < c.length; i++) { if (i >= p) { o[i] = s / p; s -= c[i - p][5]; } s += c[i][5]; } return o; }
function trendScore(c) { const cl = c.map(x => x[4]), e21 = emaN(cl, 21), e50 = emaN(cl, 50), n = cl.length - 1; const a = atrMean(c, 14) || 1e-9; return 0.4 * Math.tanh((cl[n] - e50[n]) / a / 2) + 0.3 * Math.tanh((e21[n] - e50[n]) / a) + 0.3 * Math.tanh((e21[n] - e21[n - 3]) / a * 2); }

const REQ_QUEUE = { next: 0, minGap: num('REQ_GAP_MS', 120) };
async function throttle() { const now = Date.now(), at = Math.max(now, REQ_QUEUE.next); REQ_QUEUE.next = at + REQ_QUEUE.minGap; if (at > now) await sleep(at - now); }
async function safeFetch(ex, sym, tf, limit, since) { let attempt = 0; while (attempt < 3) { await throttle(); try { return await ex.fetchOHLCV(sym, tf, since, limit); } catch (e) { const msg = String(e.message || e); if (msg.includes('429') || msg.includes('Too Many') || msg.includes('rate limit')) { attempt++; await sleep(2000 * Math.pow(2, attempt - 1)); } else throw e; } } throw new Error('Rate limit: ' + sym); }
let exUI = null;
async function uiFetch(sym, tf, limit) { if (!exUI) { exUI = new ccxt.bitget({ enableRateLimit: true, options: { defaultType: 'swap' } }); try { exUI.setMarkets(ex.markets); } catch (e) { await exUI.loadMarkets(); } } try { return await exUI.fetchOHLCV(sym, tf, undefined, limit); } catch (e) { return await safeFetch(ex, sym, tf, limit); } }
function aggregateN(c, baseMs, n) { const ms = baseMs * n, g = new Map(); for (const x of c) { const k = Math.floor(x[0] / ms) * ms; let a = g.get(k); if (!a) { a = [k, x[1], x[2], x[3], x[4], x[5], 1]; g.set(k, a); } else { a[2] = Math.max(a[2], x[2]); a[3] = Math.min(a[3], x[3]); a[4] = x[4]; a[5] += x[5]; a[6]++; } } return [...g.values()].filter(a => a[6] === n); }
function fillGaps(c, ms, maxFill = 3) { if (!c || !c.length) return c || []; let out = [c[0]]; for (let i = 1; i < c.length; i++) { const prev = out.length ? out[out.length - 1] : null; const gap = prev ? Math.round((c[i][0] - prev[0]) / ms) : 1; if (prev && gap > 1) { if (gap - 1 > maxFill) out = []; else for (let k = 1; k < gap; k++) { const p = prev[4]; out.push([prev[0] + k * ms, p, p, p, p, 0]); } } out.push(c[i]); } return out; }
function mergeC(a, b) { const m = new Map(); for (const x of a) m.set(x[0], x); for (const x of b) m.set(x[0], x); return [...m.values()].sort((p, q) => p[0] - q[0]); }
const histCache = new Map(), histInflight = new Map();
async function getHist1h(sym, need) { if (histInflight.has(sym)) return histInflight.get(sym); const job = getHist1hRaw(sym, need); histInflight.set(sym, job); try { return await job; } finally { histInflight.delete(sym); } }
async function getHist1hRaw(sym, need) { const now = Date.now(); let h = histCache.get(sym); if (!h || !h.c.length) { const want0 = now - need * H1; let since = want0, out = []; for (let g = 0; g < 25; g++) { const r = await safeFetch(ex, sym, '1h', 1000, since); if (!r || !r.length) break; out = out.concat(r); const lt = r[r.length - 1][0]; if (lt >= now - 2 * H1 || lt < since) break; since = lt + H1; } h = { c: closedOnly(mergeC([], out), H1, now), t: now }; } else { const since = h.c[h.c.length - 1][0] - 2 * H1; const r = await safeFetch(ex, sym, '1h', 100, since); h.c = closedOnly(mergeC(h.c, r || []), H1, now); h.t = now; } const cap = need + 300; if (h.c.length > cap) h.c = h.c.slice(-cap); histCache.set(sym, h); return h.c; }

function smoothrng(src, t, m) { const wper = t * 2 - 1; const absDiff = src.map((v, i) => i === 0 ? 0 : Math.abs(v - src[i - 1])); const avrng = emaN(absDiff, t); const smrng = emaN(avrng, wper); return smrng.map(v => v == null ? null : v * m); }
function rngfilt(src, r) { const res = new Array(src.length).fill(null); for (let i = 0; i < src.length; i++) { if (r[i] == null || src[i] == null) continue; if (i === 0) { res[i] = src[i]; continue; } if (src[i] > res[i - 1]) { res[i] = src[i] - r[i] < res[i - 1] ? res[i - 1] : src[i] - r[i]; } else if (src[i] + r[i] > res[i - 1]) { res[i] = res[i - 1]; } else { res[i] = src[i] + r[i]; } } return res; }
function trfSeries(c) { const src = c.map(x => x[4]); if (src.length < TRF.PER2 + 10) return { dir: new Array(src.length).fill(0), filt: new Array(src.length).fill(null) }; const smrng1 = smoothrng(src, TRF.PER1, TRF.MULT1); const smrng2 = smoothrng(src, TRF.PER2, TRF.MULT2); const smrng = smrng1.map((v, i) => v != null && smrng2[i] != null ? (v + smrng2[i]) / 2 : null); const filt = rngfilt(src, smrng); const dir = new Array(src.length).fill(0); let upward = 0, downward = 0; for (let i = 1; i < src.length; i++) { if (filt[i] == null || filt[i-1] == null) continue; if (filt[i] > filt[i - 1]) { upward = (dir[i-1] === 1 ? upward : 0) + 1; downward = 0; } else if (filt[i] < filt[i - 1]) { downward = (dir[i-1] === -1 ? downward : 0) + 1; upward = 0; } const longCond = (src[i] > filt[i] && src[i] > src[i - 1] && upward > 0) || (src[i] > filt[i] && src[i] < src[i - 1] && upward > 0); const shortCond = (src[i] < filt[i] && src[i] < src[i - 1] && downward > 0) || (src[i] < filt[i] && src[i] > src[i - 1] && downward > 0); if (longCond) dir[i] = 1; else if (shortCond) dir[i] = -1; else dir[i] = dir[i - 1]; } return { dir, filt }; }

let MKT_DIR = 'NÖTR', mktLastUpdate = 0;
async function updateMarketDirection() { try { const now = Date.now(); if (now - mktLastUpdate < 60e3) return; const [btcC, ethC] = await Promise.all([safeFetch(ex, BTC, '15m', 100), safeFetch(ex, ETH, '15m', 100)]); let bDir = 0, eDir = 0; if (btcC && btcC.length > 60) { const cl = fillGaps(btcC.filter(x => x[0] + M15 <= now), M15); if (cl.length > 60) { const trf = trfSeries(cl); bDir = trf.dir[cl.length-1] || 0; } } if (ethC && ethC.length > 60) { const cl = fillGaps(ethC.filter(x => x[0] + M15 <= now), M15); if (cl.length > 60) { const trf = trfSeries(cl); eDir = trf.dir[cl.length-1] || 0; } } if (bDir === 1 && eDir === 1) MKT_DIR = 'LONG'; else if (bDir === -1 && eDir === -1) MKT_DIR = 'SHORT'; else MKT_DIR = 'NÖTR'; market.btcDir = bDir === 1 ? 'LONG' : bDir === -1 ? 'SHORT' : 'NÖTR'; mktLastUpdate = now; } catch(e) {} }

const ofCache = new Map();
async function getFlowData(sym) { const now = Date.now(), hit = ofCache.get(sym); if (hit && now - hit.t < 20e3) return hit.d; let d = null; try { await throttle(); const trades = await ex.fetchTrades(sym, undefined, 500); const from = now - 15 * M1; let buyVol = 0, sellVol = 0, n = 0; for (const t of trades || []) { if (!t || !(t.timestamp >= from)) continue; const v = Number(t.cost) || (Number(t.price) * Number(t.amount)) || 0; if (t.side === 'buy') buyVol += v; else if (t.side === 'sell') sellVol += v; else continue; n++; } await throttle(); const ob = await ex.fetchOrderBook(sym, 20); let bidVol = 0, askVol = 0; for (const q of (ob.bids || []).slice(0, 20)) bidVol += q[0] * q[1]; for (const q of (ob.asks || []).slice(0, 20)) askVol += q[0] * q[1]; const total = buyVol + sellVol; d = { n, takerBuyRatio: total > 0 ? buyVol / total : 0.5, obImbalance: (bidVol + askVol) > 0 ? (bidVol - askVol) / (bidVol + askVol) : 0, t: now }; } catch (e) { d = null; } ofCache.set(sym, { t: now, d }); return d; }

// ÜÇGEN - DEĞİŞTİRİLMEDİ
function pivots(c, end, K, from) { const hi = [], lo = []; for (let i = Math.max(K, from); i <= end - K; i++) { let isH = true, isL = true; for (let d = 1; d <= K && (isH || isL); d++) { if (c[i][2] <= c[i - d][2] || c[i][2] < c[i + d][2]) isH = false; if (c[i][3] >= c[i - d][3] || c[i][3] > c[i + d][3]) isL = false; } if (isH) hi.push({ i, p: c[i][2] }); if (isL) lo.push({ i, p: c[i][3] }); } return { hi, lo }; }
function fitLines(pts, c, end, atrA, side, C, prevKey, maxC) { if (!pts || pts.length < 2) return []; const aEnd = atrA[end], all = []; for (let a = 0; a < pts.length - 1; a++) { for (let b = a + 1; b < pts.length; b++) { const A = pts[a], B = pts[b], len = B.i - A.i; if (len < 15) continue; const s = (B.p - A.p) / len; let ok = true, touches = 0, lastT = -1e9, devSum = 0; const inl = []; for (let q = a; q < pts.length; q++) { const p = pts[q]; const lp = A.p + s * (p.i - A.i), at = atrA[p.i] || aEnd; const gap = side * (p.p - lp); if (gap > C.TRI_TOL_ATR * at * 2) { ok = false; break; } if (Math.abs(gap) <= C.TRI_TOL_ATR * at) { inl.push(p); if (p.i - lastT >= C.TRI_TOUCH_SEP) { touches++; lastT = p.i; devSum += Math.abs(gap) / at; } } } if (!ok || touches < C.TRI_LINE_TOUCH) continue; if (end - lastT > C.TRI_FRESH) continue; let cok = true; for (let x = A.i; x <= end; x++) { const lp = A.p + s * (x - A.i), at = atrA[x] || aEnd; if (side === 1) { if (c[x][4] > lp + C.TRI_CLOSE_ATR * at || c[x][2] > lp + C.TRI_WICK_ATR * at) { cok = false; break; } } else { if (c[x][4] < lp - C.TRI_CLOSE_ATR * at || c[x][3] < lp - C.TRI_WICK_ATR * at) { cok = false; break; } } } if (!cok) continue; const dev = devSum / touches; let score = Math.log(len) * 40 + touches * 40 - dev * 15 - (end - lastT) * 0.3; if (prevKey) { if (prevKey[0] === c[A.i][0]) score += 40; if (prevKey[1] === c[B.i][0]) score += 40; } all.push({ i0: A.i, p0: A.p, s, sn: s / aEnd, touches, last: lastT, score, dev, pts: inl, t0: c[A.i][0], t1: c[B.i][0] }); } } all.sort((x, y) => y.score - x.score); const out = []; for (const L of all) { if (out.every(o => Math.abs(o.sn - L.sn) > 0.005)) { out.push(L); if (out.length >= maxC) break; } } return out; }
const triDiag = {}; let triMute = false, triLast = null;
function triRej(k) { if (!triMute) triDiag[k] = (triDiag[k] || 0) + 1; return null; }
const TRI_GATES = ['toplamDokunus', 'uzunluk', 'genislikNegatif', 'konverjansYok', 'daralmaYetersiz', 'cokDar', 'yukseklikAz', 'apeksUzak', 'olgunluk', 'yasakliTip'];
function evalPair(end, atr, atrP, C, R, S) { const rej = (g, o) => Object.assign({ ok: false, g, rank: TRI_GATES.indexOf(g), tc: R.touches + S.touches }, o); if (R.touches + S.touches < C.TRI_MIN_TOUCH) return rej('toplamDokunus'); const xs = Math.max(R.i0, S.i0), len = end - xs; if (len < C.TRI_MIN_LEN || len > C.TRI_MAX_LEN) return rej('uzunluk'); const rv = x => R.p0 + R.s * (x - R.i0), sv = x => S.p0 + S.s * (x - S.i0); const w0 = rv(xs) - sv(xs), wN = rv(end) - sv(end); if (!(w0 > 0 && wN > 0)) return rej('genislikNegatif'); const sq = wN / w0, dsl = S.s - R.s; if (!(dsl > 0)) return rej('konverjansYok', { sq }); if (sq > C.TRI_SQUEEZE) return rej('daralmaYetersiz', { sq }); if (wN < 0.4 * atr) return rej('cokDar', { sq }); if (w0 < C.TRI_MIN_W0_ATR * atr) return rej('yukseklikAz', { sq }); const apex = end + wN / dsl; if (apex - end > (C.TRI_MAX_APEX || 300)) return rej('apeksUzak', { sq }); const mat = (end - xs) / (apex - xs); if (mat < C.TRI_MIN_MAT || mat > C.TRI_MAX_MAT) return rej('olgunluk', { sq, mat }); const flatTol = C.TRI_FLAT * w0 / len; if (!(R.s < -flatTol && S.s > flatTol)) return rej('yasakliTip', { sq, mat }); const pscore = R.score + S.score + (1 - sq) * 150 - Math.abs(R.i0 - S.i0) * 0.1; return { ok: true, pscore, tri: { type: 'Simetrik', end, atr: atrP, atrLog: atr, w0, wN, apex, len, R, S, touches: R.touches + S.touches, squeeze: sq, mat, keys: { R: [R.t0, R.t1], S: [S.t0, S.t1] } } }; }
function detectTriangle(c, end, C, prevKeys) { triLast = null; if (end < 60) return triRej('kisaVeri'); const lc = c.slice(0, end + 1); const atrA = atrSeries(lc, 14), atr = atrA[end]; if (!(atr > 0)) return triRej('atrYok'); const atrP = atrSeries(c.slice(0, end + 1), 14)[end]; if (!(atrP > 0)) return triRej('atrFiyatYok'); const pv = pivots(lc, end, C.TRI_K, Math.max(1, end - C.TRI_LOOK)); if (pv.hi.length < 2 || pv.lo.length < 2) return triRej('pivotYetersiz'); const mc = C.TRI_CAND || 8; const Rs = fitLines(pv.hi, lc, end, atrA, 1, C, prevKeys && prevKeys.R, mc); const Ss = fitLines(pv.lo, lc, end, atrA, -1, C, prevKeys && prevKeys.S, mc); if (!Rs.length || !Ss.length) return triRej('cizgiBulunamadi'); let best = null, worst = null, anyConv = false; for (const R of Rs) for (const S of Ss) { if (S.s > R.s) anyConv = true; const r = evalPair(end, atr, atrP, C, R, S); if (r.ok) { if (!best || r.pscore > best.pscore) best = r; } else if (!worst || r.rank > worst.rank || (r.rank === worst.rank && (r.sq == null ? 9 : r.sq) < (worst.sq == null ? 9 : worst.sq))) worst = r; } if (!triMute) { const ck = anyConv ? '_konvVar' : '_konvYok'; triDiag[ck] = (triDiag[ck] || 0) + 1; } if (!best) { triLast = worst; return triRej(worst.g); } if (!triMute) triDiag.OK = (triDiag.OK || 0) + 1; return best.tri; }
function pack(tri, c, ms) { const lastI = c.length - 1, tOf = i => i <= lastI ? c[Math.max(0, Math.round(i))][0] : c[lastI][0] + (i - lastI) * (ms || TRI_MS); const xEnd = tri.end + 30; const seg = L => [[tOf(L.i0), L.p0], [tOf(xEnd), L.p0 + L.s * (xEnd - L.i0)]]; return { type: tri.type, touches: tri.touches, squeeze: Number(tri.squeeze.toFixed(2)), mat: Number(tri.mat.toFixed(2)), apex: tOf(tri.apex), w0: tri.w0, res: seg(tri.R), sup: seg(tri.S), hi: tri.R.pts.map(p => [tOf(p.i), p.p]), lo: tri.S.pts.map(p => [tOf(p.i), p.p]) }; }
function htfDir(c2) { try { const c4 = aggregateN(c2, H2, 2); if (c4.length < 60) return 0; const s = trendScore(c4); return s > 0.15 ? 1 : s < -0.15 ? -1 : 0; } catch (e) { return 0; } }

// TRF TREND
const trendRun = { running: false, lastBar: 0, last: 0, ms: 0, dg: null, retryAt: 0, tryBar: 0, tries: 0 };
function trendEval(c, n, entry, vol24, mktDir) { if (n < 100) return { skip: 'short' }; const trf = trfSeries(c.slice(0, n + 1)); if (!trf || !trf.dir[n] || trf.filt[n] == null) return { skip: 'short' }; const L = trf.dir[n]; if (mktDir === 'LONG' && L === -1) return { skip: 'mktTers' }; if (mktDir === 'SHORT' && L === 1) return { skip: 'mktTers' }; const atr = atrAt(c, n, 14); if (!(atr > 0)) return { skip: 'short' }; const lookback = 10; const swing = c.slice(n - lookback, n + 1); const swingLow = Math.min(...swing.map(x => x[3])); const swingHigh = Math.max(...swing.map(x => x[2])); let stop = L === 1 ? swingLow - atr * 0.5 : swingHigh + atr * 0.5; const minDist = Math.max(atr * 0.8, entry * 0.005); if (L === 1 && entry - stop < minDist) stop = entry - minDist; if (L === -1 && stop - entry < minDist) stop = entry + minDist; if (Math.abs(entry - stop) / entry > 0.03) { const maxDist = Math.min(entry * 0.025, atr * 2.5); stop = L === 1 ? entry - maxDist : entry + maxDist; } const riskAbs = Math.abs(entry - stop); const riskPct = (riskAbs / entry) * 100; if (riskPct < CFG.MIN_RISK_PCT || riskPct > CFG.MAX_RISK_PCT) return { skip: 'risk' }; const wave = Math.max(swingHigh - swingLow, atr * 2.5); const tp1 = L === 1 ? entry + (wave * TREND.TP1_FIB) : entry - (wave * TREND.TP1_FIB); const tp2 = L === 1 ? entry + (wave * TREND.TP2_FIB) : entry - (wave * TREND.TP2_FIB); let av = 0; for (let i = n - 20; i < n; i++) av += c[i][5]; av /= 20; const volX = av > 0 ? c[n][5] / av : 1; const score = Math.round(Math.min(100, 70 + (volX >= 1.5 ? 15 : 0))); return { cand: { dir: L === 1 ? 'LONG' : 'SHORT', score, entry, stop, riskAbs, riskPct: r2(riskPct), tp1, tp2, tp1R: TREND.TP1_FIB, tp2R: TREND.TP2_FIB, atr, volX, candleT: c[n][0] } }; }
function buildTREND(sym, cd, time, mktDir) { return { id: 'TREND_' + sym.replace(/[^A-Z0-9]/g, '') + '_' + cd.candleT, symbol: sym, base: baseOf(sym), dir: cd.dir, strategy: 'TREND', setup: 'TREND', setupName: 'TRF Trend (' + TREND.TF + ')', entry: cd.entry, stop: cd.stop, initialStop: cd.stop, tp1: cd.tp1, tp2: cd.tp2, tp1R: cd.tp1R, tp2R: cd.tp2R, riskAbs: cd.riskAbs, riskPct: cd.riskPct, costR: 0, volX: cd.volX, atr: cd.atr, score: cd.score, chartTf: TREND.TF, reg: mktDir, aligned: mktDir !== 'NÖTR' ? mktDir === cd.dir : null, takerBuy: cd.takerBuy, time, candleT: cd.candleT, freshMin: TREND.FRESH_MIN, lastPrice: cd.entry, mfe: 0, mae: 0, maxHold: 999 * H1, status: 'OPEN', trackedTo: cd.candleT }; }
async function runTrend(force) { if (!TREND.ON || !TR.ON || trendRun.running || !universe.length || !Object.keys(tickers).length) return; const t0 = Date.now(), bar = Math.floor(t0 / TREND_MS) * TREND_MS; if (!force) { if (trendRun.lastBar === bar || t0 < trendRun.retryAt || t0 - bar < 8000) return; } await updateMarketDirection(); trendRun.running = true; try { const list = universe.filter(s => isMajor(s) || ((tickers[s] || {}).quoteVolume || 0) >= TREND.MIN_VOL).slice(0, TREND.TOP); let idx = 0; const cands = []; const dg = { list: list.length, ok: 0, cand: 0, sig: 0, err: 0, skip: {}, mkt: MKT_DIR }; const worker = async () => { while (idx < list.length) { const sym = list[idx++]; try { const raw = await safeFetch(ex, sym, TREND.TF, 300); const closed = raw.filter(x => x[0] + TREND_MS <= t0 + 2000); if (closed.length < 100) { dg.skip.short = (dg.skip.short || 0) + 1; continue; } const c = fillGaps(closed, TREND_MS); if (!c || c.length < 100) { dg.skip.short = (dg.skip.short || 0) + 1; continue; } const n = c.length - 1; dg.ok++; const tk = tickers[sym] || {}, entry = tk.last || c[n][4]; const r = trendEval(c, n, entry, tk.quoteVolume, MKT_DIR); if (!r.cand) { dg.skip[r.skip] = (dg.skip[r.skip] || 0) + 1; continue; } dg.cand++; cands.push(Object.assign({ sym }, r.cand)); } catch (e) { dg.err++; } } }; await Promise.all(Array.from({ length: CFG.CONCURRENCY }, worker)); cands.sort((a, b) => b.score - a.score); let openN = trendSignals.filter(isOpen).length, added = 0; for (const cd of cands) { if (added >= TREND.MAX_PER_SCAN || openN >= TR.MAX_OPEN) { dg.skip.cap = (dg.skip.cap || 0) + 1; continue; } if (trendSignals.some(x => x.symbol === cd.sym && isOpen(x))) { dg.skip.open = (dg.skip.open || 0) + 1; continue; } const flow = await getFlowData(cd.sym); if (flow) { if (cd.dir === 'LONG' && flow.takerBuyRatio < 0.55) { dg.skip.flow = (dg.skip.flow || 0) + 1; continue; } if (cd.dir === 'SHORT' && flow.takerBuyRatio > 0.45) { dg.skip.flow = (dg.skip.flow || 0) + 1; continue; } cd.takerBuy = Math.round(flow.takerBuyRatio * 100); } const sig = buildTREND(cd.sym, cd, t0, MKT_DIR); if (trendSignals.some(x => x.id === sig.id)) continue; trendSignals.unshift(sig); if (trendSignals.length > TR.KEEP) trendSignals.length = TR.KEEP; added++; openN++; dg.sig++; if (TR.TG && sig.score >= TR.NOTIFY) telegram(trendMsg(sig)); } trendRun.dg = dg; trendRun.lastBar = bar; } catch (e) { log('TREND hata', e.message); } trendRun.last = Date.now(); trendRun.ms = trendRun.last - t0; trendRun.running = false; }
function trendMsg(s) { return (s.dir === 'LONG' ? '🟢 ' : '🔴 ') + '📈 TRF TREND ' + s.dir + ' ' + s.base + ' — PUAN %' + s.score + '\nGiriş ' + fmt(s.entry) + '\nTP1: ' + fmt(s.tp1) + '\nTP2: ' + fmt(s.tp2) + '\nTaker %' + (s.takerBuy || '?') + '\n📈 ' + tvLink(s.base, TREND.TF === '5m' ? 5 : TREND.TF === '15m' ? 15 : 60); }
const tvLink = (base, iv) => 'https://www.tradingview.com/chart/?symbol=BITGET:' + base + 'USDT.P&interval=' + iv;

const pumpSignals = [];
async function scanPump() { if (!universe.length) return; const top = universe.slice(0, 200); for (const sym of top) { try { const raw = await safeFetch(ex, sym, '5m', 60); const closed = closedOnly(raw, M5); if (closed.length < 40) continue; const cur = raw.find(x => x[0] + M5 > Date.now()); const last10 = closed.slice(-2); let v10 = last10.reduce((s, x) => s + x[5], 0); if (cur) v10 += cur[5]; const base3h = closed.slice(-38, -2); const avg3h = base3h.reduce((s, x) => s + x[5], 0) / base3h.length; if (!(avg3h > 0)) continue; const avg10 = avg3h * 2; const mult = v10 / avg10; if (mult < CFG.PUMP_MIN_VOL) continue; const flow = await getFlowData(sym); if (!flow || flow.takerBuyRatio < CFG.PUMP_TAKER) continue; if (pumpSignals.some(x => x.symbol === sym && Date.now() - x.t < 30 * 60e3)) continue; const tk = tickers[sym]; if (!tk || !tk.last) continue; const sig = { symbol: sym, base: baseOf(sym), t: Date.now(), entry: tk.last, peak: tk.last, volMult: r2(mult), taker: Math.round(flow.takerBuyRatio * 100), v10: r2(v10), avg3h: r2(avg3h), status: 'OPEN', maxPump: 0, stop: tk.last * 0.95 }; pumpSignals.unshift(sig); if (pumpSignals.length > 100) pumpSignals.length = 100; telegram('🚀 ALGOPUMP: ' + sig.base + '\nHacim: ' + sig.volMult + 'x\nTaker: %' + sig.taker + '\nFiyat: ' + fmt(sig.entry)); } catch (e) {} } }
function trackPumps() { for (const p of pumpSignals) { if (p.status !== 'OPEN') continue; const tk = tickers[p.symbol]; if (!tk || !tk.last) continue; if (tk.last > p.peak) p.peak = tk.last; p.maxPump = r2(((p.peak - p.entry) / p.entry) * 100); if (Date.now() - p.t > 3 * H1) p.status = 'CLOSED'; } }

const zoneSignals = {};
async function scanZones() { if (!universe.length) return; const top = universe.slice(0, 100); let idx = 0; const worker = async () => { while (idx < top.length) { const sym = top[idx++]; try { const raw = await safeFetch(ex, sym, '1h', 300); const c = fillGaps(closedOnly(raw, H1), H1); if (c.length < 100) continue; const atr = atrMean(c, 14); const end = c.length - 1; const pv = pivots(c, end, 3, Math.max(1, end - CFG.ZONE_LOOKBACK)); if (pv.hi.length + pv.lo.length < 4) continue; const resZones = groupPivots(pv.hi, atr); const supZones = groupPivots(pv.lo, atr); const tk = tickers[sym]; if (!tk || !tk.last) continue; const zones = []; for (const z of resZones) { const dist = Math.abs(tk.last - z.price) / atr; const strength = Math.min(100, 20 + z.touches * 12); zones.push({ kind: 'res', price: r2(z.price), touches: z.touches, strength, dist: r2(dist), t0: z.t0 }); } for (const z of supZones) { const dist = Math.abs(tk.last - z.price) / atr; const strength = Math.min(100, 20 + z.touches * 12); zones.push({ kind: 'sup', price: r2(z.price), touches: z.touches, strength, dist: r2(dist), t0: z.t0 }); } zones.sort((a, b) => a.dist - b.dist); zoneSignals[sym] = { symbol: sym, base: baseOf(sym), price: tk.last, zones: zones.slice(0, 6), atr: r2(atr), t: Date.now() }; } catch (e) {} } }; await Promise.all(Array.from({ length: 6 }, worker)); }
function groupPivots(pts, atr) { if (!pts.length) return []; const sorted = pts.slice().sort((a, b) => a.p - b.p); const groups = []; for (const p of sorted) { let found = false; for (const g of groups) { if (Math.abs(g.price - p.p) < atr * CFG.ZONE_TOL * 100) { g.touches++; g.price = (g.price * (g.touches - 1) + p.p) / g.touches; g.t0 = Math.min(g.t0, p.i); found = true; break; } } if (!found) groups.push({ price: p.p, touches: 1, t0: p.i }); } return groups.filter(g => g.touches >= 2); }

const scalperSignals = {};
async function scanScalper() { if (!universe.length) return; const top = universe.slice(0, 60); let idx = 0; const worker = async () => { while (idx < top.length) { const sym = top[idx++]; try { const raw = await safeFetch(ex, sym, '15m', 200); const c = fillGaps(closedOnly(raw, M15), M15); if (c.length < 100) continue; const end = c.length - 1; const pv = pivots(c, end, 3, end - CFG.SMC_LOOKBACK); if (pv.hi.length < 3 || pv.lo.length < 3) continue; const lastHi = pv.hi[pv.hi.length - 1]; const lastLo = pv.lo[pv.lo.length - 1]; const lastClose = c[end][4]; const atr = atrMean(c, 14); let bos = null; if (lastClose > lastHi.p + atr * 0.1 && end - lastHi.i <= 10) bos = { dir: 'LONG', level: lastHi.p, i: lastHi.i }; else if (lastClose < lastLo.p - atr * 0.1 && end - lastLo.i <= 10) bos = { dir: 'SHORT', level: lastLo.p, i: lastLo.i }; if (!bos) continue; const tk = tickers[sym]; if (!tk || !tk.last) continue; const entry = tk.last; const risk = atr * 1.5; const stop = bos.dir === 'LONG' ? entry - risk : entry + risk; const tp1 = bos.dir === 'LONG' ? entry + risk * 2 : entry - risk * 2; scalperSignals[sym] = { symbol: sym, base: baseOf(sym), dir: bos.dir, price: tk.last, entry, stop, tp1, level: r2(bos.level), atr: r2(atr), t: Date.now(), barsAgo: end - bos.i, tf: '15m' }; } catch (e) {} } }; await Promise.all(Array.from({ length: 6 }, worker)); }

const rangeSignals = {};
async function scanRange() { if (!universe.length) return; const top = universe.slice(0, 80); let idx = 0; const worker = async () => { while (idx < top.length) { const sym = top[idx++]; try { const raw = await safeFetch(ex, sym, '1h', 200); const c = fillGaps(closedOnly(raw, H1), H1); if (c.length < 60) continue; const end = c.length - 1; const atrNow = atrMean(c, 14); const atrPrev = atrMean(c.slice(0, end - 20 + 1), 14); const squeeze = atrPrev > 0 ? atrNow / atrPrev : 1; const wnd = c.slice(-30); const hi = Math.max(...wnd.map(x => x[2])); const lo = Math.min(...wnd.map(x => x[3])); const width = (hi - lo) / ((hi + lo) / 2) * 100; if (squeeze > 0.85 || width > 3.5) continue; const tk = tickers[sym]; if (!tk || !tk.last) continue; const breakout = tk.last > hi ? 'LONG' : tk.last < lo ? 'SHORT' : null; rangeSignals[sym] = { symbol: sym, base: baseOf(sym), price: tk.last, hi: r2(hi), lo: r2(lo), width: r2(width), squeeze: r2(squeeze), breakout, atr: r2(atrNow), t: Date.now() }; } catch (e) {} } }; await Promise.all(Array.from({ length: 6 }, worker)); }

const radar = { fearGreed: null, binanceLS: { btc: null, eth: null }, rsi: { btc: null, eth: null }, lastUpdate: 0 };
async function updateRadar() { if (Date.now() - radar.lastUpdate < 5 * 60e3) return; radar.lastUpdate = Date.now(); try { const r = await fetch('https://api.alternative.me/fng/?limit=1'); const j = await r.json(); if (j && j.data && j.data[0]) radar.fearGreed = { value: +j.data[0].value, label: j.data[0].value_classification }; } catch (e) {} try { const [btcC, ethC] = await Promise.all([safeFetch(ex, BTC, '15m', 100), safeFetch(ex, ETH, '15m', 100)]); if (btcC && btcC.length > 20) { const cl = btcC.map(x => x[4]); const r = rsiSeries(cl, 14); radar.rsi.btc = r2(r[r.length - 1]); } if (ethC && ethC.length > 20) { const cl = ethC.map(x => x[4]); const r = rsiSeries(cl, 14); radar.rsi.eth = r2(r[r.length - 1]); } } catch (e) {} try { const [b, e] = await Promise.all([ fetch('https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=15m&limit=1').then(r => r.ok ? r.json() : null).catch(() => null), fetch('https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=ETHUSDT&period=15m&limit=1').then(r => r.ok ? r.json() : null).catch(() => null) ]); if (Array.isArray(b) && b[0]) radar.binanceLS.btc = { long: r2(+b[0].longAccount * 100), short: r2(+b[0].shortAccount * 100) }; if (Array.isArray(e) && e[0]) radar.binanceLS.eth = { long: r2(+e[0].longAccount * 100), short: r2(+e[0].shortAccount * 100) }; } catch (e) {} }

const ex = new ccxt.bitget({ enableRateLimit: true, options: { defaultType: 'swap' } });
let universe = [], tickers = {}, market = { btc: null, eth: null, btcDir: 'NÖTR', lastTick: 0 };
let trendSignals = [], brkEvents = [], structLT = {}, triRadar = [], ltNear = [], ltDepth = null;
let dirty = false;
let scan = { last: 0, ms: 0, running: false, total: 0, eligible: 0 };
const candleCache = new Map();
const volCache = new Map();
const LTP = { MIN_EXT: CFG.BRK_MIN_EXT, MAX_EXT: CFG.BRK_MAX_EXT, MIN_VOL: CFG.BRK_MIN_VOL, MIN_STRENGTH: CFG.MIN_STRENGTH };

function loadState() { try { const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); trendSignals = (j.tr || []).filter(s => s && s.strategy === 'TREND'); brkEvents = (j.brk || []).filter(s => s && s.type === 'Simetrik'); } catch (e) { log('fresh start'); } }
function saveState() { if (!dirty) return; dirty = false; try { fs.mkdirSync(DATA_DIR, { recursive: true }); const tmp = STATE_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ tr: trendSignals.slice(0, TR.KEEP), brk: brkEvents.slice(0, 200) })); fs.renameSync(tmp, STATE_FILE); } catch (e) {} }
async function telegram(text) { if (!TG_TOKEN || !TG_CHAT) return; try { await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true }) }); } catch (e) {} }
function isSuspect(sym) { if (isMajor(sym)) return false; const m = ex.markets[sym], inf = (m && m.info) || {}; const st = String(inf.symbolType || inf.category || '').toLowerCase(); if (st && st !== 'perpetual' && st !== 'crypto') return true; const lt = Number(inf.launchTime || inf.onlineTime || 0); return lt > 1e12 && Date.now() - lt < CFG.MIN_LISTING_DAYS * 86400e3; }
async function refreshUniverse() { try { if (!Object.keys(ex.markets || {}).length) await ex.loadMarkets(); await sleep(300); tickers = await ex.fetchTickers(); market.lastTick = Date.now(); const all = Object.values(tickers).filter(t => t && t.symbol && t.symbol.endsWith(':USDT') && ex.markets[t.symbol] && ex.markets[t.symbol].linear); const ok = []; for (const t of all) { if (CFG.EXCLUDED.includes(baseOf(t.symbol).toUpperCase())) continue; if ((t.quoteVolume || 0) < CFG.MIN_VOL_USDT) continue; if (isSuspect(t.symbol)) continue; ok.push(t); } const top = ok.slice().sort((x, y) => (y.quoteVolume || 0) - (x.quoteVolume || 0)).slice(0, CFG.UNIVERSE).map(t => t.symbol); for (const s of [BTC, ETH]) if (!top.includes(s)) top.push(s); universe = top; scan.total = all.length; scan.eligible = ok.length; for (const s of [BTC, ETH]) { const t = tickers[s]; if (t) { const k = s === BTC ? 'btc' : 'eth'; market[k] = { price: t.last, chg: t.percentage }; } } } catch (e) { log('evren hata', e.message); } }
async function fetchTriCandles(sym) { if (TRI_TF === '2h') { const need = CFG_LT.TRI_LOOK * 2 + 120; const c1h = fillGaps(await getHist1h(sym, Math.max(need, HIST_NEED)), H1); return closedOnly(aggregateN(c1h, H1, 2), H2); } if (TRI_TF === '1h') { const need = CFG_LT.TRI_LOOK + 100; return closedOnly(fillGaps(await getHist1h(sym, need), H1), H1); } return closedOnly(fillGaps(await safeFetch(ex, sym, '15m', 800), M15), M15); }
async function refreshTickers() { try { await sleep(200); const t = await ex.fetchTickers(); tickers = t; market.lastTick = Date.now(); for (const s of [BTC, ETH]) if (t[s]) { const k = s === BTC ? 'btc' : 'eth'; market[k] = { price: t[s].last, chg: t[s].percentage }; } for (const list of [trendSignals, brkEvents]) for (const s of list) if (isOpen(s) && t[s.symbol] && t[s.symbol].last) s.lastPrice = t[s.symbol].last; } catch (e) {} }

function calculateStrength(tri, vol, ext) { let s = 50; s += vol >= 2.5 ? 15 : vol >= 1.5 ? 10 : 0; s += ext <= 0.3 ? 10 : 0; s += Math.min(15, Math.max(0, (tri.touches - 5) * 3)); return Math.max(0, Math.min(100, Math.round(s))); }
function buildStruct(S, t0, ms, C, prev) { const o = { t: t0, lines: [] }; if (S.c2 && S.c2.length >= 60) { const CC = C || CFG_LT; let tri = detectTriangle(S.c2, S.c2.length - 1, CC, prev && prev.keys), ago = 0; if (!tri) { const keepLast = triLast, wasMute = triMute; triMute = true; try { for (let k = 1; k <= (CC.TRI_BACK || 0) && !tri; k++) { tri = detectTriangle(S.c2, S.c2.length - 1 - k, CC, prev && prev.keys); if (tri) ago = k; } } finally { triMute = wasMute; } triLast = keepLast; } if (tri) { const pk = pack(tri, S.c2, ms); o.tri = pk; o.htf = htfDir(S.c2); o.squeeze = tri.squeeze; o.touches = tri.touches; o.type = tri.type; o.w0 = tri.w0; o.mat = tri.mat; o.keys = tri.keys; o.ago = ago; o.lines.push({ key: 'R', kind: 'res', seg: pk.res, apex: pk.apex, atr: tri.atr, touches: tri.touches, squeeze: tri.squeeze, type: tri.type }); o.lines.push({ key: 'S', kind: 'sup', seg: pk.sup, apex: pk.apex, atr: tri.atr, touches: tri.touches, squeeze: tri.squeeze, type: tri.type }); } } return o; }
async function liveVol(sym) { const now = Date.now(), hit = volCache.get(sym); if (hit && now - hit.t < 15000) return hit.d; try { const raw = await safeFetch(ex, sym, '15m', 40); const closed = raw.filter(x => x[0] + M15 <= now), cur = raw.find(x => x[0] + M15 > now), n = closed.length; const base = closed.slice(-20); let avg = 0; for (const x of base) avg += x[5]; avg = base.length ? avg / base.length : 0; const bk = closed[n - 1]; let volX = 0, projX = 0, el = 0; if (avg > 0) { const prev = bk ? bk[5] : 0; if (cur) { el = Math.min(1, Math.max(0.05, (now - cur[0]) / M15)); const proj = cur[5] / el; projX = proj / avg; const w = Math.min(1, el / 0.6); volX = (w * proj + (1 - w) * prev) / avg; } else volX = prev / avg; } const d = { volX, projX, el, bk, bars: closed.slice(-13), avg15: avg }; volCache.set(sym, { t: now, d }); return d; } catch (e) { const d = { volX: 0, projX: 0, el: 0, bk: null, bars: [], avg15: 0 }; volCache.set(sym, { t: now, d }); return d; } }
function lineValues(st, now) { const out = {}; for (const L of st.lines) { const a = L.seg[0], b = L.seg[1], dt = b[0] - a[0]; if (!dt) { out[L.key] = a[1]; continue; } const q = (now - a[0]) / dt; out[L.key] = a[1] + (b[1] - a[1]) * q; } return out; }
function planTrade(st, dir, P, vals, v) { const L = dir === 'LONG' ? 1 : -1; const atr2 = st.lines[0].atr; const swing = (v.bars || []).slice(-10); const swingHigh = swing.length ? Math.max(...swing.map(x => x[2])) : P; const swingLow = swing.length ? Math.min(...swing.map(x => x[3])) : P; let stop = L === 1 ? swingLow - atr2 * 0.5 : swingHigh + atr2 * 0.5; if (Math.abs(P - stop) / P > 0.04) stop = L === 1 ? P - P * 0.02 : P + P * 0.02; const wave = Math.max(swingHigh - swingLow, atr2 * 2.5); const tp1 = L === 1 ? P + wave * CFG.BRK_TP1_FIB : P - wave * CFG.BRK_TP1_FIB; const tp2 = L === 1 ? P + wave * CFG.BRK_TP2_FIB : P - wave * CFG.BRK_TP2_FIB; return { stop, tp1, tp2, tp1R: CFG.BRK_TP1_FIB, tp2R: CFG.BRK_TP2_FIB }; }
function brkCheck(prof, st, L, P, now, volX) { const key = L === 1 ? 'R' : 'S', atr = st.lines[0].atr; const lineNow = lineValues(st, now)[key]; const ext = L * (P - lineNow) / atr; if (!(ext >= prof.MIN_EXT)) return { ok: false, ext, why: 'aşım yetersiz' }; if (ext > prof.MAX_EXT) return { ok: false, ext, why: 'çok geç' }; if (volX < prof.MIN_VOL) return { ok: false, ext, why: 'hacim yetersiz' }; return { ok: true, ext }; }

async function liveTick() { await refreshTickers(); await updateMarketDirection(); const now = Date.now(); if (now - market.lastTick > 90e3) return; trackTrends(); trackBrks(); const rad = []; for (const sym of Object.keys(structLT)) { const st = structLT[sym], tk = tickers[sym]; if (!st || !tk || !tk.last || now - st.t > 4 * TRI_MS) continue; const P = tk.last; const vals = lineValues(st, now); if (vals.R == null || vals.S == null || vals.R <= vals.S) continue; const atr = st.lines[0].atr; if (!(atr > 0)) continue; const dR = (P - vals.R) / atr, dS = (P - vals.S) / atr; let cand = null; if (Math.abs(dR) <= CFG.NEAR_ATR || (dR > 0 && dR <= CFG.BRK_SEE)) cand = { bias: 'LONG', d: dR, v: vals.R, line: 'üst çizgi' }; if (Math.abs(dS) <= CFG.NEAR_ATR || (dS < 0 && -dS <= CFG.BRK_SEE)) { if (!cand || Math.abs(dS) < Math.abs(cand.d)) cand = { bias: 'SHORT', d: dS, v: vals.S, line: 'alt çizgi' }; } if (!cand) continue; if (brkEvents.some(x => x.symbol === sym && x.dir === cand.bias && isOpen(x))) continue; const L = cand.bias === 'LONG' ? 1 : -1; const broke = L * cand.d > 0.05; const v = await liveVol(sym); const volEff = v.el >= 0.2 ? Math.max(v.volX, v.projX * 0.8) : v.volX; const pre = calculateStrength({ touches: st.touches, squeeze: st.squeeze }, volEff, Math.abs(cand.d)); const item = { symbol: sym, base: baseOf(sym), price: P, bias: cand.bias, dir: cand.bias, rank: Math.abs(cand.d), touches: st.touches, type: st.type, volX: r2(volEff), strength: pre, broke, aligned: MKT_DIR !== 'NÖTR' ? MKT_DIR === cand.bias : null, squeeze: st.squeeze != null ? Number(st.squeeze) : null, state: st.type + ' üçgen • ' + cand.line + ' ' + fmt(cand.v) }; if (broke && volEff < CFG.BRK_MIN_VOL) { item.why = 'hacim yetersiz'; rad.push(item); continue; } rad.push(item); if (!broke) continue; const chk = brkCheck(LTP, st, L, P, now, volEff); if (!chk.ok) { item.why = chk.why; continue; } const plan = planTrade(st, cand.bias, P, vals, v); const flow = await getFlowData(sym); if (flow) { item.takerBuy = Math.round(flow.takerBuyRatio * 100); if (cand.bias === 'LONG' && flow.takerBuyRatio < 0.55) { item.why = 'alıcı zayıf'; continue; } if (cand.bias === 'SHORT' && flow.takerBuyRatio > 0.45) { item.why = 'satıcı zayıf'; continue; } } const ev = { id: 'BRK_' + sym.replace(/[^A-Z0-9]/g, '') + '_' + now, strategy: 'TRI', tf: TRI_TF, symbol: sym, base: baseOf(sym), dir: cand.bias, time: now, price: P, line: cand.v, type: st.type, touches: st.touches, squeeze: st.squeeze, mat: st.mat != null ? r2(st.mat) : null, volX: r2(volEff), ext: r2(chk.ext), strength: Math.round(pre), aligned: item.aligned, reg: MKT_DIR, takerBuy: item.takerBuy, entry: P, stop: plan.stop, initialStop: plan.stop, riskAbs: Math.abs(P - plan.stop), riskPct: r2(Math.abs(P - plan.stop) / P * 100), tp1: plan.tp1, tp1R: plan.tp1R, tp2: plan.tp2, tp2R: plan.tp2R, status: 'OPEN', lastPrice: P, mfe: 0, mae: 0, trackedTo: now }; brkEvents.unshift(ev); if (brkEvents.length > 200) brkEvents.length = 200; dirty = true; log('KIRILIM', ev.dir, ev.base, 'güç', ev.strength); telegram('🐢 KIRILIM ' + ev.dir + ' ' + ev.base + '\nGiriş: ' + fmt(ev.entry) + '\nTP1: ' + fmt(ev.tp1)); } triRadar = rad.sort((a, b) => a.rank - b.rank).slice(0, 40); }
function trackTrends() { for (const s of trendSignals) { if (!isOpen(s) || !s.riskAbs) continue; const t = tickers[s.symbol]; if (!t || !t.last) continue; const P = t.last, L = s.dir === 'LONG' ? 1 : -1; s.lastPrice = P; const r = L * (P - s.entry) / s.riskAbs; s.mfe = Math.max(s.mfe || 0, r); s.mae = Math.min(s.mae || 0, r); if (s.status === 'OPEN') { if (L * (P - s.stop) <= 0) { s.status = 'STOP'; s.netR = -1; s.closedAt = Date.now(); } else if (r >= s.tp1R) { s.status = 'TP1'; s.stop = s.entry; } } else if (s.status === 'TP1' && L * (P - s.stop) <= 0) { s.status = 'BE'; s.netR = 0.5 * s.tp1R; s.closedAt = Date.now(); } } }
function trackBrks() { for (const b of brkEvents) { if (!isOpen(b) || !b.riskAbs) continue; const t = tickers[b.symbol]; if (!t || !t.last) continue; const P = t.last, L = b.dir === 'LONG' ? 1 : -1; const r = L * (P - b.entry) / b.riskAbs; b.lastPrice = P; b.mfe = Math.max(b.mfe || 0, r); b.mae = Math.min(b.mae || 0, r); if (b.status === 'OPEN') { if (L * (P - b.stop) <= 0) { b.status = 'STOP'; b.netR = -1; b.closedAt = Date.now(); } else if (r >= b.tp1R) { b.status = 'TP1'; b.stop = b.entry; } } else if (b.status === 'TP1' && L * (P - b.stop) <= 0) { b.status = 'BE'; b.netR = 0.5 * b.tp1R; b.closedAt = Date.now(); } } }

async function runScan() { if (scan.running || !universe.length) return; scan.running = true; const t0 = Date.now(); try { const S = {}; let idx = 0; const worker = async () => { while (idx < universe.length) { const sym = universe[idx++]; try { const c = await fetchTriCandles(sym); if (c.length < 60) continue; S[sym] = { c2: c }; } catch (e) {} } }; await Promise.all(Array.from({ length: CFG.CONCURRENCY }, worker)); for (const sym of universe) { const s = S[sym]; if (!s) continue; const c = s.c2, i = c.length - 1; if (t0 - (c[i][0] + TRI_MS) > 3 * TRI_MS) { delete structLT[sym]; continue; } const prev = structLT[sym]; if (prev && prev.lastC === c[i][0] && prev.lines.length) { prev.t = t0; continue; } const st = buildStruct(s, t0, TRI_MS, CFG_LT, prev); st.lastC = c[i][0]; if (st.lines.length) structLT[sym] = st; else if (!(prev && t0 - prev.t < CFG_LT.GRACE_MIN * 60e3)) delete structLT[sym]; } scan.last = Date.now(); scan.ms = scan.last - t0; } catch (e) { log('scan hata', e.message); } scan.running = false; }

const candleInflight = new Map();
async function apiCandles(sym, reqTf) {
    if (!ex.markets[sym]) throw new Error('bilinmeyen sembol');
    const useTf = ['5m', '15m', '1h', '2h', '4h'].includes(reqTf) ? reqTf : TRI_TF;
    const key = sym + '|' + useTf, now = Date.now(), hit = candleCache.get(key);
    if (hit && now - hit.t < 8000) return hit.d;
    if (candleInflight.has(key)) return candleInflight.get(key);
    
    const job = (async () => {
        let c, dur, tf;
        if (useTf === '5m') { c = await uiFetch(sym, '5m', 300); dur = M5; tf = '5m'; }
        else if (useTf === '15m') { c = await uiFetch(sym, '15m', 300); dur = M15; tf = '15m'; }
        else if (useTf === '4h') { c = await uiFetch(sym, '4h', 300); dur = H4; tf = '4H'; }
        else if (useTf === '2h') {
            const hc = histCache.get(sym); let c1h;
            if (hc && hc.c.length > 100) { const rec = await uiFetch(sym, '1h', 5); c1h = mergeC(hc.c, rec); }
            else c1h = await uiFetch(sym, '1h', 900);
            c = aggregateN(fillGaps(c1h, H1), H1, 2); dur = H2; tf = '2H';
        }
        else { c = await uiFetch(sym, '1h', 600); dur = H1; tf = '1H'; }
        
        const cl = c.map(x => x[4]);
        const e21 = emaN(cl, 21), e50 = emaN(cl, 50);
        let tri = null;
        if (structLT[sym] && structLT[sym].tri) tri = structLT[sym].tri;
        else if (c.length > 60) {
            triMute = true;
            try { const t = detectTriangle(c, c.length - 1, CFG_LT) || detectTriangle(c, c.length - 2, CFG_LT); if (t) tri = pack(t, c, dur); } finally { triMute = false; }
        }
        
        let cut = Math.max(0, c.length - 130);
        if (tri) {
            const tS = Math.min(tri.res[0][0], tri.sup[0][0]);
            let ix = c.findIndex(x => x[0] >= tS); if (ix < 0) ix = 0;
            cut = Math.max(0, Math.min(cut, ix - 20));
        }
        
        const d = { c: c.slice(cut), e21: e21.slice(cut), e50: e50.slice(cut), tf, dur, tri };
        candleCache.set(key, { t: Date.now(), d });
        return d;
    })();
    candleInflight.set(key, job);
    try { return await job; } finally { candleInflight.delete(key); }
}

function apiState() { const px = {}; for (const x of triRadar.concat(brkEvents.slice(0, 80), trendSignals.slice(0, 80), pumpSignals.slice(0, 40))) { const t = tickers[x.symbol]; if (t && t.last) px[x.symbol] = t.last; } const forming = []; for (const sym of Object.keys(structLT)) { if (brkEvents.some(x => x.symbol === sym && isOpen(x))) continue; const stx = structLT[sym], tk = tickers[sym]; if (!stx || !tk || !tk.last || Date.now() - stx.t > 4 * TRI_MS) continue; const v = lineValues(stx, Date.now()); if (v.R == null || v.S == null || v.R <= v.S) continue; const atr = stx.lines[0].atr; if (!(atr > 0)) continue; const toUp = (v.R - tk.last) / atr, toDn = (tk.last - v.S) / atr; if (!(toUp > 0 && toDn > 0)) continue; forming.push({ symbol: sym, base: baseOf(sym), price: tk.last, type: stx.type, touches: stx.touches, squeeze: stx.squeeze, toUp, toDn }); } return { now: Date.now(), mode: 'v61.1 • AlgoCoinism', px, market, regime: { dir: MKT_DIR, btcDir: market.btcDir }, forming, tr: trendSignals.slice(0, 60), brk: brkEvents.slice(0, 60), radar: triRadar, pump: pumpSignals.slice(0, 30), zones: Object.values(zoneSignals).slice(0, 40), scalper: Object.values(scalperSignals).slice(0, 40), range: Object.values(rangeSignals).slice(0, 40), piyasa: radar, tri: { tf: TRI_TF, structs: Object.keys(structLT).length, near: ltNear, depth: ltDepth }, trend: { tf: TREND.TF, dg: trendRun.dg }, universe: universe.length }; }

const HTML = String.raw`<!DOCTYPE html>
<html lang="tr" class="dark">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AlphaSon v61.1 — AlgoCoinism</title>
<script src="https://cdn.tailwindcss.com"></script>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
<style>
:root{--bg:#020617;--card:#0f172a;--border:#1e293b;--cyan:#06b6d4;--purple:#a855f7}
body{background:var(--bg);color:#f1f5f9;font-family:'Inter',sans-serif;overflow-x:hidden}
::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-track{background:#0f172a}::-webkit-scrollbar-thumb{background:#1e293b;border-radius:4px}
.sidebar{background:linear-gradient(180deg,#0f172a 0%,#020617 100%);border-right:1px solid var(--border)}
.menu-item{display:flex;align-items:center;gap:10px;padding:9px 14px;margin:2px 8px;border-radius:8px;color:#94a3b8;font-size:13px;font-weight:500;cursor:pointer;transition:all .15s}
.menu-item:hover{background:rgba(6,182,212,.08);color:#e2e8f0}
.menu-item.active{background:linear-gradient(135deg,rgba(6,182,212,.2),rgba(168,85,247,.15));color:#22d3ee;border-left:2px solid #06b6d4}
.card{background:linear-gradient(135deg,rgba(15,23,42,.95),rgba(15,23,42,.7));border:1px solid rgba(51,65,85,.8);border-radius:14px;backdrop-filter:blur(12px);transition:border-color .2s}
.card:hover{border-color:rgba(6,182,212,.4)}
.badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:6px;font-size:10px;font-weight:700}
.long{color:#10b981}.short{color:#ef4444}.muted{color:#64748b}
.chip{display:inline-block;padding:2px 7px;border-radius:5px;font-size:9px;font-weight:800;font-family:'JetBrains Mono',monospace}
.chip-L{background:rgba(16,185,129,.15);color:#10b981;border:1px solid rgba(16,185,129,.35)}
.chip-S{background:rgba(239,68,68,.15);color:#ef4444;border:1px solid rgba(239,68,68,.35)}
.chip-TRI{background:rgba(168,85,247,.15);color:#a855f7;border:1px solid rgba(168,85,247,.35)}
.chip-OPEN{background:rgba(245,158,11,.15);color:#f59e0b;border:1px solid rgba(245,158,11,.35)}
.chip-TP1{background:rgba(59,130,246,.15);color:#3b82f6;border:1px solid rgba(59,130,246,.35)}
.chip-STOP{background:rgba(239,68,68,.15);color:#ef4444;border:1px solid rgba(239,68,68,.35)}
.chip-BE{background:rgba(100,116,139,.2);color:#94a3b8;border:1px solid rgba(100,116,139,.35)}
canvas{display:block;width:100%;height:100%}
.chart-grid{background-size:24px 24px;background-image:linear-gradient(to right,rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(to bottom,rgba(255,255,255,.025) 1px,transparent 1px)}
.sig-row{border-left:3px solid transparent;cursor:pointer;transition:background .15s;background:#0f172a;border:1px solid #1e293b;border-radius:10px;margin-bottom:6px}
.sig-row:hover{background:#1e293b}
.sig-row.sel{border-color:#06b6d4}
.sig-row.L{border-left-color:#10b981}
.sig-row.S{border-left-color:#ef4444}
.sig-row.TRI{border-left-color:#a855f7}
.grad-cyan{background:linear-gradient(135deg,#06b6d4,#0891b2)}
.tab-btn{padding:9px 16px;border-radius:8px;font-size:12px;font-weight:700;color:#94a3b8;cursor:pointer;transition:all .15s;white-space:nowrap;border:1px solid transparent}
.tab-btn:hover{color:#e2e8f0;background:rgba(30,41,59,.5)}
.tab-btn.a{background:rgba(6,182,212,.15);color:#22d3ee;border-color:rgba(6,182,212,.4)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.pulse{animation:pulse 2s infinite}
.detail-panel{position:fixed;top:0;right:0;bottom:0;width:100%;max-width:800px;background:#020617;border-left:1px solid #1e293b;z-index:50;transform:translateX(100%);transition:transform .3s ease;display:flex;flex-direction:column;box-shadow:-10px 0 30px rgba(0,0,0,.5)}
.detail-panel.open{transform:translateX(0)}
.detail-header{padding:16px 20px;border-bottom:1px solid #1e293b;display:flex;justify-content:space-between;align-items:center}
.detail-body{flex:1;overflow-y:auto;padding:20px}
</style>
</head>
<body>
<div class="flex min-h-screen">
  <aside class="sidebar hidden lg:flex flex-col w-60 shrink-0 sticky top-0 h-screen overflow-y-auto">
    <div class="p-5 border-b border-slate-800">
      <div class="flex items-center gap-2.5">
        <div class="w-9 h-9 rounded-xl grad-cyan flex items-center justify-center"><i class="fa-solid fa-arrow-trend-up text-white text-sm"></i></div>
        <div>
          <div class="font-extrabold text-white text-[15px]">AlphaSon</div>
          <div class="text-[9px] text-cyan-400 font-mono font-bold">v61.1 • AlgoCoinism</div>
        </div>
      </div>
    </div>
    <div class="py-3 text-[10px] text-slate-600 font-bold uppercase tracking-widest px-5">MENÜ</div>
    <div id="sidebar-menu"></div>
    <div class="mt-auto p-4 border-t border-slate-800">
      <div class="text-[10px] text-slate-600 font-mono">Bitget Perpetual</div>
      <div class="flex items-center gap-1.5 mt-1"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500 pulse"></span><span class="text-[10px] text-slate-500">Canlı</span></div>
    </div>
  </aside>
  <main class="flex-1 min-w-0 flex flex-col">
    <header class="sticky top-0 z-40 border-b border-slate-800 bg-slate-950/80 backdrop-blur-xl">
      <div class="px-4 lg:px-6 h-14 flex items-center justify-between gap-3">
        <div class="flex items-center gap-3 min-w-0">
          <button id="mobMenu" class="lg:hidden text-slate-400"><i class="fa-solid fa-bars"></i></button>
          <h1 id="pageTitle" class="font-bold text-sm text-white truncate">Ana Sayfa</h1>
        </div>
        <div class="flex items-center gap-2 text-xs font-mono">
          <div class="hidden sm:flex items-center gap-2 bg-slate-900 px-2.5 py-1.5 rounded-lg border border-slate-800">
            <span class="text-slate-500">Piyasa:</span><span id="cMkt" class="font-bold text-white">NÖTR</span>
          </div>
          <div class="hidden sm:flex items-center gap-2 bg-slate-900 px-2.5 py-1.5 rounded-lg border border-slate-800">
            <span class="text-slate-500">BTC:</span><span id="cBTC" class="text-white font-bold">…</span>
          </div>
          <div class="hidden sm:flex items-center gap-2 bg-slate-900 px-2.5 py-1.5 rounded-lg border border-slate-800">
            <span class="text-slate-500">ETH:</span><span id="cETH" class="text-white font-bold">…</span>
          </div>
        </div>
      </div>
    </header>
    <div id="main" class="p-4 lg:p-6 max-w-[1600px] mx-auto w-full"></div>
  </main>
</div>

<div id="detailPanel" class="detail-panel">
  <div class="detail-header">
    <div class="font-bold text-white text-lg" id="detailTitle">Detay</div>
    <button onclick="closeDetail()" class="text-slate-400 hover:text-white"><i class="fa-solid fa-xmark text-xl"></i></button>
  </div>
  <div class="detail-body" id="detailBody">
    <!-- Detay içeriği buraya gelecek -->
  </div>
</div>

<script>
var MENU=[
  {k:'home',ico:'fa-house',lbl:'Ana Sayfa'},
  {k:'piyasa',ico:'fa-globe',lbl:'Piyasa Radarı'},
  {k:'pump',ico:'fa-rocket',lbl:'AlgoPump'},
  {k:'trend',ico:'fa-arrow-trend-up',lbl:'Trend Sinyalleri'},
  {k:'lt',ico:'fa-draw-polygon',lbl:'LT Üçgenler'},
  {k:'zones',ico:'fa-layer-group',lbl:'Zone Master'},
  {k:'scalper',ico:'fa-bolt',lbl:'Scalper (SMC)'},
  {k:'range',ico:'fa-chart-area',lbl:'Range Pro'},
  {k:'strateji',ico:'fa-crown',lbl:'Stratejiler'},
  {k:'stat',ico:'fa-chart-simple',lbl:'İstatistik'}
];
var S=null,tab='home',sel=null,tfSel=null,chartFor='',chartCache={};
function $(id){return document.getElementById(id)}
function fp(p){if(p==null||isNaN(p))return'—';p=Number(p);var a=Math.abs(p);return a>=1000?p.toFixed(2):a>=1?p.toFixed(4):a>=0.01?p.toFixed(5):p.toFixed(7)}
function f2(x,d){d=d==null?2:d;return x==null||isNaN(x)?'—':Number(x).toFixed(d)}
function sg(x,d){d=d==null?2:d;x=Number(x);if(isNaN(x))return'—';return(x>0?'+':'')+x.toFixed(d)}
function cl(x){return x>0?'long':x<0?'short':'muted'}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])})}
function isOp(x){return x.status==='OPEN'||x.status==='TP1'}
function dirChip(d){return d==='LONG'?'<span class="chip chip-L">▲ LONG</span>':'<span class="chip chip-S">▼ SHORT</span>'}
function stChip(k){var m={OPEN:'chip-OPEN',TP1:'chip-TP1',STOP:'chip-STOP',BE:'chip-BE'};var l={OPEN:'AÇIK',TP1:'TP1 ✓',STOP:'STOP',BE:'BE'};return '<span class="chip '+(m[k]||'chip-BE')+'">'+(l[k]||k)+'</span>'}
function renderSidebar(){var h=MENU.map(function(m){return '<div class="menu-item'+(tab===m.k?' active':'')+'" data-k="'+m.k+'"><i class="fa-solid '+m.ico+' w-4"></i><span>'+m.lbl+'</span></div>'}).join('');$('sidebar-menu').innerHTML=h;Array.prototype.forEach.call($('sidebar-menu').children,function(el){el.onclick=function(){tab=el.dataset.k;sel=null;closeDetail();renderAll();}})}
function renderTop(){if(!S)return;var m=S.market||{};if($('cMkt')){$('cMkt').innerHTML=S.regime.dir==='LONG'?'<span class="long">LONG</span>':S.regime.dir==='SHORT'?'<span class="short">SHORT</span>':'<span class="muted">NÖTR</span>'}if($('cBTC'))$('cBTC').innerHTML=m.btc?fp(m.btc.price):'—';if($('cETH'))$('cETH').innerHTML=m.eth?fp(m.eth.price):'—';var titles={home:'Ana Sayfa',piyasa:'Piyasa Radarı',pump:'AlgoPump',trend:'Trend Sinyalleri',lt:'LT Üçgenler',zones:'Zone Master',scalper:'Scalper (SMC)',range:'Range Pro',strateji:'Stratejiler',stat:'İstatistik'};if($('pageTitle'))$('pageTitle').textContent=titles[tab]||tab}

function drawChart(d, V, cid) {
    var c = $(cid);
    if (!c || !d || !d.c.length) return;
    var W = c.clientWidth, H = c.clientHeight, dp = window.devicePixelRatio || 1;
    if (c.width !== Math.round(W * dp) || c.height !== Math.round(H * dp)) { c.width = Math.round(W * dp); c.height = Math.round(H * dp); }
    var x = c.getContext('2d');
    x.setTransform(dp, 0, 0, dp, 0, 0);
    x.clearRect(0, 0, W, H);
    
    var lv = V && V.levels, tri = d.tri, nc = d.c.length, n = nc + (tri ? 32 : 4);
    var L = 8, R = 112, T = 42, B = 18, volH = 56, PW = W - L - R, PH = H - T - B - volH - 8;
    var ti = function (t) { return (t - d.c[0][0]) / d.dur; };
    var px = (V && V.px != null) ? V.px : d.c[nc - 1][4];
    var lin = !!(tri && tri.lin);
    var lg = function (a, pa, b, pb, q) { var t = (q - a) / ((b - a) || 1); return lin ? pa + (pb - pa) * t : Math.exp(Math.log(pa) + (Math.log(pb) - Math.log(pa)) * t); };
    
    var hi = -1e99, lo = 1e99;
    d.c.forEach(function (k) { hi = Math.max(hi, k[2]); lo = Math.min(lo, k[3]); });
    hi = Math.max(hi, px); lo = Math.min(lo, px);
    if (lv) [lv.entry, lv.stop, lv.tp1, lv.tp2].forEach(function (q) { if (q == null) return; var v = Number(q); if (isFinite(v)) { hi = Math.max(hi, v); lo = Math.min(lo, v); } });
    
    var tl = [];
    if (tri) [tri.res, tri.sup].forEach(function (l) {
        var a = ti(l[0][0]), b = ti(l[1][0]), xa = Math.min(Math.max(a, 0), nc + 2), xb = Math.min(b, nc + 2);
        tl.push([a, l[0][1], b, l[1][1]]);
        [xa, xb].forEach(function (q) { var v = lg(a, l[0][1], b, l[1][1], q); hi = Math.max(hi, v); lo = Math.min(lo, v); });
    });
    
    var pad = (hi - lo) * .07; hi += pad; lo -= pad;
    var Y = function (p) { return T + (hi - p) / (hi - lo) * PH; };
    var X = function (k) { return L + (k + .5) / n * PW; };
    var cw = Math.max(1.5, PW / n * .7);
    
    var labs = [];
    if (lv) {
        labs.push({ p: lv.entry, col: '#ffb020', t: 'GİRİŞ' });
        labs.push({ p: lv.stop, col: '#ff4d6d', t: 'STOP' });
        if (lv.tp1 != null) labs.push({ p: lv.tp1, col: '#00e0a0', t: 'TP1' });
        if (lv.tp2 != null) labs.push({ p: lv.tp2, col: '#3b82f6', t: 'TP2' });
    }
    labs.push({ p: px, col: '#f3f4f6', t: '', cur: 1 });
    labs.forEach(function (l) { l.y = Y(l.p); l.yy = l.y; });
    labs.sort(function (a, b) { return a.y - b.y; });
    for (var i = 1; i < labs.length; i++) { if (labs[i].yy - labs[i - 1].yy < 16) labs[i].yy = labs[i - 1].yy + 16; }
    
    var si = -1;
    if (lv && lv.t) { si = Math.floor(ti(lv.t)); if (si < 0 || si >= nc) si = -1; }
    if (lv) {
        var zx = si >= 0 ? X(si) : L, zw = W - R - zx, ye = Y(lv.entry), ys = Y(lv.stop), far = lv.tp1, yt = far != null ? Y(far) : ye;
        x.fillStyle = 'rgba(255,77,109,.10)'; x.fillRect(zx, Math.min(ye, ys), zw, Math.abs(ys - ye));
        x.fillStyle = 'rgba(0,224,160,.10)'; x.fillRect(zx, Math.min(ye, yt), zw, Math.abs(yt - ye));
    }
    
    x.font = '10px JetBrains Mono,monospace';
    for (var g = 0; g <= 5; g++) {
        var gy = T + PH * g / 5, gp = hi - (hi - lo) * g / 5;
        x.strokeStyle = 'rgba(255,255,255,.04)'; x.lineWidth = 1; x.beginPath(); x.moveTo(L, gy); x.lineTo(W - R, gy); x.stroke();
        var near = labs.some(function (l) { return Math.abs(l.yy - gy) < 10; });
        if (!near) { x.fillStyle = '#7e8ca8'; x.fillText(fp(gp), W - R + 8, gy + 3); }
    }
    
    var line = function (arr, col, w) {
        if (!arr) return;
        x.strokeStyle = col; x.lineWidth = w; x.beginPath();
        var st = false;
        arr.forEach(function (v, k) { if (v == null) return; st ? x.lineTo(X(k), Y(v)) : (x.moveTo(X(k), Y(v)), st = true); });
        x.stroke();
    };
    line(d.e50, '#a78bfa', 1.1); line(d.e21, '#3b82f6', 1.1);
    
    d.c.forEach(function (k, i) {
        var up = k[4] >= k[1], col = up ? '#00e0a0' : '#ff4d6d';
        x.strokeStyle = col; x.fillStyle = col; x.lineWidth = 1;
        x.beginPath(); x.moveTo(X(i), Y(k[2])); x.lineTo(X(i), Y(k[3])); x.stroke();
        x.fillRect(X(i) - cw / 2, Math.min(Y(k[1]), Y(k[4])), cw, Math.max(1, Math.abs(Y(k[4]) - Y(k[1]))));
    });
    
    var vmax = Math.max.apply(null, d.c.map(function (k) { return k[5]; })) || 1, vTop = T + PH + 8;
    x.strokeStyle = 'rgba(255,255,255,.06)'; x.beginPath(); x.moveTo(L, vTop); x.lineTo(W - R, vTop); x.stroke();
    d.c.forEach(function (k, i) {
        var col = k[4] >= k[1] ? '#00e0a0' : '#ff4d6d', h = (k[5] / vmax) * (volH - 4);
        x.fillStyle = col; x.globalAlpha = 0.5; x.fillRect(X(i) - cw / 2, vTop + volH - h, cw, h); x.globalAlpha = 1;
    });
    
    if (tri) {
        x.save(); x.beginPath(); x.rect(L, T, PW, PH); x.clip();
        tl.forEach(function (l) {
            x.strokeStyle = 'rgba(167,139,250,.85)'; x.lineWidth = 2; x.beginPath();
            var NS = 80;
            for (var z = 0; z <= NS; z++) { var q = l[0] + (l[2] - l[0]) * z / NS, yv = lg(l[0], l[1], l[2], l[3], q); z ? x.lineTo(X(q), Y(yv)) : x.moveTo(X(q), Y(yv)); }
            x.stroke();
        });
        x.fillStyle = 'rgba(167,139,250,.9)';
        tri.hi.concat(tri.lo).forEach(function (p) { x.beginPath(); x.arc(X(ti(p[0])), Y(p[1]), 2.5, 0, 7); x.fill(); });
        x.restore();
    }
    
    x.save(); x.beginPath(); x.rect(L, T, W - R - L, PH); x.clip();
    labs.forEach(function (l) { if (l.cur) return; x.strokeStyle = l.col; x.lineWidth = 1.2; x.globalAlpha = .8; x.setLineDash([6, 4]); x.beginPath(); x.moveTo(L, l.y); x.lineTo(W - R, l.y); x.stroke(); x.setLineDash([]); x.globalAlpha = 1; });
    x.restore();
    
    if (si >= 0) {
        var kk = d.c[si], isL = V.dir === 'LONG', mx = X(si);
        x.strokeStyle = 'rgba(167,139,250,.45)'; x.lineWidth = 1; x.setLineDash([2, 3]); x.beginPath(); x.moveTo(mx, T); x.lineTo(mx, T + PH); x.stroke(); x.setLineDash([]);
        x.fillStyle = isL ? '#00e0a0' : '#ff4d6d'; x.beginPath();
        if (isL) { var y0 = Y(kk[3]) + 5; x.moveTo(mx, y0); x.lineTo(mx - 8, y0 + 14); x.lineTo(mx + 8, y0 + 14); }
        else { var y1 = Y(kk[2]) - 5; x.moveTo(mx, y1); x.lineTo(mx - 8, y1 - 14); x.lineTo(mx + 8, y1 - 14); }
        x.closePath(); x.fill();
    }
    
    x.strokeStyle = 'rgba(255,255,255,.5)'; x.lineWidth = 1; x.setLineDash([1, 3]); x.beginPath(); x.moveTo(L, Y(px)); x.lineTo(W - R, Y(px)); x.stroke(); x.setLineDash([]);
    
    labs.forEach(function (l) {
        var y = Math.max(T - 4, Math.min(T + PH + 4, l.yy)), txt = (l.t ? l.t + ' ' : '') + fp(l.p);
        x.fillStyle = l.col; x.fillRect(W - R + 2, y - 8, R - 4, 16);
        x.fillStyle = '#080b12'; x.font = 'bold 10px JetBrains Mono,monospace'; x.fillText(txt, W - R + 6, y + 3.5);
    });
    
    x.fillStyle = '#7e8ca8'; x.font = '10px JetBrains Mono,monospace';
    var stp = Math.max(1, Math.ceil(nc / 7));
    for (var q = 0; q < nc; q += stp) {
        var dt = new Date(d.c[q][0]), hh = ('0' + dt.getHours()).slice(-2) + ':' + ('0' + dt.getMinutes()).slice(-2);
        if (d.dur >= 3600e3) hh = ('0' + dt.getDate()).slice(-2) + '.' + ('0' + (dt.getMonth() + 1)).slice(-2) + ' ' + hh;
        x.fillText(hh, X(q) - 12, H - 5);
    }
    
    if (V && V.dir) {
        var isLg = V.dir === 'LONG';
        x.fillStyle = isLg ? '#00e0a0' : '#ff4d6d'; x.fillRect(8, 7, 92, 24);
        x.fillStyle = '#051412'; x.font = 'bold 13px Inter,sans-serif'; x.fillText(isLg ? '▲ LONG' : '▼ SHORT', 16, 24);
        if (V.strat) { x.fillStyle = '#f3f4f6'; x.font = 'bold 11px Inter,sans-serif'; x.fillText(V.strat, 108, 24); }
        if (V.pnl) {
            var pc = V.pnl.r > 0.005 ? '#00e0a0' : V.pnl.r < -0.005 ? '#ff4d6d' : '#7e8ca8', txt = (V.pnl.fin ? 'KAPANDI ' : (V.pnl.lbl || 'CANLI') + ' ') + sg(V.pnl.r) + 'R   ' + sg(V.pnl.pct) + '%';
            x.font = 'bold 12px JetBrains Mono,monospace';
            var w = x.measureText(txt).width + 22;
            x.fillStyle = pc; x.fillRect(W - R - w + L, 7, w, 24);
            x.fillStyle = '#080b12'; x.fillText(txt, W - R - w + L + 11, 23);
        }
    }
}

function openDetail(o, kind){
  sel={o:o, kind:kind, id:o.id, sym:o.symbol};
  $('detailPanel').classList.add('open');
  var d=o.dir||o.bias||'LONG';
  $('detailTitle').innerHTML=esc(o.base)+' <span class="text-sm font-normal text-slate-500 ml-2">'+(kind==='tr'?'TRF Trend':kind==='lt'?'LT Üçgen':kind==='scalper'?'Scalper':kind==='range'?'Range Pro':kind==='pump'?'AlgoPump':'Sinyal')+'</span>';
  
  var px = S.px[o.symbol] || o.entry || o.price;
  var L = d==='LONG'?1:-1;
  var entry = o.entry || o.price;
  var riskAbs = o.riskAbs || (entry * 0.02);
  var r = L * (px - entry) / riskAbs;
  var pct = L * (px - entry) / entry * 100;
  
  var isOpn = isOp(o) || (o.status==='OPEN');
  var pnlCls = r>0?'long':r<0?'short':'muted';
  
  var html = '<div class="grid grid-cols-3 gap-3 mb-4">';
  html += '<div class="bg-slate-900 border border-slate-800 rounded-xl p-3 text-center"><div class="text-[10px] text-slate-500 uppercase">Giriş</div><div class="text-lg font-bold font-mono text-amber-400 mt-1">'+fp(entry)+'</div></div>';
  html += '<div class="bg-slate-900 border border-slate-800 rounded-xl p-3 text-center"><div class="text-[10px] text-slate-500 uppercase">Şu Anki</div><div class="text-lg font-bold font-mono text-white mt-1">'+fp(px)+'</div></div>';
  html += '<div class="bg-slate-900 border border-slate-800 rounded-xl p-3 text-center"><div class="text-[10px] text-slate-500 uppercase">Durum</div><div class="mt-1">'+stChip(o.status||'OPEN')+'</div></div>';
  html += '</div>';
  
  if(o.stop && o.tp1) {
    html += '<div class="grid grid-cols-3 gap-3 mb-4">';
    html += '<div class="bg-slate-900 border border-slate-800 rounded-xl p-3 text-center"><div class="text-[10px] text-slate-500 uppercase">STOP</div><div class="text-sm font-bold font-mono text-red-400 mt-1">'+fp(o.stop)+'</div></div>';
    html += '<div class="bg-slate-900 border border-slate-800 rounded-xl p-3 text-center"><div class="text-[10px] text-slate-500 uppercase">TP1 (Fib 1.618)</div><div class="text-sm font-bold font-mono text-emerald-400 mt-1">'+fp(o.tp1)+'</div></div>';
    html += '<div class="bg-slate-900 border border-slate-800 rounded-xl p-3 text-center"><div class="text-[10px] text-slate-500 uppercase">TP2 (Fib 2.618)</div><div class="text-sm font-bold font-mono text-emerald-400 mt-1">'+fp(o.tp2||0)+'</div></div>';
    html += '</div>';
  }
  
  html += '<div class="bg-slate-900 border border-slate-800 rounded-xl p-4 mb-4 flex justify-between items-center">';
  html += '<div><div class="text-[10px] text-slate-500 uppercase">Anlık K/Z (R)</div><div class="text-3xl font-bold font-mono '+pnlCls+'">'+(isOpn?sg(r)+'R':'—')+'</div></div>';
  html += '<div class="text-right"><div class="text-[10px] text-slate-500 uppercase">Yüzde</div><div class="text-2xl font-bold font-mono '+pnlCls+'">'+(isOpn?sg(pct)+'%':'—')+'</div></div>';
  html += '</div>';
  
  html += '<div class="chart-grid relative w-full h-[340px] rounded-xl bg-slate-950 border border-slate-800 overflow-hidden mb-4"><canvas id="detailCanvas"></canvas></div>';
  
  $('detailBody').innerHTML = html;
  
  var tf = kind==='tr'?'15m':kind==='lt'?'2h':'15m';
  fetch('/api/candles?symbol='+encodeURIComponent(o.symbol)+'&tf='+tf)
    .then(r=>r.json())
    .then(data=>{
      if(data.error) return;
      var cv = $('detailCanvas');
      if(!cv) return;
      drawChart(data, { dir:d, levels:{entry:entry, stop:o.stop, tp1:o.tp1, tp2:o.tp2, t:o.time}, px:px, strat: kind==='tr'?'TRF Trend':kind==='lt'?'LT Üçgen':'Sinyal', pnl:{r:r, pct:pct, fin:!isOpn, lbl:'CANLI'} }, 'detailCanvas');
    })
    .catch(()=>{});
}

function closeDetail() {
  $('detailPanel').classList.remove('open');
  sel = null;
}

function renderHome(){if(!S)return '<div class="text-center py-20 text-slate-500">Yükleniyor…</div>';var p=S.piyasa||{};var btc=((p.binanceLS||{}).btc)||{};var eth=((p.binanceLS||{}).eth)||{};var fg=p.fearGreed;var rsi=p.rsi||{};var tr=(S.tr||[]).filter(isOp).length;var brk=(S.brk||[]).filter(isOp).length;var pumpN=(S.pump||[]).filter(function(x){return x.status==='OPEN'}).length;var h='';h+='<div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">'+'<div class="card p-4"><div class="text-[10px] text-slate-500 uppercase font-bold">Trend Açık</div><div class="text-2xl font-bold text-cyan-400 mt-1">'+tr+'</div></div>'+'<div class="card p-4"><div class="text-[10px] text-slate-500 uppercase font-bold">LT Kırılım Açık</div><div class="text-2xl font-bold text-purple-400 mt-1">'+brk+'</div></div>'+'<div class="card p-4"><div class="text-[10px] text-slate-500 uppercase font-bold">Pump Aktif</div><div class="text-2xl font-bold text-amber-400 mt-1">'+pumpN+'</div></div>'+'<div class="card p-4"><div class="text-[10px] text-slate-500 uppercase font-bold">Taranan Coin</div><div class="text-2xl font-bold text-white mt-1">'+(S.universe||0)+'</div></div>'+'</div>';h+='<h2 class="text-sm font-bold text-white mb-3 mt-6">🌐 Piyasa Radarı</h2><div class="grid grid-cols-1 md:grid-cols-3 gap-3">';h+='<div class="card p-4"><div class="text-[10px] text-slate-500 uppercase font-bold mb-2">Korku & Hırs</div>'+(fg?'<div class="text-3xl font-bold '+(fg.value>=55?'short':fg.value<=45?'long':'muted')+'">'+fg.value+'</div><div class="text-xs text-slate-400 mt-1">'+esc(fg.label)+'</div>':'<div class="text-slate-500 text-xs">veri yok</div>')+'</div>';h+='<div class="card p-4"><div class="text-[10px] text-slate-500 uppercase font-bold mb-2">RSI</div><div class="text-xs space-y-1"><div class="flex justify-between"><span class="text-slate-400">BTC</span><span class="'+(rsi.btc>=70?'short':rsi.btc<=30?'long':'text-white')+' font-bold font-mono">'+f2(rsi.btc,1)+'</span></div><div class="flex justify-between"><span class="text-slate-400">ETH</span><span class="'+(rsi.eth>=70?'short':rsi.eth<=30?'long':'text-white')+' font-bold font-mono">'+f2(rsi.eth,1)+'</span></div></div></div>';h+='<div class="card p-4"><div class="text-[10px] text-slate-500 uppercase font-bold mb-2">Binance Long/Short</div><div class="text-xs space-y-1">'+(btc.long?'<div class="flex justify-between"><span class="text-slate-400">BTC</span><span><span class="long font-bold">'+btc.long+'%</span> / <span class="short font-bold">'+btc.short+'%</span></span></div>':'')+(eth.long?'<div class="flex justify-between"><span class="text-slate-400">ETH</span><span><span class="long font-bold">'+eth.long+'%</span> / <span class="short font-bold">'+eth.short+'%</span></span></div>':'')+'</div></div>';h+='</div>';h+='<h2 class="text-sm font-bold text-white mb-3 mt-6">🎴 Hazır Stratejiler</h2><div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">';var strats=[{n:'Momentum Avcısı',d:'Agresif momentum. Trend varsa çalışır.',r:'+%53/ay',dd:'-11%',w:'%65',c:'cyan'},{n:'Prime Max',d:'Güvenli. 3 coin, 10x, %1.2 TP.',r:'+%17/ay',dd:'-3.6%',w:'%62',c:'purple'},{n:'Alfa 3',d:'Sıkışma kırılımı. 3 coin, uzun vade.',r:'+%11.9/ay',dd:'-3.6%',w:'%62',c:'amber'},{n:'Altın Avcısı',d:'Emtia trend takip.',r:'+%22/ay',dd:'-8%',w:'%58',c:'emerald'}];strats.forEach(function(s){h+='<div class="card p-4"><div class="flex items-center justify-between mb-2"><div class="font-bold text-white text-sm">'+s.n+'</div><span class="badge badge-prem">'+(s.c==='cyan'?'AKTİF':'HAZIR')+'</span></div><div class="text-[11px] text-slate-400 leading-relaxed mb-3">'+s.d+'</div><div class="grid grid-cols-3 gap-1 text-center"><div><div class="text-[9px] text-slate-500 uppercase">Aylık</div><div class="text-xs font-bold text-emerald-400">'+s.r+'</div></div><div><div class="text-[9px] text-slate-500 uppercase">Max DD</div><div class="text-xs font-bold text-red-400">'+s.dd+'</div></div><div><div class="text-[9px] text-slate-500 uppercase">Win</div><div class="text-xs font-bold text-white">'+s.w+'</div></div></div></div>'});h+='</div>';return h}

function renderPiyasa(){if(!S)return '';var p=S.piyasa||{};var fg=p.fearGreed;var btc=((p.binanceLS||{}).btc)||{};var eth=((p.binanceLS||{}).eth)||{};var rsi=p.rsi||{};var h='';h+='<div class="grid md:grid-cols-2 gap-4">';h+='<div class="card p-5"><h3 class="font-bold text-white mb-3 flex items-center gap-2"><i class="fa-solid fa-brain text-cyan-400"></i>Korku & Hırs Endeksi</h3>'+(fg?'<div class="text-center py-4"><div class="text-6xl font-extrabold '+(fg.value>=55?'text-red-500':fg.value<=45?'text-emerald-500':'text-slate-300')+'">'+fg.value+'</div><div class="text-sm text-slate-400 mt-2">'+esc(fg.label)+'</div></div>':'<div class="text-slate-500 text-center py-4">veri yok</div>')+'</div>';h+='<div class="card p-5"><h3 class="font-bold text-white mb-3 flex items-center gap-2"><i class="fa-solid fa-chart-line text-cyan-400"></i>RSI (15m)</h3><div class="space-y-3"><div><div class="flex justify-between text-xs mb-1"><span class="text-slate-400">BTC</span><span class="font-mono font-bold '+(rsi.btc>=70?'short':rsi.btc<=30?'long':'text-white')+'">'+f2(rsi.btc,1)+'</span></div><div class="h-2 bg-slate-800 rounded-full overflow-hidden"><div class="h-full '+(rsi.btc>=70?'bg-red-500':rsi.btc<=30?'bg-emerald-500':'bg-cyan-500')+'" style="width:'+Math.min(100,Math.max(0,rsi.btc||0))+'%"></div></div></div><div><div class="flex justify-between text-xs mb-1"><span class="text-slate-400">ETH</span><span class="font-mono font-bold '+(rsi.eth>=70?'short':rsi.eth<=30?'long':'text-white')+'">'+f2(rsi.eth,1)+'</span></div><div class="h-2 bg-slate-800 rounded-full overflow-hidden"><div class="h-full '+(rsi.eth>=70?'bg-red-500':rsi.eth<=30?'bg-emerald-500':'bg-cyan-500')+'" style="width:'+Math.min(100,Math.max(0,rsi.eth||0))+'%"></div></div></div></div></div>';h+='</div>';h+='<div class="card p-5 mt-4"><h3 class="font-bold text-white mb-3 flex items-center gap-2"><i class="fa-solid fa-scale-balanced text-cyan-400"></i>Binance Long/Short</h3><div class="grid md:grid-cols-2 gap-4">'+(btc.long?'<div><div class="text-xs text-slate-400 mb-2">BTC</div><div class="flex gap-1 h-8 rounded-lg overflow-hidden"><div class="bg-emerald-500 flex items-center justify-center text-[10px] font-bold" style="width:'+btc.long+'%">'+btc.long+'%</div><div class="bg-red-500 flex items-center justify-center text-[10px] font-bold" style="width:'+btc.short+'%">'+btc.short+'%</div></div></div>':'')+(eth.long?'<div><div class="text-xs text-slate-400 mb-2">ETH</div><div class="flex gap-1 h-8 rounded-lg overflow-hidden"><div class="bg-emerald-500 flex items-center justify-center text-[10px] font-bold" style="width:'+eth.long+'%">'+eth.long+'%</div><div class="bg-red-500 flex items-center justify-center text-[10px] font-bold" style="width:'+eth.short+'%">'+eth.short+'%</div></div></div>':'')+'</div></div>';return h}

function renderPump(){if(!S)return '';var arr=(S.pump||[]);if(!arr.length)return '<div class="text-center py-16 text-slate-500"><i class="fa-solid fa-rocket text-4xl mb-3 opacity-40"></i><div>Henüz pump yok. Sistem tarıyor…</div></div>';var h='<div class="text-[11px] text-slate-400 mb-4 leading-relaxed">🚀 <b class="text-white">AlgoPump:</b> Son 10dk hacmi, son 3 saat ortalamasıyla kıyaslar. <b class="text-cyan-400">4x üzeri hacim artışı</b> + <b class="text-emerald-400">%75+ alıcı baskısı</b> olan coinleri yakalar.</div>';h+='<div class="space-y-2">';arr.forEach(function(p){var act=p.status==='OPEN';var L=p.entry?1:0;h+='<div class="sig-row '+(L?'L':'S')+'" onclick="openDetail('+JSON.stringify(p).replace(/"/g,'&quot;')+', \'pump\')"><div class="p-4 flex items-center justify-between gap-3 flex-wrap"><div class="flex items-center gap-3"><span class="text-2xl">🚀</span><div><div class="font-bold text-white">'+esc(p.base)+'<span class="text-[10px] text-slate-500 ml-2">USDT</span></div><div class="text-[10px] text-slate-500 font-mono">'+new Date(p.t).toLocaleString('tr-TR')+'</div></div></div><div class="text-right"><div class="text-xs text-slate-400">Giriş</div><div class="font-mono font-bold text-white">'+fp(p.entry)+'</div></div><div class="text-right"><div class="text-xs text-slate-400">Peak</div><div class="font-mono font-bold text-emerald-400">'+fp(p.peak)+'</div></div><div class="text-right"><div class="text-xs text-slate-400">Max</div><div class="font-mono font-bold text-emerald-400">+%'+p.maxPump+'</div></div><div class="text-right"><div class="text-xs text-slate-400">Hacim</div><div class="font-mono font-bold text-amber-400">'+p.volMult+'x</div></div><div class="text-right"><div class="text-xs text-slate-400">Taker</div><div class="font-mono font-bold text-cyan-400">%'+p.taker+'</div></div><span class="chip '+(act?'chip-OPEN':'chip-BE')+'">'+(act?'AÇIK':'KAPALI')+'</span></div></div>'});h+='</div>';return h}

function renderTrend(){if(!S)return '';var arr=(S.tr||[]);if(!arr.length)return '<div class="text-center py-16 text-slate-500">Trend sinyali bekleniyor…</div>';var h='<div class="text-[11px] text-slate-400 mb-3">📈 <b class="text-cyan-400">TRF Trend ('+(S.trend?S.trend.tf:'15m')+')</b> — Twin Range Filter trend dönüşleri. TP1/TP2 Fibonacci tabanlı.</div><div class="space-y-1">';arr.forEach(function(t){var L=t.dir==='LONG';var px = S.px[t.symbol]||t.entry;var r = L * (px - t.entry) / t.riskAbs;var pnlCls = r>0?'long':r<0?'short':'muted';h+='<div class="sig-row '+(L?'L':'S')+' '+(sel&&sel.id===t.id?'sel':'')+'" onclick="openDetail('+JSON.stringify(t).replace(/"/g,'&quot;')+', \'tr\')"><div class="p-3 grid grid-cols-12 gap-2 items-center"><div class="col-span-3"><div class="font-bold text-white">'+esc(t.base)+'</div><div class="text-[10px] text-slate-500 font-mono">TRF Trend</div></div><div class="col-span-2">'+dirChip(t.dir)+'</div><div class="col-span-2 font-mono text-xs text-slate-300">'+fp(t.entry)+'<div class="text-[9px] text-emerald-400">TP1 '+fp(t.tp1)+'</div></div><div class="col-span-2">'+stChip(t.status)+'</div><div class="col-span-2 text-right font-mono font-bold '+pnlCls+'">'+(isOp(t)?sg(r)+'R':(t.netR!=null?sg(t.netR)+'R':'—'))+'</div><div class="col-span-1 text-right text-[9px] text-slate-500">%'+f2(t.score,0)+'</div></div></div>'});h+='</div>';return h}

function renderLT(){if(!S)return '';var arr=(S.brk||[]);var radar=(S.radar||[]);var forming=(S.forming||[]);var h='<div class="text-[11px] text-slate-400 mb-3">🐢 <b class="text-purple-400">LT Üçgenler</b> — Simetrik üçgen tespiti ve kırılım sinyalleri. Yapı: <b class="text-white">'+(S.tri?S.tri.structs:0)+'</b> • İzlenen: <b class="text-white">'+radar.length+'</b></div>';if(arr.length){h+='<h3 class="text-xs text-slate-500 uppercase font-bold mb-2 mt-4">Kırılım Sinyalleri ('+arr.length+')</h3><div class="space-y-1">';arr.forEach(function(t){var L=t.dir==='LONG';var px = S.px[t.symbol]||t.entry;var r = L * (px - t.entry) / t.riskAbs;var pnlCls = r>0?'long':r<0?'short':'muted';h+='<div class="sig-row TRI '+(L?'L':'S')+'" onclick="openDetail('+JSON.stringify(t).replace(/"/g,'&quot;')+', \'lt\')"><div class="p-3 grid grid-cols-12 gap-2 items-center"><div class="col-span-3"><div class="font-bold text-white">'+esc(t.base)+' <span class="chip chip-TRI">TRI</span></div><div class="text-[10px] text-slate-500 font-mono">Güç %'+t.strength+' • Hacim '+f2(t.volX,1)+'x</div></div><div class="col-span-2">'+dirChip(t.dir)+'</div><div class="col-span-2 font-mono text-xs text-slate-300">'+fp(t.entry)+'<div class="text-[9px] text-emerald-400">TP1 '+fp(t.tp1)+'</div></div><div class="col-span-2">'+stChip(t.status)+'</div><div class="col-span-3 text-right font-mono font-bold '+pnlCls+'">'+(isOp(t)?sg(r)+'R':(t.netR!=null?sg(t.netR)+'R':'—'))+'</div></div></div>'});h+='</div>'}if(radar.length){h+='<h3 class="text-xs text-slate-500 uppercase font-bold mb-2 mt-4">Radar ('+radar.length+')</h3><div class="space-y-1">';radar.forEach(function(r){h+='<div class="sig-row" onclick="openDetail('+JSON.stringify(r).replace(/"/g,'&quot;')+', \'lt\')"><div class="p-3 grid grid-cols-12 gap-2 items-center"><div class="col-span-3"><div class="font-bold text-white">'+esc(r.base)+'</div><div class="text-[10px] text-slate-500">'+esc(r.type||'')+' • '+r.touches+' değme</div></div><div class="col-span-2">'+dirChip(r.bias)+'</div><div class="col-span-2 font-mono text-xs">'+fp(r.price)+'</div><div class="col-span-3 text-[10px] text-slate-500">'+esc(r.state||'')+(r.why?' <span class="text-amber-400">⏸ '+esc(r.why)+'</span>':'')+'</div><div class="col-span-2 text-right text-xs font-bold '+(r.strength>=55?'text-emerald-400':'text-slate-400')+'">%'+r.strength+'</div></div></div>'});h+='</div>'}if(forming.length){h+='<h3 class="text-xs text-slate-500 uppercase font-bold mb-2 mt-4">Sıkışan Üçgenler ('+forming.length+')</h3><div class="space-y-1">';forming.forEach(function(x){h+='<div class="sig-row" onclick="openDetail('+JSON.stringify(x).replace(/"/g,'&quot;')+', \'lt\')"><div class="p-3 flex justify-between items-center"><div><div class="font-bold text-white">'+esc(x.base)+'</div><div class="text-[10px] text-slate-500">'+esc(x.type||'')+' • '+x.touches+' değme</div></div><div class="text-right"><div class="font-mono text-xs">'+fp(x.price)+'</div><div class="text-[10px] text-slate-500">Üste '+f2(x.toUp,2)+' ATR • Alta '+f2(x.toDn,2)+' ATR</div></div></div></div>'});h+='</div>'}if(!arr.length&&!radar.length&&!forming.length)h+='<div class="text-center py-16 text-slate-500">Üçgen tespit ediliyor…</div>';return h}

function renderZones(){if(!S)return '';var arr=(S.zones||[]);if(!arr.length)return '<div class="text-center py-16 text-slate-500">Zone verisi taranıyor…</div>';var h='<div class="text-[11px] text-slate-400 mb-3">🎯 <b class="text-cyan-400">Zone Master</b> — Pivot tabanlı Destek/Direnç. Güç yüzdesi = değme sayısı × 12. Yüksek güç = güçlü seviye.</div>';h+='<div class="grid grid-cols-1 md:grid-cols-2 gap-3">';arr.forEach(function(z){h+='<div class="card p-4" onclick="openDetail('+JSON.stringify(z).replace(/"/g,'&quot;')+', \'zone\')"><div class="flex items-center justify-between mb-2"><div class="font-bold text-white">'+esc(z.base)+'</div><div class="font-mono text-xs text-slate-400">Fiyat: '+fp(z.price)+' • ATR: '+z.atr+'</div></div><div class="space-y-1">';z.zones.forEach(function(zz){h+='<div class="flex items-center gap-2 text-xs"><span class="chip '+(zz.kind==='res'?'chip-S':'chip-L')+'">'+(zz.kind==='res'?'DİRENÇ':'DESTEK')+'</span><span class="font-mono text-white">'+fp(zz.price)+'</span><span class="text-slate-500">'+zz.touches+' değme</span><div class="flex-1 ml-2 h-1.5 bg-slate-800 rounded-full overflow-hidden"><div class="h-full '+(zz.strength>=70?'bg-emerald-400':zz.strength>=45?'bg-amber-400':'bg-slate-500')+'" style="width:'+zz.strength+'%"></div></div><span class="font-mono font-bold text-xs '+(zz.strength>=70?'text-emerald-400':zz.strength>=45?'text-amber-400':'text-slate-400')+'">%'+zz.strength+'</span></div>'});h+='</div></div>'});h+='</div>';return h}

function renderScalper(){if(!S)return '';var arr=(S.scalper||[]);if(!arr.length)return '<div class="text-center py-16 text-slate-500">Scalper taranıyor…</div>';var h='<div class="text-[11px] text-slate-400 mb-3">⚡ <b class="text-amber-400">Scalper (SMC)</b> — 15m grafikte Market Structure (BOS). Son 10 mum içinde kırılım.</div><div class="space-y-1">';arr.forEach(function(s){var px = S.px[s.symbol]||s.entry;var r = (s.dir==='LONG'?1:-1) * (px - s.entry) / Math.abs(s.entry - s.stop);var pnlCls = r>0?'long':r<0?'short':'muted';h+='<div class="sig-row '+(s.dir==='LONG'?'L':'S')+'" onclick="openDetail('+JSON.stringify(s).replace(/"/g,'&quot;')+', \'scalper\')"><div class="p-3 flex items-center justify-between gap-2 flex-wrap"><div class="flex items-center gap-2">'+dirChip(s.dir)+'<span class="font-bold text-white">'+esc(s.base)+'</span><span class="text-[10px] text-slate-500">BOS @ '+fp(s.level)+' ('+s.barsAgo+' mum önce)</span></div><div class="flex items-center gap-3"><span class="font-mono text-xs text-slate-300">Giriş: '+fp(s.entry)+'</span><span class="font-mono font-bold '+pnlCls+'">'+sg(r)+'R</span></div></div></div>'});h+='</div>';return h}

function renderRange(){if(!S)return '';var arr=(S.range||[]);if(!arr.length)return '<div class="text-center py-16 text-slate-500">Range verisi taranıyor…</div>';var h='<div class="text-[11px] text-slate-400 mb-3">📉 <b class="text-purple-400">Range Pro</b> — ATR sıkışması + fiyat konsolidasyonu. Kırılım yaklaşınca sinyal.</div><div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">';arr.forEach(function(r){h+='<div class="card p-4" onclick="openDetail('+JSON.stringify(r).replace(/"/g,'&quot;')+', \'range\')"><div class="flex justify-between items-center mb-2"><div class="font-bold text-white">'+esc(r.base)+'</div>'+(r.breakout?'<span class="chip chip-TP1">KIRILIM '+r.breakout+'</span>':'<span class="chip chip-OPEN">SIKIŞMA</span>')+'</div><div class="text-xs space-y-1 font-mono"><div class="flex justify-between"><span class="text-slate-400">Fiyat</span><span>'+fp(r.price)+'</span></div><div class="flex justify-between"><span class="text-slate-400">Üst</span><span class="long">'+fp(r.hi)+'</span></div><div class="flex justify-between"><span class="text-slate-400">Alt</span><span class="short">'+fp(r.lo)+'</span></div><div class="flex justify-between"><span class="text-slate-400">Genişlik</span><span>'+r.width+'%</span></div><div class="flex justify-between"><span class="text-slate-400">Sıkışma</span><span class="text-purple-400">'+r.squeeze+'</span></div></div></div>'});h+='</div>';return h}

function renderStrateji(){var strats=[{n:'Momentum Avcısı',tag:'AGRESİF',desc:'Piyasa trenddeyken çalışır. Kısa-uzun vadeli momentum uyumlu coinlerde kırılım sonrası girer.',perf:'Aylık +%53 • DD -%11 • Win %65',detail:'TP/SL: Fib 1.618 / 2.618 • Yüksek R:R • Trend gerektirir'},{n:'Prime Max',tag:'GÜVENLİ',desc:'Ortalamadan sapmaları arar (mean reversion). 3 coin, 10x kaldıraç, %15 marjin.',perf:'Aylık +%17 • DD -%3.6 • Win %62',detail:'TP %1.2 • SL %0 (BE) • Düşük risk'},{n:'Alfa 3',tag:'SIKIŞMA',desc:'Volatilite sıkışması + kırılım. Sadece 3 spesifik coinde (BTC gibi) çalışır.',perf:'6 aylık +%50 • DD -%4 • Win %62',detail:'Uzun vade • Squeeze breakout • BTC/ETH odaklı'},{n:'Altın Avcısı',tag:'EMTİA',desc:'Değerli metaller + emtia trend takip.',perf:'Aylık +%22 • DD -%8 • Win %58',detail:'XAU/XAG • Trend takip • Düşük korelasyon'}];var h='<div class="text-[11px] text-slate-400 mb-4">🎴 <b class="text-cyan-400">4 hazır strateji</b> — Videoda gösterilen AlgoCoinism stratejileri. Otomatik bot olarak çalıştırılabilir.</div>';h+='<div class="grid grid-cols-1 md:grid-cols-2 gap-4">';strats.forEach(function(s){h+='<div class="card p-5"><div class="flex items-center justify-between mb-2"><h3 class="font-bold text-white text-base">'+s.n+'</h3><span class="badge badge-pro">'+s.tag+'</span></div><p class="text-xs text-slate-400 leading-relaxed mb-3">'+s.desc+'</p><div class="bg-slate-900/60 rounded-lg p-3 text-[11px] font-mono"><div class="text-cyan-400 font-bold mb-1">'+s.perf+'</div><div class="text-slate-500">'+s.detail+'</div></div></div>'});h+='</div>';return h}

function renderStat(){if(!S)return '';function tbl(title,obj){var k=Object.keys(obj||{});if(!k.length)return '';return '<h3 class="text-xs text-slate-500 uppercase font-bold mb-2 mt-4">'+title+'</h3><div class="overflow-x-auto"><table class="w-full text-xs font-mono"><thead><tr class="text-slate-500 border-b border-slate-800 text-[10px] uppercase"><th class="text-left py-2">Grup</th><th class="text-right py-2">N</th><th class="text-right py-2">Win%</th><th class="text-right py-2">Ort.R</th><th class="text-right py-2">Top.R</th></tr></thead><tbody>'+k.map(function(kk){var x=obj[kk];return '<tr class="border-b border-slate-800/50"><td class="py-2 text-white">'+esc(kk)+'</td><td class="text-right py-2">'+(x.n||0)+'</td><td class="text-right py-2">'+f2((x.win||0)*100,0)+'</td><td class="text-right py-2 '+(x.avgR>0?'long':x.avgR<0?'short':'muted')+'">'+sg(x.avgR||0)+'</td><td class="text-right py-2 '+(x.totalR>0?'long':x.totalR<0?'short':'muted')+'">'+sg(x.totalR||0,1)+'</td></tr>'}).join('')+'</tbody></table></div>'}function stats(list){var closed=list.filter(function(s){return !isOp(s)&&s.netR!=null});if(!closed.length)return null;var n=closed.length,w=0,tot=0,gp=0,gl=0;closed.forEach(function(s){tot+=s.netR;if(s.netR>0){w++;gp+=s.netR}else{gl-=s.netR}});return{n:n,win:w/n,avgR:tot/n,totalR:tot,pf:gl>0?gp/gl:99}}var a=stats(S.tr||[]);var b=stats(S.brk||[]);var h='<div class="grid md:grid-cols-2 gap-4">';['Trend','LT Kırılım'].forEach(function(name,i){var st=i===0?a:b;h+='<div class="card p-5"><h3 class="font-bold text-white mb-3">'+name+'</h3>'+(st?'<div class="grid grid-cols-2 gap-3 text-xs font-mono"><div><div class="text-slate-500">İşlem</div><div class="font-bold text-white text-lg">'+st.n+'</div></div><div><div class="text-slate-500">Win</div><div class="font-bold text-white text-lg">'+f2(st.win*100,0)+'%</div></div><div><div class="text-slate-500">Ort. R</div><div class="font-bold '+(st.avgR>0?'long':'short')+' text-lg">'+sg(st.avgR)+'</div></div><div><div class="text-slate-500">Toplam R</div><div class="font-bold '+(st.totalR>0?'long':'short')+' text-lg">'+sg(st.totalR,1)+'</div></div><div><div class="text-slate-500">PF</div><div class="font-bold text-white text-lg">'+(st.pf>=99?'∞':f2(st.pf))+'</div></div></div>':'<div class="text-slate-500 text-xs">Henüz kapanan yok</div>')+'</div>'});h+='</div>';return h}

function renderAll(){renderTop();renderSidebar();var M=$('main');if(!M)return;var h='';switch(tab){case 'home':h=renderHome();break;case 'piyasa':h=renderPiyasa();break;case 'pump':h=renderPump();break;case 'trend':h=renderTrend();break;case 'lt':h=renderLT();break;case 'zones':h=renderZones();break;case 'scalper':h=renderScalper();break;case 'range':h=renderRange();break;case 'strateji':h=renderStrateji();break;case 'stat':h=renderStat();break;default:h=renderHome()}M.innerHTML=h}

function poll(){fetch('/api/state').then(function(r){if(!r.ok)throw 0;return r.json()}).then(function(d){S=d;renderAll()}).catch(function(){})}
$('mobMenu')&&$('mobMenu').addEventListener('click',function(){renderSidebar()});
addEventListener('resize',function(){if(S)renderAll()});
setInterval(poll,5000);
poll();
</script>
</body></html>`;

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    try {
        if (u.pathname === '/health') return json(res, 200, { ok: true, name: 'AlphaSon', version: 'v61.1', triangles: Object.keys(structLT).length, radar: triRadar.length, breakouts: brkEvents.length, trend: trendSignals.length, pumps: pumpSignals.length, universe: universe.length });
        if (u.pathname === '/' || u.pathname === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(HTML); }
        if (u.pathname === '/api/state') return json(res, 200, apiState());
        if (u.pathname === '/api/candles') { if (!rateOk(ip, 120)) return json(res, 429, { error: 'çok fazla istek' }); return json(res, 200, await apiCandles(u.searchParams.get('symbol') || '', u.searchParams.get('tf') || '')); }
        if (u.pathname === '/api/piyasa') { await updateRadar(); return json(res, 200, radar); }
        json(res, 404, { error: 'yok' });
    } catch (e) { json(res, 500, { error: e.message }); }
});

async function start() {
    try {
        loadState();
        await ex.loadMarkets(); log('markets:', Object.keys(ex.markets).length);
        await refreshUniverse();
        log('universe:', universe.length);
        setInterval(refreshUniverse, CFG.UNIVERSE_MS);
        setInterval(liveTick, 8e3);
        setInterval(saveState, 15e3);
        setInterval(() => runTrend(false), 5000);
        (async () => { await runScan(); })();
        setInterval(async () => { if (!scan.running) await runScan(); }, 5 * 60e3);
        setInterval(scanPump, 60e3);
        setInterval(scanZones, 3 * 60e3);
        setInterval(scanScalper, 3 * 60e3);
        setInterval(scanRange, 5 * 60e3);
        setInterval(trackPumps, 30e3);
        setInterval(updateRadar, 5 * 60e3);
        setTimeout(updateRadar, 3000);
        log('AlphaSon v61.1 • AlgoCoinism Edition ready');
    } catch (e) { log('start hata', e.message); setTimeout(start, 30000); }
}
function shutdown() { dirty = true; saveState(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); }
process.on('unhandledRejection', e => log('UNHANDLED:', e && e.stack ? e.stack : e));
process.on('uncaughtException', e => log('UNCAUGHT:', e && e.stack ? e.stack : e));
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

if (require.main === module) server.listen(PORT, '0.0.0.0', () => { log('PORT', PORT); start(); });
module.exports = { detectTriangle, pack, buildStruct, lineValues, planTrade, trendEval, trfSeries, apiState, scanPump, scanZones, scanScalper, scanRange };
