'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = Number(process.env.PORT || 10000);

// Bu sunucu yalnızca sinyal üretir. Emir göndermez ve API anahtarı kullanmaz.
const CFG = {
    SCAN_INTERVAL_MS: 30 * 1000,
    LIVE_UPDATE_INTERVAL_MS: 3 * 1000,
    TIMEFRAME: '5m',
    CANDLE_LIMIT: 100,

    MIN_VOLUME_USDT: 5_000_000,
    MAX_CANDIDATES: 30,
    MAX_SETUPS: 8,

    BOX_CANDLES: 12,
    ATR_PERIOD: 14,
    COMPRESSION_RATIO_MAX: 0.90,
    MAX_BOX_WIDTH_PCT: 1.50,
    WATCH_DISTANCE_PCT: 0.35,
    BREAKOUT_BUFFER_PCT: 0.03,

    WATCH_SCORE_MIN: 55,
    WATCH_TTL_MS: 20 * 60 * 1000,
    FIRED_TTL_MS: 10 * 60 * 1000,
    FINISHED_RETENTION_MS: 2 * 60 * 1000,

    OI_HISTORY_MS: 5 * 60 * 1000,
    OI_LOOKBACK_MS: 3 * 60 * 1000,
    OI_QUERY_DELAY_MS: 100,

    STOP_ATR_BUFFER: 0.25,
    TP1_R: 1.20,
    TP2_R: 2.00
};

const exchange = new ccxt.bitget({
    enableRateLimit: true,
    timeout: 30000,
    options: { defaultType: 'swap' }
});

let setups = [];
let isScanning = false;
let isUpdatingPrices = false;
let isShuttingDown = false;
let scanTimer;
let liveTimer;

const oiHistory = new Map();
const recentWarnings = new Map();

app.disable('x-powered-by');
app.use((req, res, next) => {
    res.set({
        'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store'
    });
    next();
});

function number(value, decimals = 8) {
    const result = Number(value);
    return Number.isFinite(result) ? Number(result.toFixed(decimals)) : 0;
}

function average(values) {
    return values.length
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : 0;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function warnOnce(key, error, cooldownMs = 60 * 1000) {
    const now = Date.now();

    if (now - (recentWarnings.get(key) || 0) < cooldownMs) return;

    recentWarnings.set(key, now);
    console.warn('[' + new Date(now).toISOString() + '] ' + key + ': ' + error.message);
}

function formatPrice(value) {
    const price = Number(value);

    if (!Number.isFinite(price)) return '-';
    if (price >= 1000) return price.toFixed(2);
    if (price >= 100) return price.toFixed(3);
    if (price >= 1) return price.toFixed(5);
    if (price >= 0.01) return price.toFixed(7);

    return price.toFixed(8);
}

function percentDistance(from, to) {
    if (!from) return 100;
    return Math.abs(to - from) / from * 100;
}

function calculateATR(candles, period = CFG.ATR_PERIOD) {
    if (candles.length < period + 1) return null;

    const trueRanges = [];

    for (let index = 1; index < candles.length; index++) {
        const high = Number(candles[index][2]);
        const low = Number(candles[index][3]);
        const previousClose = Number(candles[index - 1][4]);

        trueRanges.push(Math.max(
            high - low,
            Math.abs(high - previousClose),
            Math.abs(low - previousClose)
        ));
    }

    return average(trueRanges.slice(-period));
}

function calculateEMA(values, period) {
    if (values.length < period) return null;

    const multiplier = 2 / (period + 1);
    let ema = average(values.slice(0, period));

    for (let index = period; index < values.length; index++) {
        ema = (values[index] - ema) * multiplier + ema;
    }

    return ema;
}

function calculateVolumeRatio(candles, timeframeMs) {
    if (candles.length < 22) return 0;

    const current = candles[candles.length - 1];
    const previous = candles.slice(-21, -1);
    const averageVolume = average(previous.map(candle => Number(candle[5])));

    if (!averageVolume) return 0;

    const elapsed = Date.now() - Number(current[0]);
    const progress = elapsed < timeframeMs
        ? Math.max(0.25, Math.min(1, elapsed / timeframeMs))
        : 1;

    return Number(current[5]) / progress / averageVolume;
}

function getSnapshot() {
    const active = setups.filter(setup => setup.state === 'WATCH' || setup.state === 'FIRE');

    return {
        setups,
        stats: {
            total: active.length,
            watch: active.filter(setup => setup.state === 'WATCH').length,
            fire: active.filter(setup => setup.state === 'FIRE').length
        },
        scanning: isScanning,
        updatedAt: Date.now()
    };
}

function broadcast() {
    const payload = JSON.stringify({
        type: 'snapshot',
        data: getSnapshot()
    });

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(payload);
            } catch {}
        }
    });
}

