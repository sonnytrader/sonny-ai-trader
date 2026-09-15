'use strict';

const express = require('express');
const cors = require('cors');
const ccxt = require('ccxt');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = Number(process.env.PORT || 3000);

app.use(cors());
app.use(express.json());

// ============================================================
// CONFIG
// ============================================================

const CONFIG = {
    TIMEFRAME: '2h',
    TREND_TIMEFRAME: '4h',
    CANDLE_LIMIT: 100,

    PIVOT_LEFT: 3,
    PIVOT_RIGHT: 3,
    PIVOT_WINDOW: 40,
    LEVEL_MERGE_PCT: 0.005,
    MIN_TOUCHES: 2,

    EMA_FAST: 21,
    EMA_SLOW: 50,
    EMA_TREND: 200,

    MIN_VOLUME_MULTIPLIER: 1.5,
    STRONG_VOLUME_MULTIPLIER: 2.0,
    MIN_BODY_ATR_RATIO: 0.35,

    MIN_BREAKOUT_DISTANCE: 0.3,
    MAX_BREAKOUT_DISTANCE: 3.0,

    RSI_PERIOD: 14,
    RSI_LONG_MIN: 45,
    RSI_SHORT_MAX: 55,

    RETEST_ZONE_ATR: 0.5,
    RETEST_LOOKBACK_CANDLES: 12,

    STOP_ATR_MULTIPLIER: 1.5,
    TP1_RR: 1.5,
    TP2_RR: 2.5,
    TP3_RR: 4.0,

    SIGNAL_COOLDOWN_MS: 4 * 60 * 60 * 1000,

    MIN_24H_VOLUME_USDT: 3000000,
    MAX_TARGETS: 150,

    SCAN_INTERVAL_MS: 3 * 60 * 1000,
    PRESCAN_INTERVAL_MS: 10 * 60 * 1000,
    API_DELAY_MS: 120,

    MAX_SIGNALS_KEPT: 200,
    DEBUG: true
};

// ============================================================
// EXCHANGE
// ============================================================

const exchange = new ccxt.bitget({
    enableRateLimit: true,
    rateLimit: 250,
    options: { defaultType: 'swap' }
});

// ============================================================
// STATE
// ============================================================

let targets = [];
let signals = [];
let scanRunning = false;
let isShuttingDown = false;
let lastPrescanAt = 0;
let lastScanAt = 0;

const lastSignalTime = new Map();

const APP_STATE = {
    scanStatus: { message: 'Sunucu baslatiliyor...', isScanning: false },
    updatedAt: Date.now()
};

const DEBUG = {
    scanned: 0, signals: 0, strong: 0, medium: 0,
    rejected: 0, errors: 0
};

// ============================================================
// HELPERS
// ============================================================

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function num(v, d = 8) {
    const n = Number(v);
    return Number.isFinite(n) ? Number(n.toFixed(d)) : null;
}

function pct(a, b) { return b ? (a / b) * 100 : 0; }

function sma(values, period) {
    if (!values || values.length < period) return null;
    const arr = values.slice(-period).map(Number).filter(Number.isFinite);
    if (arr.length !== period) return null;
    return arr.reduce((a, b) => a + b, 0) / period;
}

function ema(values, period) {
    if (!values || values.length < period) return null;
    const arr = values.map(Number);
    if (arr.some(v => !Number.isFinite(v))) return null;
    let r = sma(arr.slice(0, period), period);
    if (r == null) return null;
    const k = 2 / (period + 1);
    for (let i = period; i < arr.length; i++) r = arr[i] * k + r * (1 - k);
    return r;
}

function atr(candles, period = 14) {
    if (!candles || candles.length < period + 1) return null;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
        const h = Number(candles[i][2]);
        const l = Number(candles[i][3]);
        const pc = Number(candles[i - 1][4]);
        if (![h, l, pc].every(Number.isFinite)) continue;
        trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    return sma(trs, period);
}

function rsi(closes, period = 14) {
    if (!closes || closes.length < period + 1) return null;
    let g = 0, l = 0;
    for (let i = 1; i <= period; i++) {
        const d = closes[i] - closes[i - 1];
        if (d >= 0) g += d; else l -= d;
    }
    g /= period; l /= period;
    for (let i = period + 1; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        g = (g * (period - 1) + Math.max(0, d)) / period;
        l = (l * (period - 1) + Math.max(0, -d)) / period;
    }
    if (l === 0) return 100;
    return 100 - 100 / (1 + g / l);
}

function closedCandles(ohlcv) {
    if (!Array.isArray(ohlcv) || ohlcv.length < 2) return [];
    return ohlcv.slice(0, -1).filter(c => Array.isArray(c) && c.length >= 6);
}

// ============================================================
// PIVOT BULMA
// ============================================================

function findPivotHighs(candles) {
    const result = [];
    const L = CONFIG.PIVOT_LEFT, R = CONFIG.PIVOT_RIGHT;
    for (let i = L; i < candles.length - R; i++) {
        const h = Number(candles[i][2]);
        if (!Number.isFinite(h)) continue;
        let ok = true;
        for (let j = i - L; j <= i + R; j++) {
            if (j === i) continue;
            if (Number(candles[j][2]) >= h) { ok = false; break; }
        }
        if (ok) result.push({ index: i, price: h, time: candles[i][0] });
    }
    return result;
}

function findPivotLows(candles) {
    const result = [];
    const L = CONFIG.PIVOT_LEFT, R = CONFIG.PIVOT_RIGHT;
    for (let i = L; i < candles.length - R; i++) {
        const lo = Number(candles[i][3]);
        if (!Number.isFinite(lo)) continue;
        let ok = true;
        for (let j = i - L; j <= i + R; j++) {
            if (j === i) continue;
            if (Number(candles[j][3]) <= lo) { ok = false; break; }
        }
        if (ok) result.push({ index: i, price: lo, time: candles[i][0] });
    }
    return result;
}

