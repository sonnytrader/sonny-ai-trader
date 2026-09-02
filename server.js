'use strict';
/*
 * COMPRESSION BREAKOUT RADAR v1.0
 * ================================
 * Strateji (tek hipotez, indikatör oylaması YOK):
 *   "Likit Bitget USDT-perp'te ATR'si daralmış (sıkışmış) bir enstrüman,
 *    BTC rejimiyle aynı yönde kutu kenarını KAPANIŞLA kırar, hacim ve OI
 *    teyit ederse, retest sonrası 1.5-2.5R gidebilir."
 *
 * Aynı kutu/ATR event'i "başarısız kırılım" (fade) de üretebilir:
 *   fitil kutu dışına çıkar ama gövde içeride kapanırsa, TERS yönde
 *   likidite avı sinyali. Ayrı motor değil - aynı pipeline'ın dalı.
 *
 * KURALLAR:
 *   - Emir gönderilmez. Sadece WATCH -> teyit -> ENTRY notu üretir.
 *   - Fitil ile FIRE/ENTRY olmaz. Her karar KAPANMIŞ mumla verilir.
 *   - Aynı yönde eş zamanlı en fazla MAX_CONCURRENT_SAME_DIR "gerçek"
 *     (ENTRY) pozisyon sayılır; fazlası "KORELASYONLU" etiketiyle gösterilir.
 *   - Her ENTRY'nin kağıt R sonucu deftere yazılır (TP/SL/time-stop).
 *   - Public data: OHLCV, ticker, open interest. API key YOK.
 */
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = Number(process.env.PORT || 10000);
const DATA_FILE = path.join(__dirname, 'radar_data.json');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ==================== KONFİGÜRASYON ====================
const CFG = {
    // Evren
    MIN_VOLUME_USDT: 20_000_000,
    MAX_CANDIDATES: 60,
    SCAN_CONCURRENCY: 3,

    // Zaman dilimleri
    TF_SIGNAL: '15m',
    TF_REGIME: '1h',
    SIGNAL_CANDLE_LIMIT: 200,   // ATR percentile + EMA200 için yeterli geçmiş
    REGIME_CANDLE_LIMIT: 260,

    // Kutu (Donchian)
    BOX_LOOKBACK: 16,           // sinyal mumundan ÖNCEKİ 16 bar
    MAX_BOX_WIDTH_ATR: 1.2,     // kutu genişliği < 1.2 x ATR olmalı

    // Sıkışma
    ATR_PERIOD: 14,
    ATR_HISTORY_BARS: 100,      // percentile için geçmiş pencere
    COMPRESSION_PERCENTILE_MAX: 25,

    // Teyit eşikleri
    VOLUME_Z_LOOKBACK: 30,
    VOLUME_Z_MIN: 1.5,
    OI_HISTORY_MS: 3 * 60 * 60 * 1000,   // 3 saat
    OI_Z_LOOKBACK_MIN: 12,               // en az 12 örnek biriksin
    OI_Z_MIN: 1.0,

    // Fade (başarısız kırılım)
    FADE_VOLUME_Z_MIN: 1.5,
    FADE_STOP_ATR_BUFFER: 0.25,

    // Retest (breakout -> entry)
    RETEST_MAX_BARS: 6,                  // 6 x 15m = 1.5 saat
    RETEST_TOLERANCE_ATR: 0.15,

    // Risk / hedefler
    STOP_ATR_BUFFER: 0.2,
    TP1_R: 1.0,
    TP2_R: 2.5,
    TIME_STOP_BARS: 12,                  // entry sonrası TP1 gelmezse (3 saat)
    TIME_STOP_BARS_AFTER_TP1: 24,        // TP1 sonrası TP2 gelmezse (6 saat)

    // Korelasyon / portföy
    MAX_CONCURRENT_SAME_DIR: 3,

    // Döngüler
    SCAN_INTERVAL_MS: 60 * 1000,
    LIVE_UPDATE_INTERVAL_MS: 5 * 1000,
    REGIME_REFRESH_MS: 5 * 60 * 1000,

    // Saklama
    FINISHED_RETENTION_MS: 30 * 60 * 1000,
    JOURNAL_MAX_ENTRIES: 300
};