async function getCandles(symbol) {
    try {
        const candles = await exchange.fetchOHLCV(
            symbol,
            CFG.TIMEFRAME,
            undefined,
            CFG.CANDLE_LIMIT
        );

        return Array.isArray(candles)
            ? candles
                .filter(candle => Array.isArray(candle) && candle.length >= 6)
                .sort((left, right) => left[0] - right[0])
            : [];
    } catch (error) {
        warnOnce('Mum verisi alınamadı (' + symbol + ')', error);
        return [];
    }
}

async function getOpenInterest(symbol) {
    try {
        const result = await exchange.fetchOpenInterest(symbol);
        const value = Number(
            result?.openInterestAmount ||
            result?.openInterest ||
            result?.amount ||
            0
        );

        if (Number.isFinite(value) && value > 0) return value;
    } catch (error) {
        warnOnce('CCXT OI sorgusu başarısız', error);
    }

    try {
        const marketSymbol = symbol
            .replace(':USDT', '')
            .replace('/', '')
            .replace('USDT', '') + 'USDT';

        const url = 'https://api.bitget.com/api/v2/mix/market/open-interest?symbol=' +
            encodeURIComponent(marketSymbol) +
            '&productType=usdt-futures';

        const response = await fetch(url, {
            signal: AbortSignal.timeout(8000)
        });

        if (!response.ok) return 0;

        const data = await response.json();
        const item = data?.data?.openInterestList?.[0];
        const value = Number(item?.size || 0);

        return Number.isFinite(value) && value > 0 ? value : 0;
    } catch (error) {
        warnOnce('Bitget OI yedek sorgusu başarısız', error);
        return 0;
    }
}

function updateOIHistory(symbol, value) {
    if (!Number.isFinite(value) || value <= 0) return 0;

    const now = Date.now();
    const history = oiHistory.get(symbol) || [];

    history.push({ value, timestamp: now });

    const retained = history.filter(item => now - item.timestamp <= CFG.OI_HISTORY_MS);
    oiHistory.set(symbol, retained);

    const reference = retained
        .filter(item => now - item.timestamp >= CFG.OI_LOOKBACK_MS)
        .at(-1);

    if (!reference?.value) return 0;

    return ((value - reference.value) / reference.value) * 100;
}

function cleanOIHistory() {
    const cutoff = Date.now() - CFG.OI_HISTORY_MS;

    for (const [symbol, history] of oiHistory.entries()) {
        const retained = history.filter(item => item.timestamp >= cutoff);

        if (retained.length) oiHistory.set(symbol, retained);
        else oiHistory.delete(symbol);
    }
}

