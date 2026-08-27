'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = Number(process.env.PORT || 10000);
const API_TOKEN = process.env.API_TOKEN || '';

app.use(express.json());

// ========================= CONFIG (test için aşırı gevşetildi) =========================
const CFG = {
    RADAR: 800,               // 500'den 800'e çıkarıldı
    CANDIDATES: 200,          // 150'den 200'e çıkarıldı
    DEEP: 100,                // 60'tan 100'e çıkarıldı

    MAX_SIGNALS: 15,

    MIN_VOLUME_USDT: Number(process.env.MIN_VOLUME_USDT || 500000), // 500k USDT

    SCAN_MS: 60000,
    LIVE_MS: 10000,
    CONCURRENCY: 2,

    H4: 100,
    H2: 100,
    M15: 160,
    M5: 80,
    CHART: 160,

    LEVEL_LOOKBACK: 20,
    BREAKOUT_LOOKBACK: 12,
    PIVOT_SPAN: 2,

    LEVEL_CLUSTER_PCT: 0.0035,
    MIN_TOUCHES: 1,           // 1 dokunuş yeterli

    BREAKOUT_VOL: 1.0,        // Hacim şartı yok (1.0 = ortalama)

    RETEST_TOL: 0.0045,
    RETEST_MIN: 30 * 60 * 1000,  // 30 dakika (test için)

    MIN_SCORE: 30,            // Çok düşük skor eşiği

    MIN_RR: 1.50,
    TP2_RR: 2.25,
    TP3_RR: 3.25,

    ATR_STOP: 1.00,

    SIGNAL_TTL: 45 * 60 * 1000,

    COOLDOWN: 4 * 60 * 60 * 1000,

    FIVE_MIN_REQUIRED: false,

    AUTO_TRADE: false
};

// ========================= EXCHANGE =========================
const exchange = new ccxt.bitget({
    enableRateLimit: true,
    timeout: 30000,
    options: {
        defaultType: 'swap'
    }
});

// ========================= STATE =========================
const STATE = {
    markets: [],
    marketMap: new Map(),
    universe: [],
    candidates: [],
    deep: [],
    signals: new Map(),
    pending: new Map(),
    cooldowns: new Map(),
    selected: 'BTC/USDT:USDT',
    selectedTf: '15m',
    scanning: false,
    lastScan: 0,
    lastError: '',
    market: {
        label: 'YATAY / KARIŞIK',
        direction: 'FLAT',
        breadth: 50,
        green: 0,
        red: 0,
        average: 0,
        btc: 'NEUTRAL',
        eth: 'NEUTRAL'
    },
    stats: {
        universe: 0,
        candidates: 0,
        deep: 0,
        analyzed: 0,
        pending: 0,
        signals: 0,
        errors: 0
    },
    signalHistory: []
};

// ========================= CACHE =========================
const candleCache = new Map();

// ========================= HELPERS =========================
function n(v, d = 0) {
    const x = Number(v);
    return Number.isFinite(x) ? x : d;
}

function avg(a) {
    return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function closed(c) {
    return Array.isArray(c) && c.length > 1 ? c.slice(0, -1) : (c || []);
}

function cleanSymbol(s) {
    let x = String(s || '').toUpperCase()
        .replace('/USDT:USDT', '')
        .replace('/USDT', '')
        .replace(':USDT', '');
    if (x.endsWith('USDT')) x = x.slice(0, -4);
    return x + 'USDT';
}

function fmt(v) {
    const x = Number(v);
    if (!Number.isFinite(x)) return '-';
    if (x >= 1000) return x.toFixed(2);
    if (x >= 100) return x.toFixed(3);
    if (x >= 1) return x.toFixed(5);
    if (x >= 0.01) return x.toFixed(7);
    if (x >= 0.0001) return x.toFixed(8);
    return x.toFixed(10);
}

// ========================= MARKET =========================
function findMarket(symbol) {
    const wanted = cleanSymbol(symbol);
    if (!STATE.markets.length) return null;
    return STATE.markets.find(m => cleanSymbol(m.symbol) === wanted) || null;
}

async function loadMarkets() {
    const markets = await exchange.loadMarkets(true);
    STATE.markets = Object.values(markets).filter(m =>
        m && m.active !== false && m.swap === true && m.linear === true &&
        m.quote === 'USDT' && m.settle === 'USDT'
    );
    STATE.marketMap = new Map(STATE.markets.map(m => [m.symbol, m]));
}

async function loadMarketsWithRetry(maxRetries = 3, delayMs = 5000) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            await loadMarkets();
            return;
        } catch (e) {
            console.error(`Market yüklenemedi (${i + 1}/${maxRetries}):`, e.message);
            if (i < maxRetries - 1) await sleep(delayMs);
        }
    }
    throw new Error('Marketler yüklenemedi');
}

// ========================= CANDLES (cache'li) =========================
async function getCandles(symbol, tf, limit) {
    const cacheKey = `${symbol}|${tf}|${limit}`;
    const cached = candleCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 60000) {
        return cached.data;
    }

    try {
        const data = await exchange.fetchOHLCV(symbol, tf, undefined, limit);
        const cleaned = Array.isArray(data)
            ? data.filter(x => Array.isArray(x) && x.length >= 6).sort((a, b) => a[0] - b[0])
            : [];
        candleCache.set(cacheKey, { data: cleaned, timestamp: Date.now() });
        return cleaned;
    } catch (error) {
        console.error(`Mum verisi alınamadı: ${symbol} ${tf} - ${error.message}`);
        if (cached) return cached.data;
        return [];
    }
}

// ========================= TICKERS (hata durumunda fırlat) =========================
async function getTickers() {
    let tickers;
    try {
        tickers = await exchange.fetchTickers();
    } catch (error) {
        console.error('Tickers alınamadı:', error.message);
        if (!STATE.universe.length) {
            throw error;
        }
        return STATE.universe;
    }

    const rows = [];
    for (const m of STATE.markets) {
        const t = tickers[m.symbol];
        if (!t) continue;
        const last = n(t.last || t.close);
        const volume = n(t.quoteVolume);
        if (!(last > 0) || !(volume > 0)) continue;
        const high = n(t.high);
        const low = n(t.low);
        rows.push({
            symbol: m.symbol,
            price: last,
            volume,
            change: n(t.percentage),
            range: low > 0 ? ((high - low) / low) * 100 : 0
        });
    }
    rows.sort((a, b) => b.volume - a.volume);
    return rows.slice(0, CFG.RADAR);
}

// ========================= INDICATORS =========================
function ema(candles, p) {
    const c = closed(candles);
    if (c.length < p) return null;
    let e = avg(c.slice(0, p).map(x => n(x[4])));
    const k = 2 / (p + 1);
    for (let i = p; i < c.length; i++) {
        e = n(c[i][4]) * k + e * (1 - k);
    }
    return e;
}

