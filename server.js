'use strict';
// ============================================================
// SONER TRADE v14 (TEK DOSYA)
//  - CANLI UYARI MOTORU: üçgen çizgisi / destek-direnç / 20 saatlik zirve-dip için
//    "yaklaşıyor", "temas", "KIRILDI" uyarıları (kapanış beklemeden, ~10 sn'de bir fiyat kontrolü, hacim ile)
//  - Kırılım uyarısı 15m kapanışta otomatik doğrulanır: ONAYLI / SAHTE (istatistik tutulur)
//  - PB (15m pullback) + TB (1H kırılım) + TR (2H üçgen kapanış sinyali) hâlâ çalışır
//  - Gölge varyantlar kaldırıldı. Hareketliler (5 dk yükselen/düşen) sekmesi eklendi.
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const flag = (k, d) => process.env[k] == null || process.env[k] === '' ? d : process.env[k] !== '0';
const num = (k, d) => process.env[k] == null || process.env[k] === '' ? d : Number(process.env[k]);

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const SELF_URL = process.env.RENDER_EXTERNAL_URL || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const M1 = 60e3, M15 = 15 * 60e3, H1 = 3600e3, H2 = 2 * H1, D1 = 24 * H1;
const BTC = 'BTC/USDT:USDT', ETH = 'ETH/USDT:USDT';

const NON_CRYPTO = [
    'USDC','USDT','DAI','TUSD','BUSD','FDUSD','USDE','SUSDE','USDS','USD1','PYUSD','USDD','FRAX','LUSD','GUSD','BUIDL','USTC','USDP',
    'WBTC','WETH','WSTETH','STETH','RETH','CBETH','WBNB','WAVAX','WMATIC',
    'PAXG','XAUT','XAU','XAG','XPT','XPD','GOLD','SILVER','OIL','WTI','BRENT','USOIL','UKOIL',
    'AAPL','MSFT','GOOGL','AMZN','META','TSLA','NVDA','AMD','INTC','ORCL','NFLX','COIN','HOOD','CRCL','MSTR','MARA','RIOT','PLTR','SPY','QQQ','SPCX','SNDK','ARM','SMCI','GME','AMC',
    'EUR','GBP','JPY','CHF','AUD','CAD','NZD','CNH','CNY','DXY','VIX','NASDAQ','SPX','NIKKEI','DAX',
    'OPENAI','ANTHROPIC','SPACEX','XAI','SAMSUNG','HYNIX','SKHY','SKHYNIX'
];

// ======================= ÜÇGEN / SIKIŞMA MODÜLÜ (gömülü) =======================
const TRI = (() => {
    const AGG = Math.max(1, Math.round(Number(process.env.TRI_AGG) || 2));
    const DUR = AGG * H1;

    function cfg(num, flag) {
        return {
            ENABLE_TR: flag('ENABLE_TR', true),
            TRI_K: num('TRI_K', 3),
            TRI_LOOK: num('TRI_LOOK', 120),
            TRI_MIN_LEN: num('TRI_MIN_LEN', 18),
            TRI_MAX_LEN: num('TRI_MAX_LEN', 110),
            TRI_TOL_ATR: num('TRI_TOL_ATR', 0.35),
            TRI_WICK_ATR: num('TRI_WICK_ATR', 0.6),
            TRI_CLOSE_ATR: num('TRI_CLOSE_ATR', 0.15),
            TRI_MIN_TOUCH: num('TRI_MIN_TOUCH', 4),
            TRI_SQUEEZE: num('TRI_SQUEEZE', 0.7),
            TRI_FLAT: num('TRI_FLAT', 0.08),
            TRI_MAX_LIFE: num('TRI_MAX_LIFE', 1),
            TRI_REQ_HTF: flag('TRI_REQ_HTF', false),
            TRI_NEAR_ATR: num('TRI_NEAR_ATR', 0.8),
            TRI_BRK_ATR: num('TRI_BRK_ATR', 0.1), TRI_VOLX: num('TRI_VOLX', 1.2), TRI_BODY: num('TRI_BODY', 0.45),
            TRI_CLOSEPOS: num('TRI_CLOSEPOS', 0.65), TRI_MAX_EXT_ATR: num('TRI_MAX_EXT_ATR', 1.2),
            TRI_STOP_ATR: num('TRI_STOP_ATR', 0.25), TRI_MIN_RISK_PCT: num('TRI_MIN_RISK_PCT', 0.8), TRI_MAX_RISK_PCT: num('TRI_MAX_RISK_PCT', 10),
            TRI_MAX_COST_R: num('TRI_MAX_COST_R', 0.5), TRI_MIN_TP2R: num('TRI_MIN_TP2R', 1.5), TRI_CAP_R: num('TRI_CAP_R', 5),
            TRI_HOLD_MS: num('TRI_HOLD_H', 48) * H1, TRI_TS_MS: 6 * DUR
        };
    }

    const sigKey = C => [C.TRI_K, C.TRI_LOOK, C.TRI_MIN_LEN, C.TRI_MAX_LEN, C.TRI_TOL_ATR, C.TRI_WICK_ATR, C.TRI_CLOSE_ATR, C.TRI_MIN_TOUCH, C.TRI_SQUEEZE, C.TRI_FLAT].join(',');
    const lineR = (t, x) => t.R.p0 + t.R.s * (x - t.R.i0);
    const lineS = (t, x) => t.S.p0 + t.S.s * (x - t.S.i0);

    function atrAt(c, j, p = 14) {
        if (j < p) return 0;
        let s = 0;
        for (let i = j - p + 1; i <= j; i++) s += Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - c[i - 1][4]), Math.abs(c[i][3] - c[i - 1][4]));
        return s / p;
    }
    function volAvg(c, j, p = 20) {
        let s = 0, n = 0;
        for (let i = Math.max(0, j - p); i < j; i++) { s += c[i][5]; n++; }
        return n ? s / n : 0;
    }

    function pivots(c, end, K, from) {
        const hi = [], lo = [];
        for (let i = Math.max(K, from); i <= end - K; i++) {
            let isH = true, isL = true;
            for (let d = 1; d <= K && (isH || isL); d++) {
                if (c[i][2] <= c[i - d][2] || c[i][2] < c[i + d][2]) isH = false;
                if (c[i][3] >= c[i - d][3] || c[i][3] > c[i + d][3]) isL = false;
            }
            if (isH) hi.push({ i, p: c[i][2] });
            if (isL) lo.push({ i, p: c[i][3] });
        }
        return { hi, lo };
    }

    function fit(pts, c, end, atr, side, C) {
        const P = pts.slice(-8);
        let best = null;
        for (let a = 0; a < P.length - 1; a++) {
            for (let b = a + 1; b < P.length; b++) {
                const A = P[a], B = P[b];
                if (B.i - A.i < 4) continue;
                const s = (B.p - A.p) / (B.i - A.i);
                let ok = true;
                for (let x = A.i; x <= end; x++) {
                    const ln = A.p + s * (x - A.i);
                    if (side === 1 ? (c[x][4] > ln + C.TRI_CLOSE_ATR * atr || c[x][2] > ln + C.TRI_WICK_ATR * atr)
                                   : (c[x][4] < ln - C.TRI_CLOSE_ATR * atr || c[x][3] < ln - C.TRI_WICK_ATR * atr)) { ok = false; break; }
                }
                if (!ok) continue;
                const pts2 = [];
                for (const p of P) if (p.i >= A.i && Math.abs(p.p - (A.p + s * (p.i - A.i))) <= C.TRI_TOL_ATR * atr) pts2.push(p);
                if (pts2.length < 2) continue;
                const lastI = pts2[pts2.length - 1].i;
                if (end - lastI > 45) continue;
                const score = pts2.length * 1000 + (lastI - A.i) * 2 + lastI * 0.01;
                if (!best || score > best.score) best = { i0: A.i, p0: A.p, s, touches: pts2.length, last: lastI, score, pts: pts2 };
            }
        }
        return best;
    }

    // c: kapanmış 2H mumlar, end: dahil edilecek son mum indeksi
    function detect(c, end, C) {
        if (end < 50) return null;
        const atr = atrAt(c, end);
        if (!(atr > 0)) return null;
        const pv = pivots(c, end, C.TRI_K, Math.max(1, end - C.TRI_LOOK));
        if (pv.hi.length < 2 || pv.lo.length < 2) return null;
        const R = fit(pv.hi, c, end, atr, 1, C), S = fit(pv.lo, c, end, atr, -1, C);
        if (!R || !S) return null;
        if (R.touches + S.touches < C.TRI_MIN_TOUCH) return null;
        const xs = Math.max(R.i0, S.i0), len = end - xs;
        if (len < C.TRI_MIN_LEN || len > C.TRI_MAX_LEN) return null;
        const rv = x => R.p0 + R.s * (x - R.i0), sv = x => S.p0 + S.s * (x - S.i0);
        const w0 = rv(xs) - sv(xs), wN = rv(end) - sv(end);
        if (!(w0 > 0 && wN > 0)) return null;
        if (wN / w0 > C.TRI_SQUEEZE || wN < 0.5 * atr) return null;
        const dsl = S.s - R.s;
        if (!(dsl > 0)) return null;
        const apex = end + wN / dsl;
        if (apex - end > 80) return null;
        const flatTol = C.TRI_FLAT * w0 / len, rf = Math.abs(R.s) <= flatTol, sf = Math.abs(S.s) <= flatTol;
        let type = 'Sıkışma';
        if (R.s < -flatTol && S.s > flatTol) type = 'Simetrik üçgen';
        else if (rf && S.s > flatTol) type = 'Yükselen üçgen';
        else if (sf && R.s < -flatTol) type = 'Alçalan üçgen';
        else if (R.s > flatTol && S.s > flatTol) type = 'Yükselen kama';
        else if (R.s < -flatTol && S.s < -flatTol) type = 'Alçalan kama';
        const life = (end - xs) / Math.max(1e-9, apex - xs);
        return { type, end, atr, w0, wN, apex, len, life, R, S, touches: R.touches + S.touches };
    }

    function get(S, j2, C) {
        const m = S._tri || (S._tri = new Map()), k = j2 + '|' + sigKey(C);
        if (m.has(k)) return m.get(k);
        const t = j2 >= 60 ? detect(S.c2, j2 - 1, C) : null;
        m.set(k, t);
        return t;
    }

    function breakout(tri, c, j, C) {
        const q = c[j], atr = tri.atr, rj = lineR(tri, j), sj = lineS(tri, j);
        let side = 0;
        if (q[4] > rj + C.TRI_BRK_ATR * atr) side = 1; else if (q[4] < sj - C.TRI_BRK_ATR * atr) side = -1;
        if (!side) return { fail: 'tr kırılım yok', stage: 2 };
        if (tri.life > C.TRI_MAX_LIFE) return { fail: 'tr apex çok yakın', stage: 2 };
        const L = side === 1, line = L ? rj : sj;
        const rng = (q[2] - q[3]) || 1e-12, body = Math.abs(q[4] - q[1]) / rng, cp = (q[4] - q[3]) / rng;
        if (body < C.TRI_BODY || (L ? cp < C.TRI_CLOSEPOS : cp > 1 - C.TRI_CLOSEPOS)) return { fail: 'tr zayıf mum', stage: 3 };
        const vs = volAvg(c, j, 20), volX = vs > 0 ? q[5] / vs : 0;
        if (volX < C.TRI_VOLX) return { fail: 'tr hacim düşük', stage: 4 };
        const ext = Math.abs(q[4] - line) / atr;
        if (ext > C.TRI_MAX_EXT_ATR) return { fail: 'tr uzamış', stage: 5 };
        return { side, line, atr, volX, ext, height: tri.w0 };
    }

    function near(tri, c, j, price, tEnd, C) {
        const x = j + (tEnd - c[j][0]) / DUR, r = lineR(tri, x), s = lineS(tri, x), a = tri.atr;
        const dR = (r - price) / a, dS = (price - s) / a;
        const pk = Math.abs(dR) <= Math.abs(dS) ? { side: 1, d: dR, line: r } : { side: -1, d: dS, line: s };
        if (Math.abs(pk.d) > C.TRI_NEAR_ATR) return null;
        return { side: pk.side, dist: Math.abs(pk.d), over: pk.d < 0, line: pk.line, tri: { type: tri.type, touches: tri.touches, squeeze: tri.wN / tri.w0 } };
    }
    function stateText(nr, fmt) {
        const t = nr.tri, nm = nr.side === 1 ? 'direnç' : 'destek';
        return t.type + ' • ' + t.touches + ' dokunuş • daralma %' + Math.round((1 - t.squeeze) * 100) + ' • ' + nm + ' ' + fmt(nr.line) +
            (nr.over ? ' aşıldı, ' + AGG + 'H kapanış bekleniyor' : ' (' + nr.dist.toFixed(2) + ' ATR uzakta)');
    }

    function pack(tri, c) {
        const lastI = c.length - 1, tOf = i => i <= lastI ? c[Math.max(0, Math.round(i))][0] : c[lastI][0] + (i - lastI) * DUR;
        const xEnd = Math.min(tri.apex, tri.end + 1 + 10);
        const seg = (L, f) => [[tOf(L.i0), L.p0], [tOf(xEnd), f(tri, xEnd)]];
        return {
            type: tri.type, touches: tri.touches, squeeze: Number((tri.wN / tri.w0).toFixed(2)), apex: tOf(tri.apex),
            res: seg(tri.R, lineR), sup: seg(tri.S, lineS),
            hi: tri.R.pts.map(p => [tOf(p.i), p.p]), lo: tri.S.pts.map(p => [tOf(p.i), p.p])
        };
    }

    function extra(c15, c1h, aggregateN, ptrMap) {
        const c2 = aggregateN(c1h, H1, AGG);
        return { c2, p2h: ptrMap(c15, c2, DUR) };
    }
    const aggregate = (c1h, aggregateN) => aggregateN(c1h, H1, AGG);

    return { cfg, detect, get, breakout, near, stateText, pack, extra, aggregate, AGG, DUR };
})();
// =====================================================================

const CFG = {
    MIN_SCORE: num('MIN_SCORE', 0),
    ENABLE_PB: flag('ENABLE_PB', true), ENABLE_SW: flag('ENABLE_SW', false),
    REQ_4H: flag('REQ_4H', false), TREND_LOOSE: flag('TREND_LOOSE', false),
    MKT_MODE: process.env.MKT_MODE || 'notAgainst',
    MIN_ADX: num('MIN_ADX', 20),
    RS_LB: 24, RS_MIN: num('RS_MIN', 0),
    PB_WIN: 6, PB_TOUCH_ATR: 0.10, PB_MAX_DEPTH_ATR: 0.5, PB_DRY: num('PB_DRY', 1.1),
    PB_MIN_VOLX: num('PB_MIN_VOLX', 1.0), VOL_MAX: num('VOL_MAX', 2.8),
    MIN_BODY: 0.5, MIN_CLOSEPOS: 0.65, RSI_L: [42, 65], RSI_S: [35, 58], MAX_EXT_ATR: 1.0,
    SW_LOOK: 32, SW_DEPTH_ATR: 0.10, SW_WICK: 0.45, SW_MIN_VOLX: 1.5,
    STOP_BUF_ATR: num('STOP_BUF_ATR', 0.30), MIN_RISK_PCT: num('MIN_RISK_PCT', 0.6), MAX_RISK_PCT: 3.5,
    COST_PCT: 0.14, COST_MULT: num('COST_MULT', 1), MAX_COST_R: num('MAX_COST_R', 0.18),
    ROOM_MIN: num('ROOM_MIN', 1.2), ROOM_LOOK: 96,
    EXIT_MODE: process.env.EXIT_MODE || 'A',
    TP1_R: num('TP1_R', 1.0), TP2_R: num('TP2_R', 2.0), TPB_R: 1.5, TRAIL_ATR: 2, CAP_R: 4,
    TIME_STOP_MS: 6 * M15, TIME_STOP_MFE: 0.3, MAX_HOLD_MS: 8 * H1,
    COOLDOWN_MS: 2 * H1, MAX_OPEN_PER_DIR: num('MAX_OPEN_PER_DIR', 4), MAX_OPEN_TOTAL: num('MAX_OPEN_TOTAL', 8),
    MAX_OPEN_SETUP: { PB: num('MAX_OPEN_PB', 3), SW: 2, TB: num('MAX_OPEN_TB', 4), TR: num('MAX_OPEN_TR', 3) },
    MAX_PER_SCAN: 2, DAY_STOP_R: -3,
    MAX_SIGNAL_AGE_MS: 5 * 60e3, SCAN_DELAY_MS: 8000,
    UNIVERSE: num('UNIVERSE', 250), MIN_VOL_USDT: num('MIN_VOL', 2e6),
    FLAT_MAX: 0.08, MIN_LISTING_DAYS: 30,
    EXCLUDED: NON_CRYPTO.concat((process.env.EXCLUDE || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean)),
    CONCURRENCY: 6, TRACK_MS: 15e3, UNIVERSE_MS: 5 * 60e3, KEEP: 1000,
    HEALTH_N: 30, HEALTH_MIN_R: 0,
    PB_RELAX_15M: flag('PB_RELAX_15M', true),
    ENABLE_TB: flag('ENABLE_TB', true), TB_DON: num('TB_DON', 20), TB_ADX: num('TB_ADX', 20), TB_VOLX: num('TB_VOLX', 1.2), TB_RS_MIN: num('TB_RS_MIN', -99),
    TB_STOP_ATR: num('TB_STOP_ATR', 2), TB_TRAIL_ATR: num('TB_TRAIL_ATR', 3), TB_CAP_R: 10, TB_MAX_EXT_ATR: num('TB_MAX_EXT_ATR', 2.5),
    TB_RSI_L: [55, 80], TB_RSI_S: [20, 45], TB_MIN_RISK_PCT: 0.8, TB_MAX_RISK_PCT: 6, TB_MAX_COST_R: num('TB_MAX_COST_R', 0.12),
    TB_MAX_HOLD_MS: 72 * H1, TB_TS_MS: 8 * H1, TB_TS_MFE: 0.3, TB_COOLDOWN_MS: 12 * H1,
    TB_SHORT_MKT: flag('TB_SHORT_MKT', false),
    TR_PAPER: flag('TR_PAPER', false),
    BT_MIN_VOL: num('BT_MIN_VOL', 2e6),
    // ---- CANLI UYARI MOTORU ----
    ENABLE_LIVE: flag('ENABLE_LIVE', true),
    LIVE_MS: num('LIVE_MS', 10000),                 // fiyat kontrol aralığı
    LV_NEAR_ATR: num('LV_NEAR_ATR', 0.45),          // "yaklaşıyor" mesafesi (ATR)
    LV_TOUCH_ATR: num('LV_TOUCH_ATR', 0.08),        // "temas" mesafesi (ATR)
    LV_BRK_ATR: num('LV_BRK_ATR', 0.12),            // kırılım için çizgiyi aşma (ATR)
    LV_MAX_EXT_ATR: num('LV_MAX_EXT_ATR', 1.0),     // bundan fazla aşılmışsa geç kalınmış say
    LV_HOLD_TICKS: num('LV_HOLD_TICKS', 2),         // kırılımın kaç ardışık kontrolde korunması gerekir (fitil filtresi)
    LV_VOL_NEAR: num('LV_VOL_NEAR', 1.3),           // yaklaşırken Telegram için min canlı hacim (x)
    LV_VOL_TOUCH: num('LV_VOL_TOUCH', 1.0),
    LV_VOL_BRK: num('LV_VOL_BRK', 1.0),             // bunun altındaki kırılımlar sadece panoda görünür
    LV_VOL_STRONG: num('LV_VOL_STRONG', 1.5),       // "GÜÇLÜ HACİM" eşiği
    LV_STOP_ATR: num('LV_STOP_ATR', 0.6),           // önerilen stop: çizginin bu kadar ATR ötesi
    LV_SR: flag('LV_SR', true), LV_SR_TOUCH: num('LV_SR_TOUCH', 2), LV_SR_LOOK: num('LV_SR_LOOK', 200),
    LV_SR_TOL: num('LV_SR_TOL', 0.35), LV_SR_RANGE: num('LV_SR_RANGE', 5), LV_SR_NEAR_MIN: num('LV_SR_NEAR_MIN', 3),
    LV_CD_NEAR_MIN: num('LV_CD_NEAR_MIN', 60), LV_CD_BRK_MIN: num('LV_CD_BRK_MIN', 90), LV_SYM_GAP_MIN: num('LV_SYM_GAP_MIN', 20),
    LV_TG_MAX_H: num('LV_TG_MAX_H', 30),            // saatte en fazla Telegram uyarısı
    LV_MAX_VOLFETCH: num('LV_MAX_VOLFETCH', 14),
    LV_STALE_MS: 45 * 60e3,
    ...TRI.cfg(num, flag)
};