function buildSetup(direction, symbol, price, data) {
    const isLong = direction === 'LONG';
    const trigger = isLong
        ? data.boxHigh * (1 + CFG.BREAKOUT_BUFFER_PCT / 100)
        : data.boxLow * (1 - CFG.BREAKOUT_BUFFER_PCT / 100);

    const stop = isLong
        ? data.boxLow - data.atr * CFG.STOP_ATR_BUFFER
        : data.boxHigh + data.atr * CFG.STOP_ATR_BUFFER;

    const risk = Math.abs(trigger - stop);

    if (!Number.isFinite(risk) || risk <= 0) return null;

    const tp1 = isLong
        ? trigger + risk * CFG.TP1_R
        : trigger - risk * CFG.TP1_R;

    const tp2 = isLong
        ? trigger + risk * CFG.TP2_R
        : trigger - risk * CFG.TP2_R;

    return {
        id: symbol + ':' + direction,
        symbol,
        direction,
        state: 'WATCH',

        currentPrice: price,
        trigger,
        stop,
        tp1,
        tp2,

        boxHigh: data.boxHigh,
        boxLow: data.boxLow,
        boxWidthPct: data.boxWidthPct,
        compressionRatio: data.compressionRatio,
        volumeRatio: data.volumeRatio,
        oiChangePct: data.oiChangePct,
        score: data.score,

        reason: data.reason,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        expiresAt: Date.now() + CFG.WATCH_TTL_MS
    };
}

async function analyzeCandidate(candidate) {
    const candles = await getCandles(candidate.symbol);

    if (candles.length < 70) return [];

    const closed = candles.slice(0, -1);
    const currentPrice = number(candidate.ticker.last);

    if (!currentPrice || closed.length < 60) return [];

    const box = closed.slice(-CFG.BOX_CANDLES);
    const boxHigh = Math.max(...box.map(candle => Number(candle[2])));
    const boxLow = Math.min(...box.map(candle => Number(candle[3])));
    const boxWidthPct = (boxHigh - boxLow) / boxHigh * 100;

    if (boxWidthPct > CFG.MAX_BOX_WIDTH_PCT) return [];

    const recentATR = calculateATR(closed.slice(-20));
    const olderATR = calculateATR(closed.slice(-40, -20));

    if (!recentATR || !olderATR || olderATR <= 0) return [];

    const compressionRatio = recentATR / olderATR;

    if (compressionRatio > CFG.COMPRESSION_RATIO_MAX) return [];

    const closes = closed.map(candle => Number(candle[4]));
    const ema20 = calculateEMA(closes, 20);
    const ema50 = calculateEMA(closes, 50);
    const volumeRatio = calculateVolumeRatio(candles, 5 * 60 * 1000);

    const longDistance = (boxHigh - currentPrice) / boxHigh * 100;
    const shortDistance = (currentPrice - boxLow) / boxLow * 100;

    const candidates = [];

    if (longDistance >= 0 && longDistance <= CFG.WATCH_DISTANCE_PCT) {
        candidates.push({
            direction: 'LONG',
            distancePct: longDistance,
            trendAligned: ema20 > ema50
        });
    }

    if (shortDistance >= 0 && shortDistance <= CFG.WATCH_DISTANCE_PCT) {
        candidates.push({
            direction: 'SHORT',
            distancePct: shortDistance,
            trendAligned: ema20 < ema50
        });
    }

    if (!candidates.length) return [];

    const oi = await getOpenInterest(candidate.symbol);
    const oiChangePct = updateOIHistory(candidate.symbol, oi);
    const results = [];

    for (const item of candidates) {
        let score = 0;

        if (boxWidthPct < 0.80) score += 20;
        else if (boxWidthPct < 1.20) score += 15;
        else score += 10;

        if (compressionRatio < 0.70) score += 20;
        else score += 12;

        if (item.distancePct < 0.10) score += 20;
        else if (item.distancePct < 0.25) score += 15;
        else score += 10;

        if (volumeRatio >= 1.50) score += 15;
        else if (volumeRatio >= 1.20) score += 10;
        else score += 4;

        if (item.trendAligned) score += 15;

        if (oiChangePct >= 0.15) score += 15;
        else if (Math.abs(oiChangePct) >= 0.05) score += 6;

        if (score < CFG.WATCH_SCORE_MIN) continue;

        const reason = [
            '5M sıkışma',
            'banda yakın fiyat',
            item.trendAligned ? 'trend uyumu' : 'nötr trend',
            'hacim ' + volumeRatio.toFixed(1) + 'x',
            'OI ' + oiChangePct.toFixed(2) + '%'
        ].join(' · ');

        const setup = buildSetup(item.direction, candidate.symbol, currentPrice, {
            boxHigh,
            boxLow,
            boxWidthPct,
            compressionRatio,
            volumeRatio,
            oiChangePct,
            score: Math.min(score, 100),
            atr: recentATR,
            reason
        });

        if (setup) results.push(setup);
    }

    return results;
}

