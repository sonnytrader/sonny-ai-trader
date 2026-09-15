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
    // ⭐ SCALP 15 DAKİKA
    TIMEFRAME: '15m',
    TREND_TIMEFRAME: '1h',
    CANDLE_LIMIT: 60,

    // Son 20 mumun en yükseği/düşüğü
    BREAKOUT_LOOKBACK: 20,

    // Trend filtresi
    EMA_TREND: 200,

    // Hacim onayı
    MIN_VOLUME_MULTIPLIER: 2.0,

    // Kırılım minimum mesafesi (kapanış, kırılan seviyeyi %0.05 geçmeli)
    MIN_BREAKOUT_BUFFER: 0.0005,

    // Fiyat kırılan seviyeden bu kadar uzaklaşırsa sinyal iptal
    MAX_DISTANCE_FROM_LEVEL: 0.5, // %0.5

    // Sinyal geçerlilik süresi
    SIGNAL_VALID_MS: 30 * 60 * 1000, // 30 dakika

    // Cooldown (aynı coin+yön için)
    SIGNAL_COOLDOWN_MS: 30 * 60 * 1000, // 30 dakika

    // ATR bazlı stop
    ATR_PERIOD: 14,
    STOP_ATR_MULT: 0.8,   // Kısa stop (scalp)

    // TP
    TP1_RR: 1.5,
    TP2_RR: 3.0,

    // RSI
    RSI_PERIOD: 14,
    RSI_LONG_MIN: 50,
    RSI_SHORT_MAX: 50,

    // Coin filtresi
    MIN_24H_VOLUME_USDT: 5000000, // 5M USDT (likit coinler)
    MAX_TARGETS: 150,

    // Döngüler
    SCAN_INTERVAL_MS: 2 * 60 * 1000,     // 2 dakikada bir tara
    PRESCAN_INTERVAL_MS: 10 * 60 * 1000, // 10 dakikada bir coin listesi
    LIVE_INTERVAL_MS: 5000,              // 5 saniyede fiyat güncelle
    MARKET_STATUS_INTERVAL_MS: 60 * 1000,// 1 dakikada piyasa durumu
    API_DELAY_MS: 100,

    MAX_SIGNALS_KEPT: 100,
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
let marketStatus = { btc: null, eth: null, overall: 'UNKNOWN', score: 0, updatedAt: 0 };
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
    scanned: 0, signals: 0, long: 0, short: 0,
    rejected: 0, errors: 0, expired: 0
};

// ============================================================
// HELPERS
// ============================================================

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function num(v, d = 8) {
    const n = Number(v);
    return Number.isFinite(n) ? Number(n.toFixed(d)) : null;
}

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
// TREND (1H EMA200)
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
// MARKET STATUS
// ============================================================

async function updateMarketStatus() {
    try {
        const btc = await getTrend('BTC/USDT:USDT');
        const eth = await getTrend('ETH/USDT:USDT');

        const tickers = await exchange.fetchTickers(['BTC/USDT:USDT', 'ETH/USDT:USDT']);
        const btcT = tickers['BTC/USDT:USDT'];
        const ethT = tickers['ETH/USDT:USDT'];

        const btcChg = btcT ? Number(btcT.percentage) : 0;
        const ethChg = ethT ? Number(ethT.percentage) : 0;

        let score = 0;
        if (btc.trend === 'BULLISH') score += 2;
        else if (btc.trend === 'BEARISH') score -= 2;
        if (eth.trend === 'BULLISH') score += 2;
        else if (eth.trend === 'BEARISH') score -= 2;

        if (Number.isFinite(btcChg)) {
            if (btcChg > 2) score += 2;
            else if (btcChg > 0.5) score += 1;
            else if (btcChg < -2) score -= 2;
            else if (btcChg < -0.5) score -= 1;
        }
        if (Number.isFinite(ethChg)) {
            if (ethChg > 2) score += 2;
            else if (ethChg > 0.5) score += 1;
            else if (ethChg < -2) score -= 2;
            else if (ethChg < -0.5) score -= 1;
        }

        let overall;
        if (score >= 5) overall = 'BULLISH';
        else if (score >= 2) overall = 'BULLISH_WEAK';
        else if (score <= -5) overall = 'BEARISH';
        else if (score <= -2) overall = 'BEARISH_WEAK';
        else overall = 'MIXED';

        marketStatus = {
            btc: {
                trend: btc.trend,
                price: btcT ? num(btcT.last) : null,
                change24h: Number.isFinite(btcChg) ? num(btcChg, 2) : null
            },
            eth: {
                trend: eth.trend,
                price: ethT ? num(ethT.last) : null,
                change24h: Number.isFinite(ethChg) ? num(ethChg, 2) : null
            },
            overall,
            score,
            updatedAt: Date.now()
        };

        broadcast();
    } catch (err) {
        console.error(`[marketStatus] ${err.message}`);
    }
}