const tbOnly = o => Object.assign({ ENABLE_PB: false, ENABLE_TR: false }, o);
const trOnly = o => Object.assign({ ENABLE_PB: false, ENABLE_TB: false }, o);
const VARIANTS = [
    { name: 'Temel (PB+TB+TR)', o: {} },
    { name: 'Sadece TB (1H kırılım)', o: tbOnly({}) },
    { name: 'Sadece TR (2H üçgen)', o: trOnly({}) },
    { name: 'Sadece PB', o: { ENABLE_TB: false, ENABLE_TR: false } },
    { name: 'PB+TB (TR yok)', o: { ENABLE_TR: false } },
    { name: 'TB donchian 30', o: tbOnly({ TB_DON: 30 }) },
    { name: 'TB piyasa filtresi yok', o: tbOnly({ MKT_MODE: 'off' }) },
    { name: 'TR piyasa filtresi yok', o: trOnly({ MKT_MODE: 'off' }) },
    { name: 'TB short sadece piyasa short', o: tbOnly({ TB_SHORT_MKT: true }) },
    { name: 'TR HTF uyumu şart', o: trOnly({ TRI_REQ_HTF: true }) },
    { name: 'TR hacim 1.5x', o: trOnly({ TRI_VOLX: 1.5 }) },
    { name: 'TR apex erken (0.75)', o: trOnly({ TRI_MAX_LIFE: 0.75 }) },
    { name: 'TR en az 5 dokunuş', o: trOnly({ TRI_MIN_TOUCH: 5 }) },
    { name: 'TR sıkı daralma (0.55)', o: trOnly({ TRI_SQUEEZE: 0.55 }) }
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const tick = () => new Promise(r => setImmediate(r));
const log = (...a) => console.log('[SONER]', ...a);
const baseOf = s => s.split('/')[0];
const isMajor = s => /^(BTC|ETH)\//.test(s);
const trDay = t => new Date(t + 3 * H1).toISOString().slice(0, 10);
const trHour = t => String(new Date(t + 3 * H1).getUTCHours()).padStart(2, '0') + ':00';
const session = t => { const h = new Date(t).getUTCHours(); return h < 7 ? '1 Asya (03-10 TR)' : h < 13 ? '2 Londra (10-16 TR)' : h < 21 ? '3 ABD (16-00 TR)' : '4 Gece (00-03 TR)'; };
const costFor = vol => { const v = vol || 0; return v >= 200e6 ? 0.14 : v >= 50e6 ? 0.18 : v >= 10e6 ? 0.25 : 0.35; };
const flatRatio = c => { const a = c.slice(-96); let f = 0; for (const x of a) if (x[2] === x[3] || !x[5]) f++; return a.length ? f / a.length : 1; };
const mktOf = (bd, ed, bsc) => { const s = 2 * (bd || 0) + (ed || 0) + (bsc || 0); return s >= 2 ? 1 : s <= -2 ? -1 : 0; };
const breadthScore = (up, dn, n) => n > 0 ? ((up - dn) / n) * 4 : 0;
const last = a => a[a.length - 1];
const closedOnly = (c, ms, now = Date.now()) => c.filter(x => x[0] + ms <= now);
const fmt = p => { const a = Math.abs(p); return a >= 1000 ? p.toFixed(2) : a >= 1 ? p.toFixed(4) : a >= 0.01 ? p.toFixed(5) : p.toFixed(7); };
const cdOf = (s, C) => (s.setup === 'TB' || s.setup === 'TR') ? C.TB_COOLDOWN_MS : C.COOLDOWN_MS;

function aggregateN(c, baseMs, n) {
    const ms = baseMs * n, g = new Map();
    for (const x of c) {
        const k = Math.floor(x[0] / ms) * ms;
        let a = g.get(k);
        if (!a) { a = [k, x[1], x[2], x[3], x[4], x[5], 1]; g.set(k, a); }
        else { a[2] = Math.max(a[2], x[2]); a[3] = Math.min(a[3], x[3]); a[4] = x[4]; a[5] += x[5]; a[6]++; }
    }
    return [...g.values()].filter(a => a[6] === n);
}

function emaSeries(v, p) {
    const out = new Array(v.length).fill(null);
    if (v.length < p) return out;
    let e = 0; for (let i = 0; i < p; i++) e += v[i]; e /= p; out[p - 1] = e;
    const k = 2 / (p + 1);
    for (let i = p; i < v.length; i++) { e = v[i] * k + e * (1 - k); out[i] = e; }
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
        const m = dm(i);
        trS = trS - trS / p + trAt(c, i); pS = pS - pS / p + m[0]; mS = mS - mS / p + m[1];
        dxs.push(dxAt());
        const k = dxs.length;
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
function ptrMap(c, cH, dur) {
    const o = new Array(c.length); let p = -1;
    for (let i = 0; i < c.length; i++) { const t = c[i][0] + M15; while (p + 1 < cH.length && cH[p + 1][0] + dur <= t) p++; o[i] = p; }
    return o;
}

function buildSym(c15, c1h, c4h) {
    const f15 = feats(c15), f1h = feats(c1h), f4h = feats(c4h);
    return {
        f15, f1h, f4h,
        t15: trendSeries(f15, 0.08),
        t1h: trendSeries(f1h, 0.10),
        t4h: trendSeries(f4h, 0.15),
        p1h: ptrMap(c15, c1h, H1),
        p4h: ptrMap(c15, c4h, 4 * H1),
        ...TRI.extra(c15, c1h, aggregateN, ptrMap)
    };
}
function rsAt(c, i, btcMap, lb) {
    if (!btcMap || i < lb) return null;
    const a = btcMap.get(c[i][0]), b = btcMap.get(c[i - lb][0]);
    if (a == null || b == null) return null;
    return ((c[i][4] / c[i - lb][4] - 1) - (a / b - 1)) * 100;
}

// ------------------------- STRATEJİ (kapanış sinyalleri: PB / TB / TR) -------------------------
function signalAt(S, i, ctx) {
    const C = ctx.cfg || CFG, f = S.f15, c = f.c;
    if (i < 80) return { signal: null, reason: 'veri az', stage: 0 };
    const atr = f.atr[i], e21 = f.e21[i], e50 = f.e50[i], adx = f.adx[i], rv = f.rsi[i], vs = f.vsma[i];
    const j1 = S.p1h[i], j4 = S.p4h[i];
    if ([atr, e21, e50, adx, rv, vs].some(x => x == null) || j1 < 1 || j4 < 1) return { signal: null, reason: 'veri az', stage: 0 };
    const k0 = c[i], price = k0[4], h1 = S.t1h[j1], h4 = S.t4h[j4], t15 = S.t15[i], mkt = ctx.mkt || 0, rsv = ctx.rs;
    const minScore = ctx.minScore != null ? ctx.minScore : C.MIN_SCORE;
    const volX = vs > 0 ? k0[5] / vs : 0;
    const rng = (k0[2] - k0[3]) || 1e-12, body = Math.abs(k0[4] - k0[1]) / rng, cp = (k0[4] - k0[3]) / rng;
    const mktOK = side => C.MKT_MODE === 'align' ? mkt === side : C.MKT_MODE === 'off' ? true : mkt !== -side;

    const finish = (setup, name, side, o) => {
        const L = side === 1, entry = price, stop = o.ref - side * C.STOP_BUF_ATR * atr, risk = side * (entry - stop);
        if (!(risk > 0)) return { fail: 'risk', stage: 9 };
        const riskPct = risk / entry * 100;
        if (riskPct < C.MIN_RISK_PCT || riskPct > C.MAX_RISK_PCT) return { fail: 'risk aralığı', stage: 9 };
        const costPct = ctx.costPct != null ? ctx.costPct : C.COST_PCT, costR = costPct / riskPct;
        if (costR > C.MAX_COST_R) return { fail: 'maliyet', stage: 10 };
        let tgt = L ? -Infinity : Infinity;
        for (let j = Math.max(0, i - C.ROOM_LOOK); j < i; j++) { if (L) { if (c[j][2] > tgt) tgt = c[j][2]; } else if (c[j][3] < tgt) tgt = c[j][3]; }
        let room = side * (tgt - entry) / risk; if (room <= 0) room = 9;
        if (room < C.ROOM_MIN) return { fail: 'oda yok', stage: 11 };
        const parts = {};
        parts.trend = adx >= 30 ? 25 : adx >= 25 ? 20 : adx >= C.MIN_ADX ? 12 : 5;
        parts.rs = rsv == null ? 8 : Math.round(Math.max(0, Math.min(20, side * rsv * 8)));
        parts.htf = (h1 === side ? 8 : 0) + (h4 === side ? 7 : 0);
        parts.pullback = (o.dry <= 0.8 ? 8 : o.dry <= 1.0 ? 5 : 2) + (o.extd <= 0.5 ? 7 : o.extd <= 0.9 ? 4 : 1);
        parts.oda = room >= 3 ? 15 : room >= 2 ? 11 : room >= 1.5 ? 8 : 4;
        parts.maliyet = costR <= 0.08 ? 10 : costR <= 0.12 ? 7 : 4;
        let score = 0; for (const k in parts) score += parts[k];
        if (score < minScore) return { fail: 'skor', stage: 12 };
        const warnings = [];
        if (mkt === -side) warnings.push('Piyasa ters');
        if (rsv != null && side * rsv < 0) warnings.push('BTC\'den zayıf');
        const mode = C.EXIT_MODE, tp1R = mode === 'B' ? C.TPB_R : C.TP1_R;
        return { sig: {
            symbol: ctx.sym, base: baseOf(ctx.sym), dir: L ? 'LONG' : 'SHORT', setup, setupName: name, score, parts, warnings,
            entry, stop, initialStop: stop, mode, tp1R, tp2R: C.TP2_R, capR: C.CAP_R, trail: C.TRAIL_ATR, atr,
            tp1: entry + side * risk * tp1R, tp2: entry + side * risk * C.TP2_R,
            tsMs: C.TIME_STOP_MS, tsMfe: C.TIME_STOP_MFE,
            riskPct, costR, volX: o.volX != null ? o.volX : volX, adx, rsi: rv, room, rs: rsv, trend: t15, trend1h: h1, trend4h: h4, mkt,
            time: k0[0] + M15, candleT: k0[0], level: o.level, lastPrice: entry, mfe: 0, mae: 0,
            reason: name + ' | hacim ' + volX.toFixed(1) + 'x | ADX ' + adx.toFixed(0) + ' | hedef alanı ' + room.toFixed(1) + 'R'
        } };
    };

    const buildPB = side => {
        const L = side === 1;
        const h4ok = C.REQ_4H ? h4 === side : h4 !== -side;
        const t15ok = C.PB_RELAX_15M ? (t15 === side || t15 === 0) : (t15 === side);
        if (!(t15ok && (C.TREND_LOOSE ? h1 !== -side : h1 === side) && h4ok)) return { fail: 'trend yok', stage: 1 };
        if (adx < C.MIN_ADX) return { fail: 'adx', stage: 2 };
        if (!mktOK(side)) return { fail: 'piyasa ters', stage: 3 };
        if (rsv != null && side * rsv < C.RS_MIN) return { fail: 'rs zayıf', stage: 3 };
        if (!(L ? (e21 > e50 && price > e50) : (e21 < e50 && price < e50))) return { fail: 'pullback yok', stage: 4 };
        let touched = false, held = true, ext = L ? Infinity : -Infinity;
        for (let j = i - C.PB_WIN; j < i; j++) {
            const x = c[j], a = f.e21[j], b = f.e50[j]; if (a == null || b == null) continue;
            if (L) { if (x[3] <= a + C.PB_TOUCH_ATR * atr) touched = true; if (x[4] < b) held = false; if (x[3] < ext) ext = x[3]; }
            else { if (x[2] >= a - C.PB_TOUCH_ATR * atr) touched = true; if (x[4] > b) held = false; if (x[2] > ext) ext = x[2]; }
        }
        if (!touched || !held) return { fail: 'pullback yok', stage: 4 };
        if (L ? ext < e50 - C.PB_MAX_DEPTH_ATR * atr : ext > e50 + C.PB_MAX_DEPTH_ATR * atr) return { fail: 'pullback derin', stage: 4 };
        const prev = c[i - 1];
        const trig = L ? (k0[4] > k0[1] && k0[4] > e21 && k0[4] > prev[2] && cp >= C.MIN_CLOSEPOS)
                       : (k0[4] < k0[1] && k0[4] < e21 && k0[4] < prev[3] && cp <= 1 - C.MIN_CLOSEPOS);
        if (!trig || body < C.MIN_BODY) return { fail: 'tetik yok', stage: 5 };
        if (volX < C.PB_MIN_VOLX) return { fail: 'hacim düşük', stage: 6 };
        if (volX > C.VOL_MAX) return { fail: 'klimaks hacim', stage: 6 };
        const pv = (c[i - 1][5] + c[i - 2][5] + c[i - 3][5]) / 3, dry = vs > 0 ? pv / vs : 1;
        if (dry > C.PB_DRY) return { fail: 'pullback hacmi yüksek', stage: 6 };
        const rr = L ? C.RSI_L : C.RSI_S;
        if (rv < rr[0] || rv > rr[1]) return { fail: 'rsi', stage: 7 };
        const extd = Math.abs(price - e21) / atr;
        if (extd > C.MAX_EXT_ATR) return { fail: 'uzamış', stage: 8 };
        return finish('PB', 'Trend Pullback', side, { ref: L ? Math.min(ext, k0[3]) : Math.max(ext, k0[2]), extd, dry, level: e21 });
    };

    const buildSW = side => {
        const L = side === 1, s = i - 1;
        if (!(t15 !== -side && h1 !== -side && h4 !== -side)) return { fail: 'trend yok', stage: 1 };
        if (!mktOK(side)) return { fail: 'piyasa ters', stage: 3 };
        let lvl = L ? Infinity : -Infinity;
        for (let j = s - C.SW_LOOK; j < s; j++) { const x = c[j]; if (L) { if (x[3] < lvl) lvl = x[3]; } else if (x[2] > lvl) lvl = x[2]; }
        const sc = c[s], r = (sc[2] - sc[3]) || 1e-12;
        const depth = L ? (lvl - sc[3]) / atr : (sc[2] - lvl) / atr, back = L ? sc[4] > lvl : sc[4] < lvl;
        const wick = L ? (Math.min(sc[1], sc[4]) - sc[3]) / r : (sc[2] - Math.max(sc[1], sc[4])) / r;
        if (depth < C.SW_DEPTH_ATR || !back || wick < C.SW_WICK) return { fail: 'sweep yok', stage: 4 };
        const confirm = L ? (k0[4] > k0[1] && k0[4] > sc[4] && k0[4] > lvl) : (k0[4] < k0[1] && k0[4] < sc[4] && k0[4] < lvl);
        if (!confirm || body < C.MIN_BODY * 0.8) return { fail: 'tetik yok', stage: 5 };
        const sv = f.vsma[s], svx = sv > 0 ? sc[5] / sv : 0;
        if (svx < C.SW_MIN_VOLX) return { fail: 'hacim düşük', stage: 6 };
        const extd = Math.abs(price - lvl) / atr;
        if (extd > 1.5) return { fail: 'uzamış', stage: 8 };
        return finish('SW', 'Sweep Dönüşü', side, { ref: L ? Math.min(sc[3], k0[3]) : Math.max(sc[2], k0[2]), extd: extd * 0.66, dry: 1, volX: svx, level: lvl });
    };

    const isHourClose = (k0[0] + M15) % H1 === 0;
    const buildTB = side => {
        if (!C.ENABLE_TB || !isHourClose) return null;
        const L = side === 1, F = S.f1h, n = j1;
        if (n < C.TB_DON + 3) return { fail: 'veri az', stage: 0 };
        const q = F.c[n];
        if (q[0] + H1 !== k0[0] + M15) return { fail: 'tb 1h eski', stage: 0 };
        const a1 = F.atr[n], ad1 = F.adx[n], v1 = F.vsma[n], r1 = F.rsi[n], e1 = F.e21[n];
        if ([a1, ad1, v1, r1, e1].some(x => x == null)) return { fail: 'veri az', stage: 0 };
        if (!(h1 === side && h4 === side)) return { fail: 'tb trend yok', stage: 1 };
        let ch = L ? -Infinity : Infinity, cp0 = ch;
        for (let j = n - C.TB_DON; j < n; j++) { const x = F.c[j]; if (L) { if (x[2] > ch) ch = x[2]; } else if (x[3] < ch) ch = x[3]; }
        for (let j = n - 1 - C.TB_DON; j < n - 1; j++) { const x = F.c[j]; if (L) { if (x[2] > cp0) cp0 = x[2]; } else if (x[3] < cp0) cp0 = x[3]; }
        const pc = F.c[n - 1][4];
        if (!(L ? q[4] > ch : q[4] < ch) || (L ? pc > cp0 : pc < cp0)) return { fail: 'tb kırılım yok', stage: 2 };
        if (ad1 < C.TB_ADX) return { fail: 'tb adx', stage: 3 };
        if (!mktOK(side)) return { fail: 'tb piyasa ters', stage: 3 };
        if (side === -1 && C.TB_SHORT_MKT && mkt !== -1) return { fail: 'tb short: piyasa short değil', stage: 3 };
        if (rsv != null && side * rsv < C.TB_RS_MIN) return { fail: 'tb rs zayıf', stage: 3 };
        const vx = q[5] / v1, rg = (q[2] - q[3]) || 1e-12, bd1 = Math.abs(q[4] - q[1]) / rg, cp1 = (q[4] - q[3]) / rg;
        if (vx < C.TB_VOLX) return { fail: 'tb hacim düşük', stage: 4 };
        if (bd1 < 0.5 || (L ? cp1 < 0.7 : cp1 > 0.3)) return { fail: 'tb zayıf mum', stage: 5 };
        const rr = L ? C.TB_RSI_L : C.TB_RSI_S;
        if (r1 < rr[0] || r1 > rr[1]) return { fail: 'tb rsi', stage: 6 };
        const ext1 = Math.abs(q[4] - e1) / a1;
        if (ext1 > C.TB_MAX_EXT_ATR) return { fail: 'tb uzamış', stage: 7 };
        const entry = price, risk = C.TB_STOP_ATR * a1, stop = entry - side * risk, riskPct = risk / entry * 100;
        if (riskPct < C.TB_MIN_RISK_PCT || riskPct > C.TB_MAX_RISK_PCT) return { fail: 'tb risk aralığı', stage: 9 };
        const costPct = ctx.costPct != null ? ctx.costPct : C.COST_PCT, costR = costPct / riskPct;
        if (costR > C.TB_MAX_COST_R) return { fail: 'tb maliyet', stage: 10 };
        const parts = {
            trend: ad1 >= 30 ? 25 : ad1 >= 25 ? 20 : 12,
            rs: rsv == null ? 8 : Math.round(Math.max(0, Math.min(20, side * rsv * 8))),
            htf: 15,
            pullback: (vx >= 2 ? 8 : vx >= 1.5 ? 5 : 3) + (ext1 <= 1 ? 7 : ext1 <= 1.8 ? 4 : 1),
            oda: 10,
            maliyet: costR <= 0.06 ? 10 : costR <= 0.09 ? 7 : 4
        };
        let score = 0; for (const pk in parts) score += parts[pk];
        if (score < minScore) return { fail: 'skor', stage: 12 };
        const warnings = [];
        if (mkt === -side) warnings.push('Piyasa ters');
        if (rsv != null && side * rsv < 0) warnings.push('BTC\'den zayıf');
        return { sig: {
            symbol: ctx.sym, base: baseOf(ctx.sym), dir: L ? 'LONG' : 'SHORT', setup: 'TB', setupName: 'Trend Kırılımı 1H', score, parts, warnings,
            entry, stop, initialStop: stop, mode: 'T', tp1R: 2, tp2R: C.TB_CAP_R, capR: C.TB_CAP_R, trail: C.TB_TRAIL_ATR, atr: a1, hh: entry,
            tp1: entry + side * risk * 2, tp2: entry + side * risk * C.TB_CAP_R, tsMs: C.TB_TS_MS, tsMfe: C.TB_TS_MFE, maxHold: C.TB_MAX_HOLD_MS,
            riskPct, costR, volX: vx, adx: ad1, rsi: r1, room: 9, rs: rsv, trend: t15, trend1h: h1, trend4h: h4, mkt,
            time: k0[0] + M15, candleT: k0[0], level: ch, lastPrice: entry, mfe: 0, mae: 0,
            reason: 'Trend Kırılımı 1H | hacim ' + vx.toFixed(1) + 'x | ADX(1H) ' + ad1.toFixed(0) + ' | ' + C.TB_TRAIL_ATR + 'xATR trailing'
        } };
    };

    const buildTR = side => {
        if (!C.ENABLE_TR || !S.c2 || !S.p2h) return null;
        const j2 = S.p2h[i];
        if (j2 == null || j2 < 60) return null;
        const q = S.c2[j2];
        if (q[0] + TRI.DUR !== k0[0] + M15) return null;               // sadece 2H kapanışında
        const tri = TRI.get(S, j2, C);
        if (!tri) return side === 1 ? { fail: 'tr üçgen yok', stage: 1 } : null;
        const b = TRI.breakout(tri, S.c2, j2, C);
        if (b.fail) return side === 1 ? { fail: b.fail, stage: b.stage } : null;
        if (b.side !== side) return null;
        if (!mktOK(side)) return { fail: 'tr piyasa ters', stage: 3 };
        if (C.TRI_REQ_HTF && (h1 === -side || h4 === -side)) return { fail: 'tr htf ters', stage: 3 };
        const L = side === 1, entry = price, ref = L ? Math.min(q[3], b.line) : Math.max(q[2], b.line);
        const stop = ref - side * C.TRI_STOP_ATR * b.atr, risk = side * (entry - stop);
        if (!(risk > 0)) return { fail: 'tr risk', stage: 9 };
        const riskPct = risk / entry * 100;
        if (riskPct < C.TRI_MIN_RISK_PCT || riskPct > C.TRI_MAX_RISK_PCT) return { fail: 'tr risk aralığı', stage: 9 };
        const costPct = ctx.costPct != null ? ctx.costPct : C.COST_PCT, costR = costPct / riskPct;
        if (costR > C.TRI_MAX_COST_R) return { fail: 'tr maliyet', stage: 10 };
        let tp2R = side * ((b.line + side * b.height) - entry) / risk;    // ölçülü hareket
        if (tp2R < C.TRI_MIN_TP2R) return { fail: 'tr hedef kısa', stage: 11 };
        tp2R = Math.min(tp2R, C.TRI_CAP_R);
        const parts = {
            trend: Math.min(25, tri.touches * 5),
            rs: rsv == null ? 8 : Math.round(Math.max(0, Math.min(20, side * rsv * 8))),
            htf: (h1 === side ? 8 : 0) + (h4 === side ? 7 : 0),
            pullback: (b.volX >= 2 ? 8 : b.volX >= 1.5 ? 6 : 4) + (b.ext <= 0.5 ? 7 : b.ext <= 0.9 ? 4 : 2),
            oda: tp2R >= 3 ? 15 : tp2R >= 2 ? 11 : 8,
            maliyet: costR <= 0.1 ? 10 : 5
        };
        let score = 0; for (const pk in parts) score += parts[pk];
        if (score < minScore) return { fail: 'skor', stage: 12 };
        const warnings = [];
        if (mkt === -side) warnings.push('Piyasa ters');
        if (h1 === -side) warnings.push('1H ters');
        if (rsv != null && side * rsv < 0) warnings.push('BTC\'den zayıf');
        return { sig: {
            symbol: ctx.sym, base: baseOf(ctx.sym), dir: L ? 'LONG' : 'SHORT', setup: 'TR', setupName: 'Üçgen Kırılımı ' + TRI.AGG + 'H (' + tri.type + ')', score, parts, warnings,
            entry, stop, initialStop: stop, mode: 'A', tp1R: 1, tp2R, capR: C.CAP_R, trail: C.TRAIL_ATR, atr: b.atr,
            tp1: entry + side * risk, tp2: entry + side * risk * tp2R, tsMs: C.TRI_TS_MS, tsMfe: 0.3, maxHold: C.TRI_HOLD_MS,
            riskPct, costR, volX: b.volX, adx, rsi: rv, room: tp2R, rs: rsv, trend: t15, trend1h: h1, trend4h: h4, mkt,
            time: k0[0] + M15, candleT: k0[0], level: b.line, lastPrice: entry, mfe: 0, mae: 0, tri: TRI.pack(tri, S.c2),
            reason: tri.type + ' | ' + tri.touches + ' dokunuş | hacim ' + b.volX.toFixed(1) + 'x | ölçülü hedef ' + tp2R.toFixed(1) + 'R'
        } };
    };

    const cands = []; let best = { reason: 'trend yok', stage: 0 }; const fails = {};
    for (const side of [1, -1]) {
        const rs = [['PB', C.ENABLE_PB ? buildPB(side) : null], ['SW', C.ENABLE_SW ? buildSW(side) : null], ['TB', buildTB(side)], ['TR', buildTR(side)]];
        for (const pr of rs) {
            const nm = pr[0], r = pr[1];
            if (!r) continue;
            if (r.sig) cands.push(r.sig);
            else {
                if (r.stage > best.stage) best = { reason: r.fail, stage: r.stage };
                if (!fails[nm] || r.stage > fails[nm].stage) fails[nm] = { reason: r.fail, stage: r.stage };
            }
        }
    }
    if (cands.length) { cands.sort((a, b) => b.score - a.score); return { signal: cands[0], reason: 'sinyal', stage: 99, fails }; }

    let near = null;
    if (ctx.watch) {
        for (const side of [1, -1]) {
            const L = side === 1;
            const t15okR = C.PB_RELAX_15M ? (t15 === side || t15 === 0) : (t15 === side);
            if (t15okR && h1 === side && adx >= C.MIN_ADX && mktOK(side) && (L ? (e21 > e50 && price > e50) : (e21 < e50 && price < e50))) {
                const dist = Math.abs(price - e21) / atr;
                if (dist <= 0.8 && (!near || dist < near.dist)) near = { side, dist, e21, trigger: L ? k0[2] : k0[3] };
            }
        }
    }
    if (ctx.watch && C.ENABLE_TB && j1 >= C.TB_DON + 3 && S.f1h.atr[j1] != null) {
        const F = S.f1h, n = j1, a1 = F.atr[n];
        for (const side of [1, -1]) {
            if (!(h1 === side && h4 === side && mktOK(side))) continue;
            let ch = side === 1 ? -Infinity : Infinity;
            for (let j = n - C.TB_DON + 1; j <= n; j++) { const x = F.c[j]; if (side === 1) { if (x[2] > ch) ch = x[2]; } else if (x[3] < ch) ch = x[3]; }
            const dist = side * (ch - price) / a1;
            if (dist >= 0 && dist <= 0.8 && (!near || dist < near.dist)) near = { side, dist, e21: ch, trigger: ch, tb: true };
        }
    }
    if (ctx.watch && C.ENABLE_TR && S.c2 && S.p2h && S.p2h[i] >= 60) {
        const j2 = S.p2h[i], tri = TRI.get(S, j2, C);
        if (tri) { const nr = TRI.near(tri, S.c2, j2, price, k0[0] + M15, C); if (nr) near = { side: nr.side, dist: nr.dist, e21: nr.line, trigger: nr.line, tr: nr }; }
    }
    return { signal: null, reason: best.reason, stage: best.stage, near, fails };
}

// ------------------------- İŞLEM TAKİBİ -------------------------
const isOpen = s => s.status === 'ACTIVE' || s.status === 'TP1_HIT';
function closeSig(s, status, gross, t) { s.status = status; s.grossR = Number(gross.toFixed(3)); s.netR = Number((gross - s.costR).toFixed(3)); s.closedAt = t; }
function advance(s, k, dur) {
    dur = dur || M1;
    const L = s.dir === 'LONG', sg = L ? 1 : -1, risk = Math.abs(s.entry - s.initialStop), rA = p => sg * (p - s.entry) / risk;
    s.mfe = Math.max(s.mfe || 0, rA(L ? k[2] : k[3])); s.mae = Math.min(s.mae || 0, rA(L ? k[3] : k[2]));
    s.lastPrice = k[4];
    const end = k[0] + dur, el = k[0] - s.time, hitStop = L ? k[3] <= s.stop : k[2] >= s.stop, T1 = s.tp1R, T2 = s.tp2R;
    if (s.mode === 'T') {
        if (hitStop) { const r = rA(s.stop); closeSig(s, r > -0.98 ? 'TRAIL' : 'STOP', r, end); return true; }
        if (el >= (s.maxHold || CFG.MAX_HOLD_MS) || (el >= s.tsMs && s.mfe < s.tsMfe)) { closeSig(s, 'TIMEOUT', rA(k[4]), end); return true; }
        s.hh = L ? Math.max(s.hh == null ? s.entry : s.hh, k[2]) : Math.min(s.hh == null ? s.entry : s.hh, k[3]);
        if (rA(s.hh) >= s.capR) { closeSig(s, 'TP2', s.capR, end); return true; }
        const ns = s.hh - sg * s.trail * s.atr;
        if (L ? ns > s.stop : ns < s.stop) s.stop = ns;
        return false;
    }
    if (s.status === 'ACTIVE') {
        if (hitStop) { closeSig(s, 'STOP', -1, end); return true; }
        if (L ? k[2] >= s.tp1 : k[3] <= s.tp1) {
            if (s.mode === 'B') { closeSig(s, 'TP', T1, end); return true; }
            s.status = 'TP1_HIT'; s.stop = s.entry; s.tp1At = k[0]; s.hh = L ? k[2] : k[3]; return true;
        }
        if (el >= s.tsMs && s.mfe < s.tsMfe) { closeSig(s, 'TIMEOUT', rA(k[4]), end); return true; }
    } else if (s.status === 'TP1_HIT' && k[0] > s.tp1At) {
        if (hitStop) { closeSig(s, s.stop === s.entry ? 'BE' : 'TRAIL', 0.5 * T1 + 0.5 * rA(s.stop), end); return true; }
        if (s.mode === 'C') {
            s.hh = L ? Math.max(s.hh, k[2]) : Math.min(s.hh, k[3]);
            const ns = s.hh - sg * s.trail * s.atr; if (L ? ns > s.stop : ns < s.stop) s.stop = ns;
            if (rA(s.hh) >= s.capR) { closeSig(s, 'TP2', 0.5 * T1 + 0.5 * s.capR, end); return true; }
        } else if (L ? k[2] >= s.tp2 : k[3] <= s.tp2) { closeSig(s, 'TP2', 0.5 * T1 + 0.5 * T2, end); return true; }
    }
    if (el >= (s.maxHold || CFG.MAX_HOLD_MS) && isOpen(s)) { const r = rA(k[4]); closeSig(s, 'TIMEOUT', s.status === 'TP1_HIT' ? 0.5 * T1 + 0.5 * r : r, end); return true; }
    return false;
}

// ------------------------- İSTATİSTİK -------------------------
function grp(list) {
    const n = list.length;
    if (!n) return { n: 0, win: 0, avgR: 0, avgCost: 0, avgGross: 0, totalR: 0, pf: 0, dd: 0, se: 0, t: 0, ci: 0, avgHold: 0 };
    let tot = 0, w = 0, gp = 0, gl = 0, eq = 0, pk = 0, dd = 0, sq = 0, hold = 0, cost = 0;
    for (const s of list) {
        tot += s.netR; cost += s.costR || 0; if (s.netR > 0) { w++; gp += s.netR; } else gl -= s.netR;
        eq += s.netR; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); sq += s.netR * s.netR;
        if (s.closedAt && s.time) hold += s.closedAt - s.time;
    }
    const avg = tot / n; let se = 0, t = 0, ci = 0;
    if (n > 1) { const v = Math.max(0, (sq - n * avg * avg) / (n - 1)); se = Math.sqrt(v / n); t = se > 0 ? avg / se : 0; ci = 1.96 * se; }
    return { n, win: w / n, avgR: avg, avgCost: cost / n, avgGross: avg + cost / n, totalR: tot, pf: gl > 0 ? gp / gl : (gp > 0 ? 99 : 0), dd, se, t: Number(t.toFixed(2)), ci: Number(ci.toFixed(3)), avgHold: Number((hold / n / 60000).toFixed(1)) };
}
function groupBy(list, fn) { const m = {}; for (const s of list) { const k = fn(s); (m[k] = m[k] || []).push(s); } const o = {}; Object.keys(m).sort().forEach(k => { o[k] = grp(m[k]); }); return o; }
const band = s => s.score >= 70 ? '4 70+' : s.score >= 60 ? '3 60-69' : s.score >= 50 ? '2 50-59' : '1 <50';
const mktName = s => s.mkt === 1 ? 'Piyasa LONG' : s.mkt === -1 ? 'Piyasa SHORT' : 'Piyasa YATAY';
const sessOf = s => session(s.candleT != null ? s.candleT : s.time - M15);
function calcStats(closed, todayKey) {
    const sorted = closed.slice().sort((a, b) => a.closedAt - b.closedAt);
    return { all: grp(sorted), today: grp(sorted.filter(s => trDay(s.closedAt) === todayKey)),
        bySetup: groupBy(sorted, s => s.setup + ' ' + s.setupName), bySetupDir: groupBy(sorted, s => s.setup + ' ' + s.setupName + ' ' + s.dir), byDir: groupBy(sorted, s => s.dir), byBand: groupBy(sorted, band),
        bySession: groupBy(sorted, sessOf), byMkt: groupBy(sorted, mktName), byExit: groupBy(sorted, s => s.status), byHour: groupBy(sorted, s => trHour(s.time)) };
}
function health() {
    const cl = signals.filter(s => !s.trPaper && !isOpen(s) && s.netR != null).sort((a, b) => b.closedAt - a.closedAt).slice(0, CFG.HEALTH_N);
    const g = grp(cl), today = trDay(Date.now());
    const dayR = signals.filter(s => !s.trPaper && !isOpen(s) && s.netR != null && trDay(s.closedAt) === today).reduce((a, s) => a + s.netR, 0);
    const badEdge = g.n >= CFG.HEALTH_N && g.avgR < CFG.HEALTH_MIN_R, dayStop = dayR <= CFG.DAY_STOP_R;
    return { n: g.n, need: CFG.HEALTH_N, avgR: g.avgR, dayR, badEdge, dayStop, paper: badEdge || dayStop };
}

// ------------------------- DURUM -------------------------
const ex = new ccxt.bitget({ enableRateLimit: true, options: { defaultType: 'swap' } });
let signals = [], lastSig = {}, universe = [], tickers = {}, tickersAt = 0, radar = [], market = { btc: null, eth: null, mood: null };
let scan = { last: 0, ms: 0, running: false, reasons: {}, by: {}, reasonDay: '', total: 0, eligible: 0, excluded: 0, suspect: 0 }, dirty = false, lastScanSlot = 0;
let mktDir = 0, nonCrypto = new Set(), nonCryptoAt = 0, tracking = false;
let btJob = { running: false, msg: '', done: 0, total: 0, result: null, error: null };
const candleCache = new Map(), mtf = new Map();
// canlı uyarı durumu
let alerts = [], alertCd = {}, liveRadar = [], movers = { up: [], down: [] }, liveRunning = false, tgTimes = [];
let live = { last: 0, ms: 0, n: 0, lines: 0, err: '' };
const struct = {}, lineState = {}, pend = {}, hist = {}, volCache = new Map();

function loadState() {
    try {
        const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        signals = (j.signals || []).filter(s => !s.shadow); lastSig = j.lastSig || {}; alerts = j.alerts || []; alertCd = j.alertCd || {};
        log('durum:', signals.length, 'sinyal,', alerts.length, 'uyarı');
    } catch (e) { log('temiz başlangıç (state.json yok).'); }
}
function saveState() {
    if (!dirty) return; dirty = false;
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        const now = Date.now(), cd = {}; for (const k in alertCd) if (now - alertCd[k] < 6 * H1) cd[k] = alertCd[k];
        const tmp = STATE_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ signals, lastSig, alerts: alerts.slice(0, 400), alertCd: cd })); fs.renameSync(tmp, STATE_FILE);
    } catch (e) { log('kayıt hatası', e.message); }
}
async function telegram(text) {
    if (!TG_TOKEN || !TG_CHAT) return;
    try { await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: TG_CHAT, text }) }); } catch (e) { }
}
function isSuspect(sym) {
    if (isMajor(sym)) return false;
    const m = ex.markets[sym], inf = (m && m.info) || {};
    if (String(inf.isRwa || inf.rwa || '').toUpperCase() === 'YES') return true;
    const st = String(inf.symbolType || inf.category || '').toLowerCase();
    if (st && st !== 'perpetual' && st !== 'crypto') return true;
    const lt = Number(inf.launchTime || inf.onlineTime || 0);
    return lt > 1e12 && Date.now() - lt < CFG.MIN_LISTING_DAYS * 86400e3;
}
async function refreshUniverse() {
    try {
        if (!Object.keys(ex.markets || {}).length) await ex.loadMarkets();
        tickers = await ex.fetchTickers(); tickersAt = Date.now();
        if (Date.now() - nonCryptoAt > 6 * H1) { nonCrypto = new Set(); nonCryptoAt = Date.now(); }
        const all = Object.values(tickers).filter(t => t && t.symbol && t.symbol.endsWith(':USDT') && ex.markets[t.symbol] && ex.markets[t.symbol].linear);
        let suspect = 0;
        const ok = all.filter(t => {
            if (CFG.EXCLUDED.includes(baseOf(t.symbol).toUpperCase()) || nonCrypto.has(t.symbol)) return false;
            if ((t.quoteVolume || 0) < CFG.MIN_VOL_USDT) return false;
            if (isSuspect(t.symbol)) { suspect++; return false; }
            return true;
        });
        scan.suspect = suspect;
        const top = ok.slice().sort((x, y) => (y.quoteVolume || 0) - (x.quoteVolume || 0)).slice(0, CFG.UNIVERSE).map(t => t.symbol);
        for (const s of [BTC, ETH]) if (!top.includes(s)) top.push(s);
        universe = top; scan.total = all.length; scan.eligible = ok.length;
        for (const s of [BTC, ETH]) { const t = tickers[s]; if (t) { const key = s === BTC ? 'btc' : 'eth'; market[key] = Object.assign(market[key] || { dir: 0 }, { price: t.last, chg: t.percentage }); } }
    } catch (e) { log('evren hatası', e.message); }
}
const fetchTF = async (sym, tf, limit, ms) => closedOnly(await ex.fetchOHLCV(sym, tf, undefined, limit), ms);
async function getMulti(sym) {
    const now = Date.now(), rec = mtf.get(sym) || {};
    const lastH1 = Math.floor(now / H1) * H1 - H1, lastH4 = Math.floor(now / (4 * H1)) * (4 * H1) - 4 * H1;
    const need1h = !rec.c1h || last(rec.c1h)[0] < lastH1, need4h = !rec.c4h || last(rec.c4h)[0] < lastH4;
    const get = () => Promise.all([fetchTF(sym, '15m', 300, M15), need1h ? fetchTF(sym, '1h', 400, H1) : null, need4h ? fetchTF(sym, '4h', 150, 4 * H1) : null]);
    let d; try { d = await get(); } catch (e) { await sleep(400); d = await get(); }
    rec.c15 = d[0]; if (d[1]) rec.c1h = d[1]; if (d[2]) rec.c4h = d[2];
    mtf.set(sym, rec); return rec;
}

