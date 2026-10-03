// server.js — SONER v36 (http + ccxt, express yok, socket.io yok)
// Üçgen Kırılım + Trend Takip + BTC Kapısı
const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || './data';
const STATE_FILE = path.join(DATA_DIR, 'state36.json');

const M1 = 60e3, M15 = 15*M1, H1 = 3600e3;
const BTC = 'BTC/USDT:USDT', ETH = 'ETH/USDT:USDT';
const SCAN_INTERVAL = 5*M1;
const LIVE_INTERVAL = 30*1000;
const PRESCAN_INTERVAL = 10*M1;
const TREND_INTERVAL = 5*M1;

const PRESCAN_MIN_VOL = Number(process.env.PRESCAN_MIN_VOL || 10e6);
const UNIVERSE_MAX = Number(process.env.UNIVERSE || 200);

const NON_CRYPTO = ['USDC','USDT','DAI','TUSD','BUSD','FDUSD','USDE','SUSDE','USDS','USD1','PYUSD','USDD','FRAX','LUSD','GUSD','BUIDL','USTC','USDP','WBTC','WETH','WSTETH','STETH','RETH','CBETH','WBNB','WAVAX','WMATIC','PAXG','XAUT','XAU','XAG','XPT','XPD','GOLD','SILVER','OIL','WTI','BRENT','USOIL','UKOIL'];

const TRI_K=3, TRI_LOOK=150, TRI_MIN_LEN=15, TRI_MAX_LEN=100;
const TRI_TOL_ATR=0.30, TRI_WICK_ATR=0.60, TRI_CLOSE_ATR=0.20;
const TRI_MIN_TOUCH=3, TRI_SQUEEZE=0.85, TRI_FLAT=0.12;
const NEAR_ATR=0.4, BRK_SEE=0.8, BRK_ATR=0.15, BRK_VOL=1.3;
const FRESH_MIN=5, MAX_CHASE=0.6;
const STOP_ATR15=2.0, STOP_MIN_PCT=0.8;
const BRK_TP1_R=1.0, BRK_TP2_R=2.0, BRK_EXPIRE_H=12;
const MIN_RR=0.8, MAX_TP2R=5;
const MAX_COST_R=0.35, SLIP_PCT=0.03, COOLDOWN_MIN=45;
const MIN_RISK_PCT=0.3, MAX_RISK_PCT=6.0;
const RADAR_LOCK_H=6, GATE_TH=0.15, MAX_DIR=10;

const TREND_EMA_FAST=21, TREND_EMA_SLOW=50;
const TREND_STOP_ATR=1.5;
const TREND_TP1_R=1.5, TREND_TP2_R=3.0;
const TREND_MAX_HOLD_H=24, TREND_CD_MIN=120, TREND_MAX_OPEN=8;

const log = (...a) => console.log('[v36]', ...a);
const baseOf = s => s.split('/')[0];
const isMajor = s => /^(BTC|ETH)\//.test(s);
const r2 = x => Number(Number(x).toFixed(3));
const clamp = (x,a=-1,b=1) => Math.max(a, Math.min(b, x));
const th = Math.tanh;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const closedOnly = (c, ms, now=Date.now()) => c.filter(x => x[0]+ms <= now);
const fmt = p => { const a = Math.abs(p); return a>=1000 ? p.toFixed(2) : a>=1 ? p.toFixed(4) : a>=0.01 ? p.toFixed(5) : p.toFixed(7); };
const isOpen = s => s.status === 'OPEN' || s.status === 'TP1';
const costFor = vol => { const v = vol||0; return v>=200e6 ? 0.14 : v>=50e6 ? 0.18 : v>=10e6 ? 0.25 : 0.35; };
const trAt = (c,i) => Math.max(c[i][2]-c[i][3], Math.abs(c[i][2]-c[i-1][4]), Math.abs(c[i][3]-c[i-1][4]));
const atrMean = (c,p=14) => { if (c.length <= p) return 0; let s=0; for (let i=c.length-p; i<c.length; i++) s += trAt(c,i); return s/p; };
const flatRatio = c => { const a = c.slice(-48); let f=0; for (const x of a) if (x[2]===x[3] || !x[5]) f++; return a.length ? f/a.length : 1; };
const hasGap = (c, ms, n) => { const a = c.slice(-n); for (let i=1; i<a.length; i++) if (a[i][0]-a[i-1][0] !== ms) return true; return false; };

function ema(v,p) { const k=2/(p+1); let e=v[0]; const o=[e]; for (let i=1; i<v.length; i++) { e = v[i]*k + e*(1-k); o.push(e); } return o; }
function atrSeries(c,p=14) { const o = new Array(c.length).fill(null); if (c.length <= p) return o; let a=0; for (let i=1; i<=p; i++) a += trAt(c,i); a/=p; o[p]=a; for (let i=p+1; i<c.length; i++) { a = (a*(p-1) + trAt(c,i))/p; o[i] = a; } return o; }
function aggregateN(c, baseMs, n) { const ms = baseMs*n, g = new Map(); for (const x of c) { const k = Math.floor(x[0]/ms)*ms; let a = g.get(k); if (!a) { a = [k,x[1],x[2],x[3],x[4],x[5],1]; g.set(k,a); } else { a[2] = Math.max(a[2],x[2]); a[3] = Math.min(a[3],x[3]); a[4] = x[4]; a[5] += x[5]; a[6]++; } } return [...g.values()].filter(a => a[6] === n); }

const REQ = { last: 0, minGap: 200 };
async function safeFetch(ex, sym, tf, limit, since) {
    const wait = REQ.minGap - (Date.now() - REQ.last);
    if (wait > 0) await sleep(wait);
    REQ.last = Date.now();
    for (let att=1; att<=3; att++) {
        try { return await ex.fetchOHLCV(sym, tf, since, limit); }
        catch (e) {
            const m = String(e.message || e);
            if (m.includes('429') || m.toLowerCase().includes('rate')) await sleep(2000*att);
            else throw e;
        }
    }
    throw new Error('rate');
}