// ============================================================
// SCALP SINYAL ÜRETİMİ
// ============================================================

async function scanForSignal(symbol) {
    DEBUG.scanned++;
    try {
        const raw = await exchange.fetchOHLCV(
            symbol, CONFIG.TIMEFRAME, undefined, CONFIG.CANDLE_LIMIT
        );
        const candles = closedCandles(raw);
        if (candles.length < CONFIG.BREAKOUT_LOOKBACK + 5) return null;

        const last = candles[candles.length - 1];
        const close = Number(last[4]);
        const open = Number(last[1]);
        const high = Number(last[2]);
        const low = Number(last[3]);
        const volume = Number(last[5]);
        if (![close, open, high, low, volume].every(Number.isFinite)) return null;

        // Son BREAKOUT_LOOKBACK mumun en yüksek/düşüğü (bu mum hariç)
        const priorCandles = candles.slice(0, -1);
        const lookback = priorCandles.slice(-CONFIG.BREAKOUT_LOOKBACK);

        const highestHigh = Math.max(...lookback.map(c => Number(c[2])));
        const lowestLow = Math.min(...lookback.map(c => Number(c[3])));

        // Hacim
        const volumes = priorCandles.slice(-20).map(c => Number(c[5])).filter(Number.isFinite);
        const avgVolume = sma(volumes, Math.min(20, volumes.length));
        if (!avgVolume) return null;
        const volumeRatio = volume / avgVolume;

        // RSI
        const rsiValue = rsi(priorCandles.map(c => Number(c[4])), CONFIG.RSI_PERIOD);

        // ATR
        const currentATR = atr(priorCandles, CONFIG.ATR_PERIOD);
        if (!currentATR || currentATR <= 0) return null;

        // Trend
        const trendInfo = await getTrend(symbol);
        const trend = trendInfo.trend;

        let direction = null;
        let level = null;

        // ============================================
        // LONG: Son 20 mumun en yükseğini kırdı mı?
        // ============================================
        const longBuffer = highestHigh * (1 + CONFIG.MIN_BREAKOUT_BUFFER);
        if (close > longBuffer) {
            direction = 'LONG';
            level = highestHigh;
        }

        // ============================================
        // SHORT: Son 20 mumun en düşüğünü kırdı mı?
        // ============================================
        const shortBuffer = lowestLow * (1 - CONFIG.MIN_BREAKOUT_BUFFER);
        if (!direction && close < shortBuffer) {
            direction = 'SHORT';
            level = lowestLow;
        }

        if (!direction || !level) { DEBUG.rejected++; return null; }

        // Trend filtresi
        if (direction === 'LONG' && trend === 'BEARISH') { DEBUG.rejected++; return null; }
        if (direction === 'SHORT' && trend === 'BULLISH') { DEBUG.rejected++; return null; }

        // Hacim filtresi
        if (volumeRatio < CONFIG.MIN_VOLUME_MULTIPLIER) { DEBUG.rejected++; return null; }

        // RSI filtresi
        if (direction === 'LONG' && rsiValue != null && rsiValue < CONFIG.RSI_LONG_MIN) { DEBUG.rejected++; return null; }
        if (direction === 'SHORT' && rsiValue != null && rsiValue > CONFIG.RSI_SHORT_MAX) { DEBUG.rejected++; return null; }

        // Kırılım mesafesi çok büyük olmasın (fiyat kaçmış olmasın)
        const distPct = direction === 'LONG'
            ? ((close - level) / level) * 100
            : ((level - close) / level) * 100;

        if (distPct > CONFIG.MAX_DISTANCE_FROM_LEVEL) { DEBUG.rejected++; return null; }

        // Cooldown
        const cooldownKey = `${symbol}_${direction}`;
        const lastTime = lastSignalTime.get(cooldownKey) || 0;
        if (Date.now() - lastTime < CONFIG.SIGNAL_COOLDOWN_MS) { DEBUG.rejected++; return null; }

        // ============================================
        // GİRİŞ / STOP / TP
        // ============================================
        const entry = close;
        const stopDistance = currentATR * CONFIG.STOP_ATR_MULT;

        let stop, tp1, tp2;
        if (direction === 'LONG') {
            stop = level - stopDistance;
            const risk = entry - stop;
            tp1 = entry + risk * CONFIG.TP1_RR;
            tp2 = entry + risk * CONFIG.TP2_RR;
        } else {
            stop = level + stopDistance;
            const risk = stop - entry;
            tp1 = entry - risk * CONFIG.TP1_RR;
            tp2 = entry - risk * CONFIG.TP2_RR;
        }

        const risk = Math.abs(entry - stop);
        const rr1 = Math.abs(tp1 - entry) / risk;
        const rr2 = Math.abs(tp2 - entry) / risk;

        const reasons = [];
        reasons.push(`Son ${CONFIG.BREAKOUT_LOOKBACK} mumun ${direction === 'LONG' ? 'direnci' : 'destegi'} kirildi (${num(level)})`);
        reasons.push(`Hacim ${volumeRatio.toFixed(2)}x ortalama (güçlü)`);
        reasons.push(`Trend ${trend} (1H EMA200)`);
        if (rsiValue != null) reasons.push(`RSI ${rsiValue.toFixed(1)}`);
        reasons.push(`Kirilim mesafesi %${distPct.toFixed(2)}`);

        const lastCandles = candles.slice(-60).map(c => ({
            t: c[0],
            o: num(c[1]),
            h: num(c[2]),
            l: num(c[3]),
            c: num(c[4])
        }));

        const signal = {
            id: `${symbol.replace(/[^A-Z0-9]/gi, '')}_${direction}_${Date.now()}`,
            symbol,
            symbolTV: symbol.replace('/USDT:USDT', 'USDT.P'),
            direction,
            entry: num(entry),
            currentPrice: num(entry),
            pnlPct: 0,
            stop: num(stop),
            tp1: num(tp1),
            tp2: num(tp2),
            rr1: num(rr1, 2),
            rr2: num(rr2, 2),
            level: num(level),
            distPct: num(distPct, 2),
            volumeRatio: num(volumeRatio, 2),
            rsi: num(rsiValue, 1),
            atr: num(currentATR),
            trend,
            status: 'ACTIVE',       // ⭐ Sinyal durumu
            closeReason: null,
            reasons,
            candles: lastCandles,
            candleTime: last[0],
            timestamp: Date.now(),
            updatedAt: Date.now(),
            expiresAt: Date.now() + CONFIG.SIGNAL_VALID_MS
        };

        lastSignalTime.set(cooldownKey, Date.now());
        DEBUG.signals++;
        if (direction === 'LONG') DEBUG.long++;
        else DEBUG.short++;

        console.log(
            `\x1b[32m[${direction}] ${symbol} @ ${entry.toFixed(6)} | ` +
            `Level=${level.toFixed(6)} Vol=${volumeRatio.toFixed(2)}x ` +
            `RSI=${rsiValue ? rsiValue.toFixed(1) : '-'} Dist=%${distPct.toFixed(2)}\x1b[0m`
        );

        return signal;

    } catch (err) {
        DEBUG.errors++;
        console.error(`[scanForSignal] ${symbol}: ${err.message}`);
        return null;
    }
}