function mergeLevels(pivots, tolerancePct) {
    if (!pivots || !pivots.length) return [];
    const sorted = pivots.slice().sort((a, b) => a.price - b.price);
    const merged = [];
    let current = null;
    for (const p of sorted) {
        if (!current) {
            current = {
                price: p.price, touches: 1, indices: [p.index],
                firstIndex: p.index, lastIndex: p.index
            };
            continue;
        }
        const diff = Math.abs(p.price - current.price) / current.price;
        if (diff <= tolerancePct) {
            current.touches++;
            current.indices.push(p.index);
            current.lastIndex = p.index;
            current.price = (current.price * (current.touches - 1) + p.price) / current.touches;
        } else {
            merged.push(current);
            current = {
                price: p.price, touches: 1, indices: [p.index],
                firstIndex: p.index, lastIndex: p.index
            };
        }
    }
    if (current) merged.push(current);
    return merged;
}

// ============================================================
// TREND KONTROLU (4H EMA200)
// ============================================================

async function getTrend(symbol) {
    try {
        const raw = await exchange.fetchOHLCV(
            symbol, CONFIG.TREND_TIMEFRAME, undefined, CONFIG.EMA_TREND + 30
        );
        const candles = closedCandles(raw);
        const closes = candles.map(c => Number(c[4]));
        if (closes.length < CONFIG.EMA_TREND) return { trend: 'UNKNOWN', ema200: null };
        const ema200 = ema(closes, CONFIG.EMA_TREND);
        const last = closes[closes.length - 1];
        if (last > ema200) return { trend: 'BULLISH', ema200: num(ema200) };
        if (last < ema200) return { trend: 'BEARISH', ema200: num(ema200) };
        return { trend: 'SIDEWAYS', ema200: num(ema200) };
    } catch {
        return { trend: 'UNKNOWN', ema200: null };
    }
}

// ============================================================
// SINYAL URETIMI
// ============================================================