// ======================= CANLI UYARI MOTORU =======================
// Yapı (üçgen çizgileri + destek/direnç seviyeleri) 15 dakikalık taramada güncellenir.
// Fiyat her LIVE_MS'te (varsayılan 10 sn) kontrol edilir; kapanış beklenmez.
const lineVal = (L, t) => {
    if (L.seg) { const a = L.seg[0], b = L.seg[1], dt = b[0] - a[0]; return dt ? a[1] + (b[1] - a[1]) * (t - a[0]) / dt : a[1]; }
    return L.p;
};
function srLevels(c, atr, price) {
    const K = 3, from = Math.max(K, c.length - CFG.LV_SR_LOOK), end = c.length - 1 - K, pts = [];
    for (let i = from; i <= end; i++) {
        let h = true, l = true;
        for (let d = 1; d <= K && (h || l); d++) {
            if (c[i][2] <= c[i - d][2] || c[i][2] < c[i + d][2]) h = false;
            if (c[i][3] >= c[i - d][3] || c[i][3] > c[i + d][3]) l = false;
        }
        if (h) pts.push(c[i][2]);
        if (l) pts.push(c[i][3]);
    }
    pts.sort((a, b) => a - b);
    const groups = []; let g = null;
    for (const p of pts) {
        if (g && p - g.sum / g.n <= CFG.LV_SR_TOL * atr) { g.sum += p; g.n++; }
        else { g = { sum: p, n: 1 }; groups.push(g); }
    }
    return groups.filter(x => x.n >= CFG.LV_SR_TOUCH).map(x => ({ p: x.sum / x.n, n: x.n }))
        .filter(x => Math.abs(x.p - price) <= CFG.LV_SR_RANGE * atr)
        .sort((a, b) => Math.abs(a.p - price) - Math.abs(b.p - price)).slice(0, 8);
}
function buildStruct(S, t0) {
    const F1 = S.f1h, c1 = F1.c, n1 = c1.length - 1, atr1 = F1.atr[n1];
    if (!(atr1 > 0) || n1 < 60) return null;
    const c15 = S.f15.c, price = c15[c15.length - 1][4];
    const o = { t: t0, atr1, h1: last(S.t1h), h4: last(S.t4h), lines: [] };
    if (CFG.ENABLE_TR && S.c2 && S.c2.length >= 60) {
        const tri = TRI.detect(S.c2, S.c2.length - 1, CFG);
        if (tri) {
            const pk = TRI.pack(tri, S.c2), lb = tri.type + ' • ' + tri.touches + ' dokunuş';
            o.lines.push({ key: 'TR|res|' + pk.res[0][0], src: 'ÜÇGEN', kind: 'res', seg: pk.res, apex: pk.apex, atr: tri.atr, label: lb, h: tri.w0, n: 9 });
            o.lines.push({ key: 'TR|sup|' + pk.sup[0][0], src: 'ÜÇGEN', kind: 'sup', seg: pk.sup, apex: pk.apex, atr: tri.atr, label: lb, h: tri.w0, n: 9 });
        }
    }
    if (CFG.LV_SR) {
        for (const x of srLevels(c1, atr1, price)) {
            o.lines.push({ key: 'SR|' + Math.round(x.p / (0.5 * atr1)), src: 'DESTEK/DİRENÇ', kind: 'lvl', p: x.p, atr: atr1, side0: price >= x.p ? 1 : -1, label: x.n + ' dokunuşlu seviye', n: x.n });
        }
        let hi = -Infinity, lo = Infinity;
        for (let j = n1 - CFG.TB_DON + 1; j <= n1; j++) { hi = Math.max(hi, c1[j][2]); lo = Math.min(lo, c1[j][3]); }
        for (const pr of [[hi, CFG.TB_DON + ' saatlik zirve'], [lo, CFG.TB_DON + ' saatlik dip']]) {
            const p = pr[0];
            if (Math.abs(p - price) > CFG.LV_SR_RANGE * atr1) continue;
            if (o.lines.some(l => l.kind === 'lvl' && Math.abs(l.p - p) < 0.25 * atr1)) continue;
            o.lines.push({ key: 'DON|' + Math.round(p / (0.5 * atr1)), src: TB_LABEL, kind: 'lvl', p, atr: atr1, side0: price >= p ? 1 : -1, label: pr[1], n: 3 });
        }
    }
    return o;
}
const TB_LABEL = '1H ZİRVE/DİP';

