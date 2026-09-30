// ======================= (HTML devamı — renderMain'den itibaren) =======================
 if(sel&&sel.id){const s=S.signals.find(x=>x.id===sel.id);if(s){M.innerHTML=sigView(s);bindCalc();
   if(chartCache[ckey(s.symbol)])drawChart(chartCache[ckey(s.symbol)],s);
   if(chartFor!==ckey(s.symbol)){chartFor=ckey(s.symbol);loadChart(s.symbol)}return}}
 if(sel&&sel.sym){const r=S.radar.find(x=>x.symbol===sel.sym);
  M.innerHTML='<div class="r1" style="margin-bottom:8px"><h2 style="margin:0">'+esc(sel.sym.split('/')[0])+'</h2>'
   +(r?'<span class="tag w">'+esc(r.state)+'</span>'+strTag(r.strength||0)+volTag(r.volX||0):'')
   +'<a class="btn tv" style="margin-left:auto" href="https://www.tradingview.com/chart/?symbol=BITGET:'+sel.sym.split('/')[0]+'USDT.P&interval=15" target="_blank">📈 TradingView</a></div>'
   +tfBar()+'<canvas id="cv"></canvas>'+calcBox('','');
  bindCalc();
  if(chartCache[ckey(sel.sym)])drawChart(chartCache[ckey(sel.sym)],null);
  if(chartFor!==ckey(sel.sym)){chartFor=ckey(sel.sym);loadChart(sel.sym)}return}
 M.innerHTML=homeView()}
function renderAll(){renderTop();renderTabs();renderList();renderMain()}
function poll(){
 fetch('/api/state').then(r=>r.json()).then(d=>{
  S=d;checkNew();$('dot').className='dot on';$('conn').textContent='Bağlı';
  const t=document.activeElement&&document.activeElement.tagName;
  if(t==='INPUT'||t==='SELECT'){renderTop();renderTabs();renderList()}else renderAll()
 }).catch(()=>{$('dot').className='dot off';$('conn').textContent='Bağlantı yok'})}
addEventListener('resize',()=>{if(S)renderMain()});
setInterval(poll,3000);setInterval(()=>{if(sel&&sel.sym)loadChart(sel.sym)},15000);poll();pollBt();
</script></body></html>`;

// ======================= HTTP =======================
const json = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
};
const readBody = req => new Promise(r => {
    let b = ''; req.on('data', d => { b += d; if (b.length > 1e5) { r({}); req.destroy(); } });
    req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch (e) { r({}); } });
    req.on('error', () => r({}));
});
const authed = u => !ADMIN_KEY || u.searchParams.get('key') === ADMIN_KEY;

const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    try {
        if (u.pathname === '/' || u.pathname === '/index.html') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            return res.end(HTML);
        }
        if (u.pathname === '/health') return json(res, 200, {
            ok: true, version: 'v17', lastScan: scan.last, lastLive: live.last,
            universe: universe.length, signals: signals.length,
            tpOn: CFG.ENABLE_TP, tpOpen: signals.filter(s => isOpen(s) && s.setup === 'TP').length,
            lvOpen: signals.filter(s => isOpen(s) && s.setup === 'LV').length
        });
        if (u.pathname === '/api/state') return json(res, 200, apiState());
        if (u.pathname === '/api/candles') return json(res, 200, await apiCandles(u.searchParams.get('symbol') || '', u.searchParams.get('tf')));
        if (u.pathname === '/api/backtest' && req.method === 'GET') return json(res, 200, btJob);
        if (u.pathname === '/api/backtest' && req.method === 'POST') {
            if (!authed(u)) return json(res, 401, { error: 'yetkisiz' });
            const b = await readBody(req);
            const days = [30, 60, 90].includes(b.days) ? b.days : 90;
            const coins = [50, 100, 150, 250].includes(b.coins) ? b.coins : 100;
            const costMult = [1, 1.5, 2].includes(b.costMult) ? b.costMult : 1;
            if (!btJob.running) runBacktest(days, coins, { costMult });
            return json(res, 200, { started: true });
        }
        if (u.pathname === '/api/reset' && req.method === 'POST') {
            if (!authed(u)) return json(res, 401, { error: 'yetkisiz' });
            signals = []; lastSig = {}; dirty = true; saveState();
            return json(res, 200, { ok: true });
        }
        json(res, 404, { error: 'yok' });
    } catch (e) { json(res, 500, { error: e.message }); }
});

// ======================= BAŞLAT =======================
async function start() {
    try {
        loadState();
        await ex.loadMarkets(); log('marketler:', Object.keys(ex.markets).length);
        await refreshUniverse(); log('evren:', universe.length, 'coin');
        setInterval(refreshUniverse, CFG.UNIVERSE_MS);

        // pozisyon takibi (1m) — 15 sn'de bir
        setInterval(track, 15e3);

        // canlı üçgen motoru
        if (CFG.ENABLE_LIVE) setInterval(liveTick, CFG.LIVE_MS);
        else setInterval(refreshTickers, 15e3);

        // state kaydı
        setInterval(saveState, 15e3);

        // üçgen tarama: her 15m mum kapanışında (küçük gecikmeyle)
        lastScanSlot = Math.floor((Date.now() - CFG.SCAN_DELAY_MS) / M15);
        runScan();
        setInterval(() => {
            const slot = Math.floor((Date.now() - CFG.SCAN_DELAY_MS) / M15);
            if (slot > lastScanSlot && !scan.running) { lastScanSlot = slot; runScan(); }
        }, 3000);

        // TREND PULLBACK tarama: her 15m kapanışında (üçgenden ~30 sn sonra)
        if (CFG.ENABLE_TP) {
            setInterval(() => {
                const now = Date.now();
                // mum kapanışından 20-90 sn sonra bir kez çalıştır
                const msSinceClose = now % M15;
                if (msSinceClose < 20e3 || msSinceClose > 50e3) return;
                const slotKey = Math.floor(now / M15);
                if (start._tpSlot === slotKey) return;
                start._tpSlot = slotKey;
                scanTP().catch(e => log('TP tarama hata', e.message));
            }, 10e3);
        }

        log('SONER TRADE v17 hazır | üçgen ' + TRI.AGG + 'H | LV hacim ≥ ' + CFG.LV_VOL_SIG + 'x | TP ADX ≥ ' + CFG.TP_MIN_ADX + ' + hacim ≥ ' + CFG.TP_MIN_VOLX + 'x | mkt ' + CFG.MKT_MODE);
    } catch (e) {
        log('başlatma hatası', e.message);
        setTimeout(start, 30000);
    }
}

function shutdown() {
    dirty = true; saveState();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

if (require.main === module) {
    server.listen(PORT, '0.0.0.0', () => { log('PORT', PORT); start(); });
}

module.exports = {
    runScan, scanTP, track, refreshUniverse, apiState, liveTick, liveSignal, buildStruct,
    signalMsg, strengthScore, tpStrengthScore, tpSignal,
    grp, aggregateN, CFG, TRI
};