// ==================== KALICILIK (best-effort, JSON) ====================
// NOT: Render gibi platformlarda disk ephemeral olabilir; restart'ta
// state sıfırlanabilir. Kalıcı defter istiyorsan harici DB (Postgres/SQLite
// external volume) kullan. Bu dosya sadece kısa süreli kurtarma içindir.
function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            return {
                setups: data.setups || [],
                journal: data.journal || []
            };
        }
    } catch (e) {
        console.warn('Veri okunamadı:', e.message);
    }
    return { setups: [], journal: [] };
}
function saveData() {
    try {
        const data = {
            setups: setups.filter((s) => !isFinished(s.state) || (Date.now() - (s.finishedAt || 0)) < CFG.FINISHED_RETENTION_MS),
            journal: journal.slice(0, CFG.JOURNAL_MAX_ENTRIES),
            savedAt: Date.now()
        };
        fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), (err) => {
            if (err) console.warn('Veri kayıt hatası:', err.message);
        });
    } catch (e) {
        console.warn('Veri hazırlama hatası:', e.message);
    }
}

// ==================== EXCHANGE (public only) ====================
const exchange = new ccxt.bitget({
    enableRateLimit: true,
    timeout: 20000,
    options: { defaultType: 'swap' }
});

// ==================== STATE ====================
const initial = loadData();
let setups = initial.setups;       // aktif/son kartlar (ALERT/FIRE/ENTRY/FADE/...)
let journal = initial.journal;     // biten her setup için R kaydı (girilmemiş olanlar dahil, rMultiple=null)
let isScanning = false;
let isUpdatingLive = false;
let isShuttingDown = false;
let scanTimer, liveTimer, regimeTimer, gcTimer;

const oiHistory = new Map();       // symbol -> [{ts, value}]
const processedCandles = new Map();// symbol+dir -> son işlenmiş sinyal mumu ts (aynı mumu tekrar yeni kart yapmamak için)
const recentWarnings = new Map();

let regime = { direction: 'NEUTRAL', updatedAt: 0, ema50: null, ema200: null, price: null };

function warnOnce(key, error, cooldownMs = 60 * 1000) {
    const now = Date.now();
    if (now - (recentWarnings.get(key) || 0) < cooldownMs) return;
    recentWarnings.set(key, now);
    console.warn('[' + new Date(now).toISOString() + '] ' + key + ': ' + error.message);
}

function isFinished(state) {
    return ['EXPIRED', 'CANCELLED', 'STOPPED', 'CLOSED_WIN', 'CLOSED_LOSS', 'CLOSED_TIME'].includes(state);
}

// ==================== SAYISAL YARDIMCILAR ====================
function num(v, d = 8) {
    const x = Number(v);
    return Number.isFinite(x) ? Number(x.toFixed(d)) : 0;
}
function mean(arr) {
    return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}
function stddev(arr) {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1);
    return Math.sqrt(variance);
}
function zscore(value, history) {
    if (history.length < 5) return 0;
    const sd = stddev(history);
    if (!sd) return 0;
    return (value - mean(history)) / sd;
}
// percentile rank: history içinde value'dan KÜÇÜK olanların oranı (0-100)
// düşük percentile = mevcut değer tarihsel olarak düşük (sıkışma için istediğimiz)
function percentileRank(history, value) {
    if (!history.length) return 50;
    const below = history.filter((h) => h < value).length;
    return (below / history.length) * 100;
}