function rsi(candles, p = 14) {
    const c = closed(candles);
    if (c.length < p + 1) return 50;
    let g = 0, l = 0;
    for (let i = c.length - p; i < c.length; i++) {
        const d = n(c[i][4]) - n(c[i - 1][4]);
        if (d > 0) g += d;
        else l -= d;
    }
    if (l === 0) return 100;
    const rs = (g / p) / (l / p);
    return 100 - 100 / (1 + rs);
}

function atr(candles, p = 14) {
    const c = closed(candles);
    if (c.length < p + 1) return 0;
    const a = [];
    for (let i = 1; i < c.length; i++) {
        const h = n(c[i][2]), lo = n(c[i][3]), pc = n(c[i - 1][4]);
        a.push(Math.max(h - lo, Math.abs(h - pc), Math.abs(lo - pc)));
    }
    return avg(a.slice(-p));
}

function trend(candles) {
    const c = closed(candles);
    if (c.length < 55) return 'NEUTRAL';
    const e21 = ema(candles, 21);
    const e50 = ema(candles, 50);
    const last = n(c[c.length - 1][4]);
    if (e21 === null || e50 === null) return 'NEUTRAL';
    if (last > e21 && e21 > e50) return 'LONG';
    if (last < e21 && e21 < e50) return 'SHORT';
    return 'NEUTRAL';
}

function structure(candles, lookback = 20) {
    const c = closed(candles).slice(-lookback);
    if (c.length < 8) return 'NEUTRAL';
    const h = Math.floor(c.length / 2);
    const a = c.slice(0, h);
    const b = c.slice(h);
    const ah = Math.max(...a.map(x => n(x[2])));
    const al = Math.min(...a.map(x => n(x[3])));
    const bh = Math.max(...b.map(x => n(x[2])));
    const bl = Math.min(...b.map(x => n(x[3])));
    if (bh > ah && bl > al) return 'LONG';
    if (bh < ah && bl < al) return 'SHORT';
    return 'NEUTRAL';
}

function volumeRatio(candles, p = 20) {
    const x = closed(candles);
    if (x.length < p + 1) return 1;
    const cur = n(x[x.length - 1][5]);
    const base = x.slice(-p - 1, -1).map(z => n(z[5])).filter(Boolean);
    const a = avg(base);
    return a > 0 ? cur / a : 1;
}

// ========================= PIVOTS / LEVELS =========================
function pivots(candles, span = CFG.PIVOT_SPAN) {
    const c = closed(candles);
    const out = [];
    if (c.length < span * 2 + 8) return out;
    for (let i = span; i < c.length - span; i++) {
        const hi = n(c[i][2]), lo = n(c[i][3]);
        let isH = true, isL = true;
        for (let j = 1; j <= span; j++) {
            if (hi <= n(c[i - j][2]) || hi <= n(c[i + j][2])) isH = false;
            if (lo >= n(c[i - j][3]) || lo >= n(c[i + j][3])) isL = false;
        }
        if (isH) out.push({ price: hi, type: 'resistance', time: c[i][0] });
        if (isL) out.push({ price: lo, type: 'support', time: c[i][0] });
    }
    return out;
}

function getLevels(candles) {
    const raw = pivots(candles);
    const groups = [];
    for (const point of raw) {
        let group = groups.find(g => g.type === point.type &&
            Math.abs(point.price - g.price) / Math.max(g.price, 1e-12) <= CFG.LEVEL_CLUSTER_PCT);
        if (!group) {
            group = { type: point.type, price: point.price, items: [] };
            groups.push(group);
        }
        group.items.push(point);
        group.price = avg(group.items.map(x => x.price));
    }
    return groups.map(g => ({
        type: g.type,
        price: g.price,
        touches: g.items.length,
        lastTouch: Math.max(...g.items.map(x => x.time))
    })).filter(g => g.touches >= CFG.MIN_TOUCHES);
}

// ========================= BREAKOUT (proximity gevşetildi) =========================
function detectBreakouts(candles, levels) {
    const c = closed(candles);
    const out = [];
    if (c.length < 30) return out;
    const start = Math.max(1, c.length - 8);
    for (let i = start; i < c.length; i++) {
        const candle = c[i];
        const prev = c[i - 1];
        const history = c.slice(Math.max(0, i - 20), i);
        const avgVol = avg(history.map(x => n(x[5])).filter(Boolean));
        const vr = avgVol > 0 ? n(candle[5]) / avgVol : 1;
        const body = Math.abs(n(candle[4]) - n(candle[1]));
        const range = Math.max(n(candle[2]) - n(candle[3]), 1e-12);
        const bodyRatio = body / range;
        const atrValue = atr(candles) || n(candle[4]) * 0.003;
        const bodyAtr = body / Math.max(atrValue, 1e-12);
        if (vr < CFG.BREAKOUT_VOL) continue;
        if (bodyRatio < 0.30) continue;
        if (bodyAtr < 0.35) continue;
        for (const level of levels) {
            const proximity = Math.abs(n(prev[4]) - level.price) / Math.max(level.price, 1e-12);
            if (proximity > 0.02) continue; // 0.006 yerine 0.02
            const buffer = level.price * 0.0012;
            if (level.type === 'resistance' && n(prev[4]) <= level.price && n(candle[4]) > level.price + buffer) {
                out.push({
                    direction: 'LONG',
                    level,
                    time: n(candle[0]),
                    breakoutVolumeRatio: vr,
                    breakoutBodyAtr: bodyAtr,
                    bodyRatio
                });
            }
            if (level.type === 'support' && n(prev[4]) >= level.price && n(candle[4]) < level.price - buffer) {
                out.push({
                    direction: 'SHORT',
                    level,
                    time: n(candle[0]),
                    breakoutVolumeRatio: vr,
                    breakoutBodyAtr: bodyAtr,
                    bodyRatio
                });
            }
        }
    }
    return out.sort((a, b) => b.time - a.time);
}