async function liveVol(sym) {
    const now = Date.now(), hit = volCache.get(sym);
    if (hit && now - hit.t < 8000) return hit.d;
    const raw = await ex.fetchOHLCV(sym, '15m', undefined, 24);
    const closed = raw.filter(x => x[0] + M15 <= now), cur = raw.find(x => x[0] + M15 > now), base = closed.slice(-20);
    let avg = 0; for (const x of base) avg += x[5]; avg = base.length ? avg / base.length : 0;
    let volX = 0;
    if (avg > 0) {
        const prev = closed.length ? closed[closed.length - 1][5] : 0;
        if (cur) { const el = Math.min(1, Math.max(0.05, (now - cur[0]) / M15)), proj = cur[5] / el; volX = (el < 0.3 ? Math.max(proj, prev) : proj) / avg; }
        else volX = prev / avg;
    }
    const d = { volX }; volCache.set(sym, { t: now, d }); return d;
}
const tgCap = () => { const now = Date.now(); tgTimes = tgTimes.filter(x => now - x < H1); return tgTimes.length < CFG.LV_TG_MAX_H; };
const tvLink = (base, iv) => 'https://www.tradingview.com/chart/?symbol=BITGET:' + base + 'USDT.P&interval=' + iv;
function alertMsg(a) {
    const head = a.kind === 'KIRILDI' ? '🚀 KIRILDI ' : a.kind === 'TEMAS' ? '🔵 TEMAS ' : '🟡 YAKLAŞIYOR ';
    let m = head + (a.dir === 'LONG' ? '🟢 ' : '🔴 ') + a.dir + ' ' + a.base + ' — ' + a.src + ' • ' + a.label + ' (' + a.role + ')';
    m += '\nFiyat ' + fmt(a.price) + ' | çizgi ' + fmt(a.line) + ' (' + a.dist.toFixed(2) + ' ATR' + (a.kind === 'KIRILDI' ? ' ötede' : ' uzakta') + ')';
    m += '\nHacim ' + a.volX.toFixed(1) + 'x ' + (a.strong ? '✅ GÜÇLÜ' : '⚠️ zayıf');
    if (a.kind === 'KIRILDI') m += '\nÖnerilen stop ' + fmt(a.stop) + ' (' + a.riskPct.toFixed(2) + '%) | H1 ' + fmt(a.tp1) + ' | H2 ' + fmt(a.tp2) + '\n⏳ 15m kapanış onayı bekleniyor (takip mesajı gelir)';
    else m += a.kind === 'TEMAS' ? '\nÇizgiye temas: dönüş mü kırılım mı, izle.' : '\nKırılırsa ' + a.dir + ' yönlü. Hacim var, hazır ol.';
    m += '\nPiyasa: ' + (market.mood ? market.mood.label : '-') + (a.warnings.length ? ' | ⚠ ' + a.warnings.join(', ') : '') + '\n📈 ' + tvLink(a.base, 15);
    return m;
}

async function liveTick() {
    if (!CFG.ENABLE_LIVE || liveRunning) return;
    liveRunning = true; const t0 = Date.now();
    try {
        await refreshTickers();
        const now = Date.now();
        if (now - tickersAt > 60e3) { live.err = 'fiyat verisi eski'; liveRunning = false; return; }
        live.err = '';
        // --- hareketliler (5 dk / 15 dk) ---
        const mv = [];
        for (const sym of universe) {
            const tk = tickers[sym]; if (!tk || !tk.last) continue;
            const P = tk.last, h = hist[sym] || (hist[sym] = []);
            h.push([now, P]); while (h.length && now - h[0][0] > 20 * 60e3) h.shift();
            const ago = ms => { if (!h.length || h[0][0] > now - ms + 60e3) return null; let b = h[0]; for (const x of h) if (Math.abs(x[0] - (now - ms)) < Math.abs(b[0] - (now - ms))) b = x; return b[1]; };
            const p5 = ago(5 * 60e3), p15 = ago(15 * 60e3);
            if (p5) mv.push({ symbol: sym, base: baseOf(sym), price: P, c5: (P / p5 - 1) * 100, c15: p15 ? (P / p15 - 1) * 100 : 0, c24: tk.percentage != null ? tk.percentage : 0 });
        }
        mv.sort((a, b) => b.c5 - a.c5);
        movers = { up: mv.filter(x => x.c5 > 0).slice(0, 10), down: mv.filter(x => x.c5 < 0).slice(-10).reverse() };

        // --- çizgi kontrolü ---
        const evs = [], rad = []; let nl = 0;
        for (const sym of Object.keys(struct)) {
            const st = struct[sym], tk = tickers[sym];
            if (!st || !tk || !tk.last || now - st.t > CFG.LV_STALE_MS) continue;
            const P = tk.last; let best = null;
            for (const L of st.lines) {
                if (L.apex && now > L.apex) continue;
                nl++;
                const v = lineVal(L, now), d = (P - v) / L.atr, sk = sym + '|' + L.key;
                let ls = null, sideNow;
                if (L.kind === 'lvl') { ls = lineState[sk] || (lineState[sk] = { side: L.side0 }); sideNow = ls.side; }
                else sideNow = L.kind === 'res' ? -1 : 1;
                const brk = L.kind === 'res' ? (d >= CFG.LV_BRK_ATR ? 1 : 0) : L.kind === 'sup' ? (d <= -CFG.LV_BRK_ATR ? -1 : 0)
                    : (sideNow === -1 && d >= CFG.LV_BRK_ATR ? 1 : sideNow === 1 && d <= -CFG.LV_BRK_ATR ? -1 : 0);
                if (brk) {
                    pend[sk] = (pend[sk] || 0) + 1;
                    if (pend[sk] >= CFG.LV_HOLD_TICKS) {
                        const role = brk === 1 ? 'direnç' : 'destek';
                        if (ls) ls.side = brk;
                        delete pend[sk];
                        evs.push({ type: 'KIRILDI', sym, L, d, v, P, dir: brk === 1 ? 'LONG' : 'SHORT', role, st });
                    }
                    continue;
                }
                delete pend[sk];
                if (!(sideNow * d >= -CFG.LV_BRK_ATR)) continue;
                const ad = Math.abs(d), role = sideNow === -1 ? 'direnç' : 'destek', bias = sideNow === -1 ? 'LONG' : 'SHORT';
                if (ad <= CFG.LV_NEAR_ATR && !(L.kind === 'lvl' && L.n < CFG.LV_SR_NEAR_MIN)) {
                    const touch = ad <= CFG.LV_TOUCH_ATR || sideNow * d < 0;
                    evs.push({ type: touch ? 'TEMAS' : 'YAKLAŞIYOR', sym, L, d, v, P, dir: bias, role, st });
                }
                if (ad <= CFG.LV_NEAR_ATR * 2.2 && (!best || ad < best.ad)) best = { ad, L, v, role, bias, P, sideNow, d };
            }
            if (best) {
                const vc = volCache.get(sym), tkp = tickers[sym];
                rad.push({ symbol: sym, base: baseOf(sym), price: P, rsi: null, adx: null, bias: best.bias, rank: best.ad, chg24: tkp && tkp.percentage != null ? tkp.percentage : 0, tr: best.L.src === 'ÜÇGEN',
                    state: best.L.src + ' • ' + best.L.label + ' • ' + best.role + ' ' + fmt(best.v) + ' (' + best.ad.toFixed(2) + ' ATR ' + (best.sideNow === -1 ? 'aşağıda' : 'yukarıda') + ')' + (vc && now - vc.t < 60e3 ? ' • hacim ' + vc.d.volX.toFixed(1) + 'x' : '') });
            }
        }
        liveRadar = rad.sort((a, b) => a.rank - b.rank).slice(0, 30);

        // --- olaylar -> uyarılar (kırılımlar öncelikli) ---
        evs.sort((a, b) => (a.type === 'KIRILDI' ? 0 : 1) - (b.type === 'KIRILDI' ? 0 : 1) || Math.abs(a.d) - Math.abs(b.d));
        let fetched = 0;
        for (const e of evs) {
            const isB = e.type === 'KIRILDI';
            const cdKey = (isB ? 'B|' : e.type === 'TEMAS' ? 'T|' : 'N|') + e.sym + '|' + e.L.key;
            if (now - (alertCd[cdKey] || 0) < (isB ? CFG.LV_CD_BRK_MIN : CFG.LV_CD_NEAR_MIN) * 60e3) continue;
            if (!isB && now - (alertCd['S|' + e.sym] || 0) < CFG.LV_SYM_GAP_MIN * 60e3) continue;
            const ad = Math.abs(e.d);
            if (isB && ad > CFG.LV_MAX_EXT_ATR) { alertCd[cdKey] = now; dirty = true; continue; }   // geç kalınmış
            if (fetched >= CFG.LV_MAX_VOLFETCH) break;
            let vol; try { vol = await liveVol(e.sym); fetched++; } catch (er) { continue; }
            const gate = isB ? CFG.LV_VOL_BRK : e.type === 'TEMAS' ? CFG.LV_VOL_TOUCH : CFG.LV_VOL_NEAR;
            if (!isB && vol.volX < gate) continue;
            const side = e.dir === 'LONG' ? 1 : -1, warnings = [];
            if (mktDir === -side) warnings.push('Piyasa ters');
            if (e.st.h1 === -side) warnings.push('1H trend ters');
            if (e.st.h4 === -side) warnings.push('4H trend ters');
            const a = { id: e.sym.replace(/[^A-Z0-9]/g, '') + '_' + now, t: now, symbol: e.sym, base: baseOf(e.sym), kind: e.type, src: e.L.src, label: e.L.label, role: e.role, dir: e.dir,
                line: e.v, price: e.P, dist: ad, volX: vol.volX, strong: vol.volX >= CFG.LV_VOL_STRONG, status: isB ? 'BEKLİYOR' : '—', atr: e.L.atr, warnings,
                slope: e.L.seg ? (e.L.seg[1][1] - e.L.seg[0][1]) / ((e.L.seg[1][0] - e.L.seg[0][0]) || 1) : 0, tg: false };
            if (isB) {
                const stop = e.v - side * CFG.LV_STOP_ATR * e.L.atr, risk = side * (e.P - stop);
                a.stop = stop; a.riskPct = risk / e.P * 100; a.tp1 = e.P + side * 1.5 * risk;
                a.tp2 = e.L.h ? e.v + side * e.L.h : e.P + side * 3 * risk;
                if (side * (a.tp2 - e.P) < 1.5 * risk) a.tp2 = e.P + side * 3 * risk;
                if (a.riskPct > 8) a.warnings.push('stop geniş (' + a.riskPct.toFixed(1) + '%)');
            }
            a.tg = vol.volX >= gate && tgCap();
            alertCd[cdKey] = now; alertCd['S|' + e.sym] = now;
            alerts.unshift(a); if (alerts.length > 400) alerts.length = 400; dirty = true;
            log('UYARI', a.kind, a.dir, a.base, a.src, 'hacim', a.volX.toFixed(1), a.tg ? '[TG]' : '');
            if (a.tg) { tgTimes.push(now); telegram(alertMsg(a)); }
        }

        // --- kırılım takibi: 15m kapanışta onay / sahte ---
        let chk = 0;
        for (const a of alerts) {
            if (a.kind !== 'KIRILDI' || a.status !== 'BEKLİYOR') continue;
            const cs = Math.floor(a.t / M15) * M15, evalT = (a.t - cs > 12 * 60e3) ? cs + M15 : cs;
            if (now < evalT + M15 + 6000) continue;
            if (chk++ >= 5) break;
            try {
                const raw = await ex.fetchOHLCV(a.symbol, '15m', undefined, 8), k = raw.find(x => x[0] === evalT);
                if (!k) { if (now > evalT + M15 + 5 * 60e3) { a.status = 'BELİRSİZ'; dirty = true; } continue; }
                const ln = a.line + (a.slope || 0) * (evalT + M15 - a.t), ok = a.dir === 'LONG' ? k[4] > ln : k[4] < ln;
                a.status = ok ? 'ONAYLI' : 'SAHTE'; a.closeAt = k[4]; dirty = true;
                if (a.tg) telegram((ok ? '✅ ONAYLANDI: ' : '❌ SAHTE KIRILIM: ') + a.base + ' ' + a.dir + ' — 15m kapanış ' + fmt(k[4]) + (ok ? ' çizginin ötesinde kaldı.' : ' çizginin gerisine döndü.'));
            } catch (er) { }
        }
        live.last = Date.now(); live.ms = live.last - t0; live.n = Object.keys(struct).length; live.lines = nl;
    } catch (e) { live.err = e.message; log('canlı hata', e.message); }
    liveRunning = false;
}
function pruneLive() {
    const ok = new Set();
    for (const sym of Object.keys(struct)) for (const L of struct[sym].lines) ok.add(sym + '|' + L.key);
    for (const k of Object.keys(lineState)) if (!ok.has(k)) delete lineState[k];
    for (const k of Object.keys(pend)) if (!ok.has(k)) delete pend[k];
    for (const k of Object.keys(struct)) if (!universe.includes(k)) delete struct[k];
    for (const k of Object.keys(hist)) if (!universe.includes(k)) delete hist[k];
    for (const [k, v] of volCache) if (Date.now() - v.t > 5 * 60e3) volCache.delete(k);
}
function alertStats() {
    const g = {};
    const add = (k, a) => { const x = g[k] || (g[k] = { n: 0, ok: 0, fake: 0, wait: 0 }); x.n++; if (a.status === 'ONAYLI') x.ok++; else if (a.status === 'SAHTE') x.fake++; else x.wait++; };
    for (const a of alerts) {
        if (a.kind !== 'KIRILDI') continue;
        add('Tüm kırılımlar', a); add(a.src, a);
        add(a.strong ? 'Güçlü hacim (≥' + CFG.LV_VOL_STRONG + 'x)' : 'Zayıf hacim', a);
        add('Yön ' + a.dir, a);
    }
    return g;
}
// ==================================================================