// ============ ÜÇGEN MOTORU ============
function pivots(c, end, K, from) { const hi=[], lo=[]; for (let i=Math.max(K, from); i<=end-K; i++) { let isH=true, isL=true; for (let d=1; d<=K && (isH||isL); d++) { if (c[i][2] <= c[i-d][2] || c[i][2] < c[i+d][2]) isH=false; if (c[i][3] >= c[i-d][3] || c[i][3] > c[i+d][3]) isL=false; } if (isH) hi.push({i, p:c[i][2]}); if (isL) lo.push({i, p:c[i][3]}); } return {hi, lo}; }
function fitLine(pts, c, end, atr, side) {
    const P = pts.slice(-8); let best = null;
    for (let a=0; a<P.length-1; a++) for (let b=a+1; b<P.length; b++) {
        const A=P[a], B=P[b]; if (B.i-A.i < 3) continue;
        const s = (B.p-A.p)/(B.i-A.i); let ok=true;
        for (let x=A.i; x<=end; x++) { const ln = A.p + s*(x-A.i); if (side===1 ? (c[x][4]>ln+TRI_CLOSE_ATR*atr || c[x][2]>ln+TRI_WICK_ATR*atr) : (c[x][4]<ln-TRI_CLOSE_ATR*atr || c[x][3]<ln-TRI_WICK_ATR*atr)) { ok=false; break; } }
        if (!ok) continue;
        const pts2 = []; for (const p of P) if (p.i>=A.i && Math.abs(p.p-(A.p+s*(p.i-A.i))) <= TRI_TOL_ATR*atr) pts2.push(p);
        if (pts2.length < 2) continue;
        const lastI = pts2[pts2.length-1].i; if (end-lastI > 40) continue;
        const score = pts2.length*1000 + (lastI-A.i)*2;
        if (!best || score > best.score) best = {i0:A.i, p0:A.p, s, touches:pts2.length, last:lastI, score, pts:pts2};
    }
    return best;
}
function detectTriangle(c, end) {
    if (end < 50) return null;
    const atr = atrSeries(c,14)[end]; if (!(atr>0)) return null;
    const pv = pivots(c, end, TRI_K, Math.max(1, end-TRI_LOOK));
    if (pv.hi.length < 2 || pv.lo.length < 2) return null;
    const R = fitLine(pv.hi, c, end, atr, 1), S = fitLine(pv.lo, c, end, atr, -1);
    if (!R || !S) return null;
    if (R.touches + S.touches < TRI_MIN_TOUCH) return null;
    const xs = Math.max(R.i0, S.i0), len = end-xs;
    if (len < TRI_MIN_LEN || len > TRI_MAX_LEN) return null;
    const rv = x => R.p0 + R.s*(x-R.i0), sv = x => S.p0 + S.s*(x-S.i0);
    const w0 = rv(xs)-sv(xs), wN = rv(end)-sv(end);
    if (!(w0>0 && wN>0)) return null;
    if (wN/w0 > TRI_SQUEEZE) return null;
    if (wN < 0.4*atr) return null;
    const dsl = S.s-R.s; if (!(dsl>0)) return null;
    const apex = end + wN/dsl; if (apex-end > 100) return null;
    const flatTol = TRI_FLAT*w0/len;
    const rf = Math.abs(R.s) <= flatTol, sf = Math.abs(S.s) <= flatTol;
    let type = 'Simetrik';
    if (rf && S.s>flatTol) type = 'Yükselen';
    else if (sf && R.s<-flatTol) type = 'Alçalan';
    else if (R.s>flatTol && S.s>flatTol) type = 'Yükselen Kama';
    else if (R.s<-flatTol && S.s<-flatTol) type = 'Alçalan Kama';
    return {type, end, atr, w0, wN, apex, len, R, S, touches:R.touches+S.touches, squeeze:wN/w0};
}
const lineVal = (L, st, idx) => L.p0 + L.s*(idx - L.i0);

// ============ DURUM ============
const ex = new ccxt.bitget({ enableRateLimit: true, options: { defaultType: 'swap' } });
let universe = [], tickers = {}, market = {btc:null, eth:null, lastTick:0};
let struct = {}, brkEvents = [], trendSignals = [], triRadar = [];
let lastSig = {}, GATE = null;
let dirty = false;
let liveRunning = false, scanRunning = false, trendRunning = false, tracking = false;
let lastStateAt = 0;