async function mapWithConcurrency(items, limit, mapper) {
    const results = [];
    let cursor = 0;

    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
            const index = cursor++;
            results[index] = await mapper(items[index]);
        }
    });

    await Promise.all(workers);
    return results.flat();
}

function upsertSetup(nextSetup) {
    const existing = setups.find(setup => setup.id === nextSetup.id);

    if (!existing) {
        setups.unshift(nextSetup);
        return;
    }

    if (existing.state === 'FIRE') return;

    Object.assign(existing, nextSetup, {
        state: 'WATCH',
        createdAt: existing.createdAt,
        updatedAt: Date.now(),
        expiresAt: Date.now() + CFG.WATCH_TTL_MS
    });
}

function expireOldSetups() {
    const now = Date.now();

    setups.forEach(setup => {
        if (setup.state === 'WATCH' && now > setup.expiresAt) {
            setup.state = 'CANCEL';
            setup.cancelReason = 'Süre doldu, kırılım gerçekleşmedi.';
            setup.finishedAt = now;
        }

        if (
            setup.state === 'FIRE' &&
            now - setup.firedAt > CFG.FIRED_TTL_MS
        ) {
            setup.state = 'EXPIRED';
            setup.cancelReason = 'FIRE bildirimi süresi doldu.';
            setup.finishedAt = now;
        }
    });

    setups = setups
        .filter(setup =>
            !setup.finishedAt ||
            now - setup.finishedAt < CFG.FINISHED_RETENTION_MS
        )
        .sort((left, right) => {
            const stateOrder = { FIRE: 0, WATCH: 1, CANCEL: 2, EXPIRED: 3 };
            return stateOrder[left.state] - stateOrder[right.state];
        })
        .slice(0, CFG.MAX_SETUPS);
}

async function runScan() {
    if (isScanning || isShuttingDown) return;

    isScanning = true;

    try {
        const tickers = await exchange.fetchTickers();

        const candidates = Object.entries(tickers)
            .filter(([symbol, ticker]) => {
                return symbol.endsWith(':USDT') &&
                    number(ticker.quoteVolume) >= CFG.MIN_VOLUME_USDT &&
                    number(ticker.last) > 0;
            })
            .map(([symbol, ticker]) => ({ symbol, ticker }))
            .sort((left, right) => {
                return number(right.ticker.quoteVolume) - number(left.ticker.quoteVolume);
            })
            .slice(0, CFG.MAX_CANDIDATES);

        const discovered = await mapWithConcurrency(
            candidates,
            3,
            analyzeCandidate
        );

        discovered
            .sort((left, right) => right.score - left.score)
            .slice(0, CFG.MAX_SETUPS)
            .forEach(upsertSetup);

        cleanOIHistory();
        expireOldSetups();
        broadcast();

        console.log(
            '[' + new Date().toLocaleTimeString('tr-TR') + '] ' +
            'Tarama tamamlandı | Watch: ' +
            setups.filter(setup => setup.state === 'WATCH').length +
            ' | Fire: ' +
            setups.filter(setup => setup.state === 'FIRE').length
        );
    } catch (error) {
        warnOnce('Watch taraması başarısız', error);
    } finally {
        isScanning = false;
    }
}