async function scanForSignal(symbol) {
    DEBUG.scanned++;
    try {
        const raw = await exchange.fetchOHLCV(
            symbol, CONFIG.TIMEFRAME, undefined, CONFIG.CANDLE_LIMIT
        );
        const candles = closedCandles(raw);
        if (candles.length < CONFIG.PIVOT_WINDOW + 5) return null;

        const last = candles[candles.length - 1];
        const close = Number(last[4]);
        const open = Number(last[1]);
        const high = Number(last[2]);
        const low = Number(last[3]);
        const volume = Number(last[5]);
        if (![close, open, high, low, volume].every(Number.isFinite)) return null;

        // Son kapanan mumdan onceki mumlarla seviyeleri bul
        const priorCandles = candles.slice(0, -1);
        const windowCandles = priorCandles.slice(-CONFIG.PIVOT_WINDOW);

        const pivotHighs = mergeLevels(findPivotHighs(windowCandles), CONFIG.LEVEL_MERGE_PCT);
        const pivotLows = mergeLevels(findPivotLows(windowCandles), CONFIG.LEVEL_MERGE_PCT);

        const resistances = pivotHighs.filter(l => l.touches >= CONFIG.MIN_TOUCHES);
        const supports = pivotLows.filter(l => l.touches >= CONFIG.MIN_TOUCHES);

        // Hacim
        const volumes = priorCandles.slice(-20).map(c => Number(c[5])).filter(Number.isFinite);
        const avgVolume = sma(volumes, Math.min(20, volumes.length));
        if (!avgVolume) return null;
        const volumeRatio = volume / avgVolume;

        // ATR
        const currentATR = atr(priorCandles, CONFIG.ATR_PERIOD || 14);
        if (!currentATR || currentATR <= 0) return null;

        const body = Math.abs(close - open);
        const bodyRatio = body / currentATR;

        // RSI
        const rsiValue = rsi(priorCandles.map(c => Number(c[4])), CONFIG.RSI_PERIOD);

        // EMA'lar (2H)
        const closes2H = priorCandles.map(c => Number(c[4]));
        const ema21 = ema(closes2H, CONFIG.EMA_FAST);
        const ema50 = ema(closes2H, CONFIG.EMA_SLOW);

        // Trend (4H)
        const trendInfo = await getTrend(symbol);
        const trend = trendInfo.trend;

        // ============================================
        // LONG SINYALI
        // ============================================
        let candidate = null;

        if (trend === 'BULLISH' && rsiValue != null && rsiValue >= CONFIG.RSI_LONG_MIN) {
            // Fiyatin altindaki en yakin direnc = simdi destek oldu
            for (const r of resistances) {
                if (r.price < close) {
                    const distPct = pct(close - r.price, r.price);
                    if (distPct >= CONFIG.MIN_BREAKOUT_DISTANCE &&
                        distPct <= CONFIG.MAX_BREAKOUT_DISTANCE) {
                        // Retest kontrolu: son 12 mumda bu seviyeye dokundu mu?
                        let retest = false;
                        let retestIndex = -1;
                        for (let i = Math.max(1, priorCandles.length - CONFIG.RETEST_LOOKBACK_CANDLES);
                             i < priorCandles.length; i++) {
                            const c = priorCandles[i];
                            const cLow = Number(c[3]);
                            const cClose = Number(c[4]);
                            const cHigh = Number(c[2]);
                            // Fiyat seviyeye yaklasti mi?
                            const atLevel = Math.abs(cLow - r.price) / r.price < 0.01;
                            const aboveLevel = cClose > r.price;
                            if (atLevel && aboveLevel) {
                                retest = true;
                                retestIndex = i;
                                break;
                            }
                        }

                        candidate = {
                            direction: 'LONG',
                            level: r,
                            distPct,
                            retest,
                            retestIndex,
                            emaAlignment: ema21 && ema50 && ema21 > ema50
                        };
                        break;
                    }
                }
            }
        }

        // ============================================
        // SHORT SINYALI
        // ============================================
        if (!candidate && trend === 'BEARISH' && rsiValue != null && rsiValue <= CONFIG.RSI_SHORT_MAX) {
            // Fiyatin ustundeki en yakin destek = simdi direnc oldu
            for (const s of supports) {
                if (s.price > close) {
                    const distPct = pct(s.price - close, s.price);
                    if (distPct >= CONFIG.MIN_BREAKOUT_DISTANCE &&
                        distPct <= CONFIG.MAX_BREAKOUT_DISTANCE) {
                        let retest = false;
                        let retestIndex = -1;
                        for (let i = Math.max(1, priorCandles.length - CONFIG.RETEST_LOOKBACK_CANDLES);
                             i < priorCandles.length; i++) {
                            const c = priorCandles[i];
                            const cHigh = Number(c[2]);
                            const cClose = Number(c[4]);
                            const atLevel = Math.abs(cHigh - s.price) / s.price < 0.01;
                            const belowLevel = cClose < s.price;
                            if (atLevel && belowLevel) {
                                retest = true;
                                retestIndex = i;
                                break;
                            }
                        }

                        candidate = {
                            direction: 'SHORT',
                            level: s,
                            distPct,
                            retest,
                            retestIndex,
                            emaAlignment: ema21 && ema50 && ema21 < ema50
                        };
                        break;
                    }
                }
            }
        }

        if (!candidate) {
            DEBUG.rejected++;
            return null;
        }

        // Hacim kontrolu
        if (volumeRatio < CONFIG.MIN_VOLUME_MULTIPLIER) {
            DEBUG.rejected++;
            return null;
        }

        // Body kontrolu
        if (bodyRatio < CONFIG.MIN_BODY_ATR_RATIO) {
            DEBUG.rejected++;
            return null;
        }

        // Cooldown
        const cooldownKey = `${symbol}_${candidate.direction}`;
        const lastTime = lastSignalTime.get(cooldownKey) || 0;
        if (Date.now() - lastTime < CONFIG.SIGNAL_COOLDOWN_MS) {
            DEBUG.rejected++;
            return null;
        }

        // ============================================
        // KALITE PUANI
        // ============================================
        let qualityScore = 0;
        const reasons = [];

        // Trend
        if (candidate.direction === 'LONG' && trend === 'BULLISH') {
            qualityScore += 20;
            reasons.push('4H EMA200 üstünde (BULLISH trend)');
        } else if (candidate.direction === 'SHORT' && trend === 'BEARISH') {
            qualityScore += 20;
            reasons.push('4H EMA200 altında (BEARISH trend)');
        }

        // EMA alignment
        if (candidate.emaAlignment) {
            qualityScore += 15;
            reasons.push(candidate.direction === 'LONG'
                ? 'EMA21 > EMA50 (2H yükseliş)'
                : 'EMA21 < EMA50 (2H düşüş)');
        }

        // Retest
        if (candidate.retest) {
            qualityScore += 25;
            reasons.push('Seviye retest edildi ve tepki verdi');
        }

        // Hacim
        if (volumeRatio >= CONFIG.STRONG_VOLUME_MULTIPLIER) {
            qualityScore += 20;
            reasons.push(`Çok güçlü hacim (${volumeRatio.toFixed(2)}x)`);
        } else if (volumeRatio >= CONFIG.MIN_VOLUME_MULTIPLIER) {
            qualityScore += 12;
            reasons.push(`İyi hacim (${volumeRatio.toFixed(2)}x)`);
        }

        // Seviye dokunma
        if (candidate.level.touches >= 3) {
            qualityScore += 15;
            reasons.push(`Sağlam seviye (${candidate.level.touches}x test edilmiş)`);
        } else if (candidate.level.touches === 2) {
            qualityScore += 8;
            reasons.push(`Orta seviye (2x test edilmiş)`);
        }

        // Body
        if (bodyRatio >= 0.6) {
            qualityScore += 10;
            reasons.push(`Büyük kırılım mumu (${bodyRatio.toFixed(2)}×ATR)`);
        }

        // Kalite etiketi
        let quality = 'ZAYIF';
        if (qualityScore >= 70) quality = 'GUCLU';
        else if (qualityScore >= 45) quality = 'ORTA';
        else {
            DEBUG.rejected++;
            return null;
        }

        if (quality === 'GUCLU') DEBUG.strong++;
        else if (quality === 'ORTA') DEBUG.medium++;

        // ============================================
        // GIRIS / STOP / TP
        // ============================================
        const entry = close;
        const stopDistance = currentATR * CONFIG.STOP_ATR_MULTIPLIER;

        let stop, tp1, tp2, tp3;
        if (candidate.direction === 'LONG') {
            stop = candidate.level.price - currentATR * 0.5;
            const risk = entry - stop;
            tp1 = entry + risk * CONFIG.TP1_RR;
            tp2 = entry + risk * CONFIG.TP2_RR;
            tp3 = entry + risk * CONFIG.TP3_RR;
        } else {
            stop = candidate.level.price + currentATR * 0.5;
            const risk = stop - entry;
            tp1 = entry - risk * CONFIG.TP1_RR;
            tp2 = entry - risk * CONFIG.TP2_RR;
            tp3 = entry - risk * CONFIG.TP3_RR;
        }

        const risk = Math.abs(entry - stop);
        const rr1 = Math.abs(tp1 - entry) / risk;
        const rr2 = Math.abs(tp2 - entry) / risk;
        const rr3 = Math.abs(tp3 - entry) / risk;

        // ============================================
        // SON UC MUM (mini chart icin)
        // ============================================
        const lastCandles = candles.slice(-50).map(c => ({
            t: c[0],
            o: num(c[1]),
            h: num(c[2]),
            l: num(c[3]),
            c: num(c[4])
        }));

        const signal = {
            id: `${symbol.replace(/[^A-Z0-9]/gi, '')}_${candidate.direction}_${Date.now()}`,
            symbol,
            symbolTV: symbol.replace('/USDT:USDT', 'USDT.P'),
            direction: candidate.direction,
            quality,
            qualityScore,
            entry: num(entry),
            stop: num(stop),
            tp1: num(tp1),
            tp2: num(tp2),
            tp3: num(tp3),
            rr1: num(rr1, 2),
            rr2: num(rr2, 2),
            rr3: num(rr3, 2),
            level: num(candidate.level.price),
            levelTouches: candidate.level.touches,
            distPct: num(candidate.distPct, 2),
            volumeRatio: num(volumeRatio, 2),
            bodyRatio: num(bodyRatio, 2),
            rsi: num(rsiValue, 1),
            trend,
            retest: candidate.retest,
            reasons,
            candles: lastCandles,
            candleTime: last[0],
            timestamp: Date.now()
        };

        lastSignalTime.set(cooldownKey, Date.now());
        DEBUG.signals++;

        console.log(
            `\x1b[32m[${candidate.direction}][${quality}] ${symbol} @ ${entry.toFixed(4)} | ` +
            `Q=${qualityScore} Level=${candidate.level.price.toFixed(4)} (${candidate.level.touches}x) ` +
            `Vol=${volumeRatio.toFixed(2)}x\x1b[0m`
        );

        return signal;

    } catch (err) {
        DEBUG.errors++;
        console.error(`[scanForSignal] ${symbol}: ${err.message}`);
        return null;
    }
}

