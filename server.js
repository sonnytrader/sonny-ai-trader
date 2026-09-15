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

    ATR_PERIOD: 14,

    // ⭐ ATR BAZLI DINAMIK STOP/TP
    STOP_ATR_MULT: 1.5,      // Stop = seviye + ATR × 1.5
    TP1_ATR_MULT: 2.0,       // TP1 = Giriş + ATR × 2.0
    TP2_ATR_MULT: 3.5,       // TP2 = Giriş + ATR × 3.5
    TP3_ATR_MULT: 5.0,       // TP3 = Giriş + ATR × 5.0

    SIGNAL_COOLDOWN_MS: 4 * 60 * 60 * 1000,

    MIN_24H_VOLUME_USDT: 3000000,
    MAX_TARGETS: 150,

    SCAN_INTERVAL_MS: 3 * 60 * 1000,
    PRESCAN_INTERVAL_MS: 10 * 60 * 1000,
    LIVE_INTERVAL_MS: 5000,
    MARKET_STATUS_INTERVAL_MS: 60 * 1000,
    API_DELAY_MS: 120,

    MAX_SIGNALS_KEPT: 200,
    DEBUG: true
};

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
let marketStatus = { btc: null, eth: null, overall: 'UNKNOWN', updatedAt: 0 };
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
// PIVOT
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
            current = { price: p.price, touches: 1, indices: [p.index] };
            continue;
        }
        const diff = Math.abs(p.price - current.price) / current.price;
        if (diff <= tolerancePct) {
            current.touches++;
            current.indices.push(p.index);
            current.price = (current.price * (current.touches - 1) + p.price) / current.touches;
        } else {
            merged.push(current);
            current = { price: p.price, touches: 1, indices: [p.index] };
        }
    }
    if (current) merged.push(current);
    return merged;
}

// ============================================================
// TREND
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
// MARKET STATUS (BTC + ETH)
// ============================================================