// ==================== SERİ İNDİKATÖRLER (tam seri, tek nokta değil) ====================
function emaSeries(values, period) {
    if (values.length < period) return [];
    const k = 2 / (period + 1);
    const out = new Array(values.length).fill(null);
    let prev = mean(values.slice(0, period));
    out[period - 1] = prev;
    for (let i = period; i < values.length; i++) {
        prev = (values[i] - prev) * k + prev;
        out[i] = prev;
    }
    return out;
}
// Wilder ATR - tam seri
function atrSeries(candles, period = CFG.ATR_PERIOD) {
    if (candles.length < period + 1) return [];
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
        const h = Number(candles[i][2]), l = Number(candles[i][3]), pc = Number(candles[i - 1][4]);
        trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    const out = [];
    let atr = mean(trs.slice(0, period));
    out.push(atr);
    for (let i = period; i < trs.length; i++) {
        atr = (atr * (period - 1) + trs[i]) / period;
        out.push(atr);
    }
    return out; // out[k] candles[k+period] mumuna karşılık gelir
}

// ==================== BTC REJİMİ ====================
async function refreshRegime() {
    try {
        const candles = await getCandles('BTC/USDT:USDT', CFG.TF_REGIME, CFG.REGIME_CANDLE_LIMIT);
        if (candles.length < 210) return;
        const closes = candles.map((c) => Number(c[4]));
        const ema50Series = emaSeries(closes, 50);
        const ema200Series = emaSeries(closes, 200);
        const ema50 = ema50Series[ema50Series.length - 1];
        const ema200 = ema200Series[ema200Series.length - 1];
        const price = closes[closes.length - 1];
        if (!ema50 || !ema200) return;

        let direction;
        if (price > ema50 && ema50 > ema200) direction = 'RISK_ON';
        else if (price < ema50 && ema50 < ema200) direction = 'RISK_OFF';
        else direction = 'CHOP';

        regime = { direction, updatedAt: Date.now(), ema50: num(ema50, 2), ema200: num(ema200, 2), price: num(price, 2) };
    } catch (error) {
        warnOnce('Rejim', error);
    }
}

// ==================== MUM VERİSİ ====================
async function getCandles(symbol, timeframe, limit) {
    try {
        const candles = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
        return Array.isArray(candles)
            ? candles.filter((c) => Array.isArray(c) && c.length >= 6).sort((a, b) => a[0] - b[0])
            : [];
    } catch (error) {
        warnOnce('Mum (' + symbol + ')', error);
        return [];
    }
}

// ==================== OPEN INTEREST ====================
async function getOpenInterest(symbol) {
    try {
        const r = await exchange.fetchOpenInterest(symbol);
        const v = Number(r?.openInterestAmount || r?.openInterest || 0);
        if (Number.isFinite(v) && v > 0) return v;
    } catch { /* fallback dene */ }
    try {
        const marketSymbol = symbol.replace(':USDT', '').replace('/', '').replace('USDT', '') + 'USDT';
        const url = 'https://api.bitget.com/api/v2/mix/market/open-interest?symbol=' +
            encodeURIComponent(marketSymbol) + '&productType=usdt-futures';
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return 0;
        const data = await res.json();
        const v = Number(data?.data?.openInterestList?.[0]?.size || 0);
        return Number.isFinite(v) && v > 0 ? v : 0;
    } catch {
        return 0;
    }
}
function pushOI(symbol, value) {
    if (!Number.isFinite(value) || value <= 0) return;
    const now = Date.now();
    const hist = oiHistory.get(symbol) || [];
    hist.push({ ts: now, value });
    const retained = hist.filter((h) => now - h.ts <= CFG.OI_HISTORY_MS);
    oiHistory.set(symbol, retained);
}
function oiZScore(symbol, currentValue) {
    const hist = (oiHistory.get(symbol) || []).map((h) => h.value);
    if (hist.length < CFG.OI_Z_LOOKBACK_MIN) return 0; // yeterli geçmiş yok -> nötr
    return zscore(currentValue, hist);
}
function cleanOIHistory() {
    const cutoff = Date.now() - CFG.OI_HISTORY_MS;
    for (const [symbol, hist] of oiHistory.entries()) {
        const retained = hist.filter((h) => h.ts >= cutoff);
        if (retained.length) oiHistory.set(symbol, retained);
        else oiHistory.delete(symbol);
    }
}