// ========================= RETEST =========================
function retest(candles, p) {
    const c = closed(candles);
    const after = c.filter(x => n(x[0]) > p.breakoutTime);
    if (!after.length) return { status: 'WAITING_RETEST', quality: 0 };
    if (Date.now() - p.breakoutTime > CFG.RETEST_MIN) return { status: 'EXPIRED', quality: 0 };
    const tol = p.level.price * CFG.RETEST_TOL;
    const invalidation = p.level.price * 0.0035;
    for (const x of after.slice(0, 8)) {
        const open = n(x[1]), high = n(x[2]), low = n(x[3]), close = n(x[4]);
        const range = Math.max(high - low, 1e-12);
        if (p.direction === 'LONG' && close < p.level.price - invalidation) return { status: 'INVALIDATED', quality: 0 };
        if (p.direction === 'SHORT' && close > p.level.price + invalidation) return { status: 'INVALIDATED', quality: 0 };
        const touched = high >= p.level.price - tol && low <= p.level.price + tol;
        if (!touched) continue;
        const body = Math.abs(close - open);
        const lowerWick = Math.min(open, close) - low;
        const upperWick = high - Math.max(open, close);
        if (p.direction === 'LONG') {
            const recovered = close >= p.level.price;
            const rejection = lowerWick / range >= 0.30;
            const healthy = close > open || rejection || body / range >= 0.45;
            if (recovered && healthy) {
                return {
                    status: 'RETESTED',
                    quality: Math.min(100, 60 + (rejection ? 20 : 0) + (close > open ? 20 : 0)),
                    candle: x
                };
            }
        }
        if (p.direction === 'SHORT') {
            const recovered = close <= p.level.price;
            const rejection = upperWick / range >= 0.30;
            const healthy = close < open || rejection || body / range >= 0.45;
            if (recovered && healthy) {
                return {
                    status: 'RETESTED',
                    quality: Math.min(100, 60 + (rejection ? 20 : 0) + (close < open ? 20 : 0)),
                    candle: x
                };
            }
        }
    }
    return { status: 'WAITING_RETEST', quality: 0 };
}

// ========================= TRADE PLAN =========================
function createTradePlan(direction, level, candles) {
    const c = closed(candles);
    if (c.length < 20) return null;
    const current = n(c[c.length - 1][4]);
    const volatility = atr(candles, 14) || current * 0.005;
    const recent = c.slice(-8);
    const swingLow = Math.min(...recent.map(x => n(x[3])));
    const swingHigh = Math.max(...recent.map(x => n(x[2])));
    let entry, stop;
    if (direction === 'LONG') {
        entry = Math.max(current, level.price);
        stop = Math.min(swingLow, level.price - volatility * CFG.ATR_STOP);
        if (stop >= entry) stop = entry - volatility * CFG.ATR_STOP;
    } else {
        entry = Math.min(current, level.price);
        stop = Math.max(swingHigh, level.price + volatility * CFG.ATR_STOP);
        if (stop <= entry) stop = entry + volatility * CFG.ATR_STOP;
    }
    const risk = Math.abs(entry - stop);
    if (!(risk > 0)) return null;
    let tp1, tp2, tp3;
    if (direction === 'LONG') {
        tp1 = entry + risk * CFG.MIN_RR;
        tp2 = entry + risk * CFG.TP2_RR;
        tp3 = entry + risk * CFG.TP3_RR;
    } else {
        tp1 = entry - risk * CFG.MIN_RR;
        tp2 = entry - risk * CFG.TP2_RR;
        tp3 = entry - risk * CFG.TP3_RR;
    }
    const rr = Math.abs(tp1 - entry) / risk;
    if (rr < CFG.MIN_RR) return null;
    return {
        entry,
        entryLow: Math.min(level.price, entry),
        entryHigh: Math.max(level.price, entry),
        stop,
        tp1,
        tp2,
        tp3,
        rr
    };
}

// ========================= SCORE =========================
function calculateScore(direction, h4Trend, h2Trend, m15Trend, m5Trend, volumeRatio, retestQuality, rsiValue, breakoutBodyAtr, bodyRatio, levelTouches) {
    let score = 38;
    const reasons = [];
    if (h4Trend === direction) { score += 16; reasons.push('4H uyumlu'); }
    if (h2Trend === direction) { score += 14; reasons.push('2H uyumlu'); }
    if (m15Trend === direction) { score += 8; reasons.push('15M yapı uyumlu'); }
    if (m5Trend === direction) { score += 5; reasons.push('5M bonus'); }
    if (volumeRatio >= 1.5) { score += 8; reasons.push('hacim güçlü'); }
    if (volumeRatio >= 2) { score += 5; reasons.push('hacim çok güçlü'); }
    if (retestQuality >= 70) { score += 8; reasons.push('kaliteli retest'); }
    else if (retestQuality >= 60) { score += 5; reasons.push('retest teyidi'); }
    if ((direction === 'LONG' && rsiValue >= 45 && rsiValue <= 75) || (direction === 'SHORT' && rsiValue >= 25 && rsiValue <= 55)) {
        score += 5; reasons.push('RSI uygun');
    }
    if (breakoutBodyAtr >= 0.6) { score += 4; reasons.push('güçlü breakout mumu'); }
    if (bodyRatio >= 0.7) { score += 3; reasons.push('yüksek gövde oranı'); }
    if (levelTouches >= 3) { score += 5; reasons.push('güçlü seviye'); }

    return { score: Math.min(100, Math.round(score)), reasons };
}

