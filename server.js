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
// AYARLAR
// ============================================================

const CONFIG = {
    // Zaman dilimi
    TIMEFRAME: '2h',
    CANDLE_LIMIT: 60,

    // Pencere (son kac mumdaki pivotlara bakilacak)
    PIVOT_WINDOW: 30,

    // Pivot toleransı (kac mum sag-sol kontrol edilecek)
    PIVOT_LEFT: 3,
    PIVOT_RIGHT: 3,

    // Ayni seviyeye sayilmasi icin tolerans (%0.5)
    LEVEL_MERGE_PCT: 0.005,

    // Seviye en az kac kez dokunulmali
    MIN_TOUCHES: 2,

    // Kirilim icin minimum hacim carpani
    MIN_VOLUME_MULTIPLIER: 1.3,

    // Kirilim mumunun minimum body buyuklugu (ATR'nin %30'u)
    MIN_BODY_ATR_RATIO: 0.30,

    // Fiyat seviyeden bu kadar uzaktaysa sinyal verme
    MAX_DISTANCE_FROM_LEVEL: 3.0, // %

    // Ayni coin icin sinyal tekrar etme suresi
    SIGNAL_COOLDOWN_MS: 4 * 60 * 60 * 1000, // 4 saat

    // Tarama
    SCAN_INTERVAL_MS: 3 * 60 * 1000,
    PRESCAN_INTERVAL_MS: 10 * 60 * 1000,
    LIVE_INTERVAL_MS: 5000,
    API_DELAY_MS: 150,

    // Filtreler
    MIN_24H_VOLUME_USDT: 1000000, // Minimum 1M USDT hacim
    MAX_TARGETS: 150,

    // Sinyal gecmisi
    MAX_SIGNALS_KEPT: 100,

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
let levels = new Map();      // symbol -> { resistance, support, ... }
let signals = [];            // aktif sinyaller
let scanRunning = false;
let isShuttingDown = false;
let lastPrescanAt = 0;
let lastScanAt = 0;

const lastSignalTime = new Map();  // symbol+direction -> timestamp

const APP_STATE = {
    scanStatus: { message: 'Sunucu baslatiliyor...', isScanning: false },
    updatedAt: Date.now()
};

const DEBUG = {
    scanned: 0,
    signalsLong: 0,
    signalsShort: 0,
    noLevels: 0,
    tooFar: 0,
    noBreakout: 0,
    lowVolume: 0,
    smallBody: 0,
    cooldown: 0,
    errors: 0
};

// ============================================================
// YARDIMCILAR
// ============================================================

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function num(v, d = 8) {
    const n = Number(v);
    return Number.isFinite(n) ? Number(n.toFixed(d)) : null;
}

function pct(a, b) {
    return b ? (a / b) * 100 : 0;
}

function sma(values, period) {
    if (!values || values.length < period) return null;
    const arr = values.slice(-period).map(Number).filter(Number.isFinite);
    if (arr.length !== period) return null;
    return arr.reduce((a, b) => a + b, 0) / period;
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

// Sadece kapanmis mumlar
function closedCandles(ohlcv) {
    if (!Array.isArray(ohlcv) || ohlcv.length < 2) return [];
    return ohlcv.slice(0, -1).filter(c => Array.isArray(c) && c.length >= 6);
}

// ============================================================
// PIVOT BULMA (tepe ve dip noktaları)
// ============================================================

function findPivotHighs(candles) {
    const result = [];
    const L = CONFIG.PIVOT_LEFT;
    const R = CONFIG.PIVOT_RIGHT;

    for (let i = L; i < candles.length - R; i++) {
        const h = Number(candles[i][2]);
        if (!Number.isFinite(h)) continue;

        let isPivot = true;
        for (let j = i - L; j <= i + R; j++) {
            if (j === i) continue;
            if (Number(candles[j][2]) >= h) {
                isPivot = false;
                break;
            }
        }

        if (isPivot) {
            result.push({
                index: i,
                price: h,
                time: candles[i][0]
            });
        }
    }
    return result;
}

function findPivotLows(candles) {
    const result = [];
    const L = CONFIG.PIVOT_LEFT;
    const R = CONFIG.PIVOT_RIGHT;

    for (let i = L; i < candles.length - R; i++) {
        const lo = Number(candles[i][3]);
        if (!Number.isFinite(lo)) continue;

        let isPivot = true;
        for (let j = i - L; j <= i + R; j++) {
            if (j === i) continue;
            if (Number(candles[j][3]) <= lo) {
                isPivot = false;
                break;
            }
        }

        if (isPivot) {
            result.push({
                index: i,
                price: lo,
                time: candles[i][0]
            });
        }
    }
    return result;
}

// ============================================================
// SEVIYE BIRLESTIRME
// Yakin pivotlari tek seviyede toplar
// ============================================================

function mergeLevels(pivots, tolerancePct) {
    if (!pivots || pivots.length === 0) return [];

    // Fiyata gore sirala
    const sorted = pivots.slice().sort((a, b) => a.price - b.price);

    const merged = [];
    let current = null;

    for (const pivot of sorted) {
        if (!current) {
            current = {
                price: pivot.price,
                touches: 1,
                indices: [pivot.index],
                firstIndex: pivot.index,
                lastIndex: pivot.index
            };
            continue;
        }

        const diffPct = Math.abs(pivot.price - current.price) / current.price;

        if (diffPct <= tolerancePct) {
            // Ayni seviyeye ekle
            current.touches++;
            current.indices.push(pivot.index);
            current.lastIndex = pivot.index;
            // Fiyati ortalama al
            current.price = (
                current.price * (current.touches - 1) + pivot.price
            ) / current.touches;
        } else {
            merged.push(current);
            current = {
                price: pivot.price,
                touches: 1,
                indices: [pivot.index],
                firstIndex: pivot.index,
                lastIndex: pivot.index
            };
        }
    }

    if (current) merged.push(current);

    return merged;
}

// ============================================================
// SEVIYE ANALIZI
// ============================================================

function analyzeLevels(candles) {
    if (candles.length < CONFIG.PIVOT_WINDOW) return null;

    const windowCandles = candles.slice(-CONFIG.PIVOT_WINDOW);

    const pivotHighs = findPivotHighs(windowCandles);
    const pivotLows = findPivotLows(windowCandles);

    const mergedHighs = mergeLevels(pivotHighs, CONFIG.LEVEL_MERGE_PCT);
    const mergedLows = mergeLevels(pivotLows, CONFIG.LEVEL_MERGE_PCT);

    // En az MIN_TOUCHES dokunulmus seviyeler
    const strongResistances = mergedHighs
        .filter(l => l.touches >= CONFIG.MIN_TOUCHES)
        .sort((a, b) => b.touches - a.touches);

    const strongSupports = mergedLows
        .filter(l => l.touches >= CONFIG.MIN_TOUCHES)
        .sort((a, b) => b.touches - a.touches);

    if (strongResistances.length === 0 && strongSupports.length === 0) {
        return null;
    }

    const currentPrice = Number(candles[candles.length - 1][4]);

    // Fiyatin USTUNDEKI en yakin direnc
    let nearestResistance = null;
    for (const r of strongResistances) {
        if (r.price > currentPrice) {
            if (nearestResistance === null || r.price < nearestResistance.price) {
                nearestResistance = r;
            }
        }
    }

    // Fiyatin ALTINDAKI en yakin destek
    let nearestSupport = null;
    for (const s of strongSupports) {
        if (s.price < currentPrice) {
            if (nearestSupport === null || s.price > nearestSupport.price) {
                nearestSupport = s;
            }
        }
    }

    return {
        resistances: strongResistances.map(r => ({
            price: num(r.price),
            touches: r.touches
        })),
        supports: strongSupports.map(s => ({
            price: num(s.price),
            touches: s.touches
        })),
        nearestResistance: nearestResistance
            ? {
                price: num(nearestResistance.price),
                touches: nearestResistance.touches
            }
            : null,
        nearestSupport: nearestSupport
            ? {
                price: num(nearestSupport.price),
                touches: nearestSupport.touches
            }
            : null,
        currentPrice: num(currentPrice)
    };
}

// ============================================================
// SINYAL URETIMI
// ============================================================

async function scanForSignal(symbol) {
    try {
        const raw = await exchange.fetchOHLCV(
            symbol,
            CONFIG.TIMEFRAME,
            undefined,
            CONFIG.CANDLE_LIMIT
        );

        const candles = closedCandles(raw);

        if (candles.length < CONFIG.PIVOT_WINDOW + 2) {
            return null;
        }

        // Son tamamlanmis mum (breakout mumu)
        const lastCandle = candles[candles.length - 1];
        const prevCandle = candles[candles.length - 2];

        const close = Number(lastCandle[4]);
        const open = Number(lastCandle[1]);
        const high = Number(lastCandle[2]);
        const low = Number(lastCandle[3]);
        const volume = Number(lastCandle[5]);

        // Seviyeleri analiz et (breakout mumundan ONCEKI mumlarla)
        const priorCandles = candles.slice(0, -1);
        const levelInfo = analyzeLevels(priorCandles);

        if (!levelInfo) {
            DEBUG.noLevels++;
            return null;
        }

        // Hacim kontrolu
        const volumes = priorCandles
            .slice(-20)
            .map(c => Number(c[5]))
            .filter(Number.isFinite);

        const avgVolume = sma(volumes, Math.min(20, volumes.length));
        if (!avgVolume || avgVolume <= 0) return null;

        const volumeRatio = volume / avgVolume;

        // Body kontrolu
        const body = Math.abs(close - open);
        const currentATR = atr(priorCandles, 14);
        if (!currentATR || currentATR <= 0) return null;

        const bodyRatio = body / currentATR;

        // ============================================
        // LONG SINYALI
        // ============================================
        let direction = null;
        let level = null;

        if (levelInfo.nearestResistance) {
            const resistance = levelInfo.nearestResistance.price;

            // Fiyat direnci kirdi mi? (kapanis direncin USTUNDE)
            if (close > resistance) {
                // Kirilim miktari cok buyuk olmamali (fiyat coktan kacmamis)
                const distancePct = pct(close - resistance, resistance);

                if (distancePct <= CONFIG.MAX_DISTANCE_FROM_LEVEL) {
                    // Hacim yeterli mi?
                    if (volumeRatio >= CONFIG.MIN_VOLUME_MULTIPLIER) {
                        // Body yeterli mi?
                        if (bodyRatio >= CONFIG.MIN_BODY_ATR_RATIO) {
                            direction = 'LONG';
                            level = {
                                price: resistance,
                                touches: levelInfo.nearestResistance.touches,
                                type: 'RESISTANCE'
                            };
                        } else {
                            DEBUG.smallBody++;
                        }
                    } else {
                        DEBUG.lowVolume++;
                    }
                } else {
                    DEBUG.tooFar++;
                }
            } else {
                DEBUG.noBreakout++;
            }
        }

        // ============================================
        // SHORT SINYALI
        // ============================================
        if (!direction && levelInfo.nearestSupport) {
            const support = levelInfo.nearestSupport.price;

            // Fiyat destegi kirdi mi? (kapanis destegin ALTINDA)
            if (close < support) {
                const distancePct = pct(support - close, support);

                if (distancePct <= CONFIG.MAX_DISTANCE_FROM_LEVEL) {
                    if (volumeRatio >= CONFIG.MIN_VOLUME_MULTIPLIER) {
                        if (bodyRatio >= CONFIG.MIN_BODY_ATR_RATIO) {
                            direction = 'SHORT';
                            level = {
                                price: support,
                                touches: levelInfo.nearestSupport.touches,
                                type: 'SUPPORT'
                            };
                        } else {
                            DEBUG.smallBody++;
                        }
                    } else {
                        DEBUG.lowVolume++;
                    }
                } else {
                    DEBUG.tooFar++;
                }
            } else {
                DEBUG.noBreakout++;
            }
        }

        if (!direction || !level) return null;

        // Cooldown kontrolu
        const cooldownKey = `${symbol}_${direction}`;
        const lastTime = lastSignalTime.get(cooldownKey) || 0;
        if (Date.now() - lastTime < CONFIG.SIGNAL_COOLDOWN_MS) {
            DEBUG.cooldown++;
            return null;
        }

        // ============================================
        // SINYAL OLUSTUR
        // ============================================

        // Basit risk yonetimi
        const stopDistance = currentATR * 1.5;
        let stop, tp1, tp2;

        if (direction === 'LONG') {
            stop = close - stopDistance;
            tp1 = close + stopDistance * 1.5;
            tp2 = close + stopDistance * 2.5;
        } else {
            stop = close + stopDistance;
            tp1 = close - stopDistance * 1.5;
            tp2 = close - stopDistance * 2.5;
        }

        const rr = Math.abs(tp1 - close) / Math.abs(close - stop);

        const signal = {
            id: `${symbol.replace(/[^A-Z0-9]/gi, '')}_${direction}_${Date.now()}`,
            symbol,
            direction,
            timeframe: CONFIG.TIMEFRAME.toUpperCase(),
            entry: num(close),
            stop: num(stop),
            tp1: num(tp1),
            tp2: num(tp2),
            rr: num(rr, 2),
            level: num(level.price),
            levelTouches: level.touches,
            levelType: level.type,
            breakoutDistancePct: num(pct(
                direction === 'LONG' ? close - level.price : level.price - close,
                level.price
            ), 2),
            volumeRatio: num(volumeRatio, 2),
            bodyRatio: num(bodyRatio, 2),
            atr: num(currentATR),
            candleTime: lastCandle[0],
            timestamp: Date.now()
        };

        lastSignalTime.set(cooldownKey, Date.now());
        DEBUG.signalsLong += direction === 'LONG' ? 1 : 0;
        DEBUG.signalsShort += direction === 'SHORT' ? 1 : 0;

        console.log(
            `\x1b[32m[${direction}] ${symbol} @ ${close} | ` +
            `Level ${level.price} (${level.touches}x) | ` +
            `Vol ${volumeRatio.toFixed(2)}x | ` +
            `Dist ${signal.breakoutDistancePct}%\x1b[0m`
        );

        return signal;

    } catch (err) {
        DEBUG.errors++;
        console.error(`[scanForSignal] ${symbol}: ${err.message}`);
        return null;
    }
}

// ============================================================
// PRESCAN (coin listesi)
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

// ============================================================
// FULL SCAN
// ============================================================

async function runScan() {
    if (scanRunning) return;
    scanRunning = true;

    APP_STATE.scanStatus = {
        message: `Tarama: ${targets.length} coin`,
        isScanning: true
    };
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
        `[SCAN DONE] scanned=${DEBUG.scanned} ` +
        `new=${newSignals} ` +
        `total=${signals.length} ` +
        `L=${DEBUG.signalsLong} S=${DEBUG.signalsShort}`
    );
}

async function runAll() {
    if (Date.now() - lastPrescanAt > CONFIG.PRESCAN_INTERVAL_MS || !targets.length) {
        await runPreScan();
    }
    await runScan();
}

// ============================================================
// CANLI FIYAT (opsiyonel, sadece goruntuleme icin)
// ============================================================

async function updateLivePrices() {
    if (!signals.length) return;

    try {
        const tickers = await exchange.fetchTickers();
        let changed = false;

        for (const sig of signals) {
            const t = tickers[sig.symbol];
            if (t && Number(t.last) > 0) {
                const old = sig.currentPrice;
                sig.currentPrice = num(t.last);
                sig.updatedAt = Date.now();
                if (old !== sig.currentPrice) changed = true;
            }
        }

        if (changed) broadcast();
    } catch (err) {
        // sessizce devam
    }
}

// ============================================================
// API
// ============================================================

app.get('/api/signals', (req, res) => {
    res.json(snapshot());
});

app.get('/api/debug', (req, res) => {
    res.json({
        success: true,
        debug: DEBUG,
        config: CONFIG,
        targets: targets.length,
        signals: signals.length
    });
});

app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        time: Date.now(),
        targets: targets.length,
        signals: signals.length
    });
});