async function updateLivePrices() {
    if (isUpdatingPrices || isShuttingDown) return;

    isUpdatingPrices = true;

    try {
        const tickers = await exchange.fetchTickers();
        const now = Date.now();
        let changed = false;

        for (const setup of setups) {
            if (setup.state !== 'WATCH' && setup.state !== 'FIRE') continue;

            const price = number(tickers[setup.symbol]?.last);
            if (price <= 0) continue;

            setup.currentPrice = price;
            setup.updatedAt = now;

            if (setup.state === 'WATCH') {
                const fired = setup.direction === 'LONG'
                    ? price >= setup.trigger
                    : price <= setup.trigger;

                const invalidated = setup.direction === 'LONG'
                    ? price < setup.boxLow
                    : price > setup.boxHigh;

                const movedAway = setup.direction === 'LONG'
                    ? percentDistance(setup.boxHigh, price) > CFG.WATCH_DISTANCE_PCT * 1.5
                    : percentDistance(setup.boxLow, price) > CFG.WATCH_DISTANCE_PCT * 1.5;

                if (fired) {
                    setup.state = 'FIRE';
                    setup.firedAt = now;
                    changed = true;

                    console.log(
                        'FIRE ' + setup.direction +
                        ' | ' + setup.symbol +
                        ' | ' + formatPrice(price)
                    );
                } else if (invalidated) {
                    setup.state = 'CANCEL';
                    setup.cancelReason = 'Fiyat sıkışma kutusunun ters tarafına geçti.';
                    setup.finishedAt = now;
                    changed = true;
                } else if (movedAway) {
                    setup.state = 'CANCEL';
                    setup.cancelReason = 'Fiyat giriş bandından uzaklaştı.';
                    setup.finishedAt = now;
                    changed = true;
                }
            }
        }

        expireOldSetups();

        if (changed) broadcast();
    } catch (error) {
        warnOnce('Canlı fiyat güncellemesi başarısız', error);
    } finally {
        isUpdatingPrices = false;
    }
}

app.get('/api/setups', (req, res) => {
    res.json({ success: true, ...getSnapshot() });
});

app.get('/health', (req, res) => {
    res.json({
        ok: true,
        scanning: isScanning,
        setupCount: setups.length,
        now: new Date().toISOString()
    });
});