function norm(s) {
    if (!s.initialStop) s.initialStop = s.stop;
    if (!s.riskAbs) s.riskAbs = Math.abs(s.entry - s.initialStop);
    if (!s.trackedTo) s.trackedTo = Math.floor(s.time/M1)*M1;
    s.mfe = s.mfe || 0; s.mae = s.mae || 0; s.costR = s.costR || 0;
    if (s.status === 'TP1' && !s.tp1At) s.tp1At = s.time;
    return s;
}
function mkPos(o) {
    const L = o.dir === 'LONG' ? 1 : -1;
    const riskAbs = L*(o.entry - o.stop);
    const riskPct = riskAbs/o.entry*100;
    return Object.assign({
        id:o.id, strategy:o.strategy, symbol:o.sym, base:baseOf(o.sym), dir:o.dir, time:o.time,
        entry:o.entry, stop:o.stop, initialStop:o.stop, riskAbs, riskPct:r2(riskPct),
        costR:r2(o.costPct/riskPct),
        tp1R:o.tp1R, tp2R:o.tp2R,
        tp1: o.entry + L*riskAbs*o.tp1R,
        tp2: o.entry + L*riskAbs*o.tp2R,
        trail:1.0, maxHold:o.maxHold,
        status:'OPEN', lastPrice:o.entry, mfe:0, mae:0,
        trackedTo: Math.floor(o.time/M1)*M1
    }, o.extra || {});
}
const curR = (s,px) => (s.dir==='LONG'?1:-1)*(px - s.entry)/Math.abs(s.entry - s.initialStop);
function closeSig(s, status, gross, t, px) { s.status=status; s.grossR=r2(gross); s.netR=r2(gross-s.costR); s.closedAt=t; s.exitPrice=px; }
function advance(s, k, dur) {
    dur = dur || M1;
    const L = s.dir === 'LONG', side = L ? 1 : -1, risk = Math.abs(s.entry - s.initialStop);
    const end = k[0]+dur, el = k[0]-s.time;
    s.lastPrice = k[4];
    s.mfe = Math.max(s.mfe, side*(k[L?2:3]-s.entry)/risk);
    s.mae = Math.min(s.mae, side*(k[L?3:2]-s.entry)/risk);
    if (s.status === 'OPEN') {
        if (L ? k[3]<=s.stop : k[2]>=s.stop) { closeSig(s,'STOP',-1,end,s.stop); return true; }
        if (L ? k[2]>=s.tp1 : k[3]<=s.tp1) { s.status='TP1'; s.stop=s.entry; s.tp1At=k[0]; return false; }
    } else if (s.status === 'TP1' && k[0] > s.tp1At) {
        const hh = L ? k[2] : k[3];
        const ts = s.entry + side*Math.max(0, (side*(hh-s.entry))/risk - s.trail)*risk;
        if (L ? ts>s.stop : ts<s.stop) s.stop = ts;
        if (L ? k[3]<=s.stop : k[2]>=s.stop) { closeSig(s, s.stop===s.entry?'BE':'TRAIL', 0.5*s.tp1R + 0.5*curR(s,s.stop), end, s.stop); return true; }
        if (L ? k[2]>=s.tp2 : k[3]<=s.tp2) { closeSig(s,'TP2', 0.5*s.tp1R + 0.5*s.tp2R, end, s.tp2); return true; }
    }
    if (el >= s.maxHold && isOpen(s)) { const r = curR(s, k[4]); closeSig(s,'SÜRE', s.status==='TP1' ? 0.5*s.tp1R + 0.5*r : r, end, k[4]); return true; }
    return false;
}

// ============ EVREN ============
function isSuspect(sym) {
    if (isMajor(sym)) return false;
    const inf = (ex.markets[sym] && ex.markets[sym].info) || {};
    if (String(inf.isRwa || inf.rwa || '').toUpperCase() === 'YES') return true;
    return false;
}
async function refreshUniverse() {
    try {
        if (!Object.keys(ex.markets || {}).length) await ex.loadMarkets();
        await sleep(300);
        tickers = await ex.fetchTickers();
        market.lastTick = Date.now();
        const all = Object.values(tickers).filter(t => t && t.symbol && t.symbol.endsWith(':USDT') && ex.markets[t.symbol] && ex.markets[t.symbol].linear);
        const ok = all.filter(t => !NON_CRYPTO.includes(baseOf(t.symbol).toUpperCase()) && (t.quoteVolume||0) >= PRESCAN_MIN_VOL && !isSuspect(t.symbol));
        const top = ok.slice().sort((a,b) => (b.quoteVolume||0)-(a.quoteVolume||0)).slice(0, UNIVERSE_MAX).map(t => t.symbol);
        for (const s of [BTC,ETH]) if (!top.includes(s)) top.push(s);
        universe = top;
        for (const s of [BTC,ETH]) { const t = tickers[s]; if (t) market[s===BTC?'btc':'eth'] = {price:t.last, chg:t.percentage}; }
        log('evren:', universe.length, 'coin');
    } catch (e) { log('evren hata', e.message); }
}
async function refreshTickers() {
    try {
        const t = await ex.fetchTickers(); tickers = t; market.lastTick = Date.now();
        for (const s of [BTC,ETH]) if (t[s]) market[s===BTC?'btc':'eth'] = {price:t[s].last, chg:t[s].percentage};
        for (const list of [brkEvents, trendSignals]) for (const s of list) if (isOpen(s) && t[s.symbol] && t[s.symbol].last) s.lastPrice = t[s.symbol].last;
    } catch (e) { }
}

// ============ BTC KAPISI ============
function mkCtx(c) {
    const cl = c.map(x => x[4]);
    const h = aggregateN(c, M15, 4), hc = h.map(x => x[4]);
    return {c, cl, e21: ema(cl,21), e50: ema(cl,50), atr: atrSeries(c,14),
        h1: {t:h.map(x=>x[0]), cl:hc, e21:ema(hc,21), e50:ema(hc,50)}};
}
function h1Idx(ctx, tEnd) { const t = ctx.h1.t; let lo=0, hi=t.length-1, r=-1; while (lo<=hi) { const m=(lo+hi)>>1; if (t[m]+H1<=tEnd) { r=m; lo=m+1; } else hi=m-1; } return r; }
function gateAt(ctx, i) {
    if (i < 55) return null;
    const c = ctx.c, atr = ctx.atr[i], e21 = ctx.e21, e50 = ctx.e50;
    if (!(atr>0) || e21[i]==null || e50[i]==null || e21[i-3]==null) return null;
    const j = h1Idx(ctx, c[i][0]+M15); if (j<0) return null;
    const H = ctx.h1; if (H.e21[j]==null || H.e50[j]==null) return null;
    const a1 = atr*2;
    const t1 = 0.5*th((H.cl[j]-H.e50[j])/a1/2) + 0.5*th((H.e21[j]-H.e50[j])/a1);
    const sl = th((e21[i]-e21[i-3])/atr*2);
    const mv = th((ctx.cl[i]-ctx.cl[i-3])/atr/1.5);
    const score = 0.45*t1 + 0.30*sl + 0.25*mv;
    const long = score > -GATE_TH;
    const short = score < GATE_TH;
    return {score, long, short, t:c[i][0]};
}
async function updateGate() {
    if (GATE && Date.now()-GATE.u < 30e3) return;
    try {
        const c = closedOnly(await safeFetch(ex, BTC, '15m', 400), M15);
        if (c.length < 130) return;
        const g = gateAt(mkCtx(c), c.length-1);
        if (g) GATE = Object.assign(g, {u:Date.now()});
    } catch (e) { }
}
const gateOk = dir => !GATE ? true : (dir==='LONG' ? GATE.long : GATE.short);