// ========================= ANALYZE COIN =========================
async function analyzeCoin(row) {
    const symbol = row.symbol;
    try {
        const [h1, m15, m5] = await Promise.all([
            getCandles(symbol, '1h', CFG.H4),
            getCandles(symbol, '15m', CFG.M15),
            getCandles(symbol, '5m', CFG.M5)
        ]);
        if (h1.length < 70 || m15.length < 35 || m5.length < 15) return null;
        const h2 = aggregateCandles(h1, 2);
        const h4 = aggregateCandles(h1, 4);
        if (h2.length < 45 || h4.length < 45) return null;
        const h4Trend = trend(h4);
        const h2Trend = trend(h2);
        const m15Trend = structure(m15);
        const m5Trend = trend(m5);
        const l4 = getLevels(h4);
        const l2 = getLevels(h2);
        if (!l4.length && !l2.length) return null;
        const levels = [];
        for (const l of l4) levels.push({ tf: '4H', direction: l.type === 'resistance' ? 'LONG' : 'SHORT', level: l });
        for (const l of l2) levels.push({ tf: '2H', direction: l.type === 'resistance' ? 'LONG' : 'SHORT', level: l });
        const breakouts = detectBreakouts(m15, levels.map(x => x.level));
        if (breakouts.length) {
            console.log(`[${cleanSymbol(symbol)}] ${levels.length} seviye, ${breakouts.length} kırılım tespit edildi`);
        }
        for (const breakout of breakouts) {
            const candidates = levels.filter(x => x.direction === breakout.direction &&
                Math.abs(x.level.price - breakout.level.price) / breakout.level.price < 0.0035);
            if (!candidates.length) continue;
            const best = candidates.sort((a, b) => b.level.touches - a.level.touches)[0];
            createPending(symbol, breakout.direction, best.tf, {
                level: best.level.price,
                time: breakout.time,
                volumeRatio: breakout.breakoutVolumeRatio,
                bodyRatio: breakout.bodyRatio,
                bodyAtr: breakout.breakoutBodyAtr,
                touches: best.level.touches
            });
        }
        const currentRsi = rsi(m15);
        const pendings = [...STATE.pending.values()].filter(p => p.symbol === cleanSymbol(symbol));
        for (const pending of pendings) {
            const rt = retest(m15, pending);
            pending.status = rt.status;
            pending.updatedAt = Date.now();
            if (rt.status === 'EXPIRED') { STATE.pending.delete(pending.key); continue; }
            if (rt.status === 'INVALIDATED') {
                STATE.pending.delete(pending.key);
                STATE.cooldowns.set(pending.key, Date.now());
                continue;
            }
            if (!rt.quality) continue;
            if (h4Trend !== 'NEUTRAL' && h4Trend !== pending.direction) { pending.status = 'REJECTED_4H'; continue; }
            if (h2Trend !== 'NEUTRAL' && h2Trend !== pending.direction) { pending.status = 'REJECTED_2H'; continue; }
            const fiveMinute = confirm5m(m5, pending.direction);
            if (CFG.FIVE_MIN_REQUIRED && !fiveMinute) { pending.status = 'WAITING_5M'; continue; }
            const scored = calculateScore(
                pending.direction,
                h4Trend,
                h2Trend,
                m15Trend,
                m5Trend,
                pending.breakoutVolumeRatio,
                rt.quality,
                currentRsi,
                pending.breakoutBodyATR || 0,
                pending.breakoutBodyRatio || 0,
                pending.levelTouches || 0
            );
            if (scored.score < CFG.MIN_SCORE) { pending.status = 'REJECTED_SCORE'; continue; }
            const plan = createTradePlan(pending.direction, { price: pending.level }, m15);
            if (!plan) { pending.status = 'REJECTED_RR'; continue; }
            const duplicate = [...STATE.signals.values()].some(signal =>
                signal.symbol === pending.symbol && signal.direction === pending.direction);
            if (duplicate) continue;
            const now = Date.now();
            STATE.pending.delete(pending.key);
            const signal = {
                id: [pending.symbol, pending.direction, now].join('|'),
                symbol: pending.symbol,
                marketSymbol: symbol,
                direction: pending.direction,
                score: scored.score,
                confidence: scored.score,
                currentPrice: row.price,
                entry: plan.entry,
                entryLow: plan.entryLow,
                entryHigh: plan.entryHigh,
                stop: plan.stop,
                stopLoss: plan.stop,
                tp1: plan.tp1,
                tp2: plan.tp2,
                tp3: plan.tp3,
                rr: Number(plan.rr.toFixed(2)),
                rsi: Number(currentRsi.toFixed(1)),
                volumeRatio: Number(pending.breakoutVolumeRatio.toFixed(2)),
                breakoutLevel: pending.level,
                timeframeLevel: pending.timeframeLevel,
                h4Trend, h2Trend, m15Trend, m5Trend,
                retestQuality: rt.quality,
                fiveMinuteConfirmed: fiveMinute,
                status: 'GİRİŞ BEKLENİYOR',
                entryReady: false,
                reason: scored.reasons.join(' + '),
                reasons: scored.reasons,
                breakoutTime: pending.breakoutTime,
                retestTime: rt.candle ? rt.candle[0] : 0,
                signalAt: now,
                cooldownKey: pending.key
            };
            STATE.signals.set(signal.id, signal);
            while (STATE.signals.size > CFG.MAX_SIGNALS) {
                const first = STATE.signals.keys().next().value;
                STATE.signals.delete(first);
            }
        }
    } catch (error) {
        console.error(`Analiz hatası (${symbol}):`, error.message);
    }
    return null;
}

// ========================= PENDING =========================
function createPending(symbol, direction, tf, breakout) {
    const key = [cleanSymbol(symbol), direction, tf, fmt(breakout.level)].join('|');
    const old = STATE.pending.get(key);
    if (old) { old.updatedAt = Date.now(); return; }
    const cooldown = STATE.cooldowns.get(key);
    if (cooldown && Date.now() - cooldown < CFG.COOLDOWN) return;
    STATE.pending.set(key, {
        key,
        symbol: cleanSymbol(symbol),
        direction,
        timeframeLevel: tf,
        level: breakout.level,
        breakoutTime: breakout.time,
        breakoutVolumeRatio: breakout.volumeRatio,
        breakoutBodyRatio: breakout.bodyRatio || 0,
        breakoutBodyATR: breakout.bodyAtr || 0,
        levelTouches: breakout.touches || 0,
        status: 'WAITING_RETEST',
        createdAt: Date.now(),
        updatedAt: Date.now()
    });
    console.log('BREAKOUT |', cleanSymbol(symbol), '|', direction, '|', fmt(breakout.level), '| VOL', breakout.volumeRatio.toFixed(2) + 'x');
}

// ========================= 5M =========================
function confirm5m(candles, direction) {
    const c = closed(candles);
    if (c.length < 3) return false;
    const last = c[c.length - 1];
    const previous = c[c.length - 2];
    if (direction === 'LONG') return (last[4] > last[1] && last[4] >= previous[4]);
    return (last[4] < last[1] && last[4] <= previous[4]);
}

// ========================= AGGREGATE =========================
function aggregateCandles(candles, hours) {
    const map = new Map();
    const bucketMs = hours * 60 * 60 * 1000;
    for (const candle of candles) {
        const bucket = Math.floor(n(candle[0]) / bucketMs) * bucketMs;
        if (!map.has(bucket)) {
            map.set(bucket, [bucket, n(candle[1]), n(candle[2]), n(candle[3]), n(candle[4]), n(candle[5])]);
        } else {
            const item = map.get(bucket);
            item[2] = Math.max(item[2], n(candle[2]));
            item[3] = Math.min(item[3], n(candle[3]));
            item[4] = n(candle[4]);
            item[5] += n(candle[5]);
        }
    }
    return [...map.values()].sort((a, b) => a[0] - b[0]);
}

// ========================= MARKET REGIME =========================
function calculateMarketRegime(rows) {
    if (!rows.length) {
        STATE.market = { label: 'YATAY / KARIŞIK', direction: 'FLAT', breadth: 50, green: 0, red: 0, average: 0, btc: 'NEUTRAL', eth: 'NEUTRAL' };
        return;
    }
    let green = 0, red = 0, total = 0;
    for (const r of rows) {
        if (r.change > 0) green++;
        else if (r.change < 0) red++;
        total += r.change;
    }
    const breadth = (green / Math.max(green + red, 1)) * 100;
    const average = total / rows.length;
    let direction = 'FLAT', label = 'YATAY / KARIŞIK';
    if (breadth >= 60 && average >= 0.35) { direction = 'LONG'; label = 'POZİTİF / YÜKSELİŞ'; }
    else if (breadth <= 40 && average <= -0.35) { direction = 'SHORT'; label = 'NEGATİF / DÜŞÜŞ'; }
    STATE.market = {
        label,
        direction,
        breadth: Number(breadth.toFixed(1)),
        green,
        red,
        average: Number(average.toFixed(2)),
        btc: 'NEUTRAL',
        eth: 'NEUTRAL'
    };
}