const HTML = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Manual Breakout Radar</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#070b11;color:#dbe4ee;font-family:Arial,sans-serif}.app{display:grid;grid-template-columns:390px 1fr;min-height:100vh}.side{background:#0b111b;border-right:1px solid #1a2533;padding:16px}.brand{font-size:18px;font-weight:900;color:#20e6a8}.sub{font-size:11px;color:#8492a6;margin:5px 0 15px}.stats{display:flex;gap:8px;margin-bottom:12px}.stat{flex:1;padding:9px;background:#101826;border-radius:8px;text-align:center}.stat b{display:block;font-size:18px;color:#20e6a8}.stat span{font-size:9px;color:#718096}.list{display:flex;flex-direction:column;gap:8px}.card{padding:13px;border:1px solid #1c2938;border-left:4px solid #64748b;border-radius:9px;background:#101826;cursor:pointer}.card:hover,.card.selected{border-color:#20e6a8;background:#0d1a15}.card.long{border-left-color:#20e6a8}.card.short{border-left-color:#ff5570}.card.fire{box-shadow:0 0 20px rgba(251,191,36,.22);border-color:#fbbf24}.top{display:flex;justify-content:space-between;gap:8px}.coin{font-weight:900}.badge{font-size:10px;font-weight:bold;padding:3px 8px;border-radius:12px}.watch{background:#0d3d2a;color:#20e6a8}.fire{background:#3d2d0d;color:#fbbf24}.cancel,.expired{background:#2d1d1d;color:#ff5570}.meta{display:flex;flex-wrap:wrap;gap:7px;margin-top:8px;font-size:10px;color:#9ba9ba}.score{color:#f1f5f9;font-weight:bold}.main{padding:28px;max-width:900px}.empty{color:#718096;text-align:center;padding:60px 20px}.title{font-size:28px;font-weight:900;color:#20e6a8}.notice{margin-top:8px;color:#9ba9ba;font-size:13px;line-height:1.5}.panel{margin-top:24px;background:#101826;border:1px solid #1c2938;border-radius:12px;padding:20px}.levels{display:grid;grid-template-columns:repeat(2,minmax(140px,1fr));gap:10px;margin-top:20px}.level{padding:12px;background:#0b111b;border-radius:8px}.level span{display:block;font-size:10px;color:#718096}.level b{display:block;margin-top:5px;font-size:17px}.green{color:#20e6a8}.red{color:#ff5570}.blue{color:#60a5fa}.yellow{color:#fbbf24}.copy{margin-top:18px;border:0;border-radius:7px;padding:10px 14px;background:#20e6a8;color:#052018;font-weight:bold;cursor:pointer}@media(max-width:800px){.app{grid-template-columns:1fr}.side{border-right:0;border-bottom:1px solid #1a2533}.main{padding:16px}.levels{grid-template-columns:1fr 1fr}}
</style>
</head>
<body>
<div class="app">
<aside class="side">
  <div class="brand">MANUAL BREAKOUT RADAR</div>
  <div class="sub">Emir göndermez · WATCH ile hazırlan, FIRE gelince karar ver</div>
  <div class="stats">
    <div class="stat"><b id="total">0</b><span>Aktif</span></div>
    <div class="stat"><b id="watch">0</b><span>WATCH</span></div>
    <div class="stat"><b id="fire">0</b><span>FIRE</span></div>
  </div>
  <div class="list" id="list"><div class="empty">Tarama başlıyor...</div></div>
</aside>
<main class="main">
  <div class="title">Erken Kurulum Radarı</div>
  <div class="notice">WATCH: seviyeleri hazırla. FIRE: kırılım gerçekleşti; giriş kararı tamamen sende.</div>
  <div class="panel" id="details"><div class="empty">Soldan bir kurulum seç.</div></div>