async function runScan() {
    if (scan.running || !universe.length) return;
    scan.running = true; const t0 = Date.now(), day = trDay(t0);
    if (scan.reasonDay !== day) { scan.reasons = {}; scan.by = {}; scan.reasonDay = day; }
    const bump = k => { scan.reasons[k] = (scan.reasons[k] || 0) + 1; };
    const bumpBy = (nm, k) => { const o = scan.by[nm] || (scan.by[nm] = {}); o[k] = (o[k] || 0) + 1; };
    try {
        const S = {}; let idx = 0;
        const worker = async () => {
            while (idx < universe.length) {
                const sym = universe[idx++];
                try {
                    const d = await getMulti(sym);
                    if (!isMajor(sym) && flatRatio(d.c15) >= CFG.FLAT_MAX) { nonCrypto.add(sym); continue; }
                    if (d.c15.length < 120 || !d.c1h || d.c1h.length < 60 || !d.c4h || d.c4h.length < 60) { bump('veri az'); continue; }
                    S[sym] = buildSym(d.c15, d.c1h, d.c4h);
                } catch (e) { bump('hata'); }
            }
        };
        await Promise.all(Array.from({ length: CFG.CONCURRENCY }, worker));

        let up = 0, dn = 0, fl = 0; const keys = Object.keys(S);
        for (const k of keys) { const v = last(S[k].t15); if (v === 1) up++; else if (v === -1) dn++; else fl++; }
        const bsc = breadthScore(up, dn, keys.length);
        const bd = S[BTC] ? last(S[BTC].t15) : 0, ed = S[ETH] ? last(S[ETH].t15) : 0;
        mktDir = mktOf(bd, ed, bsc);
        market.btc = Object.assign(market.btc || {}, { dir: bd }); market.eth = Object.assign(market.eth || {}, { dir: ed });
        market.mood = { label: mktDir === 1 ? 'LONG' : mktDir === -1 ? 'SHORT' : 'YATAY', up, down: dn, flat: fl, n: keys.length, breadth: Number(bsc.toFixed(2)), btc: bd, eth: ed, score: Number((2 * bd + ed + bsc).toFixed(2)) };
        scan.excluded = nonCrypto.size;

        const btcMap = S[BTC] ? new Map(S[BTC].f15.c.map(x => [x[0], x[4]])) : null;
        const watchAll = [], found = [];
        for (const sym of universe) {
            const s = S[sym]; if (!s) continue;
            const c = s.f15.c, i = c.length - 1;
            if (t0 - (c[i][0] + M15) > 2 * M15) { bump('bayat veri'); continue; }
            const t = tickers[sym] || {};
            if (CFG.ENABLE_LIVE) { try { const stc = buildStruct(s, t0); if (stc) struct[sym] = stc; } catch (e) { } }
            const r = signalAt(s, i, { sym, mkt: mktDir, rs: isMajor(sym) ? null : rsAt(c, i, btcMap, CFG.RS_LB), costPct: costFor(t.quoteVolume) * CFG.COST_MULT, watch: true });
            bump(r.reason);
            if (r.fails) for (const nm in r.fails) bumpBy(nm, r.fails[nm].reason);
            if (r.near && !(CFG.ENABLE_LIVE && r.near.tr)) {
                let state;
                if (r.near.tr) state = TRI.stateText(r.near.tr, fmt);
                else if (r.near.tb) state = '1H kırılım seviyesi ' + fmt(r.near.trigger) + (r.near.side === 1 ? ' üstü' : ' altı') + ' 1H kapanış bekleniyor';
                else state = 'Pullback bölgesi (EMA21 ' + fmt(r.near.e21) + '), tetik: ' + fmt(r.near.trigger) + (r.near.side === 1 ? ' üstü' : ' altı') + ' 15m kapanış';
                watchAll.push({ symbol: sym, base: baseOf(sym), price: c[i][4], rsi: s.f15.rsi[i], adx: s.f15.adx[i], bias: r.near.side === 1 ? 'LONG' : 'SHORT', rank: r.near.dist, chg24: t.percentage != null ? t.percentage : 0, state, tr: !!r.near.tr });
            }
            if (r.signal) { if (Date.now() - r.signal.time <= CFG.MAX_SIGNAL_AGE_MS) found.push(r.signal); else bump('eski sinyal'); }
        }
        radar = watchAll.sort((a, b) => a.rank - b.rank).slice(0, 25);
        if (CFG.ENABLE_LIVE) pruneLive();

        found.sort((a, b) => b.score - a.score);
        let added = 0; const H = health();
        for (const s of found) {
            if (added >= CFG.MAX_PER_SCAN) break;
            const trp = s.setup === 'TR' && CFG.TR_PAPER, lastKey = trp ? s.symbol + '|TRP' : s.symbol;
            if (signals.some(x => x.symbol === s.symbol && !!x.trPaper === trp && isOpen(x))) continue;
            if (Date.now() - (lastSig[lastKey] || 0) < cdOf(s, CFG)) continue;
            const open = signals.filter(x => isOpen(x) && !x.trPaper);
            if (trp) { if (signals.filter(x => isOpen(x) && x.trPaper).length >= CFG.MAX_OPEN_SETUP.TR) continue; }
            else if (open.filter(x => x.dir === s.dir).length >= CFG.MAX_OPEN_PER_DIR || open.length >= CFG.MAX_OPEN_TOTAL || open.filter(x => x.setup === s.setup).length >= (CFG.MAX_OPEN_SETUP[s.setup] || 3)) continue;
            s.id = s.symbol.replace(/[^A-Z0-9]/g, '') + '_' + s.setup + '_' + s.candleT;
            s.trPaper = trp; s.status = 'ACTIVE'; s.paper = H.paper || trp; s.variant = trp ? 'TR ileri test' : 'Ana'; s.trackedTo = s.candleT + M15 - M1;
            signals.unshift(s); lastSig[lastKey] = Date.now(); if (!trp) added++; dirty = true;
            log('SİNYAL', s.paper ? '[KAĞIT]' : '', s.setup, s.dir, s.symbol, 'puan', s.score, 'piyasa', market.mood.label);
            if (!s.paper) {
                const iv = s.setup === 'TR' ? String(TRI.AGG * 60) : '15';
                telegram((s.dir === 'LONG' ? '🟢 ' : '🔴 ') + s.dir + ' ' + s.base + ' — ' + s.setupName + ' (puan ' + s.score + ', KAPANIŞ ONAYLI)' + (H.n < H.need ? ' 🧪 doğrulanmamış' : '') +
                    '\nPiyasa: ' + market.mood.label + (s.mode === 'T' ? '' : ' | Hedef alanı ' + s.room.toFixed(1) + 'R') + ' | Maliyet ' + s.costR.toFixed(2) + 'R\nGiriş ' + fmt(s.entry) + '\nStop ' + fmt(s.stop) + ' (' + s.riskPct.toFixed(2) + '%)' +
                    (s.mode === 'T' ? '\nÇıkış: ' + s.trail + 'xATR(1H) trailing stop, sabit hedef yok (azami 72s)' : '\nTP1 ' + fmt(s.tp1) + (s.mode === 'B' ? '' : ' | TP2 ' + fmt(s.tp2))) +
                    '\n⏱ 5 dk içinde gir; fiyat girişten 0.3R uzaklaştıysa atla.\n📈 ' + tvLink(s.base, iv) + (s.warnings.length ? '\n⚠ ' + s.warnings.join(', ') : ''));
            }
        }
        signals = signals.slice(0, CFG.KEEP);
        scan.last = Date.now(); scan.ms = scan.last - t0;
    } catch (e) { log('tarama hatası', e.message); }
    scan.running = false;
}

async function track() {
    if (tracking) return;
    const open = signals.filter(isOpen); if (!open.length) return;
    tracking = true;
    try {
        const bySym = {}; for (const s of open) (bySym[s.symbol] = bySym[s.symbol] || []).push(s);
        for (const sym of Object.keys(bySym)) {
            try {
                const list = bySym[sym]; let guard = 0;
                while (guard++ < 12 && list.some(isOpen)) {
                    const since = Math.min(...list.filter(isOpen).map(x => x.trackedTo));
                    const raw = await ex.fetchOHLCV(sym, '1m', since, 500), c = closedOnly(raw, M1); let progressed = false;
                    for (const s of list) {
                        if (!isOpen(s)) continue;
                        for (const k of c) {
                            if (k[0] <= s.trackedTo) continue;
                            s.trackedTo = k[0]; progressed = true; dirty = true;
                            const before = s.status;
                            if (advance(s, k, M1)) {
                                if (!isOpen(s)) { log('KAPANDI', s.symbol, s.status, s.netR); if (!s.paper) telegram(s.base + ' ' + s.dir + ' kapandı: ' + s.status + ' (' + s.netR + 'R)'); break; }
                                if (before === 'ACTIVE' && s.status === 'TP1_HIT' && !s.paper) telegram(s.base + ' ' + s.dir + ': TP1 alındı, stop girişe çekildi.');
                            }
                        }
                    }
                    if (raw.length < 500 || !progressed) break;
                }
                const t = tickers[sym]; if (t && t.last) for (const s of list) if (isOpen(s)) s.lastPrice = t.last;
            } catch (e) { }
        }
    } catch (e) { }
    tracking = false;
}
async function refreshTickers() {
    try {
        const t = await ex.fetchTickers(); tickers = t; tickersAt = Date.now();
        for (const s of [BTC, ETH]) if (t[s]) { const key = s === BTC ? 'btc' : 'eth'; market[key] = Object.assign(market[key] || { dir: 0 }, { price: t[s].last, chg: t[s].percentage }); }
        for (const s of signals) if (isOpen(s) && t[s.symbol] && t[s.symbol].last) s.lastPrice = t[s.symbol].last;
    } catch (e) { }
}
const selfPing = async () => { if (SELF_URL) { try { await fetch(SELF_URL + '/health'); } catch (e) { } } };

function apiState() {
    const now = Date.now(), closed = signals.filter(s => !isOpen(s) && s.netR != null && !s.trPaper), st = calcStats(closed, trDay(now));
    let e = 0; const eq = closed.slice().sort((a, b) => a.closedAt - b.closedAt).slice(-200).map(s => (e += s.netR));
    const rd = liveRadar.concat(radar.filter(r => !liveRadar.some(x => x.symbol === r.symbol))).sort((a, b) => a.rank - b.rank).slice(0, 30);
    return { now, mode: 'v14 CANLI UYARI + PB + TB + TR (üçgen ' + TRI.AGG + 'H)', minScore: CFG.MIN_SCORE, market, signals: signals.slice(0, 80), radar: rd, stats: st, equity: eq, health: health(),
        alerts: alerts.slice(0, 100), alertStats: alertStats(), movers,
        live: { enabled: CFG.ENABLE_LIVE, periodMs: CFG.LIVE_MS, last: live.last, ms: live.ms, symbols: live.n, lines: live.lines, err: live.err, tgHour: tgTimes.filter(x => now - x < H1).length, tgMax: CFG.LV_TG_MAX_H, tgOn: !!(TG_TOKEN && TG_CHAT),
            near: CFG.LV_NEAR_ATR, touch: CFG.LV_TOUCH_ATR, brk: CFG.LV_BRK_ATR, volNear: CFG.LV_VOL_NEAR, volBrk: CFG.LV_VOL_BRK, volStrong: CFG.LV_VOL_STRONG },
        last24: signals.filter(s => now - s.time < 24 * H1).length,
        filters: { exit: CFG.EXIT_MODE, mkt: CFG.MKT_MODE, adx: CFG.MIN_ADX, room: CFG.ROOM_MIN, maxCostR: CFG.MAX_COST_R, minRisk: CFG.MIN_RISK_PCT, volMax: CFG.VOL_MAX, rsMin: CFG.RS_MIN, sw: CFG.ENABLE_SW, req4h: CFG.REQ_4H, pb: CFG.ENABLE_PB, tb: CFG.ENABLE_TB, tbAdx: CFG.TB_ADX, tbStop: CFG.TB_STOP_ATR, tbTrail: CFG.TB_TRAIL_ATR, pbRelax: CFG.PB_RELAX_15M,
            tr: CFG.ENABLE_TR, trPaper: CFG.TR_PAPER, trAgg: TRI.AGG, trMinTouch: CFG.TRI_MIN_TOUCH, trSqueeze: CFG.TRI_SQUEEZE, trBrk: CFG.TRI_BRK_ATR, trVolx: CFG.TRI_VOLX },
        scan: { last: scan.last, ms: scan.ms, reasons: scan.reasons, by: scan.by, universe: universe.length, total: scan.total, eligible: scan.eligible, excluded: scan.excluded, suspect: scan.suspect } };
}
async function apiCandles(sym, tf) {
    if (!ex.markets[sym]) throw new Error('bilinmeyen sembol');
    tf = tf === '15m' ? '15m' : 'tri';
    const key = sym + '|' + tf, hit = candleCache.get(key); if (hit && Date.now() - hit.t < 8000) return hit.d;
    let d;
    if (tf === '15m') {
        const c = await ex.fetchOHLCV(sym, '15m', undefined, 200), cl = c.map(x => x[4]), e21 = emaSeries(cl, 21), e50 = emaSeries(cl, 50), cut = Math.max(0, c.length - 120);
        d = { c: c.slice(cut), e21: e21.slice(cut), e50: e50.slice(cut), tf: '15m', dur: M15, tri: null };
    } else {
        const raw = closedOnly(await ex.fetchOHLCV(sym, '1h', undefined, 400), H1), c2 = TRI.aggregate(raw, aggregateN);
        if (c2.length < 30) throw new Error('yetersiz veri');
        const cl = c2.map(x => x[4]), e21 = emaSeries(cl, 21), e50 = emaSeries(cl, 50), cut = Math.max(0, c2.length - 120);
        const tri = c2.length > 60 ? (TRI.detect(c2, c2.length - 1, CFG) || TRI.detect(c2, c2.length - 2, CFG)) : null;
        d = { c: c2.slice(cut), e21: e21.slice(cut), e50: e50.slice(cut), tf: TRI.AGG + 'H', dur: TRI.DUR, tri: tri ? TRI.pack(tri, c2) : null };
    }
    candleCache.set(key, { t: Date.now(), d });
    if (candleCache.size > 300) { const old = [...candleCache.entries()].sort((a, b) => a[1].t - b[1].t).slice(0, 100); for (const o of old) candleCache.delete(o[0]); }
    return d;
}

async function fetchHistory15(sym, days) {
    const total = days + 14, need = total * 96;
    let since = Date.now() - total * D1, all = [], guard = 0;
    while (since < Date.now() - M15 && guard++ < 200) {
        let r = null, retry = 0;
        while (retry < 4) { try { r = await ex.fetchOHLCV(sym, '15m', since, 1000); break; } catch (e) { retry++; await sleep(800 * retry); } }
        if (!r || !r.length) break;
        all = all.concat(r); const l = last(r)[0];
        if (l <= since) break; since = l + M15;
        await sleep(100);
    }
    all.sort((a, b) => a[0] - b[0]);
    let g2 = 0;
    while (all.length && all[0][0] > Date.now() - total * D1 + D1 && g2++ < 40) {
        let r = null;
        try { r = await ex.fetchOHLCV(sym, '15m', undefined, 1000, { until: all[0][0] - 1 }); } catch (e) { break; }
        const fresh = (r || []).filter(x => x[0] < all[0][0]);
        if (!fresh.length) break;
        all = fresh.concat(all); await sleep(100);
    }
    const seen = new Set();
    const c = closedOnly(all, M15).filter(x => !seen.has(x[0]) && seen.add(x[0])).sort((a, b) => a[0] - b[0]);
    const usable = c.length ? (last(c)[0] - c[0][0]) / D1 - 11 : 0;
    return { c, coverage: need > 0 ? c.length / need : 0, usable };
}
function prepare(data, costOf, volOf) {
    const pre = {}, cnt = new Map(), trMap = { [BTC]: new Map(), [ETH]: new Map() };
    for (const s of Object.keys(data)) {
        const c = data[s], S = buildSym(c, aggregateN(c, M15, 4), aggregateN(c, M15, 16));
        S.costPct = costOf(s); pre[s] = S;
        {
            // nokta-zamanlı 24s hacim: bugünkü ticker hacmine göre ölçeklenir
            const rv = new Array(c.length).fill(null); let sm = 0;
            for (let i = 0; i < c.length; i++) { sm += c[i][4] * c[i][5]; if (i >= 96) sm -= c[i - 96][4] * c[i - 96][5]; if (i >= 95) rv[i] = sm; }
            const tv = volOf ? volOf(s) : 0, lr = rv[c.length - 1];
            S.rv = rv; S.rvKnown = tv > 0 && lr > 0; S.rvScale = S.rvKnown ? tv / lr : 1;
        }
        for (let i = 0; i < c.length; i++) {
            const t = c[i][0], v = S.t15[i]; let a = cnt.get(t); if (!a) { a = [0, 0, 0]; cnt.set(t, a); }
            a[2]++; if (v === 1) a[0]++; else if (v === -1) a[1]++;
            if (trMap[s]) trMap[s].set(t, v);
        }
    }
    const mkt = new Map();
    for (const [t, a] of cnt) mkt.set(t, mktOf(trMap[BTC].get(t) || 0, trMap[ETH].get(t) || 0, breadthScore(a[0], a[1], a[2])));
    return { pre, maps: { mkt, btc: new Map(pre[BTC].f15.c.map(x => [x[0], x[4]])) } };
}
async function simulate(pre, use, maps, cfgO, opts, startT) {
    const C = Object.assign({}, CFG, cfgO || {}), raw = [], funnel = {}, funnelBy = {};
    for (const sym of use) {
        const S = pre[sym], c = S.f15.c, n = c.length; let busy = 0;
        const from = Math.max(startT, c[0][0] + 11 * D1);
        for (let i = 80; i < n - 1; i++) {
            const t = c[i][0]; if (t < from || t < busy) continue;
            if (i % 1500 === 0) await tick();
            const rvv = S.rvKnown && S.rv[i] != null ? S.rv[i] * S.rvScale : null;
            if (rvv != null && !isMajor(sym) && rvv < C.BT_MIN_VOL) { funnel['likidite (o an)'] = (funnel['likidite (o an)'] || 0) + 1; continue; }
            const r = signalAt(S, i, { sym, mkt: maps.mkt.get(t) || 0, rs: isMajor(sym) ? null : rsAt(c, i, maps.btc, C.RS_LB), costPct: rvv != null ? costFor(rvv) * (opts.costMult || 1) : S.costPct, minScore: opts.minScore, cfg: C });
            if (!r.signal) {
                if (r.fails) for (const nm in r.fails) { const fb = funnelBy[nm] || (funnelBy[nm] = {}), kk = r.fails[nm].reason; fb[kk] = (fb[kk] || 0) + 1; }
                if (r.reason !== 'veri az') funnel[r.reason] = (funnel[r.reason] || 0) + 1;
                continue;
            }
            funnel.sinyal = (funnel.sinyal || 0) + 1;
            const s = r.signal; s.status = 'ACTIVE';
            for (let j = i + 1; j < n; j++) { if (advance(s, c[j], M15) && !isOpen(s)) break; }
            if (isOpen(s)) continue;
            raw.push({ symbol: s.symbol, base: s.base, dir: s.dir, setup: s.setup, setupName: s.setupName, score: s.score, time: s.time, candleT: s.candleT, closedAt: s.closedAt, netR: s.netR, costR: s.costR, status: s.status, mkt: s.mkt, mfe: s.mfe });
            busy = Math.max(s.closedAt, s.time + cdOf(s, C));
        }
    }
    raw.sort((a, b) => a.time - b.time || b.score - a.score);
    const trades = [], openL = [], slot = {}; let blocked = 0;
    for (const t of raw) {
        for (let q = openL.length - 1; q >= 0; q--) if (openL[q].closedAt <= t.time) openL.splice(q, 1);
        const sk = Math.floor(t.time / M15), td = trDay(t.time);
        let dayR = 0; for (let q = trades.length - 1; q >= 0 && q > trades.length - 200; q--) { const x = trades[q]; if (x.closedAt <= t.time && trDay(x.closedAt) === td) dayR += x.netR; }
        if (openL.filter(o => o.dir === t.dir).length >= C.MAX_OPEN_PER_DIR || openL.length >= C.MAX_OPEN_TOTAL || openL.filter(o => o.setup === t.setup).length >= (C.MAX_OPEN_SETUP[t.setup] || 3) || (slot[sk] || 0) >= C.MAX_PER_SCAN || dayR <= C.DAY_STOP_R) { blocked++; continue; }
        slot[sk] = (slot[sk] || 0) + 1; openL.push(t); trades.push(t);
    }
    funnel['portföy limiti'] = blocked;
    return { trades, raw, funnel, funnelBy };
}
function robust(list) {
    const n = list.length;
    if (!n) return { med: 0, k: 0, exTop5: 0, exCoin2: 0, top2: [], top2Share: 0 };
    const r = list.map(s => s.netR).sort((a, b) => a - b);
    const med = n % 2 ? r[(n - 1) / 2] : (r[n / 2 - 1] + r[n / 2]) / 2;
    const k = Math.min(5, Math.floor(n / 4)), rest = r.slice(0, n - k);
    const exTop5 = rest.length ? rest.reduce((a, b) => a + b, 0) / rest.length : 0;
    const byC = {}; let tot = 0;
    for (const s of list) { const e = byC[s.base] || (byC[s.base] = { r: 0, n: 0 }); e.r += s.netR; e.n++; tot += s.netR; }
    const top = Object.entries(byC).sort((a, b) => b[1].r - a[1].r).slice(0, 2);
    const tr2 = top.reduce((a, x) => a + x[1].r, 0), tn = top.reduce((a, x) => a + x[1].n, 0);
    return { med, k, exTop5, exCoin2: n - tn > 0 ? (tot - tr2) / (n - tn) : 0, top2: top.map(x => x[0]), top2Share: tot > 0 ? tr2 / tot : 0 };
}
const split3 = tr => { const n = tr.length, a = Math.floor(n * 0.5), b = Math.floor(n * 0.75); return { all: grp(tr), is: grp(tr.slice(0, a)), val: grp(tr.slice(a, b)), oos: grp(tr.slice(b)) }; };