// ========================= SCAN =========================
async function runScan() {
    if (STATE.scanning) return;
    STATE.scanning = true;
    STATE.stats.errors = 0;
    try {
        console.log('Tarama başladı...');
        const rows = await getTickers();
        STATE.universe = rows;
        STATE.stats.universe = rows.length;
        calculateMarketRegime(rows);

        const btcRow = rows.find(r => r.symbol === 'BTC/USDT:USDT');
        const ethRow = rows.find(r => r.symbol === 'ETH/USDT:USDT');
        if (btcRow) {
            try {
                const btcCandles = await getCandles(btcRow.symbol, '1h', 100);
                STATE.market.btc = trend(btcCandles);
            } catch(e) { console.error('BTC trend alınamadı:', e.message); }
        }
        if (ethRow) {
            try {
                const ethCandles = await getCandles(ethRow.symbol, '1h', 100);
                STATE.market.eth = trend(ethCandles);
            } catch(e) { console.error('ETH trend alınamadı:', e.message); }
        }

        const candidates = rows.filter(r => r.volume >= CFG.MIN_VOLUME_USDT)
            .sort((a, b) => (Math.abs(b.change) * Math.log10(b.volume + 1)) - (Math.abs(a.change) * Math.log10(a.volume + 1)))
            .slice(0, CFG.CANDIDATES);
        STATE.candidates = candidates;
        STATE.stats.candidates = candidates.length;
        const deep = candidates.slice(0, CFG.DEEP);
        STATE.deep = deep;
        STATE.stats.deep = deep.length;
        STATE.stats.analyzed = 0;

        for (let i = 0; i < deep.length; i += CFG.CONCURRENCY) {
            const batch = deep.slice(i, i + CFG.CONCURRENCY);
            await Promise.all(batch.map(async row => {
                try {
                    await analyzeCoin(row);
                    STATE.stats.analyzed++;
                } catch (error) {
                    STATE.stats.errors++;
                    console.error('ANALYZE ERROR |', row.symbol, '|', error.message);
                }
            }));
            await sleep(250);
        }

        STATE.lastScan = Date.now();
        console.log(`Tarama tamamlandı. Analiz edilen: ${STATE.stats.analyzed} Sinyal: ${STATE.signals.size} Pending: ${STATE.pending.size}`);
    } catch (error) {
        STATE.lastError = error.message;
        STATE.stats.errors++;
        console.error('SCAN ERROR:', error.message);
    } finally {
        STATE.scanning = false;
        STATE.stats.pending = STATE.pending.size;
        STATE.stats.signals = STATE.signals.size;
        broadcast();
    }
}

// ========================= LIVE SIGNALS =========================
async function updateLiveSignals() {
    if (!STATE.signals.size) return;
    let tickers;
    try {
        tickers = await exchange.fetchTickers();
    } catch (e) {
        console.error('LIVE tickers alınamadı:', e.message);
        return;
    }
    const now = Date.now();
    for (const [id, signal] of STATE.signals) {
        if (now - signal.signalAt > CFG.SIGNAL_TTL) {
            STATE.signals.delete(id);
            STATE.signalHistory.push({ ...signal, result: 'TTL', closedAt: now });
            continue;
        }
        const ticker = tickers[signal.marketSymbol];
        if (!ticker) continue;
        const current = n(ticker.last || ticker.close);
        if (!(current > 0)) continue;
        signal.currentPrice = current;
        if (signal.direction === 'LONG') {
            if (current <= signal.stop) {
                STATE.signals.delete(id);
                STATE.cooldowns.set(signal.cooldownKey, now);
                STATE.signalHistory.push({ ...signal, result: 'STOP', closedAt: now });
                continue;
            }
            if (current >= signal.tp3) {
                STATE.signals.delete(id);
                STATE.signalHistory.push({ ...signal, result: 'TP3', closedAt: now });
                continue;
            }
            if (current >= signal.tp2) signal.status = 'TP2';
            else if (current >= signal.tp1) signal.status = 'TP1';
            else if (current >= signal.entryLow && current <= signal.entryHigh) { signal.status = 'GİRİŞ ALANI'; signal.entryReady = true; }
        } else {
            if (current >= signal.stop) {
                STATE.signals.delete(id);
                STATE.cooldowns.set(signal.cooldownKey, now);
                STATE.signalHistory.push({ ...signal, result: 'STOP', closedAt: now });
                continue;
            }
            if (current <= signal.tp3) {
                STATE.signals.delete(id);
                STATE.signalHistory.push({ ...signal, result: 'TP3', closedAt: now });
                continue;
            }
            if (current <= signal.tp2) signal.status = 'TP2';
            else if (current <= signal.tp1) signal.status = 'TP1';
            else if (current >= signal.entryLow && current <= signal.entryHigh) { signal.status = 'GİRİŞ ALANI'; signal.entryReady = true; }
        }
        signal.ageSeconds = Math.floor((now - signal.signalAt) / 1000);
    }
    cleanup();
    STATE.stats.signals = STATE.signals.size;
    STATE.stats.pending = STATE.pending.size;
    broadcast();
}

// ========================= CLEANUP =========================
function cleanup() {
    const now = Date.now();
    for (const [id, signal] of STATE.signals) {
        if (now - signal.signalAt > CFG.SIGNAL_TTL) STATE.signals.delete(id);
    }
    for (const [key, pending] of STATE.pending) {
        if (now - pending.createdAt > CFG.RETEST_MIN) STATE.pending.delete(key);
    }
    for (const [key, time] of STATE.cooldowns) {
        if (now - time > CFG.COOLDOWN) STATE.cooldowns.delete(key);
    }
    STATE.stats.pending = STATE.pending.size;
    STATE.stats.signals = STATE.signals.size;
}

// ========================= CHART =========================
async function getChart(symbol, timeframe) {
    const market = findMarket(symbol);
    if (!market) return [];
    if (timeframe === '2h') {
        const h1 = await getCandles(market.symbol, '1h', CFG.CHART * 2);
        return aggregateCandles(h1, 2);
    }
    if (timeframe === '4h') {
        const h1 = await getCandles(market.symbol, '1h', CFG.CHART * 4);
        return aggregateCandles(h1, 4);
    }
    return getCandles(market.symbol, timeframe, CFG.CHART);
}