// ============ TARAMA ============
async function runScan() {
    if (scanRunning || !universe.length) return;
    scanRunning = true; const t0 = Date.now();
    try {
        const S = {}; let idx = 0;
        const worker = async () => { while (idx < universe.length) { const sym = universe[idx++]; try { const c = closedOnly(await safeFetch(ex, sym, '1h', 400), H1); if (c.length < 60 || hasGap(c,H1,TRI_LOOK) || (!isMajor(sym) && flatRatio(c) >= 0.08)) { S[sym]=false; continue; } S[sym]=c; } catch(e){} } };
        await Promise.all([worker(), worker(), worker()]);
        for (const sym of universe) {
            const c = S[sym];
            if (c === false) { delete struct[sym]; continue; }
            if (!c) continue;
            const det = detectTriangle(c, c.length-1);
            if (det) struct[sym] = {t:t0, tBase:c[c.length-1][0], lastI:c.length-1, atr:det.atr, w0:det.w0, touches:det.touches, squeeze:Number(det.squeeze.toFixed(2)), type:det.type,
                R:{p0:det.R.p0, s:det.R.s, i0:det.R.i0}, S:{p0:det.S.p0, s:det.S.s, i0:det.S.i0}};
            else if (!(struct[sym] && t0-struct[sym].t < 30*M1)) delete struct[sym];
        }
        for (const k of Object.keys(struct)) if (!universe.includes(k)) delete struct[k];
        log('tarama:', Object.keys(struct).length, 'formasyon');
    } catch (e) { log('tarama hata', e.message); }
    scanRunning = false;
}

// ============ CANLI KIRILIM ============
async function liveTick() {
    if (liveRunning) return;
    liveRunning = true;
    try {
        const now = Date.now();
        if (!GATE || now-GATE.u > 240e3) { liveRunning = false; return; }
        const recent = new Set(brkEvents.filter(b => now-b.time < RADAR_LOCK_H*H1).map(b => b.symbol));
        const rad = [];
        for (const sym of Object.keys(struct)) {
            const st = struct[sym], tk = tickers[sym];
            if (!st || !tk || !tk.last || now-st.t > 4*H1) continue;
            if (recent.has(sym)) continue;
            const P = tk.last;
            const R = lineVal(st.R, st, st.lastI + (now-st.tBase)/H1);
            const S = lineVal(st.S, st, st.lastI + (now-st.tBase)/H1);
            if (!(R>S)) continue;
            const atr = st.atr; if (!(atr>0)) continue;
            const dR = (P-R)/atr, dS = (P-S)/atr;
            let cand = null;
            if (Math.abs(dR)<=NEAR_ATR || (dR>0 && dR<=BRK_SEE)) cand = {bias:'LONG', d:dR, v:R, line:'üst'};
            if (Math.abs(dS)<=NEAR_ATR || (dS<0 && -dS<=BRK_SEE)) { if (!cand || Math.abs(dS)<Math.abs(cand.d)) cand = {bias:'SHORT', d:dS, v:S, line:'alt'}; }
            if (!cand) continue;
            const L = cand.bias==='LONG'?1:-1;
            const broke = L*cand.d > 0.05;
            const aligned = gateOk(cand.bias);
            rad.push({symbol:sym, base:baseOf(sym), price:P, bias:cand.bias, dir:cand.bias, rank:Math.abs(cand.d), touches:st.touches, type:st.type, broke, aligned,
                state: st.type+' üçgen • '+cand.line+' çizgi '+fmt(cand.v)+' ('+Math.abs(cand.d).toFixed(2)+' ATR)'});
            if (!broke) continue;
            let c15; try { c15 = closedOnly(await safeFetch(ex, sym, '15m', 40), M15); } catch(e){ continue; }
            if (!c15 || c15.length < 30) continue;
            const n15 = c15.length, bk = c15[n15-1], pv = c15[n15-2], a15 = atrMean(c15, 14);
            if (!(a15>0)) continue;
            const pw = c15.slice(-21,-1), avgV = pw.reduce((a,x)=>a+x[5],0)/pw.length, vx = avgV>0 ? bk[5]/avgV : 0;
            const dBk = L*(bk[4] - (L===1?R:S));
            const dPv = L*(pv[4] - (L===1?R:S));
            const rng = (bk[2]-bk[3]) || 1e-9;
            const q = L===1 ? (bk[4]-bk[3])/rng : (bk[2]-bk[4])/rng;
            if (dBk < BRK_ATR*atr || dPv > 0.05*atr || q < 0.55 || rng > 2.5*a15 || vx < BRK_VOL) continue;
            if (now - (bk[0]+M15) > FRESH_MIN*M1) continue;
            const sk = 'BRK|'+sym+'|'+cand.bias;
            if (now - (lastSig[sk]||0) < COOLDOWN_MIN*M1) continue;
            if (brkEvents.some(x => x.symbol===sym && isOpen(x))) continue;
            const line = L===1 ? R : S;
            const stopFromLine = line - L*STOP_ATR15*a15;
            const stopFromPct = P - L*P*STOP_MIN_PCT/100;
            const stop = L===1 ? Math.min(stopFromLine, stopFromPct) : Math.max(stopFromLine, stopFromPct);
            const risk = L*(P-stop); if (!(risk>0)) continue;
            const riskPct = risk/P*100;
            if (riskPct < MIN_RISK_PCT || riskPct > MAX_RISK_PCT) continue;
            const costPct = costFor(tk.quoteVolume) + 2*SLIP_PCT;
            if (costPct/riskPct > MAX_COST_R) continue;
            const rawR = L*(line + L*st.w0 - P)/risk;
            if (rawR < MIN_RR) continue;
            const tp2R = Math.min(Math.max(rawR, BRK_TP2_R), MAX_TP2R);
            if (brkEvents.filter(isOpen).length >= MAX_DIR) continue;
            const pos = mkPos({id:'BRK_'+sym.replace(/[^A-Z0-9]/g,'')+'_'+now, strategy:'TRI', sym, dir:cand.bias, time:now, entry:P, stop, tp1R:BRK_TP1_R, tp2R, costPct, maxHold:BRK_EXPIRE_H*H1,
                extra:{type:st.type, touches:st.touches, squeeze:st.squeeze, volX:r2(vx), aligned}});
            brkEvents.unshift(pos);
            if (brkEvents.length > 200) brkEvents.length = 200;
            lastSig[sk] = now; dirty = true;
            log('KIRILIM', pos.dir, pos.base, st.type, 'hacim', vx.toFixed(1), 'risk %'+pos.riskPct, 'maliyet '+pos.costR+'R');
        }
        triRadar = rad.sort((a,b) => a.rank-b.rank).slice(0, 30);
    } catch (e) { log('live hata', e.message); }
    liveRunning = false;
}