// ============================================================
// PRESCAN
// ============================================================

async function runPreScan() {
    try {
        if (!exchange.markets || !Object.keys(exchange.markets).length) {
            await exchange.loadMarkets(true);
        }
        const tickers = await exchange.fetchTickers(undefined, { type: 'swap' });
        const list = [];
        for (const t of Object.values(tickers || {})) {
            if (!t || !t.symbol) continue;
            const m = exchange.markets[t.symbol];
            if (!m || !m.active || !m.swap || m.quote !== 'USDT') continue;
            const v = Number(t.quoteVolume);
            if (Number.isFinite(v) && v >= CONFIG.MIN_24H_VOLUME_USDT) {
                list.push({ symbol: t.symbol, volume: v });
            }
        }
        list.sort((a, b) => b.volume - a.volume);
        targets = list.slice(0, CONFIG.MAX_TARGETS).map(i => i.symbol);
        lastPrescanAt = Date.now();
        console.log(`RADAR | ${targets.length} coin | min vol: ${CONFIG.MIN_24H_VOLUME_USDT}`);
    } catch (err) {
        console.error(`[runPreScan] ${err.message}`);
    }
}

// ============================================================
// SCAN
// ============================================================

async function runScan() {
    if (scanRunning) return;
    scanRunning = true;
    DEBUG.scanned = 0;
    DEBUG.rejected = 0;

    APP_STATE.scanStatus = { message: `Tarama: ${targets.length} coin`, isScanning: true };
    broadcast();

    let newSignals = 0;

    try {
        for (const symbol of targets) {
            if (isShuttingDown) break;
            const signal = await scanForSignal(symbol);
            if (signal) {
                signals.unshift(signal);
                signals = signals.slice(0, CONFIG.MAX_SIGNALS_KEPT);
                newSignals++;
                broadcast();
            }
            await sleep(CONFIG.API_DELAY_MS);
        }
        lastScanAt = Date.now();
    } catch (err) {
        console.error(`[runScan] ${err.message}`);
    }

    scanRunning = false;
    APP_STATE.scanStatus = {
        message: `Tarama bitti | ${newSignals} yeni sinyal`,
        isScanning: false
    };
    broadcast();

    console.log(
        `[SCAN DONE] scanned=${DEBUG.scanned} signals=${DEBUG.signals} ` +
        `L=${DEBUG.strong} O=${DEBUG.medium} rejected=${DEBUG.rejected}`
    );
}

async function runAll() {
    if (Date.now() - lastPrescanAt > CONFIG.PRESCAN_INTERVAL_MS || !targets.length) {
        await runPreScan();
    }
    await runScan();
}

// ============================================================
// API
// ============================================================