// ========================= STATUS =========================
function status() {
    cleanup();
    const signals = [...STATE.signals.values()].sort((a, b) => b.score - a.score);
    const pending = [...STATE.pending.values()].sort((a, b) => b.breakoutTime - a.breakoutTime);
    return {
        ok: true,
        lastScan: STATE.lastScan,
        error: STATE.lastError,
        stats: { ...STATE.stats },
        signals,
        pending,
        market: STATE.market,
        signalHistoryCount: STATE.signalHistory.length
    };
}

// ========================= API AUTH =========================
function auth(req, res, next) {
    if (!API_TOKEN) return next();
    const token = req.headers['x-api-token'] || req.query.token;
    if (token !== API_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// ========================= API ENDPOINTS =========================
app.get('/api/status', (req, res) => {
    res.json(status());
});

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        lastScan: STATE.lastScan,
        lastError: STATE.lastError
    });
});

app.get('/api/scan', auth, async (req, res) => {
    try {
        await runScan();
        res.json({ success: true, data: status() });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/chart', auth, async (req, res) => {
    try {
        const symbol = req.query.symbol || 'BTC/USDT:USDT';
        const timeframe = req.query.timeframe || '15m';
        const candles = await getChart(symbol, timeframe);
        const signal = [...STATE.signals.values()].find(s => s.marketSymbol === symbol) || null;
        res.json({ success: true, symbol, timeframe, candles, signal });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/history', auth, (req, res) => {
    res.json({ success: true, history: STATE.signalHistory.slice(-100) });
});

// ========================= WEBSOCKET =========================
function broadcast() {
    const payload = JSON.stringify({ type: 'snapshot', data: status() });
    for (const ws of wss.clients) {
        if (ws.readyState === WebSocket.OPEN) {
            try { ws.send(payload); } catch (error) { console.error('WS SEND ERROR:', error.message); }
        }
    }
}

wss.on('connection', ws => {
    try {
        ws.send(JSON.stringify({ type: 'snapshot', data: status() }));
    } catch (_) {}
});

// ========================= FRONTEND =========================
const HTML = `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SONNY AI TRADER</title>
<style>
*{box-sizing:border-box;}
body{margin:0;background:#070b11;color:#dbe4ee;font-family:Arial,sans-serif;overflow:hidden;}
.app{display:grid;grid-template-columns:275px 1fr 310px;height:100vh;}
.left{background:#0b111b;border-right:1px solid #1a2533;overflow:auto;padding:18px;}
.brand{font-size:18px;font-weight:bold;margin-bottom:5px;}
.sub{color:#718096;font-size:11px;margin-bottom:18px;}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-bottom:12px;}
.st{background:#101826;border:1px solid #1b2939;padding:9px 5px;text-align:center;border-radius:6px;}
.st b{display:block;font-size:17px;}
.st span{color:#64748b;font-size:9px;}
.cards{display:flex;flex-direction:column;gap:7px;}
.card{background:#101826;border:1px solid #1c2938;border-radius:7px;padding:11px;cursor:pointer;transition:.15s;}
.card:hover,.card.active{border-color:#13dba0;background:#111d2a;}
.card.short{border-left:3px solid #ff5570;}
.top{display:flex;align-items:center;justify-content:space-between;}
.coin{font-size:14px;font-weight:bold;}
.badge{font-size:9px;padding:3px 6px;border-radius:4px;background:#123c31;color:#13dba0;}
.badge.short{background:#421d28;color:#ff5570;}
.cp{font-size:15px;margin-top:8px;}
.meta{color:#718096;font-size:9px;margin-top:6px;}
.main{min-width:0;display:flex;flex-direction:column;}
.head{height:70px;padding:15px 20px;border-bottom:1px solid #182330;display:flex;align-items:center;justify-content:space-between;}
.title{font-weight:bold;font-size:16px;}
.title small{display:block;color:#64748b;font-size:10px;margin-top:4px;}
.pill{font-size:10px;color:#13dba0;}
.chartbox{flex:1;min-height:0;display:flex;flex-direction:column;}
.charthead{height:45px;display:flex;align-items:center;justify-content:space-between;padding:0 16px;border-bottom:1px solid #182330;}
.charthead b{font-size:12px;}
.tf{display:flex;gap:4px;}
.tf button{background:#101826;border:1px solid #1d2b3a;color:#718096;border-radius:4px;padding:5px 8px;font-size:9px;cursor:pointer;}
.tf button.active{color:#13dba0;border-color:#13dba0;}
.chart{flex:1;min-height:0;}
canvas{width:100%;height:100%;display:block;}
.right{background:#0b111b;border-left:1px solid #1a2533;overflow:auto;padding:15px;}
.box{background:#101826;border:1px solid #1a2938;border-radius:7px;padding:13px;margin-bottom:10px;}
.bt{color:#64748b;font-size:9px;font-weight:bold;letter-spacing:.5px;}
.reg{font-size:16px;font-weight:bold;margin-top:7px;}
.reg.long{color:#13dba0;}
.reg.short{color:#ff5570;}
.mi{color:#718096;font-size:10px;line-height:1.7;margin-top:7px;}
.an{font-size:16px;font-weight:bold;margin-top:9px;margin-bottom:10px;}
.longtxt{color:#13dba0;}
.shorttxt{color:#ff5570;}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;}
.lv{background:#0b111b;border:1px solid #1b2938;border-radius:5px;padding:8px;}
.lv span{display:block;color:#64748b;font-size:8px;margin-bottom:4px;}
.lv b{font-size:11px;}
.lv.entry b{color:#13dba0;}
.lv.stop b{color:#ff5570;}
.lv.tp b{color:#55a7ff;}
.pending{display:flex;flex-direction:column;gap:6px;}
.pi{border:1px solid #1b2938;border-radius:5px;padding:8px;font-size:9px;color:#718096;}
.pi b{color:#dbe4ee;}
.empty{color:#64748b;font-size:10px;padding:12px 4px;}
@media(max-width:1000px){.app{grid-template-columns:230px 1fr;}.right{display:none;}}
</style>
</head>
<body>
<div class="app">
<aside class="left">
<div class="brand">⚡ SONNY AI TRADER</div>
<div class="sub">SADECE TEYİTLİ SİNYALLER</div>
<div class="stats">
<div class="st"><b id="u">0</b><span>RADAR</span></div>
<div class="st"><b id="c">0</b><span>ADAY</span></div>
<div class="st"><b id="d">0</b><span>DERİN</span></div>
</div>
<div class="cards" id="cards"><div class="empty">Sinyal bekleniyor...</div></div>
</aside>
<main class="main">
<div class="head">
<div class="title">
<span id="ps">BTCUSDT</span> • <span id="pt">15M</span>
<small id="info">Sistem hazırlanıyor...</small>
</div>
<div class="pill">● AUTO TRADE KAPALI</div>
</div>
<section class="chartbox">
<div class="charthead">
<b id="cn">BTCUSDT • 15M</b>
<div class="tf">
<button data-t="5m">5M</button>
<button data-t="15m" class="active">15M</button>
<button data-t="1h">1H</button>
<button data-t="2h">2H</button>
<button data-t="4h">4H</button>
</div>
</div>
<div class="chart"><canvas id="cv"></canvas></div>
</section>
</main>
<aside class="right">
<div class="box">
<div class="bt">GENEL PİYASA</div>
<div id="reg" class="reg">YATAY / KARIŞIK</div>
<div id="mi" class="mi">Analiz ediliyor...</div>
</div>
<div class="box">
<div class="bt">AKTİF SCALP SİNYALİ</div>
<div id="active"><div class="empty">Henüz teyit edilmiş sinyal yok.</div></div>
</div>
<div class="box">
<div class="bt">BEKLEYEN KIRILIM / RETEST</div>
<div id="pending" class="pending"><div class="empty">Bekleyen setup yok.</div></div>
</div>
</aside>
</div>
<script>
(function(){
var S={selected:'BTC/USDT:USDT',tf:'15m',candles:[],signal:null};
function $(id){return document.getElementById(id);}
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function p(v){var x=Number(v);if(!Number.isFinite(x))return '-';if(x>=1000)return x.toFixed(2);if(x>=100)return x.toFixed(3);if(x>=1)return x.toFixed(5);if(x>=.01)return x.toFixed(7);if(x>=.0001)return x.toFixed(8);return x.toFixed(10);}
function normalize(a){return (a||[]).map(function(x){return Array.isArray(x)?{time:+x[0],open:+x[1],high:+x[2],low:+x[3],close:+x[4],volume:+(x[5]||0)}:{time:+x.time,open:+x.open,high:+x.high,low:+x.low,close:+x.close,volume:+(x.volume||0)};}).filter(function(x){return Number.isFinite(x.time)&&Number.isFinite(x.open)&&Number.isFinite(x.high)&&Number.isFinite(x.low)&&Number.isFinite(x.close);}).sort(function(a,b){return a.time-b.time;});}
function render(data){
var st=data.stats||{};
$('u').textContent=st.universe||0;$('c').textContent=st.candidates||0;$('d').textContent=st.deep||0;
$('info').textContent=data.lastScan?'Son tarama: '+new Date(data.lastScan).toLocaleTimeString('tr-TR'):'Tarama bekleniyor...';
var m=data.market||{};
$('reg').textContent=m.label||'YATAY / KARIŞIK';
$('reg').className='reg '+(m.direction==='LONG'?'long':m.direction==='SHORT'?'short':'');
$('mi').innerHTML='Breadth %'+esc(m.breadth)+' • Yeşil '+esc(m.green)+' • Kırmızı '+esc(m.red)+'<br>Ortalama '+esc(m.average)+'%<br>BTC 1H '+esc(m.btc)+' • ETH 1H '+esc(m.eth);
var cards=$('cards');cards.innerHTML='';
var arr=data.signals||[];
if(!arr.length){cards.innerHTML='<div class="empty">Teyit edilmiş sinyal yok.</div>';}
arr.forEach(function(s){
var el=document.createElement('div');
el.className='card '+(s.direction==='SHORT'?'short':'')+(s.marketSymbol===S.selected?' active':'');
el.innerHTML='<div class="top"><div class="coin">'+esc(s.symbol)+'</div><div class="badge '+(s.direction==='LONG'?'long':'short')+'">'+esc(s.direction)+'</div></div><div class="cp">'+p(s.currentPrice||s.entry)+'</div><div class="meta">● GİRİŞ ALANI • GÜÇ '+esc(s.score)+'/100</div>';
el.onclick=function(){S.selected=s.marketSymbol;S.signal=s;loadChart();};
cards.appendChild(el);
});
var selected=arr.find(function(x){return x.marketSymbol===S.selected;})||arr[0]||null;
if(selected){S.selected=selected.marketSymbol;S.signal=selected;setActive(selected);}else{setActive(null);}
$('pending').innerHTML=(data.pending&&data.pending.length)?data.pending.map(function(x){return '<div class="pi"><b>'+esc(x.symbol)+' '+esc(x.direction)+'</b><br>Seviye '+esc(x.level)+' • '+esc(x.status)+'</div>';}).join(''):'<div class="empty">Bekleyen setup yok.</div>';
if(data.chart){S.candles=normalize(data.chart.candles);S.signal=data.chart.signal||S.signal;S.selected=data.chart.symbol||S.selected;S.tf=data.chart.timeframe||S.tf;updateHeader();draw();}
if(data.error){$('info').textContent='HATA: '+data.error;}
}
function setActive(s){
if(!s){$('active').innerHTML='<div class="empty">Henüz teyit edilmiş sinyal yok.</div>';return;}
var cl=s.direction==='LONG'?'longtxt':'shorttxt';
$('active').innerHTML='<div class="an '+cl+'">'+esc(s.symbol)+' • '+esc(s.direction)+'</div><div class="grid">'+
'<div class="lv entry"><span>GİRİŞ</span><b>'+p(s.entryLow)+' — '+p(s.entryHigh)+'</b></div>'+
'<div class="lv stop"><span>STOP</span><b>'+p(s.stop)+'</b></div>'+
'<div class="lv tp"><span>TP1</span><b>'+p(s.tp1)+'</b></div>'+
'<div class="lv tp"><span>TP2</span><b>'+p(s.tp2)+'</b></div>'+
'<div class="lv tp"><span>TP3</span><b>'+p(s.tp3)+'</b></div>'+
'<div class="lv"><span>R:R</span><b>1:'+esc(s.rr)+'</b></div></div>'+
'<div class="mi">'+esc(s.status||'GİRİŞ ALANI')+' • SKOR '+esc(s.score)+'/100<br>RSI '+esc(s.rsi)+' • VOL '+esc(s.volumeRatio)+'x<br>'+esc(s.reason||'')+'</div>';
}
function updateHeader(){var sym=String(S.selected||'BTCUSDT').replace('/USDT:USDT','USDT');$('ps').textContent=sym;$('pt').textContent=String(S.tf).toUpperCase();$('cn').textContent=sym+' • '+String(S.tf).toUpperCase();}
async function loadChart(){
try{
var r=await fetch('/api/chart?symbol='+encodeURIComponent(S.selected)+'&timeframe='+encodeURIComponent(S.tf),{cache:'no-store'});
var d=await r.json();
if(!d.success)return;
S.candles=normalize(d.candles);S.signal=d.signal||S.signal;S.selected=d.symbol||S.selected;S.tf=d.timeframe||S.tf;updateHeader();draw();
}catch(e){console.error('chart',e);}
}
function draw(){
var c=$('cv');var r=c.getBoundingClientRect();var dpr=devicePixelRatio||1;
var w=Math.max(300,Math.floor(r.width));var h=Math.max(300,Math.floor(r.height));
c.width=w*dpr;c.height=h*dpr;
var x=c.getContext('2d');x.setTransform(dpr,0,0,dpr,0,0);
x.fillStyle='#070b11';x.fillRect(0,0,w,h);
if(!S.candles.length){x.fillStyle='#718096';x.font='13px Arial';x.fillText('Grafik verisi bekleniyor...',18,30);return;}
var visible=S.candles.slice(-140);
var values=[];visible.forEach(function(k){values.push(k.high,k.low);});
var s=S.signal;
if(s){[s.entryLow,s.entryHigh,s.entry,s.stop,s.tp1,s.tp2,s.tp3].forEach(function(q){if(Number.isFinite(Number(q)))values.push(Number(q));});}
var min=Math.min.apply(Math,values);var max=Math.max.apply(Math,values);
var pad=(max-min)*.07||1;min-=pad;max+=pad;
var L=55,R=85,T=20,B=22;
var volumeHeight=50;
var chartBottom=h-B-volumeHeight-10;
var PW=w-L-R;var PH=chartBottom-T;
function Y(q){return T+(max-q)/(max-min)*PH;}
function X(i){return L+i*PW/Math.max(1,visible.length-1);}
x.strokeStyle='#182330';x.lineWidth=1;
for(var g=0;g<=5;g++){var gy=T+PH*g/5;x.beginPath();x.moveTo(L,gy);x.lineTo(w-R,gy);x.stroke();x.fillStyle='#607083';x.font='9px Arial';x.fillText(p(max-(max-min)*g/5),5,gy+3);}
var step=PW/Math.max(1,visible.length-1);var bw=Math.max(2,Math.min(9,step*.62));
visible.forEach(function(k,i){
var xx=X(i);var up=k.close>=k.open;var col=up?'#13e0a2':'#ff4d6d';
x.strokeStyle=col;x.fillStyle=col;
x.beginPath();x.moveTo(xx,Y(k.high));x.lineTo(xx,Y(k.low));x.stroke();
var yo=Y(k.open);var yc=Y(k.close);
x.fillRect(xx-bw/2,Math.min(yo,yc),bw,Math.max(1,Math.abs(yc-yo)));
});
var maxVol=Math.max.apply(Math,visible.map(function(k){return k.volume;}))||1;
x.fillStyle='#101826';x.fillRect(L,chartBottom+10,PW,volumeHeight);
x.strokeStyle='#182330';x.strokeRect(L,chartBottom+10,PW,volumeHeight);
visible.forEach(function(k,i){
var vh=(k.volume/maxVol)*volumeHeight;
x.fillStyle=k.close>=k.open?'rgba(19,224,162,0.6)':'rgba(255,77,109,0.6)';
x.fillRect(X(i)-bw/2,chartBottom+10+volumeHeight-vh,bw,vh);
});
if(s){
level(s.stop,'#ff4d6d','STOP');
level(s.entry,'#13e0a2','GİRİŞ');
level(s.tp1,'#4da3ff','TP1');
level(s.tp2,'#4da3ff','TP2');
level(s.tp3,'#4da3ff','TP3');
if(s.entryLow!==s.entryHigh){x.fillStyle='rgba(19,224,162,.10)';var a=Y(s.entryLow);var b=Y(s.entryHigh);x.fillRect(L,Math.min(a,b),PW,Math.abs(a-b));}
}
function level(q,col,label){
if(!Number.isFinite(Number(q)))return;
var yy=Y(Number(q));
x.strokeStyle=col;x.setLineDash([6,5]);
x.beginPath();x.moveTo(L,yy);x.lineTo(w-R,yy);x.stroke();
x.setLineDash([]);x.fillStyle=col;x.font='bold 9px Arial';
x.fillText(label+' '+p(q),w-R+5,yy+3);
}
}
Array.prototype.forEach.call(document.querySelectorAll('[data-t]'),function(b){
b.onclick=function(){Array.prototype.forEach.call(document.querySelectorAll('[data-t]'),function(z){z.classList.remove('active');});b.classList.add('active');S.tf=b.getAttribute('data-t');loadChart();};
});
function connect(){
var proto=location.protocol==='https:'?'wss://':'ws://';
var ws=new WebSocket(proto+location.host);
ws.onmessage=function(e){try{var m=JSON.parse(e.data);if(m.type==='snapshot')render(m.data);}catch(_){}};
ws.onclose=function(){setTimeout(connect,2500);};
}
connect();
fetch('/api/status',{cache:'no-store'}).then(function(r){return r.json();}).then(render).catch(function(){});
window.addEventListener('resize',draw);
setInterval(loadChart,5000);
})();
</script>
</body>
</html>`;

// ========================= SERVER START =========================
app.get('/', (req, res) => {
    res.type('html').send(HTML);
});

process.on('unhandledRejection', e => {
    STATE.lastError = e?.message || String(e);
    console.error('UNHANDLED', e);
});
process.on('uncaughtException', e => {
    STATE.lastError = e?.message || String(e);
    console.error('UNCAUGHT', e);
});

server.listen(PORT, '0.0.0.0', async () => {
    console.log('==============================================');
    console.log('🚀 SONNY AI TRADER FINAL');
    console.log('📡 Bitget USDT Futures');
    console.log('🛰️ Radar: ' + CFG.RADAR + ' Coin');
    console.log('🎯 Candidate: ' + CFG.CANDIDATES);
    console.log('🔬 Deep: ' + CFG.DEEP);
    console.log('📊 4H + 2H → 15M Breakout → Retest → 5M');
    console.log('💰 Minimum Volume: $' + CFG.MIN_VOLUME_USDT);
    console.log('🎯 Minimum R:R: 1:' + CFG.MIN_RR);
    console.log('⏱️ Scan: 60 sec');
    console.log('🤖 Auto Trade: KAPALI');
    console.log('🌐 Port: ' + PORT);
    if (API_TOKEN) console.log('🔑 API Token koruması aktif');
    console.log('==============================================');

    try {
        await loadMarketsWithRetry();
        console.log('MARKETS | Gerçek USDT perpetual=' + STATE.markets.length);
        await runScan();
    } catch (e) {
        STATE.lastError = e.message;
        console.error('BOOT ERROR', e.message);
    }

    setTimeout(() => {
        setInterval(() => runScan().catch(e => {
            STATE.lastError = e.message;
            console.error('SCAN LOOP', e.message);
        }), CFG.SCAN_MS);
    }, 5000);

    setInterval(() => updateLiveSignals().catch(e => console.error('LIVE LOOP', e.message)), CFG.LIVE_MS);
});