// ==================== FİYAT FORMAT ====================
function fmtPrice(v) {
    const p = Number(v);
    if (!Number.isFinite(p)) return '-';
    if (p >= 1000) return p.toFixed(2);
    if (p >= 100) return p.toFixed(3);
    if (p >= 1) return p.toFixed(5);
    if (p >= 0.01) return p.toFixed(7);
    return p.toFixed(8);
}

// ==================== ANA ANALİZ: kutu + sıkışma + breakout/fade tespiti ====================
function analyzeSymbol(symbol, candles) {
    // Son mum "oluşuyor" olabilir, onu at - sadece KAPANMIŞ mumlarla çalış.
    const closed = candles.slice(0, -1);
    if (closed.length < CFG.BOX_LOOKBACK + CFG.ATR_PERIOD + CFG.ATR_HISTORY_BARS) return null;

    const atrSer = atrSeries(closed, CFG.ATR_PERIOD);
    if (atrSer.length < CFG.ATR_HISTORY_BARS + 2) return null;

    const currentATR = atrSer[atrSer.length - 1];
    if (!Number.isFinite(currentATR) || currentATR <= 0) return null;

    const atrHistoryWindow = atrSer.slice(-CFG.ATR_HISTORY_BARS);
    const atrPercentile = percentileRank(atrHistoryWindow, currentATR);
    const compressed = atrPercentile < CFG.COMPRESSION_PERCENTILE_MAX;

    // Kutu: sinyal mumundan ÖNCEKİ N bar (sinyal mumu kutunun bir parçası DEĞİL)
    const signalCandle = closed[closed.length - 1];
    const boxCandles = closed.slice(-(CFG.BOX_LOOKBACK + 1), -1);
    if (boxCandles.length < CFG.BOX_LOOKBACK) return null;

    const boxHigh = Math.max(...boxCandles.map((c) => Number(c[2])));
    const boxLow = Math.min(...boxCandles.map((c) => Number(c[3])));
    const boxWidth = boxHigh - boxLow;
    const boxOk = boxWidth < CFG.MAX_BOX_WIDTH_ATR * currentATR;

    const open = Number(signalCandle[1]);
    const high = Number(signalCandle[2]);
    const low = Number(signalCandle[3]);
    const close = Number(signalCandle[4]);
    const volume = Number(signalCandle[5]);
    const signalTs = Number(signalCandle[0]);

    // Hacim z-score (sinyal mumu hariç, önceki N bar)
    const volHistory = closed.slice(-(CFG.VOLUME_Z_LOOKBACK + 1), -1).map((c) => Number(c[5]));
    const volumeZ = zscore(volume, volHistory);

    let type = null, direction = null;

    if (close > boxHigh) { type = 'BREAKOUT'; direction = 'LONG'; }
    else if (close < boxLow) { type = 'BREAKOUT'; direction = 'SHORT'; }
    else if (low < boxLow && close >= boxLow && close > open) { type = 'FADE'; direction = 'LONG'; }
    else if (high > boxHigh && close <= boxHigh && close < open) { type = 'FADE'; direction = 'SHORT'; }
    else return null;

    return {
        symbol, type, direction, signalTs,
        signalPrice: close, open, high, low, close, volume,
        boxHigh, boxLow, boxWidth,
        atr: currentATR, atrPercentile: num(atrPercentile, 1),
        compressed, boxOk, volumeZ: num(volumeZ, 2)
    };
}