// ============ TREND TAKİP ============
async function trendTick() {
    if (trendRunning || !universe.length) return;
    trendRunning = true; const t0 = Date.now();
    try {
        if (!GATE || t0-GATE.u > 240e3) { trendRunning = false; return; }
        let idx = 0; const candidates = [];
        const worker = async () => {
            while (idx < universe.length) {
                const sym = universe[idx++];
                try {
                    const c = closedOnly(await safeFetch(ex, sym, '1h', 200), H1);
                    if (c.length < 60) continue;
                    const c15 = closedOnly(await safeFetch(ex, sym, '15m', 80), M15);
                    if (c15.length < 30) continue;
                    const cl = c.map(x=>x[4]);
                    const e21 = ema(cl, TREND_EMA_FAST), e50 = ema(cl, TREND_EMA_SLOW);
                    const i = cl.length-1;
                    if (e21[i]==null || e50[i]==null) continue;
                    const up = e21[i] > e50[i] && cl[i] > e50[i];
                    const dn = e21[i] < e50[i] && cl[i] < e50[i];
                    if (!up && !dn) continue;
                    const dir = up ? 'LONG' : 'SHORT';
                    const L = dir==='LONG'?1:-1;
                    const b = c15[c15.length-1], p = c15[c15.length-2];
                    const e21_15 = ema(c15.map(x=>x[4]), 21);
                    const i15 = c15.length-1;
                    if (e21_15[i15]==null) continue;
                    if (L*(b[4]-e21_15[i15]) <= 0) continue;
                    if (L*(b[4]-p[4]) <= 0) continue;
                    if (L===1 ? b[4] <= p[2] : b[4] >= p[3]) continue;
                    candidates.push({sym, dir, c15});
                } catch(e){}
            }
        };
        await Promise.all([worker(), worker(), worker()]);
        candidates.sort(() => Math.random()-0.5);
        for (const cd of candidates.slice(0,5)) {
            const sym = cd.sym, dir = cd.dir, L = dir==='LONG'?1:-1;
            const sk = 'TR|'+sym+'|'+dir;
            if (Date.now() - (lastSig[sk]||0) < TREND_CD_MIN*M1) continue;
            if (trendSignals.some(x => x.symbol===sym && isOpen(x))) continue;
            if (trendSignals.filter(x => isOpen(x)).length >= TREND_MAX_OPEN) break;
            if (!gateOk(dir)) continue;
            const tk = tickers[sym]; if (!tk || !tk.last) continue;
            const atr = atrMean(cd.c15, 14); if (!(atr>0)) continue;
            const entry = tk.last;
            const stop = entry - L*TREND_STOP_ATR*atr;
            const riskPct = Math.abs(entry-stop)/entry*100;
            if (riskPct < MIN_RISK_PCT || riskPct > MAX_RISK_PCT) continue;
            const costPct = costFor(tk.quoteVolume) + 2*SLIP_PCT;
            if (costPct/riskPct > MAX_COST_R) continue;
            const pos = mkPos({id:'TR_'+sym.replace(/[^A-Z0-9]/g,'')+'_'+Date.now(), strategy:'TREND', sym, dir, time:Date.now(), entry, stop, tp1R:TREND_TP1_R, tp2R:TREND_TP2_R, costPct, maxHold:TREND_MAX_HOLD_H*H1,
                extra:{setup:'Trend takip (1h EMA21/50 + 15m teyit)'}});
            trendSignals.unshift(pos);
            if (trendSignals.length > 200) trendSignals.length = 200;
            lastSig[sk] = Date.now(); dirty = true;
            log('TREND', dir, pos.base, 'risk %'+pos.riskPct, 'maliyet '+pos.costR+'R');
        }
    } catch (e) { log('trend hata', e.message); }
    trendRunning = false;
}

// ============ TAKİP ============
async function track() {
    if (tracking) return; tracking = true;
    try {
        const open = brkEvents.concat(trendSignals).filter(isOpen);
        if (!open.length) { tracking = false; return; }
        const bySym = {};
        for (const s of open) (bySym[s.symbol] = bySym[s.symbol]||[]).push(s);
        for (const sym of Object.keys(bySym)) {
            try {
                const list = bySym[sym];
                const since = Math.min(...list.map(x => x.trackedTo));
                const raw = closedOnly(await safeFetch(ex, sym, '1m', 500, since), M1);
                for (const s of list) {
                    if (!isOpen(s)) continue;
                    for (const k of raw) {
                        if (k[0] <= s.trackedTo) continue;
                        s.trackedTo = k[0]; dirty = true;
                        if (advance(s, k, M1) && !isOpen(s)) break;
                    }
                }
            } catch(e){}
        }
    } catch(e){}
    tracking = false;
}