async function runBacktest(days, coins, opts) {
    if (btJob.running) return;
    opts = Object.assign({ costMult: 1, minScore: CFG.MIN_SCORE, compare: false }, opts || {});
    btJob = { running: true, msg: 'Hazırlanıyor', done: 0, total: 1, result: null, error: null };
    try {
        if (!universe.length) await refreshUniverse();
        const syms = universe.filter(s => s !== BTC && s !== ETH).slice(0, coins), all = [BTC, ETH].concat(syms);
        const list = opts.compare ? VARIANTS : [VARIANTS[0]];
        btJob.total = all.length + list.length;
        const data = {}, skipped = []; let candles = 0, usableMax = 0;
        for (const s of all) {
            btJob.msg = 'Veri indiriliyor: ' + baseOf(s);
            try {
                const h = await fetchHistory15(s, days);
                if (h.usable < 4 && !isMajor(s)) skipped.push(baseOf(s) + ' (' + Math.max(0, Math.round(h.usable)) + ' gün)');
                else if (!isMajor(s) && flatRatio(h.c) >= CFG.FLAT_MAX) skipped.push(baseOf(s) + ' (düz mum)');
                else { data[s] = h.c; usableMax = Math.max(usableMax, h.usable); candles += h.c.length; }
            } catch (e) { skipped.push(baseOf(s) + ' (hata)'); }
            btJob.done++;
        }
        if (!data[BTC] || data[BTC].length < 1500) throw new Error('BTC 15m verisi yetersiz');
        if (!data[ETH]) data[ETH] = data[BTC];
        btJob.msg = 'Trend ve piyasa yönü hesaplanıyor'; await tick();
        const { pre, maps } = prepare(data, s => costFor((tickers[s] || {}).quoteVolume) * opts.costMult, s => (tickers[s] || {}).quoteVolume);
        const effDays = Math.max(1, Math.min(days, Math.round(usableMax))), startT = Date.now() - days * D1, use = Object.keys(data), compare = []; let base = null;
        for (const v of list) {
            btJob.msg = 'Test ediliyor: ' + v.name;
            const r = await simulate(pre, use, maps, v.o, opts, startT), sp = split3(r.trades);
            const rb = robust(r.trades);
            compare.push({ name: v.name, ex5: rb.exTop5, n: sp.all.n, perDay: sp.all.n / effDays, win: sp.all.win, avgR: sp.all.avgR, gross: sp.all.avgGross, cost: sp.all.avgCost, totalR: sp.all.totalR, pf: sp.all.pf, dd: sp.all.dd, t: sp.all.t, isR: sp.is.avgR, valR: sp.val.avgR, oosR: sp.oos.avgR, oosN: sp.oos.n });
            if (!base) base = { r, sp };
            btJob.done++;
        }
        const trades = base.r.trades, sp = base.sp, sLo = [], sHi = [];
        {
            const by = {}; for (const t of trades) (by[t.setup] = by[t.setup] || []).push(t);
            for (const k of Object.keys(by)) { const a = by[k].slice().sort((x, y) => x.score - y.score), m = Math.floor(a.length / 2); if (a.length >= 4) { for (const x of a.slice(0, m)) sLo.push(x); for (const x of a.slice(a.length - m)) sHi.push(x); } }
        }
        btJob.result = { days: effDays, reqDays: days, coins, candles, skipped, funnel: base.r.funnel, costMult: opts.costMult, minScore: opts.minScore, rawN: base.r.raw.length,
            perDay: sp.all.n / effDays, all: sp.all, is: sp.is, val: sp.val, oos: sp.oos, compare: opts.compare ? compare : null,
            scoreCheck: { lo: grp(sLo), hi: grp(sHi) }, robust: robust(trades), funnelBy: base.r.funnelBy,
            bySetupDir: groupBy(trades, s => s.setup + ' ' + s.setupName + ' ' + s.dir),
            bySetup: groupBy(trades, s => s.setup + ' ' + s.setupName), byDir: groupBy(trades, s => s.dir), byBand: groupBy(trades, band),
            bySession: groupBy(trades, sessOf), byMkt: groupBy(trades, mktName), byExit: groupBy(trades, s => s.status),
            byWeek: groupBy(trades, s => 'Hafta ' + String(Math.floor((s.time - startT) / (7 * D1)) + 1).padStart(2, '0')), byCoin: groupBy(trades, s => s.base) };
        btJob.msg = 'Tamamlandı';
    } catch (e) { btJob.error = 'Test hatası: ' + e.message; log('BT hata', e.message); }
    btJob.running = false;
}