// ==================== SETUP OLUŞTURMA (breakout -> ALERT/FIRE, fade -> ENTRY) ====================
function buildRiskLevels(direction, boxHigh, boxLow, entryPrice, atr) {
    const isLong = direction === 'LONG';
    const stop = isLong
        ? boxLow - atr * CFG.STOP_ATR_BUFFER
        : boxHigh + atr * CFG.STOP_ATR_BUFFER;
    const risk = Math.abs(entryPrice - stop);
    if (!Number.isFinite(risk) || risk <= 0) return null;
    const tp1 = isLong ? entryPrice + risk * CFG.TP1_R : entryPrice - risk * CFG.TP1_R;
    const tp2 = isLong ? entryPrice + risk * CFG.TP2_R : entryPrice - risk * CFG.TP2_R;
    return { stop, risk, tp1, tp2 };
}

async function evaluateCandidate(candidate) {
    const { symbol, ticker } = candidate;
    await sleep(150);

    const candles = await getCandles(symbol, CFG.TF_SIGNAL, CFG.SIGNAL_CANDLE_LIMIT);
    if (candles.length < 100) return null;

    const sig = analyzeSymbol(symbol, candles);
    if (!sig) return null;

    // Aynı sinyal mumunu tekrar tekrar yeni kart yapma
    const dedupeKey = symbol + ':' + sig.direction + ':' + sig.type;
    const lastTs = processedCandles.get(dedupeKey);
    if (lastTs === sig.signalTs) return null;

    if (sig.type === 'BREAKOUT') {
        if (!sig.compressed || !sig.boxOk) return null; // sıkışma şartı zorunlu
        if (regime.direction === 'CHOP') return null;    // CHOP'ta sessiz
        if (regime.direction === 'RISK_ON' && sig.direction !== 'LONG') return null;
        if (regime.direction === 'RISK_OFF' && sig.direction !== 'SHORT') return null;

        const oiRaw = await getOpenInterest(symbol);
        const oiZ = oiRaw ? oiZScore(symbol, oiRaw) : 0;
        if (oiRaw) pushOI(symbol, oiRaw);

        const oiAligned = sig.direction === 'LONG' ? oiZ >= CFG.OI_Z_MIN : oiZ <= -CFG.OI_Z_MIN;
        const confirmed = sig.volumeZ >= CFG.VOLUME_Z_MIN && oiAligned;

        const levels = buildRiskLevels(sig.direction, sig.boxHigh, sig.boxLow,
            sig.direction === 'LONG' ? sig.boxHigh : sig.boxLow, sig.atr);
        if (!levels) return null;

        processedCandles.set(dedupeKey, sig.signalTs);

        const now = Date.now();
        return {
            id: symbol + ':' + sig.direction + ':' + sig.signalTs,
            symbol, direction: sig.direction, type: 'BREAKOUT',
            state: confirmed ? 'FIRE' : 'ALERT',
            reason: (confirmed ? 'FIRE' : 'ALERT') + ' · Sıkışma %' + sig.atrPercentile.toFixed(0) +
                ' · Hacim z=' + sig.volumeZ.toFixed(2) + ' · OI z=' + num(oiZ, 2),
            boxHigh: sig.boxHigh, boxLow: sig.boxLow, boxWidthAtr: num(sig.boxWidth / sig.atr, 2),
            atr: sig.atr, atrPercentile: sig.atrPercentile,
            volumeZ: sig.volumeZ, oiZ: num(oiZ, 2),
            triggerLevel: sig.direction === 'LONG' ? sig.boxHigh : sig.boxLow,
            currentPrice: sig.signalPrice,
            stop: levels.stop, tp1: levels.tp1, tp2: levels.tp2, risk: levels.risk,
            tp1Hit: false, entryPrice: null,
            signalTs: sig.signalTs,
            retestDeadline: now + CFG.RETEST_MAX_BARS * 15 * 60 * 1000,
            createdAt: now, updatedAt: now
        };
    }

    // FADE - kapanışla zaten teyitli, doğrudan ENTRY
    if (sig.type === 'FADE') {
        if (sig.volumeZ < CFG.FADE_VOLUME_Z_MIN) return null;

        const isLong = sig.direction === 'LONG';
        const wickExtreme = isLong ? sig.low : sig.high;
        const stop = isLong
            ? wickExtreme - sig.atr * CFG.FADE_STOP_ATR_BUFFER
            : wickExtreme + sig.atr * CFG.FADE_STOP_ATR_BUFFER;
        const entryPrice = sig.close;
        const risk = Math.abs(entryPrice - stop);
        if (!Number.isFinite(risk) || risk <= 0) return null;
        const tp1 = isLong ? entryPrice + risk * CFG.TP1_R : entryPrice - risk * CFG.TP1_R;
        const tp2 = isLong ? entryPrice + risk * CFG.TP2_R : entryPrice - risk * CFG.TP2_R;

        processedCandles.set(dedupeKey, sig.signalTs);
        const now = Date.now();
        return {
            id: symbol + ':' + sig.direction + ':FADE:' + sig.signalTs,
            symbol, direction: sig.direction, type: 'FADE',
            state: 'ENTRY',
            reason: 'FADE · kutu dışı fitil, gövde içeride · Hacim z=' + sig.volumeZ.toFixed(2),
            boxHigh: sig.boxHigh, boxLow: sig.boxLow, boxWidthAtr: num(sig.boxWidth / sig.atr, 2),
            atr: sig.atr, atrPercentile: sig.atrPercentile,
            volumeZ: sig.volumeZ, oiZ: null,
            triggerLevel: entryPrice,
            currentPrice: entryPrice,
            stop, tp1, tp2, risk,
            tp1Hit: false, entryPrice,
            signalTs: sig.signalTs,
            entryAt: now,
            createdAt: now, updatedAt: now
        };
    }
    return null;
}