// ============ İSTATİSTİK ============
function grp(list) {
    const n = list.length;
    if (!n) return {n:0, win:0, avgR:0, totalR:0, pf:0, t:0, lo:0, hi:0};
    let tot=0, w=0, gp=0, gl=0, sq=0;
    for (const s of list) { tot += s.netR; if (s.netR>0) { w++; gp+=s.netR; } else gl -= s.netR; sq += s.netR*s.netR; }
    const avg = tot/n;
    let t=0, se=0;
    if (n>1) { const v = Math.max(0, (sq - n*avg*avg)/(n-1)); se = Math.sqrt(v/n); t = se>0 ? avg/se : 0; }
    const z = n>=30 ? 1.96 : 2.3;
    return {n, win:w/n, avgR:avg, totalR:tot, pf: gl>0 ? gp/gl : (gp>0?99:0), t:Number(t.toFixed(2)), lo:avg-z*se, hi:avg+z*se};
}
function groupBy(list, fn) { const m = {}; for (const s of list) { const k = fn(s); (m[k]=m[k]||[]).push(s); } const o = {}; Object.keys(m).sort().forEach(k => o[k] = grp(m[k])); return o; }
const doneOf = l => l.filter(s => !isOpen(s) && s.netR != null);
function statsOf(list) {
    const c = doneOf(list);
    return {all: grp(c), byDir: groupBy(c, s => s.dir), byExit: groupBy(c, s => s.status), byType: groupBy(c, s => s.type || s.setup || '?'), open: list.filter(isOpen).length};
}
function verdictOf(g) {
    if (g.n < 30) return {lvl:'w', txt:'Karne oluşmadı ('+g.n+'/30). İzle.'};
    if (g.lo > 0) return {lvl:'g', txt:'Olumlu: ort '+g.avgR.toFixed(2)+'R, alt sınır '+g.lo.toFixed(2)};
    if (g.n>=40 && g.hi<0) return {lvl:'r', txt:'Kenar yok: ort '+g.avgR.toFixed(2)+'R, üst sınır '+g.hi.toFixed(2)};
    return {lvl:'w', txt:'Belirsiz: '+g.avgR.toFixed(2)+'R ['+g.lo.toFixed(2)+', '+g.hi.toFixed(2)+']'};
}

function apiState() {
    const now = Date.now();
    const px = {};
    for (const x of triRadar.concat(brkEvents.slice(0,80), trendSignals.slice(0,80))) { const t = tickers[x.symbol]; if (t && t.last) px[x.symbol] = t.last; }
    return {
        now, mode:'v36 • Üçgen Kırılım + Trend Takip',
        px, market,
        gate: GATE ? {score:GATE.score, long:GATE.long, short:GATE.short, age:now-GATE.u} : null,
        breakouts: brkEvents.slice(0, 80), brkStats: statsOf(brkEvents),
        radar: triRadar, formations: Object.keys(struct).length,
        trend: trendSignals.slice(0, 80), trendStats: statsOf(trendSignals),
        universe: universe.length
    };
}

// ============ STATE KAYIT ============
function loadState() {
    try {
        const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        brkEvents = (j.brk || []).filter(s => s && s.entry).map(norm);
        trendSignals = (j.tr || []).filter(s => s && s.entry).map(norm);
        lastSig = j.lastSig || {};
        log('durum yüklendi:', brkEvents.length, 'kırılım,', trendSignals.length, 'trend');
    } catch(e) { log('temiz başlangıç'); }
}
function saveState() {
    if (!dirty) return; dirty = false;
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        const tmp = STATE_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({brk:brkEvents.slice(0,200), tr:trendSignals.slice(0,200), lastSig}));
        fs.renameSync(tmp, STATE_FILE);
    } catch(e) { log('kayıt hata', e.message); }
}