// ============================================================
// LIVE PRICES + STATUS UPDATE
// ============================================================

async function updateLivePrices() {
    if (!signals.length) return;
    try {
        const tickers = await exchange.fetchTickers();
        const now = Date.now();
        let changed = false;

        for (const sig of signals) {
            if (sig.status !== 'ACTIVE') continue;

            const t = tickers[sig.symbol];
            if (!t || !Number(t.last)) continue;

            sig.currentPrice = num(t.last);
            sig.updatedAt = now;

            const entry = Number(sig.entry);
            const current = Number(t.last);
            const stop = Number(sig.stop);
            const tp1 = Number(sig.tp1);

            // PnL
            if (sig.direction === 'LONG') {
                sig.pnlPct = num(((current - entry) / entry) * 100, 2);
            } else {
                sig.pnlPct = num(((entry - current) / entry) * 100, 2);
            }

            // ============================================
            // DURUM KONTROLÜ
            // ============================================
            if (sig.direction === 'LONG') {
                if (current <= stop) {
                    sig.status = 'STOPPED';
                    sig.closeReason = 'STOP oldu';
                    sig.closedAt = now;
                    DEBUG.expired++;
                } else if (current >= tp1) {
                    sig.status = 'TARGET_HIT';
                    sig.closeReason = 'TP1 hedefine ulasti';
                    sig.closedAt = now;
                } else if (current > entry * 1.008) {
                    sig.status = 'MISSED';
                    sig.closeReason = 'Fiyat girişten +0.8% uzaklaştı';
                    sig.closedAt = now;
                }
            } else {
                if (current >= stop) {
                    sig.status = 'STOPPED';
                    sig.closeReason = 'STOP oldu';
                    sig.closedAt = now;
                    DEBUG.expired++;
                } else if (current <= tp1) {
                    sig.status = 'TARGET_HIT';
                    sig.closeReason = 'TP1 hedefine ulasti';
                    sig.closedAt = now;
                } else if (current < entry * 0.992) {
                    sig.status = 'MISSED';
                    sig.closeReason = 'Fiyat girişten -0.8% uzaklaştı';
                    sig.closedAt = now;
                }
            }

            // Süre kontrolü
            if (sig.status === 'ACTIVE' && now > sig.expiresAt) {
                sig.status = 'EXPIRED';
                sig.closeReason = '30 dakika geçti (süre doldu)';
                sig.closedAt = now;
                DEBUG.expired++;
            }

            changed = true;
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
        console.log(`RADAR | ${targets.length} coin (min vol: $${(CONFIG.MIN_24H_VOLUME_USDT/1000000).toFixed(1)}M)`);
    } catch (err) {
        console.error(`[runPreScan] ${err.message}`);
    }
}

async function runScan() {
    if (scanRunning) return;
    scanRunning = true;
    DEBUG.scanned = 0;
    DEBUG.rejected = 0;

    APP_STATE.scanStatus = { message: `15dk tarama: ${targets.length} coin`, isScanning: true };
    broadcast();

    let newSignals = 0;

    try {
        for (const symbol of targets) {
            if (isShuttingDown) break;
            const signal = await scanForSignal(symbol);
            if (signal) {
                // Aynı coin+zıt yön sinyali varsa eski olanı sil
                signals = signals.filter(s =>
                    !(s.symbol === signal.symbol && s.direction !== signal.direction && s.status === 'ACTIVE')
                );
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

    console.log(`[SCAN DONE] scanned=${DEBUG.scanned} new=${newSignals} total=${signals.length} L=${DEBUG.long} S=${DEBUG.short} rejected=${DEBUG.rejected}`);
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
    const active = signals.filter(s => s.status === 'ACTIVE');
    return {
        success: true,
        signals: signals.slice(0, 100),
        marketStatus,
        scanStatus: APP_STATE.scanStatus,
        stats: {
            total: signals.length,
            active: active.length,
            long: active.filter(s => s.direction === 'LONG').length,
            short: active.filter(s => s.direction === 'SHORT').length,
            targetHit: signals.filter(s => s.status === 'TARGET_HIT').length,
            stopped: signals.filter(s => s.status === 'STOPPED').length,
            missed: signals.filter(s => s.status === 'MISSED').length
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
<title>SONNY SCALP 15M</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0e14;color:#e9eef5;font-family:-apple-system,Arial,sans-serif;font-size:13px;line-height:1.4;overflow:hidden}
.app{display:flex;flex-direction:column;height:100vh;width:100vw}

/* ÜST BAR */
.market-bar{display:flex;align-items:center;justify-content:space-between;padding:10px 20px;background:#0d1219;border-bottom:1px solid #1c2634;flex-shrink:0;gap:16px}
.market-left{display:flex;align-items:center;gap:16px}
.market-brand{font-size:15px;font-weight:800;letter-spacing:0.5px}
.market-brand span{color:#17d7a0}
.market-badge{font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px;background:#2a2410;color:#f6c453;margin-left:6px}
.market-item{display:flex;align-items:center;gap:8px;padding:6px 12px;background:#0a0e14;border-radius:6px;font-size:11px}
.market-item .sym{font-weight:700;color:#8b97a5}
.market-item .price{font-weight:700;color:#e9eef5}
.market-item .chg{padding:1px 6px;border-radius:3px;font-weight:700;font-size:10px}
.market-item .chg.up{background:rgba(0,255,157,0.15);color:#00ff9d}
.market-item .chg.down{background:rgba(255,56,96,0.15);color:#ff3860}
.market-item .trend{font-size:9px;font-weight:800;padding:2px 6px;border-radius:3px}
.market-item .trend.bullish{background:rgba(0,255,157,0.15);color:#00ff9d}
.market-item .trend.bearish{background:rgba(255,56,96,0.15);color:#ff3860}
.market-item .trend.sideways{background:rgba(246,196,83,0.15);color:#f6c453}

.market-overall{padding:8px 16px;border-radius:6px;font-size:12px;font-weight:800;letter-spacing:0.5px;display:flex;align-items:center;gap:8px}
.market-overall.bullish{background:rgba(0,255,157,0.15);color:#00ff9d;border:1px solid rgba(0,255,157,0.3)}
.market-overall.bearish{background:rgba(255,56,96,0.15);color:#ff3860;border:1px solid rgba(255,56,96,0.3)}
.market-overall.mixed{background:rgba(246,196,83,0.15);color:#f6c453;border:1px solid rgba(246,196,83,0.3)}
.market-score{font-size:10px;opacity:0.7}

.content{display:flex;flex:1;overflow:hidden}

/* SOL PANEL */
.sidebar{width:340px;background:#0d1219;border-right:1px solid #1c2634;display:flex;flex-direction:column;flex-shrink:0}
.side-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;padding:10px 14px;border-bottom:1px solid #1c2634}
.side-stat{background:#0a0e14;border-radius:6px;padding:6px 8px;text-align:center}
.side-stat .lbl{font-size:9px;color:#5e6b7c;text-transform:uppercase;letter-spacing:0.5px}
.side-stat .val{font-size:16px;font-weight:700;margin-top:1px}
.side-stat.active .val{color:#17d7a0}
.side-stat.long .val{color:#00ff9d}
.side-stat.short .val{color:#ff3860}

.side-actions{padding:10px 14px;border-bottom:1px solid #1c2634}
.btn{width:100%;background:#2a0f14;border:1px solid #5c1a26;color:#ff5c77;padding:7px 10px;border-radius:6px;cursor:pointer;font-size:11px;font-weight:600}
.btn:hover{background:#3a1520}

.side-list{flex:1;overflow-y:auto;padding:6px}
.side-list::-webkit-scrollbar{width:6px}
.side-list::-webkit-scrollbar-thumb{background:#2c3a4f;border-radius:3px}

.section-label{padding:10px 12px 6px;font-size:10px;font-weight:800;color:#5e6b7c;text-transform:uppercase;letter-spacing:1px}

.sig-card{margin-bottom:6px;padding:10px 12px;border-radius:8px;cursor:pointer;background:#0f1620;border:1px solid #1c2634;border-left:3px solid #2c3a4f;transition:all .15s;position:relative}
.sig-card:hover{background:#141d28}
.sig-card.selected{background:#141d28;border-color:#17d7a0;box-shadow:0 0 0 1px #17d7a0}
.sig-card.long{border-left-color:#00ff9d}
.sig-card.short{border-left-color:#ff3860}
.sig-card.long.selected{box-shadow:0 0 0 1px #00ff9d}
.sig-card.short.selected{box-shadow:0 0 0 1px #ff3860}
.sig-card.closed{opacity:0.4}
.sig-card.closed .sig-sym{text-decoration:line-through}

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

.sig-status{position:absolute;top:8px;right:8px;font-size:9px;font-weight:800;padding:2px 6px;border-radius:3px}
.sig-status.active{background:rgba(0,255,157,0.2);color:#00ff9d}
.sig-status.hit{background:rgba(0,255,157,0.3);color:#00ff9d}
.sig-status.stopped{background:rgba(255,56,96,0.3);color:#ff3860}
.sig-status.missed{background:rgba(246,196,83,0.2);color:#f6c453}
.sig-status.expired{background:rgba(94,107,124,0.3);color:#8b97a5}

/* SAĞ PANEL */
.main{flex:1;display:flex;flex-direction:column;overflow:hidden;background:#0a0e14}
.main-empty{flex:1;display:flex;align-items:center;justify-content:center;color:#5e6b7c;font-size:14px;flex-direction:column;gap:12px}
.main-empty-icon{font-size:48px;opacity:0.3}

.chart-head{padding:14px 20px;border-bottom:1px solid #1c2634;display:flex;justify-content:space-between;align-items:center;background:#0d1219}
.chart-title{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
.chart-sym{font-size:22px;font-weight:800;letter-spacing:0.5px}
.chart-dir{padding:3px 10px;border-radius:5px;font-size:12px;font-weight:800;letter-spacing:0.5px}
.chart-dir.long{background:rgba(0,255,157,0.15);color:#00ff9d;border:1px solid rgba(0,255,157,0.4)}
.chart-dir.short{background:rgba(255,56,96,0.15);color:#ff3860;border:1px solid rgba(255,56,96,0.4)}
.chart-status{padding:3px 10px;border-radius:5px;font-size:11px;font-weight:800}
.chart-status.active{background:rgba(0,255,157,0.2);color:#00ff9d}
.chart-status.hit{background:rgba(0,255,157,0.3);color:#00ff9d}
.chart-status.stopped{background:rgba(255,56,96,0.3);color:#ff3860}
.chart-status.missed{background:rgba(246,196,83,0.2);color:#f6c453}
.chart-status.expired{background:rgba(94,107,124,0.3);color:#8b97a5}

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

<div class="market-bar">
<div class="market-left">
<div class="market-brand">SONNY <span>SCALP</span> <span class="market-badge">15M</span></div>
<div class="market-item">
<span class="sym">BTC</span>
<span class="price" id="btcPrice">-</span>
<span class="chg" id="btcChg">-</span>
<span class="trend" id="btcTrend">-</span>
</div>
<div class="market-item">
<span class="sym">ETH</span>
<span class="price" id="ethPrice">-</span>
<span class="chg" id="ethChg">-</span>
<span class="trend" id="ethTrend">-</span>
</div>
</div>
<div class="market-overall mixed" id="marketOverall">-</div>
</div>

<div class="content">

<div class="sidebar">
<div class="side-stats">
<div class="side-stat active"><div class="lbl">Aktif</div><div class="val" id="statActive">0</div></div>
<div class="side-stat long"><div class="lbl">Long</div><div class="val" id="statLong">0</div></div>
<div class="side-stat short"><div class="lbl">Short</div><div class="val" id="statShort">0</div></div>
</div>
<div class="side-actions">
<button class="btn" onclick="clearSignals()">Sinyalleri Temizle</button>
</div>
<div class="side-list" id="signalList"></div>
</div>

<div class="main">
<div id="mainEmpty" class="main-empty">
<div class="main-empty-icon">⚡</div>
<div>Soldan bir sinyal seç</div>
</div>

<div id="mainContent" style="display:none;flex:1;display:none;flex-direction:column">
<div class="chart-head">
<div class="chart-title">
<div class="chart-sym" id="chartSym">-</div>
<div class="chart-dir" id="chartDir">-</div>
<div class="chart-status active" id="chartStatus">-</div>
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
<div class="chart-info-lbl">TP1 / TP2</div>
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
var lastActiveCount = 0;
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
    return h + ' sa';
}

function playSound(){
    try{
        if(!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        var o = audioCtx.createOscillator();
        var g = audioCtx.createGain();
        o.connect(g); g.connect(audioCtx.destination);
        o.frequency.value = 880;
        g.gain.setValueAtTime(0.1, audioCtx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.35);
        o.start(); o.stop(audioCtx.currentTime + 0.35);
    }catch(e){}
}

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
    
    overall.innerHTML = label + '<span class="market-score">SKOR ' + (ms.score >= 0 ? '+' : '') + ms.score + '</span>';
    overall.className = 'market-overall ' + cls;
}

function getStatusBadge(status){
    if(status === 'ACTIVE') return '<span class="sig-status active">AKTIF</span>';
    if(status === 'TARGET_HIT') return '<span class="sig-status hit">HEDEF ✓</span>';
    if(status === 'STOPPED') return '<span class="sig-status stopped">STOP ✗</span>';
    if(status === 'MISSED') return '<span class="sig-status missed">KACIRILDI</span>';
    if(status === 'EXPIRED') return '<span class="sig-status expired">SURESI DOLDU</span>';
    return '';
}

function renderCard(s){
    var dirCls = s.direction === 'LONG' ? 'long' : 'short';
    var selected = s.id === selectedId ? 'selected' : '';
    var closed = s.status !== 'ACTIVE' ? 'closed' : '';
    var pnlCls = (s.pnlPct || 0) >= 0 ? 'pos' : 'neg';
    var pnlSign = (s.pnlPct || 0) >= 0 ? '+' : '';
    
    return '<div class="sig-card ' + dirCls + ' ' + selected + ' ' + closed + '" data-id="' + esc(s.id) + '">'
        + getStatusBadge(s.status)
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
        + '<span>RSI ' + (s.rsi || '-') + '</span>'
        + '<span>' + timeAgo(s.timestamp) + '</span>'
        + '</div>'
        + '</div>';
}

function renderList(){
    var el = document.getElementById('signalList');
    if(!signals.length){
        el.innerHTML = '<div style="padding:30px 16px;text-align:center;color:#5e6b7c;font-size:12px">Sinyal yok</div>';
        return;
    }

    var active = signals.filter(s => s.status === 'ACTIVE');
    var closed = signals.filter(s => s.status !== 'ACTIVE');

    var html = '';
    if(active.length > 0){
        html += '<div class="section-label">🟢 AKTIF (' + active.length + ')</div>';
        html += active.map(renderCard).join('');
    }
    if(closed.length > 0){
        html += '<div class="section-label">📁 KAPANANLAR (' + closed.length + ')</div>';
        html += closed.slice(0, 20).map(renderCard).join('');
    }

    el.innerHTML = html;
    
    el.querySelectorAll('.sig-card').forEach(function(card){
        card.onclick = function(){
            selectedId = card.getAttribute('data-id');
            renderList();
            renderMain();
        };
    });
}

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
    var statusEl = document.getElementById('chartStatus');
    statusEl.textContent = s.status === 'ACTIVE' ? 'AKTIF' :
                           s.status === 'TARGET_HIT' ? 'HEDEF ✓' :
                           s.status === 'STOPPED' ? 'STOP ✗' :
                           s.status === 'MISSED' ? 'KACIRILDI' : 'SURESI DOLDU';
    statusEl.className = 'chart-status ' + (s.status === 'ACTIVE' ? 'active' :
                                            s.status === 'TARGET_HIT' ? 'hit' :
                                            s.status === 'STOPPED' ? 'stopped' :
                                            s.status === 'MISSED' ? 'missed' : 'expired');

    document.getElementById('tvLink').href = 'https://www.tradingview.com/chart/?symbol=BITGET:' + s.symbolTV + '&interval=15';
    document.getElementById('infoEntry').textContent = fmt(s.entry);
    document.getElementById('infoStop').textContent = fmt(s.stop);
    document.getElementById('infoTps').textContent = fmt(s.tp1) + ' / ' + fmt(s.tp2);
    document.getElementById('infoRr').textContent = '1:' + s.rr1 + ' / 1:' + s.rr2;

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
    [s.entry, s.stop, s.tp1, s.tp2, s.level, s.currentPrice].forEach(function(v){
        if(v == null) return;
        v = Number(v);
        if(v < minP) minP = v;
        if(v > maxP) maxP = v;
    });

    var pad = (maxP - minP) * 0.06 || 1;
    minP -= pad;
    maxP += pad;

    var LEFT = 130, RIGHT = 20, TOP = 20, BOTTOM = 30;
    var PW = W - LEFT - RIGHT;
    var PH = H - TOP - BOTTOM;

    function X(i){ return LEFT + i * PW / (count - 1 || 1); }
    function Y(p){ return TOP + (maxP - p) / (maxP - minP) * PH; }

    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for(var g = 0; g <= 5; g++){
        var y = TOP + PH * g / 5;
        ctx.beginPath();
        ctx.moveTo(LEFT, y);
        ctx.lineTo(W - RIGHT, y);
        ctx.stroke();
    }

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

    // Kırılan seviye (gri kesikli)
    drawLevel(s.level, '#8b97a5', 'SEVIYE', [3,3]);
    drawLevel(s.tp2, '#0f8a67', 'TP2', [4,4]);
    drawLevel(s.tp1, '#00ff9d', 'TP1', [4,4]);
    drawLevel(s.stop, '#ff3860', 'STOP', [6,3]);
    drawLevel(s.entry, '#2962ff', 'GIRIS', []);

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

function showDetail(){
    if(!selectedId) return;
    var s = signals.find(function(x){ return x.id === selectedId; });
    if(!s) return;

    document.getElementById('modalTitle').textContent = s.symbol.replace(':USDT','') + ' - ' + s.direction;

    var body = '';
    body += '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px">';
    body += '<div style="background:#0a0e14;padding:10px;border-radius:6px"><div style="font-size:10px;color:#5e6b7c">DURUM</div><div style="font-size:14px;font-weight:700">' + s.status + '</div></div>';
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
    
    if(s.closeReason){
        body += '<div style="margin-top:16px;padding:10px;background:#0a0e14;border-radius:6px;color:#8b97a5;font-size:12px">';
        body += '<b style="color:#e9eef5">Kapanış:</b> ' + esc(s.closeReason);
        body += '</div>';
    }

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

    var activeCount = newSignals.filter(function(s){ return s.status === 'ACTIVE'; }).length;
    
    // Yeni AKTİF sinyal geldiyse ses çal
    if(activeCount > lastActiveCount && lastActiveCount > 0){
        playSound();
    }
    lastActiveCount = activeCount;

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

    document.getElementById('statActive').textContent = data.stats.active;
    document.getElementById('statLong').textContent = data.stats.long;
    document.getElementById('statShort').textContent = data.stats.short;

    document.title = (data.stats.active > 0 ? '(' + data.stats.active + ') ' : '') + 'SONNY SCALP 15M';

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

        console.log('SONNY Scalp 15M baslatildi.');
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
        const startTime = Date.now();
        while (scanRunning && Date.now() - startTime < 15000) {
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
    console.log(`SONNY Scalp 15M PORT=${PORT}`);
    start();
});