// ==================== RETEST KONTROLÜ (ALERT/FIRE -> ENTRY) ====================
async function checkRetest(setup) {
    if (setup.state !== 'ALERT' && setup.state !== 'FIRE') return;
    const now = Date.now();
    if (now > setup.retestDeadline) {
        setup.state = 'EXPIRED';
        setup.finishedAt = now;
        logJournal(setup, null, 'TIMEOUT_NO_ENTRY');
        return;
    }

    const candles = await getCandles(setup.symbol, CFG.TF_SIGNAL, 20);
    const closed = candles.slice(0, -1).filter((c) => Number(c[0]) > setup.signalTs);
    if (closed.length < 2) return; // henüz yeni mum yok

    const isLong = setup.direction === 'LONG';
    const tolerance = CFG.RETEST_TOLERANCE_ATR * setup.atr;

    for (let i = 0; i < closed.length - 1; i++) {
        const touch = closed[i];
        const confirm = closed[i + 1];
        const touchLow = Number(touch[3]), touchHigh = Number(touch[2]);
        const confirmClose = Number(confirm[4]);

        const touchedEdge = isLong
            ? touchLow <= setup.triggerLevel + tolerance
            : touchHigh >= setup.triggerLevel - tolerance;
        const confirmedDirection = isLong
            ? confirmClose > setup.triggerLevel
            : confirmClose < setup.triggerLevel;

        if (touchedEdge && confirmedDirection) {
            setup.state = 'ENTRY';
            setup.entryPrice = confirmClose;
            setup.entryAt = Date.now();
            setup.updatedAt = Date.now();
            // FIRE'dan geldiyse teyitli seviyeler zaten var; ALERT'ten geldiyse de aynı seviyeler geçerli.
            return;
        }
    }
    // regime bu arada ters döndüyse iptal et (breakout için)
    if (regime.direction !== 'CHOP' &&
        ((setup.direction === 'LONG' && regime.direction === 'RISK_OFF') ||
         (setup.direction === 'SHORT' && regime.direction === 'RISK_ON'))) {
        setup.state = 'CANCELLED';
        setup.finishedAt = Date.now();
        logJournal(setup, null, 'CANCELLED_REGIME_FLIP');
    }
}