async function updateMarketStatus() {
    try {
        const btc = await getTrend('BTC/USDT:USDT');
        const eth = await getTrend('ETH/USDT:USDT');

        let overall = 'MIXED';
        if (btc.trend === 'BULLISH' && eth.trend === 'BULLISH') overall = 'BULLISH';
        else if (btc.trend === 'BEARISH' && eth.trend === 'BEARISH') overall = 'BEARISH';
        else if (btc.trend === 'BULLISH' || eth.trend === 'BULLISH') overall = 'BULLISH_WEAK';
        else if (btc.trend === 'BEARISH' || eth.trend === 'BEARISH') overall = 'BEARISH_WEAK';

        // BTC/ETH fiyatları
        const tickers = await exchange.fetchTickers(['BTC/USDT:USDT', 'ETH/USDT:USDT']);
        const btcT = tickers['BTC/USDT:USDT'];
        const ethT = tickers['ETH/USDT:USDT'];

        marketStatus = {
            btc: {
                trend: btc.trend,
                price: btcT ? num(btcT.last) : null,
                change24h: btcT ? num(btcT.percentage, 2) : null
            },
            eth: {
                trend: eth.trend,
                price: ethT ? num(ethT.last) : null,
                change24h: ethT ? num(ethT.percentage, 2) : null
            },
            overall,
            updatedAt: Date.now()
        };

        broadcast();
    } catch (err) {
        console.error(`[marketStatus] ${err.message}`);
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

        const priorCandles = candles.slice(0, -1);
        const windowCandles = priorCandles.slice(-CONFIG.PIVOT_WINDOW);

        const pivotHighs = mergeLevels(findPivotHighs(windowCandles), CONFIG.LEVEL_MERGE_PCT);
        const pivotLows = mergeLevels(findPivotLows(windowCandles), CONFIG.LEVEL_MERGE_PCT);

        const resistances = pivotHighs.filter(l => l.touches >= CONFIG.MIN_TOUCHES);
        const supports = pivotLows.filter(l => l.touches >= CONFIG.MIN_TOUCHES);

        const volumes = priorCandles.slice(-20).map(c => Number(c[5])).filter(Number.isFinite);
        const avgVolume = sma(volumes, Math.min(20, volumes.length));
        if (!avgVolume) return null;
        const volumeRatio = volume / avgVolume;

        const currentATR = atr(priorCandles, CONFIG.ATR_PERIOD);
        if (!currentATR || currentATR <= 0) return null;

        const body = Math.abs(close - open);
        const bodyRatio = body / currentATR;

        const rsiValue = rsi(priorCandles.map(c => Number(c[4])), CONFIG.RSI_PERIOD);

        const closes2H = priorCandles.map(c => Number(c[4]));
        const ema21 = ema(closes2H, CONFIG.EMA_FAST);
        const ema50 = ema(closes2H, CONFIG.EMA_SLOW);

        const trendInfo = await getTrend(symbol);
        const trend = trendInfo.trend;

        let candidate = null;

        // LONG adayı
        if (trend === 'BULLISH' && rsiValue != null && rsiValue >= CONFIG.RSI_LONG_MIN) {
            for (const r of resistances) {
                if (r.price < close) {
                    const distPct = pct(close - r.price, r.price);
                    if (distPct >= CONFIG.MIN_BREAKOUT_DISTANCE &&
                        distPct <= CONFIG.MAX_BREAKOUT_DISTANCE) {
                        let retest = false;
                        for (let i = Math.max(1, priorCandles.length - 12);
                             i < priorCandles.length; i++) {
                            const c = priorCandles[i];
                            const cLow = Number(c[3]);
                            const cClose = Number(c[4]);
                            const atLevel = Math.abs(cLow - r.price) / r.price < 0.01;
                            if (atLevel && cClose > r.price) { retest = true; break; }
                        }
                        candidate = {
                            direction: 'LONG',
                            level: r,
                            distPct,
                            retest,
                            emaAlignment: ema21 && ema50 && ema21 > ema50
                        };
                        break;
                    }
                }
            }
        }

        // SHORT adayı
        if (!candidate && trend === 'BEARISH' && rsiValue != null && rsiValue <= CONFIG.RSI_SHORT_MAX) {
            for (const s of supports) {
                if (s.price > close) {
                    const distPct = pct(s.price - close, s.price);
                    if (distPct >= CONFIG.MIN_BREAKOUT_DISTANCE &&
                        distPct <= CONFIG.MAX_BREAKOUT_DISTANCE) {
                        let retest = false;
                        for (let i = Math.max(1, priorCandles.length - 12);
                             i < priorCandles.length; i++) {
                            const c = priorCandles[i];
                            const cHigh = Number(c[2]);
                            const cClose = Number(c[4]);
                            const atLevel = Math.abs(cHigh - s.price) / s.price < 0.01;
                            if (atLevel && cClose < s.price) { retest = true; break; }
                        }
                        candidate = {
                            direction: 'SHORT',
                            level: s,
                            distPct,
                            retest,
                            emaAlignment: ema21 && ema50 && ema21 < ema50
                        };
                        break;
                    }
                }
            }
        }

        if (!candidate) { DEBUG.rejected++; return null; }
        if (volumeRatio < CONFIG.MIN_VOLUME_MULTIPLIER) { DEBUG.rejected++; return null; }
        if (bodyRatio < CONFIG.MIN_BODY_ATR_RATIO) { DEBUG.rejected++; return null; }

        const cooldownKey = `${symbol}_${candidate.direction}`;
        const lastTime = lastSignalTime.get(cooldownKey) || 0;
        if (Date.now() - lastTime < CONFIG.SIGNAL_COOLDOWN_MS) { DEBUG.rejected++; return null; }

        // KALİTE PUANI
        let qualityScore = 0;
        const reasons = [];

        if (candidate.direction === 'LONG' && trend === 'BULLISH') {
            qualityScore += 20;
            reasons.push('4H EMA200 üstünde (BULLISH trend)');
        } else if (candidate.direction === 'SHORT' && trend === 'BEARISH') {
            qualityScore += 20;
            reasons.push('4H EMA200 altında (BEARISH trend)');
        }

        if (candidate.emaAlignment) {
            qualityScore += 15;
            reasons.push(candidate.direction === 'LONG'
                ? 'EMA21 > EMA50 (2H yükseliş)'
                : 'EMA21 < EMA50 (2H düşüş)');
        }

        if (candidate.retest) {
            qualityScore += 25;
            reasons.push('Seviye retest edildi ve tepki verdi');
        }

        if (volumeRatio >= CONFIG.STRONG_VOLUME_MULTIPLIER) {
            qualityScore += 20;
            reasons.push(`Çok güçlü hacim (${volumeRatio.toFixed(2)}x)`);
        } else if (volumeRatio >= CONFIG.MIN_VOLUME_MULTIPLIER) {
            qualityScore += 12;
            reasons.push(`İyi hacim (${volumeRatio.toFixed(2)}x)`);
        }

        if (candidate.level.touches >= 3) {
            qualityScore += 15;
            reasons.push(`Sağlam seviye (${candidate.level.touches}x test edilmiş)`);
        } else if (candidate.level.touches === 2) {
            qualityScore += 8;
            reasons.push(`Orta seviye (2x test edilmiş)`);
        }

        if (bodyRatio >= 0.6) {
            qualityScore += 10;
            reasons.push(`Büyük kırılım mumu (${bodyRatio.toFixed(2)}×ATR)`);
        }

        // Piyasa durumu kontrolü
        if (candidate.direction === 'LONG' && (marketStatus.overall === 'BEARISH' || marketStatus.overall === 'BEARISH_WEAK')) {
            qualityScore -= 15;
            reasons.push('⚠️ Piyasa genel olarak BEARISH (riskli LONG)');
        }
        if (candidate.direction === 'SHORT' && (marketStatus.overall === 'BULLISH' || marketStatus.overall === 'BULLISH_WEAK')) {
            qualityScore -= 15;
            reasons.push('⚠️ Piyasa genel olarak BULLISH (riskli SHORT)');
        }

        let quality = 'ZAYIF';
        if (qualityScore >= 70) quality = 'GUCLU';
        else if (qualityScore >= 45) quality = 'ORTA';
        else { DEBUG.rejected++; return null; }

        if (quality === 'GUCLU') DEBUG.strong++;
        else if (quality === 'ORTA') DEBUG.medium++;

        // ============================================
        // ⭐ ATR BAZLI DINAMIK STOP/TP
        // ============================================
        const entry = close;

        let stop, tp1, tp2, tp3;

        if (candidate.direction === 'LONG') {
            // Stop: kırılan seviyenin ötesi + ATR × 1.5
            stop = candidate.level.price - currentATR * CONFIG.STOP_ATR_MULT;
            tp1 = entry + currentATR * CONFIG.TP1_ATR_MULT;
            tp2 = entry + currentATR * CONFIG.TP2_ATR_MULT;
            tp3 = entry + currentATR * CONFIG.TP3_ATR_MULT;
        } else {
            stop = candidate.level.price + currentATR * CONFIG.STOP_ATR_MULT;
            tp1 = entry - currentATR * CONFIG.TP1_ATR_MULT;
            tp2 = entry - currentATR * CONFIG.TP2_ATR_MULT;
            tp3 = entry - currentATR * CONFIG.TP3_ATR_MULT;
        }

        const risk = Math.abs(entry - stop);
        const rr1 = Math.abs(tp1 - entry) / risk;
        const rr2 = Math.abs(tp2 - entry) / risk;
        const rr3 = Math.abs(tp3 - entry) / risk;

        reasons.push(`ATR bazlı stop (${currentATR.toFixed(6)} × ${CONFIG.STOP_ATR_MULT})`);

        const lastCandles = candles.slice(-80).map(c => ({
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
            currentPrice: num(entry),
            pnlPct: 0,
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
            atr: num(currentATR),
            trend,
            retest: candidate.retest,
            reasons,
            candles: lastCandles,
            candleTime: last[0],
            timestamp: Date.now(),
            updatedAt: Date.now()
        };

        lastSignalTime.set(cooldownKey, Date.now());
        DEBUG.signals++;

        console.log(
            `\x1b[32m[${candidate.direction}][${quality}] ${symbol} @ ${entry.toFixed(6)} | ` +
            `Q=${qualityScore} Level=${candidate.level.price.toFixed(6)} ` +
            `ATR=${currentATR.toFixed(6)} Vol=${volumeRatio.toFixed(2)}x\x1b[0m`
        );

        return signal;

    } catch (err) {
        DEBUG.errors++;
        console.error(`[scanForSignal] ${symbol}: ${err.message}`);
        return null;
    }
}

// ============================================================
// LIVE PRICES
// ============================================================

async function updateLivePrices() {
    if (!signals.length) return;
    try {
        const tickers = await exchange.fetchTickers();
        let changed = false;
        for (const sig of signals) {
            const t = tickers[sig.symbol];
            if (t && Number(t.last) > 0) {
                sig.currentPrice = num(t.last);
                sig.updatedAt = Date.now();
                const entry = Number(sig.entry);
                const current = Number(t.last);
                if (sig.direction === 'LONG') {
                    sig.pnlPct = num(((current - entry) / entry) * 100, 2);
                } else {
                    sig.pnlPct = num(((entry - current) / entry) * 100, 2);
                }
                changed = true;
            }
        }
        if (changed) broadcast();
    } catch (err) {}
}

// ============================================================
// PRESCAN / SCAN
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
        console.log(`RADAR | ${targets.length} coin`);
    } catch (err) {
        console.error(`[runPreScan] ${err.message}`);
    }
}

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

    console.log(`[SCAN DONE] scanned=${DEBUG.scanned} signals=${DEBUG.signals} L=${DEBUG.strong} O=${DEBUG.medium} rejected=${DEBUG.rejected}`);
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
app.get('/api/market-status', (req, res) => res.json({ success: true, marketStatus }));
app.get('/api/debug', (req, res) => res.json({
    success: true, debug: DEBUG, config: CONFIG, targets: targets.length
}));
app.get('/api/health', (req, res) => res.json({
    ok: true, time: Date.now(), targets: targets.length, signals: signals.length
}));
app.delete('/api/signals', (req, res) => {
    signals = [];
    broadcast();
    res.json({ success: true });
});