app.post('/api/scan-now', async (req, res) => {
    try {
        await runScan();
        res.json({ success: true, signals: signals.length });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// SNAPSHOT
// ============================================================

function snapshot() {
    APP_STATE.updatedAt = Date.now();

    return {
        success: true,
        signals: signals.slice(0, 50),
        scanStatus: APP_STATE.scanStatus,
        stats: {
            total: signals.length,
            long: signals.filter(s => s.direction === 'LONG').length,
            short: signals.filter(s => s.direction === 'SHORT').length
        },
        updatedAt: APP_STATE.updatedAt
    };
}

function broadcast() {
    const msg = JSON.stringify({ type: 'update', data: snapshot() });
    wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) c.send(msg);
    });
}

wss.on('connection', sock => {
    sock.send(JSON.stringify({ type: 'snapshot', data: snapshot() }));
});

// ============================================================
// FRONTEND
// ============================================================

const HTML = `
<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SONNY SIGNAL ENGINE</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#0a0e14;color:#e9eef5;font-family:-apple-system,Arial,sans-serif;font-size:14px}
.wrap{max-width:1400px;margin:auto;padding:16px}
.top{display:flex;justify-content:space-between;align-items:center;padding-bottom:14px;border-bottom:1px solid #1c2634;margin-bottom:16px}
.brand{font-size:18px;font-weight:800;letter-spacing:0.5px}
.status{font-size:11px;color:#7f8b98}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px}
.stat{background:#0f1620;border:1px solid #1c2634;border-radius:8px;padding:12px}
.stat .lbl{font-size:10px;color:#7f8b98;text-transform:uppercase;letter-spacing:0.5px}
.stat .val{font-size:22px;font-weight:700;margin-top:4px}
.stat.long .val{color:#17d7a0}
.stat.short .val{color:#ff5c77}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:800px){.grid{grid-template-columns:1fr}}
.col h3{margin:0 0 10px;font-size:13px;color:#7f8b98;text-transform:uppercase;letter-spacing:1px}
.card{background:#0f1620;border:1px solid #1c2634;border-radius:10px;padding:14px;margin-bottom:10px;transition:border-color .2s}
.card:hover{border-color:#2c3a4f}
.card.long{border-left:3px solid #17d7a0}
.card.short{border-left:3px solid #ff5c77}
.row{display:flex;justify-content:space-between;align-items:center;gap:8px}
.symbol{font-size:16px;font-weight:700}
.dir{padding:4px 10px;border-radius:6px;font-size:11px;font-weight:800;letter-spacing:0.5px}
.dir.long{background:#0f2a24;color:#17d7a0}
.dir.short{background:#2a0f14;color:#ff5c77}
.meta{font-size:11px;color:#8b97a5;margin-top:8px;display:flex;gap:12px;flex-wrap:wrap}
.meta b{color:#e9eef5;font-weight:600}
.levels{margin-top:10px;padding-top:10px;border-top:1px solid #1a2331;font-size:12px;display:flex;gap:16px;flex-wrap:wrap}
.levels span{color:#8b97a5}
.levels b{color:#e9eef5}
.tag{display:inline-block;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:600;margin-left:6px}
.tag.good{background:#0f2a24;color:#17d7a0}
.tag.warn{background:#2a2410;color:#f6c453}
.time{font-size:10px;color:#5e6b7c;margin-top:8px}
.empty{padding:40px;text-align:center;color:#5e6b7c;font-size:13px}
.refresh{background:#1a2331;border:1px solid #2c3a4f;color:#e9eef5;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:12px}
.refresh:hover{background:#243044}
</style>
</head>
<body>
<div class="wrap">
<div class="top">
<div>
<div class="brand">SONNY SIGNAL ENGINE</div>
<div class="status" id="status">Baglaniyor...</div>
</div>
<button class="refresh" onclick="scanNow()">Simdi Tara</button>
</div>

<div class="stats">
<div class="stat">
<div class="lbl">Toplam</div>
<div class="val" id="statTotal">0</div>
</div>
<div class="stat long">
<div class="lbl">LONG</div>
<div class="val" id="statLong">0</div>
</div>
<div class="stat short">
<div class="lbl">SHORT</div>
<div class="val" id="statShort">0</div>
</div>
<div class="stat">
<div class="lbl">Son Tarama</div>
<div class="val" style="font-size:14px" id="statScan">-</div>
</div>
</div>

<div class="grid">
<div class="col">
<h3>LONG Sinyalleri</h3>
<div id="longList"><div class="empty">Sinyal yok</div></div>
</div>
<div class="col">
<h3>SHORT Sinyalleri</h3>
<div id="shortList"><div class="empty">Sinyal yok</div></div>
</div>
</div>
</div>

<script>
var signals = [];
var ws = null;

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
    var diff = Date.now() - ts;
    var min = Math.floor(diff / 60000);
    if(min < 1) return 'az once';
    if(min < 60) return min + ' dk once';
    var hr = Math.floor(min / 60);
    if(hr < 24) return hr + ' saat once';
    return Math.floor(hr / 24) + ' gun once';
}

function renderCard(s){
    var cls = s.direction === 'LONG' ? 'long' : 'short';
    var dirCls = s.direction === 'LONG' ? 'long' : 'short';

    var volTag = '';
    if(s.volumeRatio >= 2) volTag = '<span class="tag good">GUCLU HACIM</span>';
    else if(s.volumeRatio >= 1.5) volTag = '<span class="tag good">IYI HACIM</span>';

    var levelTag = '';
    if(s.levelTouches >= 3) levelTag = '<span class="tag good">GUCLU SEVIYE</span>';
    else if(s.levelTouches === 2) levelTag = '<span class="tag warn">ORTA SEVIYE</span>';

    return '<div class="card ' + cls + '">'
        + '<div class="row">'
        + '<div>'
        + '<div class="symbol">' + esc(s.symbol.replace(':USDT','')) + volTag + '</div>'
        + '</div>'
        + '<div class="dir ' + dirCls + '">' + s.direction + '</div>'
        + '</div>'
        + '<div class="levels">'
        + '<span>Giris <b>' + fmt(s.entry) + '</b></span>'
        + '<span>Stop <b>' + fmt(s.stop) + '</b></span>'
        + '<span>TP1 <b>' + fmt(s.tp1) + '</b></span>'
        + '<span>TP2 <b>' + fmt(s.tp2) + '</b></span>'
        + '</div>'
        + '<div class="meta">'
        + '<span>Seviye <b>' + fmt(s.level) + '</b> (' + s.levelTouches + 'x)' + levelTag + '</span>'
        + '<span>Hacim <b>' + s.volumeRatio + 'x</b></span>'
        + '<span>Kink <b>' + s.breakoutDistancePct + '%</b></span>'
        + '<span>RR <b>' + s.rr + '</b></span>'
        + '</div>'
        + '<div class="time">' + timeAgo(s.timestamp) + ' - 2H kapanis: ' + fmt(s.entry) + '</div>'
        + '</div>';
}

function render(){
    var longs = signals.filter(function(s){ return s.direction === 'LONG'; });
    var shorts = signals.filter(function(s){ return s.direction === 'SHORT'; });

    document.getElementById('statTotal').textContent = signals.length;
    document.getElementById('statLong').textContent = longs.length;
    document.getElementById('statShort').textContent = shorts.length;

    var longEl = document.getElementById('longList');
    if(longs.length === 0){
        longEl.innerHTML = '<div class="empty">LONG sinyali yok</div>';
    } else {
        longEl.innerHTML = longs.map(renderCard).join('');
    }

    var shortEl = document.getElementById('shortList');
    if(shorts.length === 0){
        shortEl.innerHTML = '<div class="empty">SHORT sinyali yok</div>';
    } else {
        shortEl.innerHTML = shorts.map(renderCard).join('');
    }
}

function apply(data){
    signals = Array.isArray(data.signals) ? data.signals : [];
    render();

    var msg = (data.scanStatus && data.scanStatus.message) ? data.scanStatus.message : 'Hazir';
    document.getElementById('status').textContent = msg + ' | ' + new Date().toLocaleTimeString('tr-TR');

    document.getElementById('statScan').textContent =
        new Date(data.updatedAt).toLocaleTimeString('tr-TR', {hour:'2-digit', minute:'2-digit'});
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
            if(m.type === 'snapshot' || m.type === 'update'){
                apply(m.data);
            }
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
    }catch(e){
        console.error(e);
    }
}

fetch('/api/signals').then(function(r){return r.json();}).then(apply).catch(function(){});
connect();
</script>
</body>
</html>
`;

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
        setInterval(function(){ updateLivePrices(); }, CONFIG.LIVE_INTERVAL_MS);
        setInterval(function(){ runPreScan(); }, CONFIG.PRESCAN_INTERVAL_MS);

        console.log('SONNY Signal Engine baslatildi.');
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
    console.log(`SONNY Signal Engine PORT=${PORT}`);
    start();
});