// ============ HTML ============
const HTML = `<!DOCTYPE html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SONER v36</title>
<style>
:root{--bg:#0c1117;--p1:#141b24;--p2:#1a2430;--ln:#243040;--tx:#e6ebf2;--dm:#8593a5;--lg:#3ddc97;--st:#ff6b7a;--am:#f2b84b;--bl:#5aa9ff}
*{box-sizing:border-box;margin:0;padding:0}body{background:var(--bg);color:var(--tx);font:13px/1.45 system-ui,sans-serif}
.top{display:flex;gap:10px;padding:10px 14px;background:var(--p1);border-bottom:1px solid var(--ln);flex-wrap:wrap;align-items:center}
.brand{font-weight:800;font-size:15px}.brand small{color:var(--am);margin-left:8px}
.chip{background:var(--bg);border:1px solid var(--ln);padding:4px 10px;border-radius:6px;font-size:12px}
.body{display:flex;height:calc(100vh - 48px)}
.side{width:480px;background:var(--p1);border-right:1px solid var(--ln);overflow:auto;padding:8px}
.main{flex:1;overflow:auto;padding:16px}
.card{background:var(--p2);border:1px solid var(--ln);border-radius:8px;padding:10px 12px;margin-bottom:8px;cursor:pointer}
.card.L{border-left:5px solid var(--lg)}.card.S{border-left:5px solid var(--st)}
.card:hover{background:#202c3a}
.r1{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.dirb{font-weight:800;font-size:12px;padding:3px 10px;border-radius:5px}.dirb.L{background:var(--lg);color:#08130d}.dirb.S{background:var(--st);color:#1a0508}
.coin{font-weight:800;font-size:14px}
.kar{color:var(--lg)}.zarar{color:var(--st)}.fl{color:var(--dm)}
.tag{font-size:10px;padding:1px 6px;border-radius:4px;background:var(--bg);border:1px solid var(--ln);color:var(--dm)}
.tag.w{color:var(--am);border-color:rgba(242,184,75,.4)}.tag.g{color:var(--lg);border-color:rgba(61,220,151,.4)}.tag.r{color:var(--st);border-color:rgba(255,107,122,.4)}
.sub{color:var(--dm);font-size:11px;margin-top:5px;display:flex;gap:10px;flex-wrap:wrap}.sub b{color:var(--tx)}
h2{font-size:16px;margin-bottom:10px}h3{font-size:12px;color:var(--dm);margin:14px 0 6px;font-weight:700;padding:0 6px}
table{width:100%;border-collapse:collapse;font-size:12px}
th{color:var(--dm);font-weight:600;text-align:left;padding:4px 6px;border-bottom:1px solid var(--ln)}
td{padding:5px 6px;border-bottom:1px solid rgba(36,48,64,.5)}
td.n,th.n{text-align:right}
.box{background:var(--p2);border:1px solid var(--ln);border-radius:8px;padding:12px;margin-bottom:12px}
.box.g{border-color:var(--lg)}.box.r{border-color:var(--st)}.box.w{border-color:var(--am)}
.tile{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:12px}
.tile .t{background:var(--p2);border:1px solid var(--ln);border-radius:8px;padding:10px 12px}
.tile .k{color:var(--dm);font-size:11px}.tile .v{font-size:20px;font-weight:800;margin-top:4px}
.note{color:var(--dm);font-size:11px;margin-top:8px}
a.tv{color:var(--bl);text-decoration:none;font-weight:700;font-size:11px}
</style></head><body>
<div class="top">
  <div class="brand">SONER TRADE<small id="modeB">v36</small></div>
  <div class="chip" id="cGate"></div>
  <div class="chip" id="cBtc"></div>
  <div class="chip" id="cEv"></div>
  <div style="flex:1"></div>
  <span id="conn" class="fl">Bağlanıyor…</span>
</div>
<div class="body">
  <div class="side" id="side"></div>
  <div class="main" id="main"></div>
</div>
<script>
var S=null,sel=null,lastSeen=0;
function $(id){return document.getElementById(id)}
function fp(p){if(p==null||isNaN(p))return'-';p=Number(p);var a=Math.abs(p);return a>=1000?p.toFixed(2):a>=1?p.toFixed(4):a>=0.01?p.toFixed(5):p.toFixed(7)}
function f2(x,d){d=d==null?2:d;return x==null||isNaN(x)?'-':Number(x).toFixed(d)}
function sg(x,d){d=d==null?2:d;if(x==null)return'-';x=Number(x);if(isNaN(x))return'-';return(x>0?'+':'')+x.toFixed(d)}
function cl(x){return x>0?'kar':x<0?'zarar':'fl'}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])})}
function ago(ts){var m=Math.floor((Date.now()-ts)/60000);return m<1?'şimdi':m<60?m+'dk':Math.floor(m/60)+'s '+(m%60)+'dk'}
function isOp(x){return x.status==='OPEN'||x.status==='TP1'}
function dirb(d){return '<span class="dirb '+(d==='LONG'?'L':'S')+'">'+(d==='LONG'?'▲ LONG':'▼ SHORT')+'</span>'}
function tvl(sym,iv){return '<a class="tv" target="_blank" href="https://www.tradingview.com/chart/?symbol=BITGET:'+esc(sym.split('/')[0])+'USDT.P&interval='+iv+'">TV</a>'}
var ST={OPEN:'AÇIK',TP1:'TP1',TP2:'TP2',TRAIL:'TRAIL',BE:'BE',STOP:'STOP','SÜRE':'SÜRE'};
function posCard(kind,o){
  var L=o.dir==='LONG'?1:-1, op=isOp(o);
  var px=(S.px&&S.px[o.symbol])||o.lastPrice||o.entry;
  var r=op?L*(px-o.entry)/o.riskAbs:o.netR;
  var tags = kind==='brk' ? '<span class="tag w">'+esc(o.type||'')+'</span><span class="tag g">ONAYLI</span>' : '<span class="tag w">'+esc(o.setup||'')+'</span>';
  return '<div class="card '+ (L===1?'L':'S') + (op?'':'') + '" data-id="'+esc(o.id)+'" data-sym="'+esc(o.symbol)+'" data-kind="'+kind+'">'+
    '<div class="r1">'+dirb(o.dir)+'<span class="coin">'+esc(o.base)+'</span><span class="tag">'+ST[o.status]+'</span>'+
    '<span style="margin-left:auto;font-weight:800;font-size:15px" class="'+cl(r)+'">'+sg(r)+'R</span></div>'+
    '<div class="r1" style="margin-top:6px">'+tags+'<span class="tag">'+ago(o.time)+'</span></div>'+
    '<div class="sub"><span>Giriş <b>'+fp(o.entry)+'</b></span><span>Stop <b class="zarar">'+fp(o.stop)+'</b></span><span>TP1 <b class="kar">'+fp(o.tp1)+'</b></span><span>TP2 <b class="kar">'+fp(o.tp2)+'</b></span><span>Maliyet '+f2(o.costR)+'R</span>'+tvl(o.symbol, kind==='brk'?15:60)+'</div>'+
    '</div>';
}
function radarCard(r){
  return '<div class="card '+(r.bias==='LONG'?'L':'S')+'">'+
    '<div class="r1">'+dirb(r.bias)+'<span class="coin">'+esc(r.base)+'</span><span class="tag">'+esc(r.type)+'</span><span style="margin-left:auto" class="fl">'+sg(r.d,2)+' ATR</span></div>'+
    '<div class="sub"><span>'+esc(r.state)+'</span>'+(r.aligned?'<span class="tag g">kapı açık</span>':'<span class="tag r">kapı ters</span>')+'</div></div>';
}
function renderSide(){
  if(!S){$('side').innerHTML='';return}
  var h='';
  h+='<h3>ÜÇGEN KIRILIM — açık ('+S.breakouts.filter(isOp).length+')</h3>';
  h+=S.breakouts.filter(isOp).map(function(o){return posCard('brk',o)}).join('')||'<div class="note" style="padding:6px">Yok</div>';
  h+='<h3>TREND TAKİP — açık ('+S.trend.filter(isOp).length+')</h3>';
  h+=S.trend.filter(isOp).map(function(o){return posCard('tr',o)}).join('')||'<div class="note" style="padding:6px">Yok</div>';
  h+='<h3>ÜÇGEN RADAR ('+S.radar.length+' / '+S.formations+' formasyon)</h3>';
  h+=S.radar.slice(0,10).map(radarCard).join('')||'<div class="note" style="padding:6px">Yaklaşan yok</div>';
  h+='<h3>Kapananlar</h3>';
  var closed = S.breakouts.concat(S.trend).filter(function(x){return !isOp(x)}).slice(0,10);
  h+=closed.map(function(o){return posCard(o.strategy==='TRI'?'brk':'tr',o)}).join('')||'<div class="note" style="padding:6px">Yok</div>';
  $('side').innerHTML = h;
}
function tbl(t,title){
  var k=Object.keys(t||{});if(!k.length)return'';
  return '<h3>'+title+'</h3><table><tr><th>Grup</th><th class="n">N</th><th class="n">Win%</th><th class="n">OrtR</th><th class="n">%95</th><th class="n">TopR</th><th class="n">PF</th><th class="n">t</th></tr>'+
    k.map(function(g){var x=t[g];return '<tr><td>'+esc(g)+'</td><td class="n">'+x.n+'</td><td class="n">'+f2(x.win*100,0)+'</td><td class="n '+cl(x.avgR)+'">'+sg(x.avgR)+'</td><td class="n fl">['+sg(x.lo)+','+sg(x.hi)+']</td><td class="n '+cl(x.totalR)+'">'+sg(x.totalR,1)+'</td><td class="n">'+f2(x.pf)+'</td><td class="n">'+f2(x.t)+'</td></tr>'}).join('')+'</table>';
}
function renderMain(){
  var M=$('main');
  if(!S){M.innerHTML='<div class="note">Yükleniyor…</div>';return}
  var B=S.brkStats, T=S.trendStats;
  var h='';
  h+='<div class="tile">'+
     '<div class="t"><div class="k">Kırılım açık</div><div class="v">'+S.breakouts.filter(isOp).length+'</div></div>'+
     '<div class="t"><div class="k">Kırılım toplam</div><div class="v '+cl(B.all.totalR)+'">'+sg(B.all.totalR,1)+'R</div></div>'+
     '<div class="t"><div class="k">Trend açık</div><div class="v">'+S.trend.filter(isOp).length+'</div></div>'+
     '<div class="t"><div class="k">Trend toplam</div><div class="v '+cl(T.all.totalR)+'">'+sg(T.all.totalR,1)+'R</div></div>'+
     '<div class="t"><div class="k">Formasyon</div><div class="v">'+S.formations+'</div></div>'+
     '<div class="t"><div class="k">Radar</div><div class="v">'+S.radar.length+'</div></div>'+
     '</div>';
  h+='<div class="box '+(S.gate? (S.gate.long&&S.gate.short?'g':(S.gate.long||S.gate.short?'w':'r')) : 'w')+'">';
  h+='<b>BTC Kapısı:</b> ';
  if (S.gate) h += 'skor '+f2(S.gate.score,2)+' → LONG '+(S.gate.long?'AÇIK':'KAPALI')+' / SHORT '+(S.gate.short?'AÇIK':'KAPALI');
  else h += 'bekleniyor';
  h+='</div>';
  h+=tbl(B.all,'ÜÇGEN genel');
  h+=tbl(B.byType,'Üçgen tipi');
  h+=tbl(B.byDir,'Üçgen yön');
  h+=tbl(B.byExit,'Üçgen çıkış');
  h+=tbl(T.all,'TREND genel');
  h+=tbl(T.byDir,'Trend yön');
  h+=tbl(T.byExit,'Trend çıkış');
  h+='<div class="note">En az 30 kapanmış işlem ve %95 alt sınırın sıfırın üstünde olması beklenir.</div>';
  M.innerHTML=h;
}
function renderTop(){
  if(!S)return;
  var g=S.gate;
  $('cGate').innerHTML='<b>Kapı</b> '+(g?('LONG '+(g.long?'✓':'✗')+' SHORT '+(g.short?'✓':'✗')):'…');
  $('cBtc').innerHTML='<b>BTC</b> '+(S.market.btc?(fp(S.market.btc.price)+' '+sg(S.market.btc.chg)+'%'):'…');
  $('cEv').innerHTML='<b>Evren</b> '+S.universe+' coin';
  $('modeB').textContent=S.mode;
}
function renderAll(){renderTop();renderSide();renderMain()}
function poll(){
  fetch('/api/state').then(function(r){return r.json()}).then(function(d){
    S=d; $('conn').textContent='● Bağlı'; renderAll();
  }).catch(function(){ $('conn').textContent='Bağlantı yok'; });
}
setInterval(poll,3000); poll();
</script>
</body></html>`;