app.get('/api/signals', (req, res) => res.json(snapshot()));
app.get('/api/debug', (req, res) => res.json({
    success: true, debug: DEBUG, config: CONFIG, targets: targets.length
}));
app.get('/api/health', (req, res) => res.json({
    ok: true, time: Date.now(), targets: targets.length, signals: signals.length
}));
app.post('/api/scan-now', async (req, res) => {
    try {
        await runScan();
        res.json({ success: true, count: signals.length });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
app.delete('/api/signals', (req, res) => {
    signals = [];
    broadcast();
    res.json({ success: true });
});

// ============================================================
// SNAPSHOT
// ============================================================

function snapshot() {
    APP_STATE.updatedAt = Date.now();
    return {
        success: true,
        signals: signals.slice(0, 100),
        scanStatus: APP_STATE.scanStatus,
        stats: {
            total: signals.length,
            strong: signals.filter(s => s.quality === 'GUCLU').length,
            medium: signals.filter(s => s.quality === 'ORTA').length,
            long: signals.filter(s => s.direction === 'LONG').length,
            short: signals.filter(s => s.direction === 'SHORT').length
        },
        updatedAt: APP_STATE.updatedAt
    };
}

function broadcast() {
    const msg = JSON.stringify({ type: 'update', data: snapshot() });
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

wss.on('connection', sock => {
    sock.send(JSON.stringify({ type: 'snapshot', data: snapshot() }));
});

// ============================================================
// FRONTEND
// ============================================================

const HTML = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SONNY SIGNAL PRO</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0e14;color:#e9eef5;font-family:-apple-system,Arial,sans-serif;font-size:14px;line-height:1.4}
.wrap{max-width:1600px;margin:auto;padding:16px}

.top{display:flex;justify-content:space-between;align-items:center;padding-bottom:14px;border-bottom:1px solid #1c2634;margin-bottom:20px}
.brand{font-size:20px;font-weight:800;letter-spacing:0.5px}
.brand span{color:#17d7a0}
.sub{font-size:11px;color:#7f8b98;margin-top:2px}
.controls{display:flex;gap:10px;align-items:center}
.btn{background:#1a2331;border:1px solid #2c3a4f;color:#e9eef5;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;transition:background .15s}
.btn:hover{background:#243044}
.btn.primary{background:#17d7a0;color:#0a0e14;border-color:#17d7a0}
.btn.primary:hover{background:#14b88c}
.btn.danger{background:#2a0f14;border-color:#ff5c77;color:#ff5c77}
.btn.danger:hover{background:#3a1520}

.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:20px}
@media(max-width:900px){.stats{grid-template-columns:repeat(2,1fr)}}
.stat{background:#0f1620;border:1px solid #1c2634;border-radius:8px;padding:12px 14px}
.stat .lbl{font-size:10px;color:#7f8b98;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:4px}
.stat .val{font-size:22px;font-weight:700}
.stat.strong .val{color:#17d7a0}
.stat.medium .val{color:#f6c453}
.stat.long .val{color:#17d7a0}
.stat.short .val{color:#ff5c77}

.filter-bar{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
.filter{background:#0f1620;border:1px solid #1c2634;color:#8b97a5;padding:6px 14px;border-radius:20px;cursor:pointer;font-size:12px;font-weight:600;transition:all .15s}
.filter:hover{border-color:#2c3a4f;color:#e9eef5}
.filter.active{background:#17d7a0;color:#0a0e14;border-color:#17d7a0}
.filter.active.short{background:#ff5c77;color:#fff}
.filter.active.medium{background:#f6c453;color:#0a0e14}

.signals{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:14px}
@media(max-width:900px){.signals{grid-template-columns:1fr}}

.sig{background:#0f1620;border:1px solid #1c2634;border-radius:12px;overflow:hidden;transition:border-color .15s;cursor:pointer}
.sig:hover{border-color:#2c3a4f}
.sig.long{border-left:3px solid #17d7a0}
.sig.short{border-left:3px solid #ff5c77}

.sig-head{padding:12px 14px;border-bottom:1px solid #1a2331;display:flex;justify-content:space-between;align-items:center}
.sig-symbol{font-size:16px;font-weight:800;letter-spacing:0.3px}
.sig-badges{display:flex;gap:6px}
.badge{padding:3px 8px;border-radius:5px;font-size:10px;font-weight:800;letter-spacing:0.5px;text-transform:uppercase}
.badge.strong{background:#0f2a24;color:#17d7a0}
.badge.medium{background:#2a2410;color:#f6c453}
.badge.weak{background:#2a1a10;color:#f6a453}
.badge.dir-long{background:#0f2a24;color:#17d7a0}
.badge.dir-short{background:#2a0f14;color:#ff5c77}
.badge.retest{background:#1a1f3a;color:#7d8bff}
.badge.trend{background:#0f1620;color:#8b97a5}

.sig-chart{padding:8px 14px;background:#0a0e14}
.sig-chart canvas{display:block;width:100%;height:100px}

.sig-levels{padding:12px 14px;display:grid;grid-template-columns:repeat(3,1fr);gap:8px;font-size:11px}
.sig-levels .lvl{background:#0a0e14;padding:6px 8px;border-radius:5px}
.sig-levels .lvl .lbl{color:#5e6b7c;font-size:9px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px}
.sig-levels .lvl .val{font-size:12px;font-weight:700;color:#e9eef5}
.sig-levels .lvl.entry{border-left:2px solid #7d8bff}
.sig-levels .lvl.stop{border-left:2px solid #ff5c77}
.sig-levels .lvl.tp1{border-left:2px solid #17d7a0}
.sig-levels .lvl.tp2{border-left:2px solid #14b88c}
.sig-levels .lvl.tp3{border-left:2px solid #0f8a67}
.sig-levels .lvl.rr{border-left:2px solid #8b97a5}

.sig-foot{padding:10px 14px;border-top:1px solid #1a2331;display:flex;justify-content:space-between;align-items:center;gap:8px}
.sig-meta{font-size:10px;color:#5e6b7c}
.sig-actions{display:flex;gap:6px}
.btn-mini{background:#1a2331;border:1px solid #2c3a4f;color:#8b97a5;padding:5px 10px;border-radius:5px;cursor:pointer;font-size:10px;font-weight:600;transition:all .15s;text-decoration:none;display:inline-block}
.btn-mini:hover{background:#243044;color:#e9eef5;border-color:#3c4a5f}
.btn-mini.tv{background:#2962ff;border-color:#2962ff;color:#fff}
.btn-mini.tv:hover{background:#1e4fd9}
.btn-mini.detail{background:#17d7a0;border-color:#17d7a0;color:#0a0e14}
.btn-mini.detail:hover{background:#14b88c}

.empty{padding:80px 20px;text-align:center;color:#5e6b7c}
.empty-icon{font-size:48px;margin-bottom:16px}
.empty-text{font-size:14px}

/* Modal */
.modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:100;align-items:center;justify-content:center;padding:20px}
.modal.open{display:flex}
.modal-content{background:#0f1620;border:1px solid #2c3a4f;border-radius:12px;max-width:700px;width:100%;max-height:90vh;overflow:auto}
.modal-head{padding:16px 20px;border-bottom:1px solid #1a2331;display:flex;justify-content:space-between;align-items:center}
.modal-title{font-size:18px;font-weight:800}
.modal-close{background:transparent;border:none;color:#7f8b98;font-size:24px;cursor:pointer;padding:0;line-height:1}
.modal-close:hover{color:#e9eef5}
.modal-body{padding:20px}
.reasons{list-style:none;margin:0}
.reasons li{padding:10px 0;border-bottom:1px solid #1a2331;color:#c5cfdd;font-size:13px;display:flex;gap:10px}
.reasons li:last-child{border-bottom:none}
.reasons li:before{content:'✓';color:#17d7a0;font-weight:800;flex-shrink:0}
.detail-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-bottom:16px}
.detail-item{background:#0a0e14;padding:10px;border-radius:6px}
.detail-item .lbl{font-size:10px;color:#5e6b7c;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px}
.detail-item .val{font-size:14px;font-weight:700;color:#e9eef5}

.sound-toggle{display:flex;align-items:center;gap:6px;font-size:11px;color:#7f8b98}
.sound-toggle input{accent-color:#17d7a0}
</style>
</head>
<body>
<div class="wrap">

<div class="top">
<div>
<div class="brand">SONNY <span>SIGNAL</span> PRO</div>
<div class="sub" id="status">Baglaniyor...</div>
</div>
<div class="controls">
<label class="sound-toggle"><input type="checkbox" id="soundToggle" checked> Ses</label>
<button class="btn" onclick="scanNow()">Simdi Tara</button>
<button class="btn danger" onclick="clearSignals()">Temizle</button>
</div>
</div>

<div class="stats">
<div class="stat"><div class="lbl">Toplam</div><div class="val" id="statTotal">0</div></div>
<div class="stat strong"><div class="lbl">Guclu</div><div class="val" id="statStrong">0</div></div>
<div class="stat medium"><div class="lbl">Orta</div><div class="val" id="statMedium">0</div></div>
<div class="stat long"><div class="lbl">Long</div><div class="val" id="statLong">0</div></div>
<div class="stat short"><div class="lbl">Short</div><div class="val" id="statShort">0</div></div>
</div>

<div class="filter-bar">
<div class="filter active" data-filter="all">Tumu</div>
<div class="filter" data-filter="GUCLU">Guclu</div>
<div class="filter" data-filter="ORTA">Orta</div>
<div class="filter" data-filter="LONG">Long</div>
<div class="filter short" data-filter="SHORT">Short</div>
</div>

<div class="signals" id="signals"></div>

</div>

<div class="modal" id="detailModal">
<div class="modal-content">
<div class="modal-head">
<div class="modal-title" id="modalTitle">Sinyal Detayi</div>
<button class="modal-close" onclick="closeModal()">×</button>
</div>
<div class="modal-body" id="modalBody"></div>
</div>
</div>

<script>
var signals = [];
var ws = null;
var filter = 'all';
var lastSignalCount = 0;
var audioCtx = null;

function fmt(v){
    v = Number(v);
    if(!Number.isFinite(v)) return '-';
    if(v >= 1000) return v.toFixed(2);
    if(v >= 100) return v.toFixed(3);
    if(v >= 1) return v.toFixed(4);
    return v.toFixed(8);
}

function esc(v){
    return String(v == null ? '' : v).replace(/[&<>"']/g, function(c){
        return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
}

function timeAgo(ts){
    var d = Date.now() - ts;
    var m = Math.floor(d / 60000);
    if(m < 1) return 'az once';
    if(m < 60) return m + ' dk';
    var h = Math.floor(m / 60);
    if(h < 24) return h + ' saat';
    return Math.floor(h / 24) + ' gun';
}

function playSound(){
    if(!document.getElementById('soundToggle').checked) return;
    try{
        if(!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        var osc = audioCtx.createOscillator();
        var gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.3);
        setTimeout(function(){
            var osc2 = audioCtx.createOscillator();
            var gain2 = audioCtx.createGain();
            osc2.connect(gain2);
            gain2.connect(audioCtx.destination);
            osc2.frequency.value = 1320;
            gain2.gain.setValueAtTime(0.1, audioCtx.currentTime);
            gain2.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.4);
            osc2.start();
            osc2.stop(audioCtx.currentTime + 0.4);
        }, 150);
    }catch(e){}
}

function drawMiniChart(canvas, candles, signal){
    var parent = canvas.parentElement;
    var W = parent.clientWidth - 28;
    var H = 100;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';

    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0a0e14';
    ctx.fillRect(0, 0, W, H);

    if(!candles || !candles.length) return;

    var visible = candles.slice(-40);
    var count = visible.length;

    var minP = Infinity, maxP = -Infinity;
    for(var i = 0; i < visible.length; i++){
        var lo = Number(visible[i].l);
        var hi = Number(visible[i].h);
        if(lo < minP) minP = lo;
        if(hi > maxP) maxP = hi;
    }

    // Seviye çizgisi de range'e dahil
    if(signal && signal.level){
        var lvl = Number(signal.level);
        if(lvl < minP) minP = lvl;
        if(lvl > maxP) maxP = lvl;
    }

    var pad = (maxP - minP) * 0.1 || 1;
    minP -= pad;
    maxP += pad;

    var LEFT = 10, RIGHT = 10, TOP = 5, BOTTOM = 5;
    var PW = W - LEFT - RIGHT;
    var PH = H - TOP - BOTTOM;

    function X(i){ return LEFT + i * PW / (count - 1 || 1); }
    function Y(p){ return TOP + (maxP - p) / (maxP - minP) * PH; }

    // Mumlar
    var cw = Math.max(2, Math.min(6, PW / count * 0.7));
    for(var c = 0; c < visible.length; c++){
        var k = visible[c];
        var x = X(c);
        var o = Number(k.o), cl = Number(k.c), h = Number(k.h), l = Number(k.l);
        var bull = cl >= o;
        var color = bull ? '#17d7a0' : '#ff5c77';
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(x, Y(h));
        ctx.lineTo(x, Y(l));
        ctx.stroke();
        var oY = Y(o), cY = Y(cl);
        ctx.fillRect(x - cw/2, Math.min(oY, cY), cw, Math.max(1, Math.abs(cY - oY)));
    }

    // Seviye çizgisi
    if(signal && signal.level){
        var lvlY = Y(signal.level);
        ctx.save();
        ctx.strokeStyle = '#7d8bff';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 3]);
        ctx.beginPath();
        ctx.moveTo(LEFT, lvlY);
        ctx.lineTo(W - RIGHT, lvlY);
        ctx.stroke();
        ctx.restore();
    }

    // Giriş noktası
    if(signal && signal.entry){
        var entryY = Y(signal.entry);
        ctx.save();
        ctx.strokeStyle = signal.direction === 'LONG' ? '#17d7a0' : '#ff5c77';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(LEFT, entryY);
        ctx.lineTo(W - RIGHT, entryY);
        ctx.stroke();
        ctx.restore();
    }
}

function renderCard(s){
    var dirClass = s.direction === 'LONG' ? 'long' : 'short';
    var qualityClass = s.quality === 'GUCLU' ? 'strong' : 'medium';
    var qualityLabel = s.quality === 'GUCLU' ? 'GUCLU' : 'ORTA';
    var dirLabel = s.direction;

    var retestBadge = s.retest ? '<span class="badge retest">RETEST</span>' : '';

    return '<div class="sig ' + dirClass + '" data-id="' + esc(s.id) + '">'
        + '<div class="sig-head">'
        + '<div class="sig-symbol">' + esc(s.symbol.replace(':USDT','')) + '</div>'
        + '<div class="sig-badges">'
        + '<span class="badge ' + qualityClass + '">' + qualityLabel + '</span>'
        + '<span class="badge dir-' + dirClass + '">' + dirLabel + '</span>'
        + retestBadge
        + '</div>'
        + '</div>'
        + '<div class="sig-chart"><canvas data-chart="' + esc(s.id) + '"></canvas></div>'
        + '<div class="sig-levels">'
        + '<div class="lvl entry"><div class="lbl">Giris</div><div class="val">' + fmt(s.entry) + '</div></div>'
        + '<div class="lvl stop"><div class="lbl">Stop</div><div class="val">' + fmt(s.stop) + '</div></div>'
        + '<div class="lvl rr"><div class="lbl">R:R</div><div class="val">1:' + s.rr3 + '</div></div>'
        + '<div class="lvl tp1"><div class="lbl">TP1</div><div class="val">' + fmt(s.tp1) + '</div></div>'
        + '<div class="lvl tp2"><div class="lbl">TP2</div><div class="val">' + fmt(s.tp2) + '</div></div>'
        + '<div class="lvl tp3"><div class="lbl">TP3</div><div class="val">' + fmt(s.tp3) + '</div></div>'
        + '</div>'
        + '<div class="sig-foot">'
        + '<div class="sig-meta">Vol ' + s.volumeRatio + 'x | Seviye ' + s.levelTouches + 'x | ' + timeAgo(s.timestamp) + '</div>'
        + '<div class="sig-actions">'
        + '<a class="btn-mini tv" href="https://www.tradingview.com/chart/?symbol=BITGET:' + esc(s.symbolTV) + '&interval=120" target="_blank" onclick="event.stopPropagation()">TV</a>'
        + '<button class="btn-mini detail" onclick="event.stopPropagation(); showDetail(\\'' + esc(s.id) + '\\')">Detay</button>'
        + '</div>'
        + '</div>'
        + '</div>';
}

function render(){
    var filtered = signals;
    if(filter === 'GUCLU' || filter === 'ORTA'){
        filtered = signals.filter(function(s){ return s.quality === filter; });
    } else if(filter === 'LONG' || filter === 'SHORT'){
        filtered = signals.filter(function(s){ return s.direction === filter; });
    }

    var el = document.getElementById('signals');
    if(!filtered.length){
        el.innerHTML = '<div class="empty"><div class="empty-icon">📊</div><div class="empty-text">Sinyal yok. Tarama devam ediyor...</div></div>';
        return;
    }

    el.innerHTML = filtered.map(renderCard).join('');

    // Mini chartları çiz
    setTimeout(function(){
        filtered.forEach(function(s){
            var canvas = document.querySelector('canvas[data-chart="' + s.id + '"]');
            if(canvas && s.candles){
                drawMiniChart(canvas, s.candles, s);
            }
        });
    }, 50);
}

function showDetail(id){
    var s = signals.find(function(x){ return x.id === id; });
    if(!s) return;

    document.getElementById('modalTitle').textContent = s.symbol.replace(':USDT','') + ' - ' + s.direction;

    var body = '';

    body += '<div class="detail-grid">';
    body += '<div class="detail-item"><div class="lbl">Kalite</div><div class="val">' + s.quality + ' (' + s.qualityScore + ')</div></div>';
    body += '<div class="detail-item"><div class="lbl">Trend</div><div class="val">' + s.trend + '</div></div>';
    body += '<div class="detail-item"><div class="lbl">Hacim</div><div class="val">' + s.volumeRatio + 'x</div></div>';
    body += '<div class="detail-item"><div class="lbl">RSI</div><div class="val">' + s.rsi + '</div></div>';
    body += '<div class="detail-item"><div class="lbl">Seviye</div><div class="val">' + fmt(s.level) + ' (' + s.levelTouches + 'x)</div></div>';
    body += '<div class="detail-item"><div class="lbl">Kirilim</div><div class="val">' + s.distPct + '%</div></div>';
    body += '<div class="detail-item"><div class="lbl">Body/ATR</div><div class="val">' + s.bodyRatio + '</div></div>';
    body += '<div class="detail-item"><div class="lbl">Retest</div><div class="val">' + (s.retest ? 'EVET' : 'HAYIR') + '</div></div>';
    body += '</div>';

    body += '<h3 style="font-size:13px;color:#7f8b98;text-transform:uppercase;letter-spacing:1px;margin:20px 0 12px">Neden Bu Sinyal?</h3>';
    body += '<ul class="reasons">';
    s.reasons.forEach(function(r){
        body += '<li>' + esc(r) + '</li>';
    });
    body += '</ul>';

    body += '<div style="margin-top:20px;display:flex;gap:8px">';
    body += '<a class="btn-mini tv" style="padding:8px 16px;font-size:12px" href="https://www.tradingview.com/chart/?symbol=BITGET:' + esc(s.symbolTV) + '&interval=120" target="_blank">TradingView\\'de Ac</a>';
    body += '</div>';

    document.getElementById('modalBody').innerHTML = body;
    document.getElementById('detailModal').classList.add('open');
}

function closeModal(){
    document.getElementById('detailModal').classList.remove('open');
}

document.getElementById('detailModal').addEventListener('click', function(e){
    if(e.target.id === 'detailModal') closeModal();
});

function apply(data){
    var newSignals = Array.isArray(data.signals) ? data.signals : [];

    // Yeni sinyal sesi
    if(newSignals.length > lastSignalCount && lastSignalCount > 0){
        playSound();
    }
    lastSignalCount = newSignals.length;

    signals = newSignals;

    document.getElementById('statTotal').textContent = data.stats.total;
    document.getElementById('statStrong').textContent = data.stats.strong;
    document.getElementById('statMedium').textContent = data.stats.medium;
    document.getElementById('statLong').textContent = data.stats.long;
    document.getElementById('statShort').textContent = data.stats.short;

    document.title = (data.stats.total > 0 ? '(' + data.stats.total + ') ' : '') + 'SONNY SIGNAL PRO';

    var msg = (data.scanStatus && data.scanStatus.message) ? data.scanStatus.message : 'Hazir';
    document.getElementById('status').textContent = msg + ' | ' + new Date().toLocaleTimeString('tr-TR');

    render();
}

function connect(){
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    ws = new WebSocket(proto + location.host);
    ws.onopen = function(){
        document.getElementById('status').textContent = 'CANLI';
    };
    ws.onmessage = function(ev){
        try{
            var m = JSON.parse(ev.data);
            if(m.type === 'snapshot' || m.type === 'update') apply(m.data);
        }catch(e){console.error(e);}
    };
    ws.onclose = function(){
        document.getElementById('status').textContent = 'Yenileniyor...';
        setTimeout(connect, 3000);
    };
}

async function scanNow(){
    try{
        document.getElementById('status').textContent = 'Taraniyor...';
        await fetch('/api/scan-now', { method: 'POST' });
    }catch(e){console.error(e);}
}

async function clearSignals(){
    try{
        if(!confirm('Tum sinyalleri silmek istediginize emin misiniz?')) return;
        await fetch('/api/signals', { method: 'DELETE' });
    }catch(e){console.error(e);}
}

// Filter butonları
document.querySelectorAll('.filter').forEach(function(f){
    f.onclick = function(){
        document.querySelectorAll('.filter').forEach(function(x){ x.classList.remove('active'); });
        f.classList.add('active');
        filter = f.getAttribute('data-filter');
        render();
    };
});

fetch('/api/signals').then(function(r){return r.json();}).then(apply).catch(function(){});
connect();
</script>
</body>
</html>`;

app.get('/', (req, res) => res.type('html').send(HTML));

// ============================================================
// START
// ============================================================

async function start() {
    try {
        await exchange.loadMarkets();
        console.log(`Bitget marketleri yuklendi | ${Object.keys(exchange.markets).length} market`);
        await runPreScan();
        await runScan();

        setInterval(function(){ runAll(); }, CONFIG.SCAN_INTERVAL_MS);
        setInterval(function(){ runPreScan(); }, CONFIG.PRESCAN_INTERVAL_MS);

        console.log('SONNY Signal Pro baslatildi.');
    } catch (err) {
        console.error(`[START] ${err.message}`);
        setTimeout(start, 30000);
    }
}

async function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`${signal} alindi; kapaniyor.`);
    wss.clients.forEach(c => c.close());
    wss.close();
    server.close(async function(){
        try { await exchange.close(); } catch (e) {}
        process.exit(0);
    });
    setTimeout(function(){ process.exit(1); }, 10000).unref();
}

process.once('SIGINT', function(){ shutdown('SIGINT'); });
process.once('SIGTERM', function(){ shutdown('SIGTERM'); });

server.listen(PORT, '0.0.0.0', function(){
    console.log(`SONNY Signal Pro PORT=${PORT}`);
    start();
});