function snapshot() {
    APP_STATE.updatedAt = Date.now();
    return {
        success: true,
        signals: signals.slice(0, 100),
        marketStatus,
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
body{background:#0a0e14;color:#e9eef5;font-family:-apple-system,Arial,sans-serif;font-size:13px;line-height:1.4;overflow:hidden}
.app{display:flex;flex-direction:column;height:100vh;width:100vw}

/* ========== ÜST BAR - PİYASA DURUMU ========== */
.market-bar{display:flex;align-items:center;justify-content:space-between;padding:10px 20px;background:#0d1219;border-bottom:1px solid #1c2634;flex-shrink:0;gap:16px}
.market-left{display:flex;align-items:center;gap:16px}
.market-brand{font-size:15px;font-weight:800;letter-spacing:0.5px}
.market-brand span{color:#17d7a0}
.market-item{display:flex;align-items:center;gap:8px;padding:6px 12px;background:#0a0e14;border-radius:6px;font-size:11px}
.market-item .sym{font-weight:700;color:#8b97a5}
.market-item .price{font-weight:700;color:#e9eef5}
.market-item .chg{padding:1px 6px;border-radius:3px;font-weight:700;font-size:10px}
.market-item .chg.up{background:rgba(0,255,157,0.15);color:#00ff9d}
.market-item .chg.down{background:rgba(255,56,96,0.15);color:#ff3860}
.market-item .trend{font-size:9px;font-weight:800;padding:2px 6px;border-radius:3px;text-transform:uppercase}
.market-item .trend.bullish{background:rgba(0,255,157,0.15);color:#00ff9d}
.market-item .trend.bearish{background:rgba(255,56,96,0.15);color:#ff3860}
.market-item .trend.sideways{background:rgba(246,196,83,0.15);color:#f6c453}

.market-overall{padding:8px 16px;border-radius:6px;font-size:12px;font-weight:800;letter-spacing:0.5px;text-transform:uppercase}
.market-overall.bullish{background:rgba(0,255,157,0.15);color:#00ff9d;border:1px solid rgba(0,255,157,0.3)}
.market-overall.bearish{background:rgba(255,56,96,0.15);color:#ff3860;border:1px solid rgba(255,56,96,0.3)}
.market-overall.mixed{background:rgba(246,196,83,0.15);color:#f6c453;border:1px solid rgba(246,196,83,0.3)}

.content{display:flex;flex:1;overflow:hidden}

/* ========== SOL PANEL ========== */
.sidebar{width:320px;background:#0d1219;border-right:1px solid #1c2634;display:flex;flex-direction:column;flex-shrink:0}
.side-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;padding:10px 14px;border-bottom:1px solid #1c2634}
.side-stat{background:#0a0e14;border-radius:6px;padding:6px 8px;text-align:center}
.side-stat .lbl{font-size:9px;color:#5e6b7c;text-transform:uppercase;letter-spacing:0.5px}
.side-stat .val{font-size:16px;font-weight:700;margin-top:1px}
.side-stat.long .val{color:#00ff9d}
.side-stat.short .val{color:#ff3860}

.side-actions{padding:10px 14px;border-bottom:1px solid #1c2634}
.btn{width:100%;background:#2a0f14;border:1px solid #5c1a26;color:#ff5c77;padding:7px 10px;border-radius:6px;cursor:pointer;font-size:11px;font-weight:600}
.btn:hover{background:#3a1520}

.side-list{flex:1;overflow-y:auto;padding:6px}
.side-list::-webkit-scrollbar{width:6px}
.side-list::-webkit-scrollbar-thumb{background:#2c3a4f;border-radius:3px}

.sig-card{margin-bottom:6px;padding:10px 12px;border-radius:8px;cursor:pointer;background:#0f1620;border:1px solid #1c2634;border-left:3px solid #2c3a4f;transition:all .15s;position:relative}
.sig-card:hover{background:#141d28;border-color:#2c3a4f}
.sig-card.selected{background:#141d28;border-color:#17d7a0;box-shadow:0 0 0 1px #17d7a0}
.sig-card.long{border-left-color:#00ff9d}
.sig-card.short{border-left-color:#ff3860}
.sig-card.long.selected{box-shadow:0 0 0 1px #00ff9d}
.sig-card.short.selected{box-shadow:0 0 0 1px #ff3860}

.sig-row{display:flex;justify-content:space-between;align-items:center;gap:6px}
.sig-sym{font-size:14px;font-weight:800;letter-spacing:0.3px}
.sig-dir{font-size:10px;font-weight:800;padding:2px 6px;border-radius:4px}
.sig-dir.long{background:rgba(0,255,157,0.15);color:#00ff9d;border:1px solid rgba(0,255,157,0.3)}
.sig-dir.short{background:rgba(255,56,96,0.15);color:#ff3860;border:1px solid rgba(255,56,96,0.3)}

.sig-price{margin-top:6px;display:flex;justify-content:space-between;align-items:center;font-size:11px}
.sig-price .cur{font-weight:700;color:#e9eef5;font-size:13px}
.sig-price .pnl{padding:1px 6px;border-radius:3px;font-weight:700;font-size:10px}
.sig-price .pnl.pos{background:rgba(0,255,157,0.15);color:#00ff9d}
.sig-price .pnl.neg{background:rgba(255,56,96,0.15);color:#ff3860}

.sig-info{margin-top:6px;display:flex;gap:8px;font-size:9px;color:#5e6b7c;flex-wrap:wrap}
.sig-quality{position:absolute;top:8px;right:8px;font-size:9px;font-weight:800;padding:2px 6px;border-radius:3px}
.sig-quality.strong{background:rgba(0,255,157,0.2);color:#00ff9d}
.sig-quality.medium{background:rgba(246,196,83,0.2);color:#f6c453}

/* ========== SAĞ PANEL ========== */
.main{flex:1;display:flex;flex-direction:column;overflow:hidden;background:#0a0e14}
.main-empty{flex:1;display:flex;align-items:center;justify-content:center;color:#5e6b7c;font-size:14px;flex-direction:column;gap:12px}
.main-empty-icon{font-size:48px;opacity:0.3}

.chart-head{padding:14px 20px;border-bottom:1px solid #1c2634;display:flex;justify-content:space-between;align-items:center;background:#0d1219}
.chart-title{display:flex;align-items:baseline;gap:12px}
.chart-sym{font-size:22px;font-weight:800;letter-spacing:0.5px}
.chart-dir{padding:3px 10px;border-radius:5px;font-size:12px;font-weight:800;letter-spacing:0.5px}
.chart-dir.long{background:rgba(0,255,157,0.15);color:#00ff9d;border:1px solid rgba(0,255,157,0.4)}
.chart-dir.short{background:rgba(255,56,96,0.15);color:#ff3860;border:1px solid rgba(255,56,96,0.4)}
.chart-quality{padding:3px 10px;border-radius:5px;font-size:11px;font-weight:800}
.chart-quality.strong{background:rgba(0,255,157,0.2);color:#00ff9d}
.chart-quality.medium{background:rgba(246,196,83,0.2);color:#f6c453}

.chart-actions{display:flex;gap:8px}
.btn-sm{background:#1a2331;border:1px solid #2c3a4f;color:#e9eef5;padding:7px 14px;border-radius:6px;cursor:pointer;font-size:11px;font-weight:600;text-decoration:none;display:inline-block}
.btn-sm:hover{background:#243044}
.btn-sm.tv{background:#2962ff;border-color:#2962ff;color:#fff}
.btn-sm.tv:hover{background:#1e4fd9}

.chart-wrap{flex:1;position:relative;padding:0;background:#070b11}
#mainCanvas{width:100%;height:100%;display:block}

.chart-info{padding:12px 20px;background:#0d1219;border-top:1px solid #1c2634;display:grid;grid-template-columns:repeat(4,1fr);gap:12px;font-size:11px}
.chart-info-item{display:flex;flex-direction:column;gap:2px}
.chart-info-lbl{color:#5e6b7c;text-transform:uppercase;font-size:9px;letter-spacing:0.5px}
.chart-info-val{font-weight:700;font-size:13px;color:#e9eef5}

/* Modal */
.modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:100;align-items:center;justify-content:center;padding:20px}
.modal.open{display:flex}
.modal-content{background:#0f1620;border:1px solid #2c3a4f;border-radius:12px;max-width:700px;width:100%;max-height:90vh;overflow:auto}
.modal-head{padding:16px 20px;border-bottom:1px solid #1a2331;display:flex;justify-content:space-between;align-items:center}
.modal-title{font-size:16px;font-weight:800}
.modal-close{background:transparent;border:none;color:#7f8b98;font-size:24px;cursor:pointer;padding:0;line-height:1}
.modal-body{padding:20px}
.reasons{list-style:none;margin:0}
.reasons li{padding:8px 0;border-bottom:1px solid #1a2331;color:#c5cfdd;font-size:12px;display:flex;gap:10px}
.reasons li:before{content:'✓';color:#00ff9d;font-weight:800;flex-shrink:0}
</style>
</head>
<body>
<div class="app">

<!-- ÜST BAR: PİYASA DURUMU -->
<div class="market-bar">
<div class="market-left">
<div class="market-brand">SONNY <span>SIGNAL</span></div>
<div class="market-item" id="btcItem">
<span class="sym">BTC</span>
<span class="price" id="btcPrice">-</span>
<span class="chg" id="btcChg">-</span>
<span class="trend" id="btcTrend">-</span>
</div>
<div class="market-item" id="ethItem">
<span class="sym">ETH</span>
<span class="price" id="ethPrice">-</span>
<span class="chg" id="ethChg">-</span>
<span class="trend" id="ethTrend">-</span>
</div>
</div>
<div class="market-overall mixed" id="marketOverall">-</div>
</div>

<div class="content">

<!-- SOL PANEL -->
<div class="sidebar">
<div class="side-stats">
<div class="side-stat"><div class="lbl">Toplam</div><div class="val" id="statTotal">0</div></div>
<div class="side-stat long"><div class="lbl">Long</div><div class="val" id="statLong">0</div></div>
<div class="side-stat short"><div class="lbl">Short</div><div class="val" id="statShort">0</div></div>
</div>
<div class="side-actions">
<button class="btn" onclick="clearSignals()">Sinyalleri Temizle</button>
</div>
<div class="side-list" id="signalList"></div>
</div>

<!-- SAĞ PANEL -->
<div class="main">
<div id="mainEmpty" class="main-empty">
<div class="main-empty-icon">📊</div>
<div>Soldan bir sinyal seç</div>
</div>

<div id="mainContent" style="display:none;flex:1;display:none;flex-direction:column">
<div class="chart-head">
<div class="chart-title">
<div class="chart-sym" id="chartSym">-</div>
<div class="chart-dir" id="chartDir">-</div>
<div class="chart-quality" id="chartQuality">-</div>
</div>
<div class="chart-actions">
<a class="btn-sm tv" id="tvLink" target="_blank">TradingView</a>
<button class="btn-sm" onclick="showDetail()">Detay</button>
</div>
</div>

<div class="chart-wrap">
<canvas id="mainCanvas"></canvas>
</div>

<div class="chart-info">
<div class="chart-info-item">
<div class="chart-info-lbl">Giris</div>
<div class="chart-info-val" id="infoEntry">-</div>
</div>
<div class="chart-info-item">
<div class="chart-info-lbl">Stop Loss</div>
<div class="chart-info-val" style="color:#ff3860" id="infoStop">-</div>
</div>
<div class="chart-info-item">
<div class="chart-info-lbl">TP1 / TP2 / TP3</div>
<div class="chart-info-val" id="infoTps">-</div>
</div>
<div class="chart-info-item">
<div class="chart-info-lbl">R:R</div>
<div class="chart-info-val" id="infoRr">-</div>
</div>
</div>
</div>
</div>

</div>
</div>

<div class="modal" id="detailModal">
<div class="modal-content">
<div class="modal-head">
<div class="modal-title" id="modalTitle">Detay</div>
<button class="modal-close" onclick="closeModal()">×</button>
</div>
<div class="modal-body" id="modalBody"></div>
</div>
</div>

<script>
var signals = [];
var selectedId = null;
var ws = null;
var lastSignalCount = 0;
var audioCtx = null;

function fmt(v){
    v = Number(v);
    if(!Number.isFinite(v)) return '-';
    if(v >= 1000) return v.toFixed(2);
    if(v >= 100) return v.toFixed(3);
    if(v >= 1) return v.toFixed(4);
    return v.toFixed(6);
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
    try{
        if(!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        var o = audioCtx.createOscillator();
        var g = audioCtx.createGain();
        o.connect(g); g.connect(audioCtx.destination);
        o.frequency.value = 880;
        g.gain.setValueAtTime(0.08, audioCtx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
        o.start(); o.stop(audioCtx.currentTime + 0.3);
    }catch(e){}
}

// ============ MARKET BAR ============
function renderMarketBar(ms){
    if(!ms || !ms.btc || !ms.eth) return;
    
    var btc = ms.btc;
    var eth = ms.eth;
    
    document.getElementById('btcPrice').textContent = fmt(btc.price);
    var btcChg = document.getElementById('btcChg');
    if(btc.change24h != null){
        btcChg.textContent = (btc.change24h >= 0 ? '+' : '') + btc.change24h + '%';
        btcChg.className = 'chg ' + (btc.change24h >= 0 ? 'up' : 'down');
    }
    var btcT = document.getElementById('btcTrend');
    btcT.textContent = btc.trend === 'BULLISH' ? 'BULL' : btc.trend === 'BEARISH' ? 'BEAR' : 'SIDE';
    btcT.className = 'trend ' + (btc.trend === 'BULLISH' ? 'bullish' : btc.trend === 'BEARISH' ? 'bearish' : 'sideways');

    document.getElementById('ethPrice').textContent = fmt(eth.price);
    var ethChg = document.getElementById('ethChg');
    if(eth.change24h != null){
        ethChg.textContent = (eth.change24h >= 0 ? '+' : '') + eth.change24h + '%';
        ethChg.className = 'chg ' + (eth.change24h >= 0 ? 'up' : 'down');
    }
    var ethT = document.getElementById('ethTrend');
    ethT.textContent = eth.trend === 'BULLISH' ? 'BULL' : eth.trend === 'BEARISH' ? 'BEAR' : 'SIDE';
    ethT.className = 'trend ' + (eth.trend === 'BULLISH' ? 'bullish' : eth.trend === 'BEARISH' ? 'bearish' : 'sideways');

    var overall = document.getElementById('marketOverall');
    var label = 'KARISIK';
    var cls = 'mixed';
    
    if(ms.overall === 'BULLISH'){ label = 'PIYASA BULLISH'; cls = 'bullish'; }
    else if(ms.overall === 'BEARISH'){ label = 'PIYASA BEARISH'; cls = 'bearish'; }
    else if(ms.overall === 'BULLISH_WEAK'){ label = 'BULLISH (ZAYIF)'; cls = 'bullish'; }
    else if(ms.overall === 'BEARISH_WEAK'){ label = 'BEARISH (ZAYIF)'; cls = 'bearish'; }
    
    overall.textContent = label;
    overall.className = 'market-overall ' + cls;
}

// ============ SOL LİSTE ============
function renderList(){
    var el = document.getElementById('signalList');
    if(!signals.length){
        el.innerHTML = '<div style="padding:30px 16px;text-align:center;color:#5e6b7c;font-size:12px">Sinyal yok</div>';
        return;
    }
    el.innerHTML = signals.map(function(s){
        var dirCls = s.direction === 'LONG' ? 'long' : 'short';
        var qualityCls = s.quality === 'GUCLU' ? 'strong' : 'medium';
        var selected = s.id === selectedId ? 'selected' : '';
        var pnlCls = (s.pnlPct || 0) >= 0 ? 'pos' : 'neg';
        var pnlSign = (s.pnlPct || 0) >= 0 ? '+' : '';
        
        return '<div class="sig-card ' + dirCls + ' ' + selected + '" data-id="' + esc(s.id) + '">'
            + '<div class="sig-quality ' + qualityCls + '">' + (s.quality === 'GUCLU' ? 'G' : 'O') + '</div>'
            + '<div class="sig-row">'
            + '<div class="sig-sym">' + esc(s.symbol.replace(':USDT','')) + '</div>'
            + '<div class="sig-dir ' + dirCls + '">' + s.direction + '</div>'
            + '</div>'
            + '<div class="sig-price">'
            + '<span class="cur">' + fmt(s.currentPrice || s.entry) + '</span>'
            + (s.pnlPct != null ? '<span class="pnl ' + pnlCls + '">' + pnlSign + s.pnlPct + '%</span>' : '')
            + '</div>'
            + '<div class="sig-info">'
            + '<span>Vol ' + s.volumeRatio + 'x</span>'
            + '<span>Sev ' + s.levelTouches + 'x</span>'
            + '<span>' + timeAgo(s.timestamp) + '</span>'
            + '</div>'
            + '</div>';
    }).join('');
    
    el.querySelectorAll('.sig-card').forEach(function(card){
        card.onclick = function(){
            selectedId = card.getAttribute('data-id');
            renderList();
            renderMain();
        };
    });
}

// ============ SAĞ BÜYÜK CHART ============
function renderMain(){
    if(!selectedId){
        document.getElementById('mainEmpty').style.display = 'flex';
        document.getElementById('mainContent').style.display = 'none';
        return;
    }
    var s = signals.find(function(x){ return x.id === selectedId; });
    if(!s){
        document.getElementById('mainEmpty').style.display = 'flex';
        document.getElementById('mainContent').style.display = 'none';
        return;
    }

    document.getElementById('mainEmpty').style.display = 'none';
    document.getElementById('mainContent').style.display = 'flex';

    document.getElementById('chartSym').textContent = s.symbol.replace(':USDT','');
    var dirEl = document.getElementById('chartDir');
    dirEl.textContent = s.direction;
    dirEl.className = 'chart-dir ' + (s.direction === 'LONG' ? 'long' : 'short');
    var qEl = document.getElementById('chartQuality');
    qEl.textContent = s.quality;
    qEl.className = 'chart-quality ' + (s.quality === 'GUCLU' ? 'strong' : 'medium');

    document.getElementById('tvLink').href = 'https://www.tradingview.com/chart/?symbol=BITGET:' + s.symbolTV + '&interval=120';
    document.getElementById('infoEntry').textContent = fmt(s.entry);
    document.getElementById('infoStop').textContent = fmt(s.stop);
    document.getElementById('infoTps').textContent = fmt(s.tp1) + ' / ' + fmt(s.tp2) + ' / ' + fmt(s.tp3);
    document.getElementById('infoRr').textContent = '1:' + s.rr1 + ' / 1:' + s.rr2 + ' / 1:' + s.rr3;

    setTimeout(function(){ drawBigChart(s); }, 30);
}

function drawBigChart(s){
    var canvas = document.getElementById('mainCanvas');
    var parent = canvas.parentElement;
    var W = parent.clientWidth;
    var H = parent.clientHeight;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Arka plan (yön rengine göre)
    if(s.direction === 'LONG'){
        ctx.fillStyle = '#08120d';
    } else {
        ctx.fillStyle = '#12080c';
    }
    ctx.fillRect(0, 0, W, H);

    var candles = s.candles;
    if(!candles || !candles.length) return;
    var count = candles.length;

    var minP = Infinity, maxP = -Infinity;
    for(var i = 0; i < candles.length; i++){
        var lo = Number(candles[i].l);
        var hi = Number(candles[i].h);
        if(lo < minP) minP = lo;
        if(hi > maxP) maxP = hi;
    }
    [s.entry, s.stop, s.tp1, s.tp2, s.tp3, s.currentPrice].forEach(function(v){
        if(v == null) return;
        v = Number(v);
        if(v < minP) minP = v;
        if(v > maxP) maxP = v;
    });

    var pad = (maxP - minP) * 0.06 || 1;
    minP -= pad;
    maxP += pad;

    var LEFT = 130;
    var RIGHT = 20;
    var TOP = 20;
    var BOTTOM = 30;
    var PW = W - LEFT - RIGHT;
    var PH = H - TOP - BOTTOM;

    function X(i){ return LEFT + i * PW / (count - 1 || 1); }
    function Y(p){ return TOP + (maxP - p) / (maxP - minP) * PH; }

    // GRID
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for(var g = 0; g <= 5; g++){
        var y = TOP + PH * g / 5;
        ctx.beginPath();
        ctx.moveTo(LEFT, y);
        ctx.lineTo(W - RIGHT, y);
        ctx.stroke();
    }

    // LEVELS
    function drawLevel(price, color, label, dash){
        if(price == null) return;
        var y = Y(price);
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        if(dash) ctx.setLineDash(dash);
        ctx.beginPath();
        ctx.moveTo(LEFT, y);
        ctx.lineTo(W - RIGHT, y);
        ctx.stroke();
        ctx.restore();

        ctx.save();
        ctx.fillStyle = color;
        ctx.font = 'bold 11px Arial';
        ctx.textAlign = 'right';
        ctx.fillText(label + ' ' + fmt(price), LEFT - 10, y + 4);
        ctx.textAlign = 'left';
        ctx.fillText(fmt(price), W - RIGHT + 3, y + 3);
        ctx.restore();
    }

    drawLevel(s.tp3, '#0f8a67', 'TP3', [4,4]);
    drawLevel(s.tp2, '#14b88c', 'TP2', [4,4]);
    drawLevel(s.tp1, '#00ff9d', 'TP1', [4,4]);
    drawLevel(s.stop, '#ff3860', 'STOP', [6,3]);
    drawLevel(s.entry, '#2962ff', 'GIRIS', []);

    // MUM ÇİZİMİ
    var cw = Math.max(2, Math.min(12, PW / count * 0.7));
    for(var c = 0; c < candles.length; c++){
        var k = candles[c];
        var x = X(c);
        var o = Number(k.o), cl = Number(k.c), h = Number(k.h), l = Number(k.l);
        var bull = cl >= o;
        var color = bull ? '#00ff9d' : '#ff3860';
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(x, Y(h));
        ctx.lineTo(x, Y(l));
        ctx.stroke();
        var oY = Y(o), cY = Y(cl);
        ctx.fillRect(x - cw/2, Math.min(oY, cY), cw, Math.max(1, Math.abs(cY - oY)));
    }

    // CANLI FİYAT
    if(s.currentPrice != null){
        var curY = Y(s.currentPrice);
        ctx.save();
        ctx.strokeStyle = '#f6c453';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(LEFT, curY);
        ctx.lineTo(W - RIGHT, curY);
        ctx.stroke();
        
        ctx.fillStyle = '#f6c453';
        ctx.beginPath();
        ctx.arc(W - RIGHT - 5, curY, 5, 0, Math.PI * 2);
        ctx.fill();
        
        ctx.fillStyle = '#f6c453';
        ctx.font = 'bold 10px Arial';
        ctx.textAlign = 'right';
        ctx.fillText('CANLI', LEFT - 10, curY + 4);
        ctx.restore();
    }
}

// ============ DETAY MODAL ============
function showDetail(){
    if(!selectedId) return;
    var s = signals.find(function(x){ return x.id === selectedId; });
    if(!s) return;

    document.getElementById('modalTitle').textContent = s.symbol.replace(':USDT','') + ' - ' + s.direction;

    var body = '';
    body += '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px">';
    body += '<div style="background:#0a0e14;padding:10px;border-radius:6px"><div style="font-size:10px;color:#5e6b7c">KALITE</div><div style="font-size:14px;font-weight:700">' + s.quality + ' (' + s.qualityScore + ')</div></div>';
    body += '<div style="background:#0a0e14;padding:10px;border-radius:6px"><div style="font-size:10px;color:#5e6b7c">TREND</div><div style="font-size:14px;font-weight:700">' + s.trend + '</div></div>';
    body += '<div style="background:#0a0e14;padding:10px;border-radius:6px"><div style="font-size:10px;color:#5e6b7c">HACIM</div><div style="font-size:14px;font-weight:700">' + s.volumeRatio + 'x</div></div>';
    body += '<div style="background:#0a0e14;padding:10px;border-radius:6px"><div style="font-size:10px;color:#5e6b7c">RSI</div><div style="font-size:14px;font-weight:700">' + s.rsi + '</div></div>';
    body += '</div>';
    body += '<h3 style="font-size:12px;color:#7f8b98;text-transform:uppercase;letter-spacing:1px;margin:16px 0 10px">NEDEN BU SINYAL?</h3>';
    body += '<ul class="reasons">';
    s.reasons.forEach(function(r){
        body += '<li>' + esc(r) + '</li>';
    });
    body += '</ul>';

    document.getElementById('modalBody').innerHTML = body;
    document.getElementById('detailModal').classList.add('open');
}

function closeModal(){
    document.getElementById('detailModal').classList.remove('open');
}

document.getElementById('detailModal').addEventListener('click', function(e){
    if(e.target.id === 'detailModal') closeModal();
});

// ============ APPLY ============
function apply(data){
    var newSignals = Array.isArray(data.signals) ? data.signals : [];

    if(newSignals.length > lastSignalCount && lastSignalCount > 0){
        playSound();
    }
    lastSignalCount = newSignals.length;

    signals = newSignals;

    if(data.marketStatus){
        renderMarketBar(data.marketStatus);
    }

    if(!selectedId && signals.length > 0){
        selectedId = signals[0].id;
    }
    if(selectedId && !signals.find(function(x){ return x.id === selectedId; })){
        selectedId = signals.length > 0 ? signals[0].id : null;
    }

    document.getElementById('statTotal').textContent = data.stats.total;
    document.getElementById('statLong').textContent = data.stats.long;
    document.getElementById('statShort').textContent = data.stats.short;

    document.title = (data.stats.total > 0 ? '(' + data.stats.total + ') ' : '') + 'SONNY SIGNAL PRO';

    renderList();
    renderMain();
}

function connect(){
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    ws = new WebSocket(proto + location.host);
    ws.onopen = function(){};
    ws.onmessage = function(ev){
        try{
            var m = JSON.parse(ev.data);
            if(m.type === 'snapshot' || m.type === 'update') apply(m.data);
        }catch(e){console.error(e);}
    };
    ws.onclose = function(){
        setTimeout(connect, 3000);
    };
}

async function clearSignals(){
    if(!confirm('Tum sinyalleri sil?')) return;
    await fetch('/api/signals', { method: 'DELETE' });
    selectedId = null;
    renderList();
    renderMain();
}

window.addEventListener('resize', function(){
    if(selectedId) renderMain();
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
        
        await updateMarketStatus();
        await runPreScan();
        await runScan();

        setInterval(function(){ runAll(); }, CONFIG.SCAN_INTERVAL_MS);
        setInterval(function(){ updateLivePrices(); }, CONFIG.LIVE_INTERVAL_MS);
        setInterval(function(){ updateMarketStatus(); }, CONFIG.MARKET_STATUS_INTERVAL_MS);
        setInterval(function(){ runPreScan(); }, CONFIG.PRESCAN_INTERVAL_MS);

        console.log('SONNY Signal Pro v3 baslatildi.');
    } catch (err) {
        console.error(`[START] ${err.message}`);
        setTimeout(start, 30000);
    }
}

async function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`${signal} alindi; kapaniyor.`);

    if (scanRunning) {
        console.log('Tarama devam ediyor, bekleniyor...');
        const start = Date.now();
        while (scanRunning && Date.now() - start < 25000) {
            await sleep(500);
        }
    }

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
    console.log(`SONNY Signal Pro v3 PORT=${PORT}`);
    start();
});