// ------------------------- ARAYÜZ (gömülü) -------------------------
const HTML = String.raw`<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SONER TRADE v14</title>
<style>
:root{--bg:#0c1117;--p1:#141b24;--p2:#1a2430;--ln:#243040;--tx:#e6ebf2;--dm:#8593a5;--lg:#3ddc97;--st:#ff6b7a;--am:#f2b84b;--bl:#5aa9ff}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--tx);font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-variant-numeric:tabular-nums}
button,input,select{font:inherit;color:inherit}button{cursor:pointer}
.app{display:flex;flex-direction:column;height:100vh}
.top{display:flex;align-items:center;gap:10px;padding:9px 14px;background:var(--p1);border-bottom:1px solid var(--ln);flex-wrap:wrap}
.brand{font-weight:800;font-size:15px}.brand small{color:var(--am);margin-left:8px;font-size:11px}
.chip{background:var(--bg);border:1px solid var(--ln);padding:4px 9px;border-radius:6px;font-size:12px}
.chip b{color:var(--dm);font-weight:600}
.up{color:var(--lg)}.dn{color:var(--st)}.fl{color:var(--dm)}.am{color:var(--am)}
.grow{flex:1}
.dot{width:8px;height:8px;border-radius:50%;background:var(--st);display:inline-block;margin-right:5px}.dot.on{background:var(--lg)}
.body{flex:1;display:flex;min-height:0}
.side{width:400px;flex-shrink:0;background:var(--p1);border-right:1px solid var(--ln);display:flex;flex-direction:column;min-height:0}
.tabs{display:flex;border-bottom:1px solid var(--ln)}
.tab{flex:1;padding:11px 2px;background:none;border:none;border-bottom:2px solid transparent;color:var(--dm);font-weight:700;font-size:12px}
.tab.a{color:var(--tx);border-bottom-color:var(--am)}
.list{flex:1;overflow:auto;padding:8px}
.main{flex:1;overflow:auto;padding:16px;min-width:0}
.card{background:var(--p2);border:1px solid var(--ln);border-radius:8px;padding:10px 12px;margin-bottom:8px;cursor:pointer}
.card.sel{border-color:var(--am)}.card.closed{opacity:.72}
.r1{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.badge{font-weight:800;font-size:11px;padding:2px 7px;border-radius:4px}
.badge.L{background:rgba(61,220,151,.16);color:var(--lg)}.badge.S{background:rgba(255,107,122,.16);color:var(--st)}
.coin{font-weight:800;font-size:14px}
.sc{margin-left:auto;font-weight:800;font-size:15px;color:var(--am)}
.sub{color:var(--dm);font-size:11px;margin-top:4px;display:flex;gap:10px;flex-wrap:wrap}.sub b{color:var(--tx)}
.tag{font-size:10px;padding:1px 6px;border-radius:4px;background:var(--bg);border:1px solid var(--ln);color:var(--dm)}
.tag.w{color:var(--am);border-color:rgba(242,184,75,.4)}.tag.g{color:var(--lg);border-color:rgba(61,220,151,.4)}.tag.r{color:var(--st);border-color:rgba(255,107,122,.4)}
h2{font-size:15px;margin-bottom:10px}h3{font-size:12px;color:var(--dm);font-weight:700;margin:14px 0 6px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:12px}
.tile{background:var(--p2);border:1px solid var(--ln);border-radius:8px;padding:9px 12px}
.tile .k{color:var(--dm);font-size:11px}.tile .v{font-size:21px;font-weight:800;margin-top:2px}
.box{background:var(--p2);border:1px solid var(--ln);border-radius:8px;padding:12px;margin-bottom:12px}
.box.ok{border-color:rgba(61,220,151,.6)}.box.no{border-color:rgba(255,107,122,.6)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
table{width:100%;border-collapse:collapse}
th{color:var(--dm);font-weight:600;text-align:left;font-size:11px;padding:4px 6px;border-bottom:1px solid var(--ln)}
td{padding:5px 6px;border-bottom:1px solid rgba(36,48,64,.6)}td.n,th.n{text-align:right}
.lv{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:8px;margin:10px 0}
.lv div{background:var(--bg);border:1px solid var(--ln);border-radius:6px;padding:6px 8px}
.lv span{display:block;font-size:10px;color:var(--dm)}.lv b{font-size:14px}
canvas{width:100%;height:360px;display:block;background:var(--bg);border:1px solid var(--ln);border-radius:8px}
.bar{height:6px;background:var(--bg);border-radius:3px;overflow:hidden}.bar i{display:block;height:100%;background:var(--am)}
.pr{display:grid;grid-template-columns:120px 1fr 30px;gap:8px;align-items:center;margin:5px 0;font-size:12px}
.frm{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0;align-items:center}
.frm input,.frm select{background:var(--bg);border:1px solid var(--ln);border-radius:6px;padding:6px 8px;width:auto}
.frm input{width:100px}
.btn{background:var(--am);color:#1a1405;border:none;border-radius:6px;padding:7px 12px;font-weight:800}
.btn.tv{background:#2962ff;color:#fff;text-decoration:none;display:inline-block}
.btn.off{background:var(--p2);color:var(--dm);border:1px solid var(--ln)}
.note{font-size:11px;color:var(--dm);margin-top:8px}
@media(max-width:900px){body{overflow:auto}.app{height:auto}.body{flex-direction:column}.side{width:100%;height:46vh}.grid2{grid-template-columns:1fr}canvas{height:260px}}
</style>
</head>
<body>
<div class="app">
 <div class="top">
  <div class="brand">SONER TRADE<small id="modeB">v14</small></div>
  <div class="chip" id="cMkt"></div><div class="chip" id="cBTC"></div><div class="chip" id="cETH"></div><div class="chip" id="cHealth"></div>
  <div class="grow"></div>
  <span><span class="dot" id="dot"></span><span id="conn">Bağlanıyor</span></span>
 </div>
 <div class="body">
  <div class="side"><div class="tabs" id="tabs"></div><div class="list" id="list"></div></div>
  <div class="main" id="main"></div>
 </div>
</div>
<script>
const TABS=[['al','Uyarılar'],['sig','Sinyaller'],['radar','Radar'],['mv','Hareket'],['stat','İstatistik'],['bt','Test']];
const allSigs=()=>S.signals;
let S=null,tab='al',sel=null,bt=null,chartCache={},chartFor='',chartTF='tri',cfgC=JSON.parse(localStorage.getItem('st_calc')||'{"bal":1000,"risk":0.5}'),lastAl=0,actx=null;
const $=id=>document.getElementById(id);
const fp=p=>{if(p==null)return'-';p=Number(p);const a=Math.abs(p);return a>=1000?p.toFixed(2):a>=1?p.toFixed(4):a>=0.01?p.toFixed(5):p.toFixed(7)};
const f2=(x,d=2)=>x==null||isNaN(x)?'-':Number(x).toFixed(d);
const sg=(x,d=2)=>{x=Number(x);return(x>0?'+':'')+x.toFixed(d)};
const cl=x=>x>0?'up':x<0?'dn':'fl';
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const ago=ts=>{const m=Math.floor((Date.now()-ts)/60000);return m<1?'şimdi':m<60?m+' dk':Math.floor(m/60)+'s '+(m%60)+'dk'};
const openS=s=>s.status==='ACTIVE'||s.status==='TP1_HIT';
const tvUrl=(sym,iv)=>'https://www.tradingview.com/chart/?symbol=BITGET:'+sym.split('/')[0]+'USDT.P&interval='+(iv||120);
const pnlR=s=>s&&s.lastPrice?(s.dir==='LONG'?1:-1)*(s.lastPrice-s.entry)/Math.abs(s.entry-s.initialStop):null;
const ST={ACTIVE:['Açık','w'],TP1_HIT:['TP1 ✓','g'],TP2:['TP2 ✓','g'],TP:['Hedef ✓','g'],TRAIL:['Trailing','g'],STOP:['Stop','r'],BE:['Başa baş','w'],TIMEOUT:['Süre','w']};
const key=()=>localStorage.getItem('st_key')||'';
async function post(url,b){const r=await fetch(url+'?key='+encodeURIComponent(key()),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})});
 if(r.status===401){const k=prompt('Yönetici anahtarı (ADMIN_KEY):');if(k){localStorage.setItem('st_key',k);return post(url,b)}}return r}
function beep(){try{actx=actx||new (window.AudioContext||window.webkitAudioContext)();const o=actx.createOscillator(),g=actx.createGain();o.connect(g);g.connect(actx.destination);o.frequency.value=880;g.gain.value=0.08;o.start();o.stop(actx.currentTime+0.25)}catch(e){}}
function checkAl(){const a=S.alerts||[];if(!lastAl){lastAl=a.length?a[0].t:Date.now();return}
 const nw=a.filter(x=>x.t>lastAl&&x.tg);if(a.length&&a[0].t>lastAl)lastAl=a[0].t;
 if(nw.length){if(nw.some(x=>x.kind==='KIRILDI'))beep();document.title='('+nw.length+') '+nw[0].kind+' '+nw[0].base+' • SONER'}else if(!document.hidden)document.title='SONER TRADE v14'}

function renderTop(){
 const md=S.market&&S.market.mood;
 $('cMkt').innerHTML=md?'<b>Piyasa</b> <span class="'+(md.label==='LONG'?'up':md.label==='SHORT'?'dn':'fl')+'"><b style="color:inherit">'+md.label+'</b></span> <span class="fl">'+md.up+'↑/'+md.down+'↓</span>':'<b>Piyasa</b> ...';
 [['cBTC','BTC','btc'],['cETH','ETH','eth']].forEach(a=>{const m=S.market[a[2]];$(a[0]).innerHTML=m?'<b>'+a[1]+'</b> '+fp(m.price)+' <span class="'+cl(m.chg)+'">'+sg(m.chg)+'%</span> <span class="'+(m.dir===1?'up':m.dir===-1?'dn':'fl')+'">15m '+(m.dir===1?'▲':m.dir===-1?'▼':'▬')+'</span>':'<b>'+a[1]+'</b> -'});
 const h=S.health;
 $('cHealth').innerHTML='<b>Sağlık</b> '+(h.n<h.need?'<span class="am">doğrulanıyor '+h.n+'/'+h.need+'</span>':'<span class="'+cl(h.avgR)+'">son '+h.need+': '+sg(h.avgR)+'R</span>')+(h.paper?' <span class="tag r">KAĞIT MODU</span>':'');
 $('modeB').textContent=S.mode}

function renderTabs(){const oc=S.signals.filter(openS).length,al=(S.alerts||[]).filter(a=>Date.now()-a.t<3600e3).length;
 $('tabs').innerHTML=TABS.map(t=>'<button class="tab'+(tab===t[0]?' a':'')+'" data-t="'+t[0]+'">'+t[1]+(t[0]==='sig'?' ('+oc+')':t[0]==='al'?' ('+al+')':'')+'</button>').join('');
 [...$('tabs').children].forEach(b=>b.onclick=()=>{tab=b.dataset.t;if(tab==='sig'||tab==='radar'||tab==='al'||tab==='mv')sel=null;renderAll()})}

function sigCard(s){
 const st=ST[s.status]||['?',''],R=pnlR(s);let pn='';
 if(openS(s)&&R!=null)pn='<span class="sc '+cl(R)+'">'+sg(R)+'R</span>';else if(s.netR!=null)pn='<span class="sc '+cl(s.netR)+'">'+sg(s.netR)+'R</span>';
 return '<div class="card'+(sel&&sel.id===s.id?' sel':'')+(openS(s)?'':' closed')+'" data-id="'+s.id+'"><div class="r1"><span class="badge '+(s.dir==='LONG'?'L':'S')+'">'+s.dir+'</span><span class="coin">'+esc(s.base)+'</span><span class="tag '+st[1]+'">'+st[0]+'</span><span class="tag">'+esc(s.setup)+'</span>'+(s.trPaper?'<span class="tag w">TR İLERİ TEST</span>':s.paper?'<span class="tag r">KAĞIT</span>':'')+'<span class="tag">P'+s.score+'</span>'+pn+'</div><div class="sub"><span>Giriş <b>'+fp(s.entry)+'</b></span><span>Stop '+fp(s.stop)+'</span><span>Risk '+f2(s.riskPct)+'%</span><span>Maliyet '+f2(s.costR)+'R</span><span>'+ago(s.time)+' önce</span></div></div>'}
function radarCard(r){return '<div class="card'+(sel&&sel.sym===r.symbol?' sel':'')+'" data-sym="'+esc(r.symbol)+'"><div class="r1"><span class="badge '+(r.bias==='LONG'?'L':'S')+'">'+r.bias+'</span><span class="coin">'+esc(r.base)+'</span>'+(r.tr?'<span class="tag w">ÜÇGEN</span>':'')+'<span class="fl">'+fp(r.price)+'</span><span class="sc '+cl(r.chg24)+'" style="font-size:12px">'+sg(r.chg24,1)+'%</span></div><div class="sub"><span>'+esc(r.state)+'</span></div></div>'}
function alStatus(a){return a.status==='ONAYLI'?['15m ONAYLI','g']:a.status==='SAHTE'?['SAHTE','r']:a.status==='BEKLİYOR'?['onay bekleniyor','w']:a.status==='BELİRSİZ'?['belirsiz','']:null}
function alCard(a){const kc=a.kind==='KIRILDI'?'g':a.kind==='TEMAS'?'w':'',ss=alStatus(a);
 return '<div class="card'+(sel&&sel.aid===a.id?' sel':'')+'" data-aid="'+a.id+'"><div class="r1"><span class="badge '+(a.dir==='LONG'?'L':'S')+'">'+a.dir+'</span><span class="coin">'+esc(a.base)+'</span><span class="tag '+kc+'">'+esc(a.kind)+'</span><span class="tag">'+esc(a.src)+'</span>'+(ss?'<span class="tag '+ss[1]+'">'+ss[0]+'</span>':'')+'<span class="tag '+(a.strong?'g':'w')+'">Hacim '+f2(a.volX,1)+'x</span><span class="sc" style="font-size:11px;color:var(--dm)">'+ago(a.t)+(a.tg?'':' • sadece pano')+'</span></div><div class="sub"><span>'+esc(a.label)+'</span><span>'+esc(a.role)+' <b>'+fp(a.line)+'</b></span><span>Fiyat '+fp(a.price)+'</span></div></div>'}
function mvCard(r){return '<div class="card'+(sel&&sel.sym===r.symbol?' sel':'')+'" data-sym="'+esc(r.symbol)+'"><div class="r1"><span class="coin">'+esc(r.base)+'</span><span class="fl">'+fp(r.price)+'</span><span class="sc '+cl(r.c5)+'" style="font-size:14px">'+sg(r.c5)+'% <span class="fl" style="font-size:10px">5dk</span></span></div><div class="sub"><span>15dk <b class="'+cl(r.c15)+'">'+sg(r.c15)+'%</b></span><span>24s <b class="'+cl(r.c24)+'">'+sg(r.c24,1)+'%</b></span></div></div>'}
function renderList(){let h='';
 if(tab==='al'){const a=S.alerts||[];h='<div class="note" style="padding:6px 8px">Canlı uyarılar: çizgiye yaklaşma / temas / KIRILIM (kapanış beklenmez). Kırılımlar 15m kapanışta ONAYLI ya da SAHTE olarak işaretlenir. "sadece pano" = Telegram\'a gitmedi.</div>'+(a.length?a.map(alCard).join(''):'<div class="note" style="padding:10px">Henüz uyarı yok. Yapı ilk taramadan sonra oluşur (birkaç dk).</div>')}
 else if(tab==='sig'){const a=S.signals.filter(openS),c=S.signals.filter(s=>!openS(s)).slice(0,25);
  h+=a.length?a.map(sigCard).join(''):'<div class="note" style="padding:10px">Açık kapanış-onaylı sinyal yok. Anlık hareketler için Uyarılar sekmesine bak.</div>';
  if(c.length)h+='<h3>Kapanan</h3>'+c.map(sigCard).join('')}
 else if(tab==='radar')h=S.radar.length?S.radar.map(radarCard).join(''):'<div class="note" style="padding:10px">Yaklaşan kurulum yok.</div>';
 else if(tab==='mv'){const m=S.movers||{up:[],down:[]};h='<div class="note" style="padding:6px 8px">Son 5 dakikanın en çok yükselen / düşen coinleri (canlı fiyattan). İlk 3-5 dk veri toplanır.</div><h3>Yükselenler</h3>'+(m.up.length?m.up.map(mvCard).join(''):'<div class="note">-</div>')+'<h3>Düşenler</h3>'+(m.down.length?m.down.map(mvCard).join(''):'<div class="note">-</div>')}
 else h='<div class="note" style="padding:10px">Ayrıntılar sağ panelde.</div>';
 $('list').innerHTML=h;
 [...$('list').querySelectorAll('.card')].forEach(e=>e.onclick=()=>{const id=e.dataset.id,sy=e.dataset.sym,ai=e.dataset.aid;
  if(ai){const a=S.alerts.find(x=>x.id===ai);sel={aid:ai,sym:a.symbol};chartTF=a.src==='ÜÇGEN'?'tri':'15m'}
  else if(id){const s=allSigs().find(x=>x.id===id);sel={id,sym:s.symbol}}else sel={sym:sy};chartFor='';renderList();renderMain()})}

function calc(e,s){const bal=+cfgC.bal||0,rk=Math.min(2,+cfgC.risk||0),ru=bal*rk/100,d=Math.abs(e-s);if(!d||!bal)return null;const q=ru/d;return{ru,q,n:q*e,lev:q*e/bal}}
function calcBox(e,s){return '<div class="box"><h3 style="margin-top:0">Pozisyon hesaplayıcı</h3><div class="frm"><label class="fl">Bakiye<br><input id="cBal" type="number" value="'+cfgC.bal+'"></label><label class="fl">Risk % (maks 2)<br><input id="cRisk" type="number" step="0.1" value="'+cfgC.risk+'"></label><label class="fl">Giriş<br><input id="cE" type="number" step="any" value="'+(e||'')+'"></label><label class="fl">Stop<br><input id="cS" type="number" step="any" value="'+(s||'')+'"></label></div><div id="cOut" class="note" style="color:var(--tx);font-size:13px"></div></div>'}
function bindCalc(){const upd=()=>{cfgC.bal=+$('cBal').value;cfgC.risk=Math.min(2,+$('cRisk').value);localStorage.setItem('st_calc',JSON.stringify(cfgC));const c=calc(+$('cE').value,+$('cS').value);
  $('cOut').innerHTML=c?'1R = <b>'+f2(c.ru)+' USDT</b> &nbsp; Miktar <b>'+f2(c.q,4)+'</b> &nbsp; Pozisyon <b>'+f2(c.n,1)+' USDT</b> &nbsp; Kaldıraç <b>'+f2(c.lev,1)+'x</b>':'Değerleri gir.'};
 ['cBal','cRisk','cE','cS'].forEach(i=>{const e=$(i);if(e)e.oninput=upd});if($('cOut'))upd()}

function partsView(s){const lab={trend:'Trend gücü (ADX / dokunuş)',rs:'BTC\'ye göre güç',htf:'1H+4H uyum',pullback:'Pullback / kırılım kalitesi',oda:'Hedef önü alan',maliyet:'Maliyet verimi'},mx={trend:25,rs:20,htf:15,pullback:15,oda:15,maliyet:10},p=s.parts||{};
 return Object.keys(lab).map(k=>'<div class="pr"><span>'+lab[k]+'</span><div class="bar"><i style="width:'+Math.min(100,(p[k]||0)/mx[k]*100)+'%"></i></div><b>'+(p[k]||0)+'</b></div>').join('')}
function sigView(s){const st=ST[s.status]||['?',''],R=pnlR(s),w=(s.warnings||[]).map(x=>'<span class="tag w">'+esc(x)+'</span> ').join('');
 const tinfo=s.tri&&s.tri.type?'<span class="tag g">'+esc(s.tri.type)+'</span>':'';
 return '<div class="r1" style="margin-bottom:8px"><span class="badge '+(s.dir==='LONG'?'L':'S')+'" style="font-size:13px">'+s.dir+'</span><h2 style="margin:0">'+esc(s.symbol.split(':')[0])+'</h2><span class="tag '+st[1]+'">'+st[0]+'</span>'+tinfo+(s.trPaper?'<span class="tag w">TR İLERİ TEST</span>':s.paper?'<span class="tag r">KAĞIT</span>':'')+'<span class="sc" style="font-size:24px">'+s.score+'</span></div>'+
 '<div class="fl" style="margin-bottom:6px">'+esc(s.setupName)+' • '+ago(s.time)+' önce'+(s.netR!=null&&!openS(s)?' • Sonuç '+sg(s.netR)+'R (brüt '+sg(s.grossR)+')':'')+'</div>'+w+tfBar()+'<canvas id="cv"></canvas>'+
 '<div class="lv"><div><span>Anlık</span><b>'+fp(s.lastPrice||s.entry)+'</b></div><div><span>K/Z</span><b class="'+cl(R)+'">'+(R!=null?sg(R)+'R':'-')+'</b></div><div><span>Giriş</span><b>'+fp(s.entry)+'</b></div><div><span>Stop'+(s.mode==='T'&&s.stop!==s.initialStop?' (trailing)':'')+'</span><b class="dn">'+fp(s.stop)+'</b></div><div><span>'+(s.mode==='T'?'Ref 2R (trailing çıkış)':'TP1 ('+s.tp1R+'R)')+'</span><b class="up">'+fp(s.tp1)+'</b></div>'+(s.mode==='B'||s.mode==='T'?'':'<div><span>TP2</span><b class="up">'+fp(s.tp2)+'</b></div>')+'<div><span>Risk</span><b>'+f2(s.riskPct)+'%</b></div><div><span>Maliyet</span><b>'+f2(s.costR)+'R</b></div><div><span>Hedef alanı</span><b>'+f2(s.room,1)+'R</b></div><div><span>MFE/MAE</span><b>'+f2(s.mfe,1)+' / '+f2(s.mae,1)+'</b></div></div>'+
 '<div class="frm"><a class="btn tv" href="'+tvUrl(s.symbol)+'" target="_blank">📈 TradingView</a></div><div class="grid2"><div class="box"><h3 style="margin-top:0">Puan dağılımı</h3>'+partsView(s)+'<div class="note">Puan sadece sıralama içindir.</div><div class="note" style="color:var(--tx)">'+esc(s.reason||'')+'</div></div><div>'+calcBox(s.entry,s.initialStop)+'</div></div>'}
function alView(a){const kc=a.kind==='KIRILDI'?'g':a.kind==='TEMAS'?'w':'',ss=alStatus(a),w=(a.warnings||[]).map(x=>'<span class="tag w">'+esc(x)+'</span> ').join('');
 const tx=a.kind==='KIRILDI'?'Fiyat '+esc(a.role)+' çizgisini '+f2(a.dist)+' ATR aştı, canlı hacim '+f2(a.volX,1)+'x. 15m mum kapanışı çizginin ötesinde kalırsa ONAYLI, geri dönerse SAHTE işaretlenir. Kırılım sonrası hemen girmek yerine grafikte retest / kapanışı kontrol et; stop mesafesi geniş olabilir.':
  a.kind==='TEMAS'?'Fiyat '+esc(a.role)+' çizgisine temas etti (canlı hacim '+f2(a.volX,1)+'x). Dönüş mü kırılım mı belli değil; kapanışı ve hacmi izle. Kırılırsa '+a.dir+' yönlü.':
  'Fiyat '+esc(a.role)+' çizgisine '+f2(a.dist)+' ATR kaldı, hacim '+f2(a.volX,1)+'x ile yaklaşıyor. Kırılırsa '+a.dir+' yönlü; hazır ol, kırılımı bekle.';
 return '<div class="r1" style="margin-bottom:8px"><span class="badge '+(a.dir==='LONG'?'L':'S')+'" style="font-size:13px">'+a.dir+'</span><h2 style="margin:0">'+esc(a.base)+'</h2><span class="tag '+kc+'">'+esc(a.kind)+'</span><span class="tag">'+esc(a.src)+'</span>'+(ss?'<span class="tag '+ss[1]+'">'+ss[0]+'</span>':'')+'<span class="tag '+(a.strong?'g':'w')+'">Hacim '+f2(a.volX,1)+'x</span></div>'+
 '<div class="fl" style="margin-bottom:6px">'+esc(a.label)+' ('+esc(a.role)+') • '+ago(a.t)+' önce</div>'+w+tfBar()+'<canvas id="cv"></canvas>'+
 '<div class="lv"><div><span>Çizgi</span><b>'+fp(a.line)+'</b></div><div><span>Uyarı fiyatı</span><b>'+fp(a.price)+'</b></div><div><span>Mesafe</span><b>'+f2(a.dist)+' ATR</b></div>'+(a.stop?'<div><span>Önerilen stop</span><b class="dn">'+fp(a.stop)+'</b></div><div><span>Hedef 1 (1.5R)</span><b class="up">'+fp(a.tp1)+'</b></div><div><span>Hedef 2</span><b class="up">'+fp(a.tp2)+'</b></div><div><span>Risk</span><b>'+f2(a.riskPct)+'%</b></div>':'')+'</div>'+
 '<div class="frm"><a class="btn tv" href="'+tvUrl(a.symbol,15)+'" target="_blank">📈 TradingView (15m)</a></div><div class="grid2"><div class="box"><div class="note" style="color:var(--tx);margin-top:0">'+tx+'</div></div><div>'+calcBox(a.price,a.stop||'')+'</div></div>'}

const reasonTxt=o=>Object.entries(o||{}).sort((a,b)=>b[1]-a[1]).slice(0,10).map(x=>x[0]+' '+x[1]).join(', ')||'-';
const nextClose=ms=>{const t=Math.ceil(Date.now()/ms)*ms;return new Date(t).toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit'})+' ('+Math.max(0,Math.round((t-Date.now())/60000))+' dk)'};
const moodTxt=()=>{const m=S.market&&S.market.mood;if(!m||m.score==null)return'';const w=v=>v===1?'yukarı':v===-1?'aşağı':'yatay';return '<div class="note" style="color:var(--tx)">Piyasa '+m.label+' çünkü: BTC 15m '+w(m.btc)+', ETH 15m '+w(m.eth)+', genişlik '+m.up+'↑/'+m.down+'↓ ('+sg(m.breadth,1)+'). Toplam puan '+sg(m.score,1)+' (LONG için ≥ +2, SHORT için ≤ -2). YATAY uyarıyı engellemez; sadece kapanış sinyallerinde ters yönlü piyasayı engeller.</div>'};
function homeView(){const F=S.filters,open=S.signals.filter(openS).length,td=S.stats.today,h=S.health,L=S.live,al=(S.alerts||[]),h1=al.filter(a=>Date.now()-a.t<3600e3),br=h1.filter(a=>a.kind==='KIRILDI').length;
 return '<h2>Pano</h2><div class="tiles"><div class="tile"><div class="k">Uyarı (son 1s)</div><div class="v">'+h1.length+'</div><div class="k">'+br+' kırılım</div></div><div class="tile"><div class="k">Açık sinyal</div><div class="v">'+open+'</div></div><div class="tile"><div class="k">Bugün bot R</div><div class="v '+cl(h.dayR)+'">'+sg(h.dayR,1)+'</div><div class="k">'+td.n+' kapanan</div></div><div class="tile"><div class="k">İzlenen çizgi</div><div class="v">'+L.lines+'</div><div class="k">'+L.symbols+' coin</div></div><div class="tile"><div class="k">Taranan coin</div><div class="v">'+S.scan.universe+'</div></div></div>'+
 '<div class="box '+(L.enabled&&!L.err?'ok':'no')+'"><h3 style="margin-top:0">Canlı uyarı motoru '+(L.enabled?'AÇIK':'KAPALI')+'</h3><div class="note" style="color:var(--tx)">Fiyat her '+Math.round(L.periodMs/1000)+' sn kontrol edilir (son kontrol: '+(L.last?ago(L.last)+' önce, '+L.ms+' ms':'-')+(L.err?' • <span class="dn">'+esc(L.err)+'</span>':'')+'). Üçgen çizgileri (2H), destek/direnç seviyeleri (1H pivot kümeleri) ve 1H zirve/dip 15 dakikada bir yenilenir. Kapanış beklenmez:</div><div class="note"><b>YAKLAŞIYOR</b>: fiyat çizgiye ≤ '+L.near+' ATR ve canlı hacim ≥ '+L.volNear+'x • <b>TEMAS</b>: ≤ '+L.touch+' ATR • <b>KIRILDI</b>: çizgiyi ≥ '+L.brk+' ATR aştı, 2 ardışık kontrolde korundu, hacim ≥ '+L.volBrk+'x ('+L.volStrong+'x üstü = GÜÇLÜ). Sonra 15m kapanışta ONAYLI/SAHTE işaretlenir.</div><div class="note">Telegram: '+(L.tgOn?'açık':'<span class="dn">kapalı (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID yok)</span>')+' • bu saat '+L.tgHour+'/'+L.tgMax+' uyarı gönderildi. Tarayıcı sekmesi açıkken kırılımda bip sesi çalar.</div></div>'+
 '<div class="box"><h3 style="margin-top:0">Kapanış onaylı sinyaller — PB '+(F.pb?'açık':'kapalı')+' • TB '+(F.tb?'açık':'kapalı')+' • TR '+(F.tr?'açık':'kapalı')+'</h3><div class="note" style="color:var(--tx)">PB her 15 dk, TB saat başı 1H kapanışında, TR 2 saatte bir '+F.trAgg+'H kapanışında kontrol edilir. Bunlar geç ama daha filtreli sinyallerdir; erken uyarılar Uyarılar sekmesindedir. TR '+(F.trPaper?'ileri test modunda (Telegram yok)':'canlı')+'. Sonraki 1H: '+nextClose(3600e3)+' • sonraki 2H: '+nextClose(7200e3)+'</div><div class="note">Sağlık kapısı: son '+h.need+' kapanan işlemin net ortalaması negatifse kapanış sinyalleri KAĞIT modunda üretilir. Günlük -3R olursa da aynı.</div></div>'+
 '<div class="box"><h3 style="margin-top:0">Son tarama</h3><div class="note" style="color:var(--tx)">'+(S.scan.last?ago(S.scan.last)+' önce, '+f2(S.scan.ms/1000,1)+' sn':'-')+' • '+S.scan.eligible+' uygun / '+S.scan.total+' vadeli</div>'+moodTxt()+'<div class="note">Kurulum bazında elenme nedenleri (bugün):</div>'+['PB','TB','TR'].map(k=>'<div class="note"><b>'+k+':</b> '+reasonTxt((S.scan.by||{})[k])+'</div>').join('')+'</div>'}

const tbl=(t,title)=>'<h3>'+title+'</h3><table><tr><th>Grup</th><th class="n">İşlem</th><th class="n">Kazanç %</th><th class="n">Net R</th><th class="n">Brüt R</th><th class="n">Toplam R</th></tr>'+Object.keys(t).map(k=>{const x=t[k];return '<tr><td>'+esc(k)+'</td><td class="n">'+x.n+'</td><td class="n">'+f2(x.win*100,0)+'</td><td class="n '+cl(x.avgR)+'">'+sg(x.avgR)+'</td><td class="n">'+sg(x.avgGross)+'</td><td class="n '+cl(x.totalR)+'">'+sg(x.totalR,1)+'</td></tr>'}).join('')+'</table>';
function alTbl(t){const ks=Object.keys(t||{});if(!ks.length)return '<h3>Kırılım uyarı doğruluğu</h3><div class="note">Henüz kırılım uyarısı yok.</div>';
 return '<h3>Kırılım uyarı doğruluğu (15m kapanışta çizgi ötesinde kaldı mı)</h3><table><tr><th>Grup</th><th class="n">Uyarı</th><th class="n">Onaylı</th><th class="n">Sahte</th><th class="n">Bekleyen</th><th class="n">Onay %</th></tr>'+ks.map(k=>{const x=t[k],d=x.ok+x.fake;return '<tr><td>'+esc(k)+'</td><td class="n">'+x.n+'</td><td class="n up">'+x.ok+'</td><td class="n dn">'+x.fake+'</td><td class="n">'+x.wait+'</td><td class="n">'+(d?f2(x.ok/d*100,0)+'%':'-')+'</td></tr>'}).join('')+'</table><div class="note">Onay % sadece "kırılış sonrası ilk 15m kapanışta çizgi ötesinde kaldı mı"yı ölçer, kârlılığı değil. Onay oranı yüksek olan grup (ör. güçlü hacim) hangi filtrelerin işe yaradığını gösterir.</div>'}
function statView(){const a=S.stats.all;
 return '<h2>Sonuçlar</h2>'+alTbl(S.alertStats)+'<h3>Kapanış onaylı sinyaller (canlı)</h3><div class="tiles"><div class="tile"><div class="k">Kapanan</div><div class="v">'+a.n+'</div></div><div class="tile"><div class="k">Kazanç</div><div class="v">'+f2(a.win*100,0)+'%</div></div><div class="tile"><div class="k">Net ort R</div><div class="v '+cl(a.avgR)+'">'+sg(a.avgR)+'</div><div class="k">±'+f2(a.ci)+'</div></div><div class="tile"><div class="k">Brüt ort R</div><div class="v">'+sg(a.avgGross)+'</div></div><div class="tile"><div class="k">Maliyet ort R</div><div class="v dn">'+f2(a.avgCost)+'</div></div><div class="tile"><div class="k">PF</div><div class="v">'+f2(a.pf)+'</div></div><div class="tile"><div class="k">Max DD</div><div class="v dn">'+f2(a.dd,1)+'R</div></div></div><canvas id="eq" style="height:150px"></canvas><div class="note">Anlamlı olması için 200+ kapanan işlem gerekir. Eski sinyalleri silmek için POST /api/reset (ADMIN_KEY gerekir).</div>'+
 tbl(S.stats.bySetup,'Kurulum')+tbl(S.stats.bySetupDir,'Kurulum × yön')+tbl(S.stats.byDir,'Yön')+tbl(S.stats.byMkt,'Piyasa')+tbl(S.stats.byExit,'Çıkış')+tbl(S.stats.byBand,'Puan bandı')+tbl(S.stats.bySession,'Seans')}
function drawEq(){const c=$('eq');if(!c||!S.equity.length)return;const W=c.clientWidth,H=c.clientHeight,dp=devicePixelRatio||1;c.width=W*dp;c.height=H*dp;const x=c.getContext('2d');x.scale(dp,dp);const v=S.equity,mn=Math.min(0,...v),mx=Math.max(.1,...v),Y=a=>H-10-(a-mn)/(mx-mn)*(H-20);
 x.strokeStyle='#243040';x.beginPath();x.moveTo(0,Y(0));x.lineTo(W,Y(0));x.stroke();x.strokeStyle='#f2b84b';x.lineWidth=2;x.beginPath();v.forEach((a,i)=>{const px=i/Math.max(1,v.length-1)*(W-8)+4;i?x.lineTo(px,Y(a)):x.moveTo(px,Y(a))});x.stroke()}

const _bs=JSON.parse(localStorage.getItem('st_bt')||'{"d":90,"c":100,"m":1,"s":0,"x":1}');
const opt=(v,cur,t)=>'<option value="'+v+'"'+(+cur===v?' selected':'')+'>'+t+'</option>';
function robustView(R){const b=R.robust;if(!b)return'';return '<div class="tiles"><div class="tile"><div class="k">Medyan R</div><div class="v '+cl(b.med)+'">'+sg(b.med)+'</div></div><div class="tile"><div class="k">En iyi '+b.k+' işlem hariç</div><div class="v '+cl(b.exTop5)+'">'+sg(b.exTop5)+'</div></div><div class="tile"><div class="k">En iyi 2 coin hariç</div><div class="v '+cl(b.exCoin2)+'">'+sg(b.exCoin2)+'</div><div class="k">'+esc(b.top2.join(', '))+'</div></div></div>'}
function funnelByView(R){const f=R.funnelBy;if(!f)return'';return '<h3>Kurulum bazında elenme (test)</h3>'+Object.keys(f).map(k=>'<div class="note"><b>'+esc(k)+':</b> '+reasonTxt(f[k])+'</div>').join('')}
function verdict(R){const r=[];
 if(R.all.n<150)r.push('örnek küçük ('+R.all.n+' işlem, en az 150 gerek)');
 [['IS',R.is],['VAL',R.val],['OOS',R.oos]].forEach(p=>{if(p[1].n<10)r.push(p[0]+' diliminde çok az işlem ('+p[1].n+')');else if(!(p[1].avgR>0))r.push(p[0]+' dilimi negatif ('+sg(p[1].avgR)+'R)')});
 if(R.all.t<2)r.push('t-stat '+f2(R.all.t,1)+' < 2');
 if(R.robust&&R.all.n>=8){const b=R.robust;if(b.exTop5<=0)r.push('en iyi '+b.k+' işlem çıkınca ort R <= 0 ('+sg(b.exTop5)+')');if(b.exCoin2<=0)r.push('en iyi 2 coin ('+b.top2.join(', ')+') çıkınca ort R <= 0');else if(b.top2Share>0.5)r.push('kârın %'+Math.round(b.top2Share*100)+'\'i 2 coinden geliyor')}
 if(S&&R.minScore!==S.minScore)r.push('test min puanı ('+R.minScore+') canlı ayardan ('+S.minScore+') farklı');
 const sc=R.scoreCheck;if(sc.hi.n>=20&&!(sc.hi.avgR>sc.lo.avgR))r.push('puan monoton değil (yüksek puan ≤ düşük puan)');
 return r}
function btView(){let h='<h2>Geçmiş veri testi (15m)</h2><div class="box"><div class="frm"><select id="bD">'+opt(14,_bs.d,'14 gün')+opt(30,_bs.d,'30 gün')+opt(60,_bs.d,'60 gün')+opt(90,_bs.d,'90 gün')+'</select><select id="bC">'+opt(10,_bs.c,'10 coin')+opt(20,_bs.c,'20 coin')+opt(40,_bs.c,'40 coin')+opt(60,_bs.c,'60 coin')+opt(100,_bs.c,'100 coin')+opt(150,_bs.c,'150 coin')+opt(250,_bs.c,'250 coin')+'</select><select id="bM">'+opt(1,_bs.m,'Maliyet x1')+opt(1.5,_bs.m,'Maliyet x1.5')+opt(2,_bs.m,'Maliyet x2 (stres)')+'</select><select id="bS">'+opt(0,_bs.s,'Puan kapısı yok')+opt(30,_bs.s,'Min puan 30')+opt(50,_bs.s,'Min puan 50')+opt(60,_bs.s,'Min puan 60')+opt(70,_bs.s,'Min puan 70')+'</select><select id="bX">'+opt(0,_bs.x,'Tek test')+opt(1,_bs.x,'Varyant karşılaştırma (__VC__ test)')+'</select><button class="btn" id="bGo">Testi başlat</button></div><div class="note">Bu test yalnızca KAPANIŞ ONAYLI sinyalleri (PB/TB/TR) ölçer; canlı uyarılar geçmişe dönük test edilemez, onların doğruluğu İstatistik sekmesinde canlı izlenir. Canlıyla aynı sinyal kodu. 15m mumda stop ve hedef aynı mumdaysa stop önce sayılır (kötümser). Gerçek karar için 60-90 gün ve 200+ işlem şart. Varyantlar çoklu testtir: en iyisini seçmek için t ≥ 3 ara. Evren bugünkü hacim sıralamasından seçilir.</div></div>';
 if(!bt)return h;
 if(bt.running)h+='<div class="box"><div>'+esc(bt.msg)+'</div><div class="bar" style="margin-top:8px"><i style="width:'+Math.round(bt.done/Math.max(1,bt.total)*100)+'%"></i></div></div>';
 if(bt.error)h+='<div class="box no dn">'+esc(bt.error)+'</div>';
 if(bt.result){const R=bt.result,v=verdict(R);
  h+='<div class="box '+(v.length?'no':'ok')+'"><b class="'+(v.length?'dn':'up')+'">'+(v.length?'HENÜZ KANIT YOK':'ADAY')+'</b><div class="note" style="color:var(--tx)">'+(v.length?v.map(esc).join(' • '):'İşlem sayısı, üç dilim, t-stat ve puan testi geçti. Yine de kağıt üstünde canlı izle.')+'</div></div>';
  h+='<div class="tiles"><div class="tile"><div class="k">İşlem</div><div class="v">'+R.all.n+'</div><div class="k">'+f2(R.perDay,1)+'/gün</div></div><div class="tile"><div class="k">Kazanç</div><div class="v">'+f2(R.all.win*100,0)+'%</div></div><div class="tile"><div class="k">Net ort R</div><div class="v '+cl(R.all.avgR)+'">'+sg(R.all.avgR)+'</div><div class="k">±'+f2(R.all.ci)+'</div></div><div class="tile"><div class="k">Brüt ort R</div><div class="v">'+sg(R.all.avgGross)+'</div></div><div class="tile"><div class="k">Maliyet ort R</div><div class="v dn">'+f2(R.all.avgCost)+'</div></div><div class="tile"><div class="k">t-stat</div><div class="v '+(Math.abs(R.all.t)>=2?cl(R.all.t):'fl')+'">'+f2(R.all.t,2)+'</div></div><div class="tile"><div class="k">PF</div><div class="v">'+f2(R.all.pf)+'</div></div><div class="tile"><div class="k">Max DD</div><div class="v dn">'+f2(R.all.dd,1)+'R</div></div></div>';
  h+=robustView(R);
  h+='<h3>Walk-forward</h3><table><tr><th>Dilim</th><th class="n">İşlem</th><th class="n">Kazanç %</th><th class="n">Net R</th><th class="n">Brüt R</th><th class="n">Toplam R</th><th class="n">PF</th></tr>'+[['IS (ilk %50)',R.is],['VAL (%25)',R.val],['OOS (son %25)',R.oos]].map(p=>{const x=p[1];return '<tr><td>'+p[0]+'</td><td class="n">'+x.n+'</td><td class="n">'+f2(x.win*100,0)+'</td><td class="n '+cl(x.avgR)+'">'+sg(x.avgR)+'</td><td class="n">'+sg(x.avgGross)+'</td><td class="n '+cl(x.totalR)+'">'+sg(x.totalR,1)+'</td><td class="n">'+f2(x.pf)+'</td></tr>'}).join('')+'</table>';
  h+='<div class="note">Puan testi: üst yarı '+sg(R.scoreCheck.hi.avgR)+'R ('+R.scoreCheck.hi.n+') • alt yarı '+sg(R.scoreCheck.lo.avgR)+'R ('+R.scoreCheck.lo.n+'). Üst yarı belirgin iyi değilse puan gürültüdür.</div><div class="note">'+R.days+' gün / '+R.coins+' coin / '+R.candles+' mum • maliyet x'+R.costMult+' • min puan '+R.minScore+' • portföy öncesi '+R.rawN+' • atlanan: '+(R.skipped.length?esc(R.skipped.join(', ')):'yok')+'</div><div class="note">Filtre hunisi: '+reasonTxt(R.funnel)+'</div>';
  if(R.compare)h+='<h3>Varyantlar (aynı veri, tek değişiklik)</h3><table><tr><th>Varyant</th><th class="n">İşlem</th><th class="n">Net R</th><th class="n">Brüt R</th><th class="n">Maliyet</th><th class="n">PF</th><th class="n">t</th><th class="n">5 hariç</th><th class="n">IS</th><th class="n">VAL</th><th class="n">OOS</th></tr>'+R.compare.map(x=>'<tr><td>'+esc(x.name)+'</td><td class="n">'+x.n+'</td><td class="n '+cl(x.avgR)+'">'+sg(x.avgR)+'</td><td class="n">'+sg(x.gross)+'</td><td class="n">'+f2(x.cost)+'</td><td class="n">'+f2(x.pf)+'</td><td class="n">'+f2(x.t,1)+'</td><td class="n '+cl(x.ex5)+'">'+sg(x.ex5)+'</td><td class="n '+cl(x.isR)+'">'+sg(x.isR)+'</td><td class="n '+cl(x.valR)+'">'+sg(x.valR)+'</td><td class="n '+cl(x.oosR)+'">'+sg(x.oosR)+' ('+x.oosN+')</td></tr>').join('')+'</table>';
  h+=funnelByView(R)+tbl(R.bySetup,'Kurulum')+tbl(R.bySetupDir,'Kurulum × yön')+tbl(R.byExit,'Çıkış')+tbl(R.byBand,'Puan bandı')+tbl(R.byDir,'Yön')+tbl(R.byMkt,'Piyasa')+tbl(R.bySession,'Seans')+tbl(R.byWeek,'Hafta (tutarlılık)')+tbl(R.byCoin,'Coin (küçük örnek anlamsız)')}
 return h}
function bindBt(){[['bD','d'],['bC','c'],['bM','m'],['bS','s'],['bX','x']].forEach(a=>{const e=$(a[0]);if(e)e.onchange=()=>{_bs[a[1]]=+e.value;localStorage.setItem('st_bt',JSON.stringify(_bs))}});
 const b=$('bGo');if(b)b.onclick=async()=>{const r=await post('/api/backtest',{days:+$('bD').value,coins:+$('bC').value,costMult:+$('bM').value,minScore:+$('bS').value,compare:+$('bX').value===1});if(r.ok)pollBt()}}
function pollBt(){fetch('/api/backtest').then(r=>r.json()).then(d=>{bt=d;const t=document.activeElement&&document.activeElement.tagName;if(tab==='bt'&&t!=='SELECT'&&t!=='INPUT')renderMain();if(d.running)setTimeout(pollBt,3000)})}

function ckey(sym){return sym+'|'+chartTF}
function setTF(v){chartTF=v?'tri':'15m';chartFor='';if(S)renderMain()}
function tfBar(){return '<div class="frm"><button class="btn'+(chartTF==='tri'?'':' off')+'" onclick="setTF(1)">Formasyon (2H)</button><button class="btn'+(chartTF==='15m'?'':' off')+'" onclick="setTF(0)">15m</button></div>'}
function curSig(){return sel&&sel.id?allSigs().find(x=>x.id===sel.id):null}
function curExtra(){if(!sel||!sel.aid)return null;const a=(S.alerts||[]).find(x=>x.id===sel.aid);if(!a)return null;const e=[[a.line,'#ffd400','ÇİZGİ']];if(a.stop)e.push([a.stop,'#ff6b7a','STOP']);return e}
function drawChart(d,s,extra){
 const c=$('cv');if(!c||!d||!d.c.length)return;
 const W=c.clientWidth,H=c.clientHeight,dp=devicePixelRatio||1;c.width=W*dp;c.height=H*dp;
 const x=c.getContext('2d');x.scale(dp,dp);
 const tri=(s&&s.tri)||d.tri,nc=d.c.length,n=nc+(tri?10:0);
 const L=8,R=86,T=12,B=20,PW=W-L-R,PH=H-T-B;
 const ti=t=>(t-d.c[0][0])/d.dur;
 let hi=-1e99,lo=1e99;d.c.forEach(k=>{hi=Math.max(hi,k[2]);lo=Math.min(lo,k[3])});
 let lv=s?[[s.tp2,'#3ddc97','TP2'],[s.tp1,'#3ddc97','TP1'],[s.stop,'#ff6b7a','STOP'],[s.entry,'#5aa9ff','GİRİŞ']].filter(a=>s.mode==='T'?(a[2]==='STOP'||a[2]==='GİRİŞ'):s.mode==='B'?a[2]!=='TP2':true):[];
 if(extra)lv=lv.concat(extra);
 lv.forEach(a=>{hi=Math.max(hi,a[0]);lo=Math.min(lo,a[0])});
 const tl=[];
 if(tri)[tri.res,tri.sup].forEach(l=>{const a=ti(l[0][0]),b=ti(l[1][0]),m=(l[1][1]-l[0][1])/((b-a)||1),xa=Math.max(a,0);tl.push([a,l[0][1],b,l[1][1]]);[xa,b].forEach(q=>{const v=l[0][1]+m*(q-a);hi=Math.max(hi,v);lo=Math.min(lo,v)})});
 const pad=(hi-lo)*.06;hi+=pad;lo-=pad;
 const Y=p=>T+(hi-p)/(hi-lo)*PH,X=k=>L+(k+.5)/n*PW,cw=Math.max(2,PW/n*.68);
 x.font='10px system-ui';x.fillStyle='#8593a5';
 for(let i=0;i<=4;i++){const gy=T+PH*i/4;x.strokeStyle='rgba(255,255,255,.05)';x.beginPath();x.moveTo(L,gy);x.lineTo(W-R,gy);x.stroke();x.fillText(fp(hi-(hi-lo)*i/4),W-R+6,gy+3)}
 if(s&&s.mode!=='T'){x.fillStyle='rgba(255,107,122,.12)';x.fillRect(L,Math.min(Y(s.initialStop),Y(s.entry)),PW,Math.abs(Y(s.entry)-Y(s.initialStop)));x.fillStyle='rgba(61,220,151,.12)';x.fillRect(L,Math.min(Y(s.entry),Y(s.tp1)),PW,Math.abs(Y(s.tp1)-Y(s.entry)))}
 const line=(arr,col,w)=>{x.strokeStyle=col;x.lineWidth=w;x.beginPath();let st=false;arr.forEach((v,k)=>{if(v==null)return;st?x.lineTo(X(k),Y(v)):(x.moveTo(X(k),Y(v)),st=true)});x.stroke()};
 line(d.e50,'#8593a5',1.2);line(d.e21,'#f2b84b',1.4);
 d.c.forEach((k,i)=>{const col=k[4]>=k[1]?'#3ddc97':'#ff6b7a';x.strokeStyle=x.fillStyle=col;x.lineWidth=1;x.beginPath();x.moveTo(X(i),Y(k[2]));x.lineTo(X(i),Y(k[3]));x.stroke();x.fillRect(X(i)-cw/2,Math.min(Y(k[1]),Y(k[4])),cw,Math.max(1,Math.abs(Y(k[4])-Y(k[1]))))});
 if(tri){x.save();x.beginPath();x.rect(L,T,PW,PH);x.clip();
  tl.forEach(l=>{x.strokeStyle='#ffd400';x.lineWidth=2.2;x.beginPath();x.moveTo(X(l[0]),Y(l[1]));x.lineTo(X(l[2]),Y(l[3]));x.stroke()});
  x.fillStyle='#ffd400';tri.hi.concat(tri.lo).forEach(p=>{x.beginPath();x.arc(X(ti(p[0])),Y(p[1]),3,0,7);x.fill()});
  x.restore()}
 lv.forEach(a=>{x.strokeStyle=x.fillStyle=a[1];x.lineWidth=a[2]==='GİRİŞ'?2:1.3;x.setLineDash(a[2]==='GİRİŞ'?[]:[6,4]);x.beginPath();x.moveTo(L,Y(a[0]));x.lineTo(W-R,Y(a[0]));x.stroke();x.setLineDash([]);x.font='bold 10px system-ui';x.fillText(a[2]+' '+fp(a[0]),W-R+6,Y(a[0])-3)});
 const lp=s&&s.lastPrice?s.lastPrice:d.c[nc-1][4];x.strokeStyle='#fff';x.lineWidth=1.5;x.beginPath();x.moveTo(L,Y(lp));x.lineTo(W-R,Y(lp));x.stroke();x.fillStyle='#fff';x.fillRect(W-R-2,Y(lp)-9,66,18);x.fillStyle='#0c1117';x.font='bold 11px system-ui';x.fillText(fp(lp),W-R+2,Y(lp)+4);
 x.fillStyle='#8593a5';x.font='10px system-ui';x.fillText((tri?tri.type+' • '+tri.touches+' dokunuş • ':'')+d.tf+' • sarı EMA21 • gri EMA50',L+4,H-5)}
function loadChart(sym){const tf=chartTF;fetch('/api/candles?symbol='+encodeURIComponent(sym)+'&tf='+tf).then(r=>r.json()).then(d=>{chartCache[sym+'|'+tf]=d;if(sel&&sel.sym===sym&&tf===chartTF&&$('cv'))drawChart(d,curSig(),curExtra())}).catch(()=>{})}

function renderMain(){const M=$('main');
 if(tab==='stat'){M.innerHTML=statView();drawEq();return}
 if(tab==='bt'){M.innerHTML=btView();bindBt();return}
 if(sel&&sel.aid){const a=(S.alerts||[]).find(x=>x.id===sel.aid);if(a){M.innerHTML=alView(a);bindCalc();if(chartCache[ckey(a.symbol)])drawChart(chartCache[ckey(a.symbol)],null,curExtra());if(chartFor!==ckey(a.symbol)){chartFor=ckey(a.symbol);loadChart(a.symbol)}return}}
 if(sel&&sel.id){const s=allSigs().find(x=>x.id===sel.id);if(s){M.innerHTML=sigView(s);bindCalc();if(chartCache[ckey(s.symbol)])drawChart(chartCache[ckey(s.symbol)],s);if(chartFor!==ckey(s.symbol)){chartFor=ckey(s.symbol);loadChart(s.symbol)}return}}
 if(sel&&sel.sym){const r=S.radar.find(x=>x.symbol===sel.sym);M.innerHTML='<div class="r1" style="margin-bottom:8px"><h2 style="margin:0">'+esc(sel.sym.split(':')[0])+'</h2>'+(r?'<span class="tag">'+esc(r.state)+'</span>':'')+'<a class="btn tv" style="margin-left:auto" href="'+tvUrl(sel.sym,15)+'" target="_blank">📈 TradingView</a></div>'+tfBar()+'<canvas id="cv"></canvas>'+calcBox('','');bindCalc();if(chartCache[ckey(sel.sym)])drawChart(chartCache[ckey(sel.sym)],null);if(chartFor!==ckey(sel.sym)){chartFor=ckey(sel.sym);loadChart(sel.sym)}return}
 M.innerHTML=homeView()}
function renderAll(){renderTop();renderTabs();renderList();renderMain()}
function poll(){fetch('/api/state').then(r=>r.json()).then(d=>{S=d;checkAl();$('dot').className='dot on';$('conn').textContent='Bağlı';const t=document.activeElement&&document.activeElement.tagName;if(t==='INPUT'||t==='SELECT'){renderTop();renderTabs();renderList()}else renderAll()}).catch(()=>{$('dot').className='dot';$('conn').textContent='Bağlantı yok'})}
addEventListener('resize',()=>{if(S)renderMain()});
addEventListener('focus',()=>{document.title='SONER TRADE v14'});
setInterval(poll,4000);setInterval(()=>{if(sel&&sel.sym)loadChart(sel.sym)},20000);poll();pollBt();
</script>
</body>
</html>
`.replace('__VC__', String(VARIANTS.length));