// ==================== KORELASYON KAPAĞI ====================
function countConcurrentEntries(direction, excludeId) {
    return setups.filter((s) => s.state === 'ENTRY' || s.state === 'RUNNING' || s.state === 'TP1_HIT')
        .filter((s) => s.direction === direction && s.id !== excludeId).length;
}

// ==================== İŞLEM (ENTRY sonrası) YÖNETİMİ ====================
function manageOpenTrade(setup, livePrice) {
    if (!['ENTRY', 'RUNNING', 'TP1_HIT'].includes(setup.state)) return;
    if (setup.state === 'ENTRY') setup.state = 'RUNNING';

    const isLong = setup.direction === 'LONG';
    const now = Date.now();
    const barsElapsed = (now - setup.entryAt) / (15 * 60 * 1000);

    setup.currentPrice = livePrice;
    setup.updatedAt = now;

    const hitStop = isLong ? livePrice <= setup.stop : livePrice >= setup.stop;
    const hitTp1 = !setup.tp1Hit && (isLong ? livePrice >= setup.tp1 : livePrice <= setup.tp1);
    const hitTp2 = isLong ? livePrice >= setup.tp2 : livePrice <= setup.tp2;

    if (!setup.tp1Hit && hitStop) {
        setup.state = 'CLOSED_LOSS';
        setup.finishedAt = now;
        setup.exitPrice = setup.stop;
        logJournal(setup, -1.0, 'STOP');
        return;
    }
    if (hitTp1 && !setup.tp1Hit) {
        setup.tp1Hit = true;
        setup.stop = setup.entryPrice; // breakeven'e çek
        setup.state = 'TP1_HIT';
    }
    if (setup.tp1Hit && hitStop) { // breakeven sonrası stop (kayıp değil, ~0R)
        setup.state = 'CLOSED_WIN';
        setup.finishedAt = now;
        setup.exitPrice = setup.stop;
        const rTotal = 0.5 * CFG.TP1_R + 0.5 * 0;
        logJournal(setup, num(rTotal, 2), 'BREAKEVEN_AFTER_TP1');
        return;
    }
    if (hitTp2) {
        setup.state = 'CLOSED_WIN';
        setup.finishedAt = now;
        setup.exitPrice = setup.tp2;
        const rTotal = 0.5 * CFG.TP1_R + 0.5 * CFG.TP2_R;
        logJournal(setup, num(rTotal, 2), 'TP2');
        return;
    }
    // Time-stop
    const maxBars = setup.tp1Hit ? CFG.TIME_STOP_BARS_AFTER_TP1 : CFG.TIME_STOP_BARS;
    if (barsElapsed > maxBars) {
        const partialR = isLong
            ? (livePrice - setup.entryPrice) / setup.risk
            : (setup.entryPrice - livePrice) / setup.risk;
        const rTotal = setup.tp1Hit ? (0.5 * CFG.TP1_R + 0.5 * partialR) : partialR;
        setup.state = 'CLOSED_TIME';
        setup.finishedAt = now;
        setup.exitPrice = livePrice;
        logJournal(setup, num(rTotal, 2), 'TIME_STOP');
    }
}

function logJournal(setup, rMultiple, outcome) {
    journal.unshift({
        id: setup.id, symbol: setup.symbol, direction: setup.direction, type: setup.type,
        entered: rMultiple !== null, rMultiple, outcome,
        atrPercentile: setup.atrPercentile, volumeZ: setup.volumeZ, oiZ: setup.oiZ,
        createdAt: setup.createdAt, finishedAt: setup.finishedAt
    });
    if (journal.length > CFG.JOURNAL_MAX_ENTRIES) journal.length = CFG.JOURNAL_MAX_ENTRIES;
}