// ============ HTTP ============
const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    try {
        if (u.pathname === '/health') {
            res.writeHead(200, {'Content-Type':'application/json'});
            return res.end(JSON.stringify({ok:true, universe:universe.length, formations:Object.keys(struct).length, gate:GATE?{long:GATE.long, short:GATE.short}:null, brk:brkEvents.length, tr:trendSignals.length}));
        }
        if (u.pathname === '/api/state') {
            res.writeHead(200, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
            return res.end(JSON.stringify(apiState()));
        }
        if (u.pathname === '/' || u.pathname === '/index.html') {
            res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
            return res.end(HTML);
        }
        res.writeHead(404); res.end('yok');
    } catch(e) { res.writeHead(500); res.end(String(e.message)); }
});

// ============ BAŞLAT ============
async function main() {
    try {
        log('başlatılıyor…');
        await ex.loadMarkets();
        await refreshUniverse();
        await updateGate();
        loadState();
        setInterval(refreshUniverse, PRESCAN_INTERVAL);
        setInterval(refreshTickers, 5000);
        setInterval(updateGate, 30e3);
        setInterval(runScan, SCAN_INTERVAL);
        setInterval(liveTick, LIVE_INTERVAL);
        setInterval(trendTick, TREND_INTERVAL);
        setInterval(track, 20e3);
        setInterval(saveState, 15e3);
        runScan().then(() => { log('HAZIR • ' + universe.length + ' coin • ' + Object.keys(struct).length + ' formasyon'); });
    } catch(e) { log('başlatma hata', e.message); setTimeout(main, 30000); }
}
process.on('SIGTERM', () => { dirty = true; saveState(); process.exit(0); });
process.on('SIGINT', () => { dirty = true; saveState(); process.exit(0); });

server.listen(PORT, '0.0.0.0', () => {
    log('PORT ' + PORT + ' • v36 • Üçgen + Trend');
    main();
});