// ------------------------- HTTP -------------------------
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise(r => { let b = ''; req.on('data', d => { b += d; if (b.length > 1e5) { r({}); req.destroy(); } }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch (e) { r({}); } }); req.on('error', () => r({})); });
const authed = u => !ADMIN_KEY || u.searchParams.get('key') === ADMIN_KEY;

const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    try {
        if (u.pathname === '/' || u.pathname === '/index.html') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(HTML);
        }
        if (u.pathname === '/health') return json(res, 200, { ok: true, lastScan: scan.last, lastLive: live.last, universe: universe.length });
        if (u.pathname === '/api/state') return json(res, 200, apiState());
        if (u.pathname === '/api/candles') return json(res, 200, await apiCandles(u.searchParams.get('symbol') || '', u.searchParams.get('tf')));
        if (u.pathname === '/api/export') return json(res, 200, { signals, lastSig, alerts });
        if (u.pathname === '/api/backtest' && req.method === 'GET') return json(res, 200, btJob);
        if (u.pathname === '/api/backtest' && req.method === 'POST') {
            if (!authed(u)) return json(res, 401, { error: 'yetkisiz' });
            const b = await readBody(req);
            const days = [14, 30, 60, 90].includes(b.days) ? b.days : 30, coins = [10, 20, 40, 60, 100, 150, 250].includes(b.coins) ? b.coins : 20;
            const costMult = [1, 1.5, 2].includes(b.costMult) ? b.costMult : 1, minScore = [0, 30, 50, 60, 70].includes(b.minScore) ? b.minScore : CFG.MIN_SCORE;
            if (!btJob.running) runBacktest(days, coins, { costMult, minScore, compare: b.compare === true });
            return json(res, 200, { started: true });
        }
        if (u.pathname === '/api/reset' && req.method === 'POST') {
            if (!ADMIN_KEY) return json(res, 403, { error: 'ADMIN_KEY tanımlı değil; sıfırlama kapalı' });
            if (!authed(u)) return json(res, 401, { error: 'yetkisiz' });
            signals = []; lastSig = {}; alerts = []; alertCd = {}; dirty = true; saveState(); return json(res, 200, { ok: true });
        }
        json(res, 404, { error: 'yok' });
    } catch (e) { json(res, 500, { error: e.message }); }
});

async function start() {
    try {
        loadState();
        await ex.loadMarkets(); log('marketler:', Object.keys(ex.markets).length);
        await refreshUniverse();
        log('evren:', universe.length, 'coin | elenen şüpheli:', scan.suspect);
        setInterval(refreshUniverse, CFG.UNIVERSE_MS); setInterval(track, CFG.TRACK_MS);
        if (CFG.ENABLE_LIVE) setInterval(liveTick, CFG.LIVE_MS); else setInterval(refreshTickers, 15e3);
        setInterval(saveState, 15e3); setInterval(selfPing, 10 * 60e3);
        lastScanSlot = Math.floor((Date.now() - CFG.SCAN_DELAY_MS) / M15);
        runScan();
        setInterval(() => { const slot = Math.floor((Date.now() - CFG.SCAN_DELAY_MS) / M15); if (slot > lastScanSlot && !scan.running) { lastScanSlot = slot; runScan(); } }, 3000);
        log('SONER TRADE v14 hazır | CANLI ' + (CFG.ENABLE_LIVE ? 'açık (' + CFG.LIVE_MS / 1000 + ' sn)' : 'kapalı') + ' | PB ' + (CFG.ENABLE_PB ? 'açık' : 'kapalı') + ' | TB ' + (CFG.ENABLE_TB ? 'açık' : 'kapalı') + ' | TR ' + (CFG.ENABLE_TR ? 'açık' : 'kapalı') + ' (' + TRI.AGG + 'H)' + (CFG.TR_PAPER ? ' [TR ileri test]' : ''));
    } catch (e) { log('başlatma hatası', e.message); setTimeout(start, 30000); }
}
function shutdown() { dirty = true; saveState(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

if (require.main === module) server.listen(PORT, '0.0.0.0', () => { log('PORT', PORT); start(); });
module.exports = { runScan, track, refreshUniverse, apiState, liveTick, buildStruct, _sigs: () => signals, _alerts: () => alerts, _struct: struct, _ex: ex, signalAt, advance, buildSym, prepare, simulate, grp, aggregateN, CFG, VARIANTS, TRI };