</main>
</div>
<script>
var setups=[];var selectedId=null;var connected=false;
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function price(v){var n=Number(v);if(!Number.isFinite(n))return '-';if(n>=1000)return n.toFixed(2);if(n>=100)return n.toFixed(3);if(n>=1)return n.toFixed(5);return n.toFixed(8)}
function render(data){setups=Array.isArray(data.setups)?data.setups:[];var stats=data.stats||{};document.getElementById('total').textContent=stats.total||0;document.getElementById('watch').textContent=stats.watch||0;document.getElementById('fire').textContent=stats.fire||0;var list=document.getElementById('list');if(!setups.length){list.innerHTML='<div class="empty">Şu an hazırlanacak kurulum yok.</div>';document.getElementById('details').innerHTML='<div class="empty">WATCH sinyali bekleniyor...</div>';return}list.innerHTML=setups.map(function(s){var state=s.state.toLowerCase();var direction=s.direction==='LONG'?'long':'short';return '<div class="card '+direction+' '+state+(selectedId===s.id?' selected':'')+'" data-id="'+esc(s.id)+'"><div class="top"><span class="coin">'+esc(s.symbol.replace(':USDT',''))+'</span><span class="badge '+state+'">'+esc(s.state)+' '+esc(s.direction)+'</span></div><div class="meta"><span class="score">'+esc(s.score)+'/100</span><span>Fiyat '+price(s.currentPrice)+'</span><span>Hacim '+Number(s.volumeRatio).toFixed(1)+'x</span></div></div>'}).join('');document.querySelectorAll('.card').forEach(function(card){card.onclick=function(){selectedId=this.getAttribute('data-id');showDetails();render(data)}});if(selectedId)showDetails()}
function showDetails(){var s=setups.find(function(x){return x.id===selectedId});if(!s)return;var state=s.state==='FIRE'?'FIRE geldi — kırılım aktif.':'WATCH — fiyat seviyeye yaklaşınca hazırlan.';document.getElementById('details').innerHTML='<div class="top"><div><h2>'+esc(s.symbol.replace(':USDT',''))+' · '+esc(s.direction)+'</h2><div class="notice">'+esc(state)+'</div></div><span class="badge '+esc(s.state.toLowerCase())+'">'+esc(s.state)+'</span></div><div class="levels"><div class="level"><span>ANLIK FİYAT</span><b>'+price(s.currentPrice)+'</b></div><div class="level"><span>GİRİŞ TETİĞİ</span><b class="green">'+price(s.trigger)+'</b></div><div class="level"><span>STOP / GEÇERSİZLİK</span><b class="red">'+price(s.stop)+'</b></div><div class="level"><span>TP1</span><b class="blue">'+price(s.tp1)+'</b></div><div class="level"><span>TP2</span><b class="blue">'+price(s.tp2)+'</b></div><div class="level"><span>KALİTE</span><b class="yellow">'+esc(s.score)+'/100</b></div></div><div class="notice" style="margin-top:18px">'+esc(s.reason)+'</div><button class="copy" onclick="copyLevels()">Seviyeleri Kopyala</button>'}
function copyLevels(){var s=setups.find(function(x){return x.id===selectedId});if(!s)return;var text=s.symbol+' '+s.direction+'\\nTetik: '+price(s.trigger)+'\\nStop: '+price(s.stop)+'\\nTP1: '+price(s.tp1)+'\\nTP2: '+price(s.tp2);navigator.clipboard.writeText(text).catch(function(){})}
function connect(){var proto=location.protocol==='https:'?'wss://':'ws://';var ws=new WebSocket(proto+location.host);ws.onopen=function(){connected=true};ws.onmessage=function(e){try{var msg=JSON.parse(e.data);if(msg.type==='snapshot')render(msg.data)}catch(_){}};ws.onerror=function(){ws.close()};ws.onclose=function(){connected=false;setTimeout(connect,3000)}}
connect();setInterval(function(){if(connected)return;fetch('/api/setups',{cache:'no-store'}).then(function(r){return r.json()}).then(function(d){if(d.success)render(d)}).catch(function(){})},4000);
</script>
</body>
</html>`;

app.get('/', (req, res) => {
    res.type('html').send(HTML);
});

wss.on('connection', ws => {
    ws.on('error', error => warnOnce('Tarayıcı WebSocket hatası', error));

    try {
        ws.send(JSON.stringify({ type: 'snapshot', data: getSnapshot() }));
    } catch {}
});

async function start() {
    try {
        await exchange.loadMarkets();
        console.log('Bitget marketleri yüklendi.');
    } catch (error) {
        console.error('Marketler yüklenemedi; 30 saniye sonra tekrar denenecek:', error.message);
        setTimeout(start, 30 * 1000);
        return;
    }

    void runScan();
    scanTimer = setInterval(runScan, CFG.SCAN_INTERVAL_MS);
    liveTimer = setInterval(() => { void updateLivePrices(); }, CFG.LIVE_UPDATE_INTERVAL_MS);
}

async function shutdown(signal) {
    if (isShuttingDown) return;

    isShuttingDown = true;
    clearInterval(scanTimer);
    clearInterval(liveTimer);

    console.log(signal + ' alındı; servis kapanıyor.');

    wss.clients.forEach(client => client.close(1001, 'Sunucu kapanıyor'));
    wss.close();

    server.close(async () => {
        try {
            await exchange.close();
        } catch {}
        process.exit(0);
    });

    setTimeout(() => process.exit(1), 10 * 1000).unref();
}

server.listen(PORT, '0.0.0.0', () => {
    console.log('Manual Breakout Radar çalışıyor: http://0.0.0.0:' + PORT);
    void start();
});

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
