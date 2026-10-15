const HTML = String.raw`<!DOCTYPE html>
<html lang="tr" class="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SONER TRADE v49 — Terminal</title>
<script src="https://cdn.tailwindcss.com"></script>
<script>
tailwind.config={darkMode:'class',theme:{extend:{colors:{
brand:{50:'#eef2ff',400:'#818cf8',500:'#6366f1',600:'#4f46e5',700:'#4338ca',900:'#312e81'},
dark:{bg:'#080b12',card:'#0e131d',panel:'#131926',border:'#1e2734',hover:'#1a2230',muted:'#7e8ca8'},
trade:{long:'#00e0a0',longBg:'rgba(0,224,160,0.10)',short:'#ff4d6d',shortBg:'rgba(255,77,109,0.10)',gold:'#ffb020',purple:'#a78bfa',blue:'#3b82f6'}
},fontFamily:{sans:['Inter','sans-serif'],mono:['JetBrains Mono','monospace']}}}};
</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
<style>
*{-webkit-tap-highlight-color:transparent}
body{background:#080b12;color:#f3f4f6;font-family:'Inter',sans-serif;overflow-x:hidden;font-variant-numeric:tabular-nums;letter-spacing:-.1px}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:#0e131d}
::-webkit-scrollbar-thumb{background:#1e2734;border-radius:4px}
::-webkit-scrollbar-thumb:hover{background:#2a3648}
.glass{background:rgba(19,25,38,.72);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border:1px solid rgba(255,255,255,.06)}
.glass-hover:hover{background:rgba(26,34,48,.9);border-color:rgba(99,102,241,.35)}
.glow-long{box-shadow:0 0 20px rgba(0,224,160,.15),inset 0 1px 0 rgba(255,255,255,.03)}
.glow-short{box-shadow:0 0 20px rgba(255,77,109,.15),inset 0 1px 0 rgba(255,255,255,.03)}
.glow-brand{box-shadow:0 0 24px rgba(99,102,241,.25)}
.chart-grid{background-size:24px 24px;background-image:linear-gradient(to right,rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(to bottom,rgba(255,255,255,.025) 1px,transparent 1px)}
canvas{display:block;width:100%;height:100%}
.tab-btn{transition:all .15s}
.tab-btn.a{background:linear-gradient(135deg,#4f46e5,#6366f1);color:#fff;box-shadow:0 6px 20px rgba(99,102,241,.35)}
.sig-row{transition:all .15s;cursor:pointer;border-left:3px solid transparent}
.sig-row:hover{background:rgba(26,34,48,.6)}
.sig-row.sel{background:rgba(99,102,241,.08);border-left-color:#6366f1}
.sig-row.L{border-left-color:#00e0a0}
.sig-row.S{border-left-color:#ff4d6d}
.sig-row.closed{opacity:.55}
.sig-row.old{opacity:.78}
#toast{position:fixed;top:80px;right:20px;z-index:999;background:linear-gradient(135deg,rgba(19,25,38,.98),rgba(14,19,29,.98));border:1px solid #6366f1;color:#fff;padding:14px 20px;border-radius:12px;font-weight:600;font-size:13px;box-shadow:0 20px 60px rgba(0,0,0,.7),0 0 40px rgba(99,102,241,.25);display:none;cursor:pointer;max-width:360px;backdrop-filter:blur(16px);animation:slideIn .3s ease}
@keyframes slideIn{from{transform:translateX(40px);opacity:0}to{transform:translateX(0);opacity:1}}
.pulse-dot{animation:pulseDot 1.8s infinite}
@keyframes pulseDot{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.55;transform:scale(1.2)}}
.tile{background:linear-gradient(135deg,rgba(19,25,38,.9),rgba(14,19,29,.85));border:1px solid #1e2734;border-radius:14px;padding:14px 16px;transition:all .2s;position:relative;overflow:hidden}
.tile:hover{border-color:#2a3648;transform:translateY(-1px)}
.tile::after{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,rgba(99,102,241,.4),transparent);opacity:0;transition:opacity .2s}
.tile:hover::after{opacity:1}
</style>
</head>
<body class="min-h-screen flex flex-col antialiased">

<!-- HEADER -->
<header class="h-16 border-b border-dark-border bg-dark-card/90 backdrop-blur-xl sticky top-0 z-50 flex items-center justify-between px-4 lg:px-6 gap-3">
  <div class="flex items-center gap-3 min-w-0">
    <div class="w-9 h-9 rounded-xl bg-gradient-to-tr from-brand-600 to-indigo-400 flex items-center justify-center shadow-lg shadow-brand-500/30 shrink-0">
      <i class="fa-solid fa-chart-line text-white text-base"></i>
    </div>
    <div class="min-w-0">
      <div class="flex items-center gap-2">
        <span class="font-bold text-[15px] tracking-tight text-white whitespace-nowrap">SONER TRADE</span>
        <span id="modeB" class="px-2 py-0.5 text-[10px] font-bold rounded-full bg-brand-500/20 text-brand-400 border border-brand-500/30 whitespace-nowrap">v49</span>
      </div>
      <p class="text-[10px] text-dark-muted hidden sm:block">Algorithmic Momentum & Pattern Engine</p>
    </div>
  </div>

  <div class="hidden xl:flex items-center gap-2 text-xs" id="topStats">
    <div class="flex items-center gap-2 bg-dark-bg px-3 py-1.5 rounded-lg border border-dark-border" id="cReg"><span class="text-dark-muted">Piyasa:</span><span class="text-dark-muted">…</span></div>
    <div class="flex items-center gap-2 bg-dark-bg px-3 py-1.5 rounded-lg border border-dark-border" id="cBtcDir"><span class="text-dark-muted">BTC:</span><span class="text-dark-muted">…</span></div>
    <div class="flex items-center gap-2 bg-dark-bg px-3 py-1.5 rounded-lg border border-dark-border" id="cHealth"></div>
  </div>

  <div class="flex items-center gap-2">
    <div class="hidden md:flex items-center gap-3 text-xs font-mono bg-dark-bg px-3 py-1.5 rounded-lg border border-dark-border">
      <div id="cBTC"><span class="text-dark-muted">BTC:</span> <span class="text-dark-muted">…</span></div>
      <div class="w-px h-3 bg-dark-border"></div>
      <div id="cETH"><span class="text-dark-muted">ETH:</span> <span class="text-dark-muted">…</span></div>
    </div>
    <div class="px-3 py-1.5 rounded-lg bg-dark-bg border border-dark-border text-xs flex items-center gap-2">
      <span class="w-2 h-2 rounded-full bg-trade-short pulse-dot" id="dot"></span>
      <span id="conn" class="text-dark-muted">Bağlanıyor</span>
    </div>
  </div>
</header>

<!-- TAB NAV -->
<div class="border-b border-dark-border bg-dark-bg/60 backdrop-blur sticky top-16 z-40">
  <div class="max-w-[1920px] mx-auto px-4 lg:px-6 flex items-center gap-2 py-2 overflow-x-auto" id="tabs"></div>
</div>

<!-- MAIN -->
<main class="flex-1 p-4 lg:p-6 max-w-[1920px] mx-auto w-full" id="main-root">
  <div id="main"></div>
</main>

<!-- FOOTER -->
<footer class="border-t border-dark-border bg-dark-card/50 py-3 px-6 text-[11px] text-dark-muted flex flex-col sm:flex-row justify-between items-center gap-2 font-mono">
  <div>SONER TRADE v49 • Algorithmic Execution System</div>
  <div class="flex items-center gap-4">
    <span>Bitget Perpetual</span>
    <span class="w-2 h-2 rounded-full bg-trade-long pulse-dot"></span>
  </div>
</footer>

<div id="toast"></div>

<script>
var TABS=[{k:'sig',ico:'fa-bolt',lbl:'Trend'},{k:'rad',ico:'fa-draw-polygon',lbl:'Radar'},{k:'stat',ico:'fa-chart-simple',lbl:'İstatistik'},{k:'bt',ico:'fa-flask',lbl:'Backtest'}];
var KEY=new URLSearchParams(location.search).get('key')||'';
function api(p){return KEY?p+(p.indexOf('?')>=0?'&':'?')+'key='+encodeURIComponent(KEY):p}
var S=null,tab='sig',sel=null,tfSel=null,chartCache={},chartFor='',cfgC={bal:1000,risk:0.5},actx=null,lastSigT=0,lastTrT=0,toastT=null;
try{cfgC=JSON.parse(localStorage.getItem('st_calc')||'{"bal":1000,"risk":0.5}')}catch(e){}
function $(id){return document.getElementById(id)}
function fp(p){if(p==null||isNaN(p))return'—';p=Number(p);var a=Math.abs(p);return a>=1000?p.toFixed(2):a>=1?p.toFixed(4):a>=0.01?p.toFixed(5):p.toFixed(7)}
function f2(x,d){d=d==null?2:d;return x==null||isNaN(x)?'—':Number(x).toFixed(d)}
function sg(x,d){d=d==null?2:d;x=Number(x);if(isNaN(x))return'—';return(x>0?'+':'')+x.toFixed(d)}
function cl(x){return x>0?'text-trade-long':x<0?'text-trade-short':'text-dark-muted'}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])})}
function ago(ts){var m=Math.floor((Date.now()-ts)/60000);return m<1?'şimdi':m<60?m+' dk':Math.floor(m/60)+'s '+(m%60)+'dk'}
function isOp(x){return x.status==='OPEN'||x.status==='TP1'}
function FM(){return (S&&S.config&&S.config.freshMin)||10}
function isFresh(o){return o.status==='OPEN'&&(Date.now()-o.time)<((o.freshMin||FM()))*60e3}
function ageTag(o){if(!o||o.status!=='OPEN')return'';var m=Math.floor((Date.now()-o.time)/60000);
 if(m<(o.freshMin||FM()))return '<span class="px-2 py-0.5 rounded-md bg-trade-longBg text-trade-long border border-trade-long/30 text-[10px] font-bold font-mono"><i class="fa-solid fa-circle text-[6px] mr-1"></i>TAZE '+m+'dk</span>';
 return '<span class="px-2 py-0.5 rounded-md bg-trade-shortBg text-trade-short border border-trade-short/30 text-[10px] font-bold font-mono">'+ago(o.time)+' önce</span>'}
function stratTag(k){return k==='tr'?'<span class="px-2 py-0.5 rounded-md bg-trade-purple/15 text-trade-purple border border-trade-purple/30 text-[10px] font-bold">FLOW/CF</span>':k==='brk'?'<span class="px-2 py-0.5 rounded-md bg-brand-500/15 text-brand-400 border border-brand-500/30 text-[10px] font-bold">KIRILIM</span>':'<span class="px-2 py-0.5 rounded-md bg-dark-hover text-dark-muted border border-dark-border text-[10px] font-bold">RADAR</span>'}
function stratName(k,o){return k==='tr'?(o&&o.strategy==='FLOW'?'MOMENTUM FLOW '+((o.chartTf||'5m').toUpperCase()):'CONFLUENCE '+((o&&o.chartTf||'').toUpperCase())):k==='brk'?'ÜÇGEN KIRILIM':'ÜÇGEN RADAR'+(o&&o.broke?' • ONAYSIZ':'')}
function dirBadge(d){return d==='LONG'?'<span class="px-2 py-0.5 rounded-md bg-trade-longBg text-trade-long border border-trade-long/30 text-[10px] font-bold font-mono">▲ LONG</span>':'<span class="px-2 py-0.5 rounded-md bg-trade-shortBg text-trade-short border border-trade-short/30 text-[10px] font-bold font-mono">▼ SHORT</span>'}
var ST={OPEN:['AÇIK','amber'],TP1:['TP1 ✓','blue'],TP2:['TP2 ✓','long'],TRAIL:['TRAIL ✓','long'],BE:['BE','muted'],STOP:['STOP','short'],'SÜRE':['SÜRE','muted'],TIMEOUT:['SÜRE','muted'],EXPIRED:['SÜRESİ DOLDU','muted']};
function stTag(k){var v=ST[k]||[k||'?','muted'];var c={amber:'bg-amber-500/10 text-amber-400 border-amber-500/30',blue:'bg-blue-500/10 text-blue-400 border-blue-500/30',long:'bg-trade-longBg text-trade-long border-trade-long/30',short:'bg-trade-shortBg text-trade-short border-trade-short/30',muted:'bg-dark-hover text-dark-muted border-dark-border'}[v[1]];return '<span class="px-2 py-0.5 rounded-md '+c+' border text-[10px] font-bold font-mono">'+v[0]+'</span>'}
function beep(){try{actx=actx||new (window.AudioContext||window.webkitAudioContext)();var o=actx.createOscillator(),g=actx.createGain();o.connect(g);g.connect(actx.destination);o.frequency.value=880;g.gain.value=0.08;o.start();o.stop(actx.currentTime+0.3)}catch(e){}}
addEventListener('pointerdown',function(){try{actx=actx||new (window.AudioContext||window.webkitAudioContext)();if(actx.state==='suspended')actx.resume()}catch(e){}},{once:true});
function showToast(txt,fn){var t=$('toast');t.innerHTML=txt;t.style.display='block';t.onclick=function(){t.style.display='none';fn&&fn()};clearTimeout(toastT);toastT=setTimeout(function(){t.style.display='none'},25000)}
function pick(kind,id,sym){sel={kind:kind,id:id||'',sym:sym};tfSel=null;chartFor=''}

function checkBrk(){var a=S.breakouts||[],mx=a.reduce(function(m,x){return Math.max(m,x.time||0)},0);
 if(!lastSigT){lastSigT=mx||Date.now();return}
 var nw=a.filter(function(x){return x.time>lastSigT});if(mx>lastSigT)lastSigT=mx;
 if(nw.length){beep();setTimeout(beep,400);var e=nw[0];showToast('<i class="fa-solid fa-bell text-amber-400 mr-2"></i>KIRILIM '+e.dir+' <b>'+e.base+'</b> — GÜÇ %'+e.strength,function(){tab='rad';pick('brk',e.id,e.symbol);renderAll()})}}
function checkTr(){var a=S.tr||[],nt=(S.trInfo||{}).notify||0,mx=a.reduce(function(m,x){return Math.max(m,x.time||0)},0);
 if(!lastTrT){lastTrT=mx||Date.now();return}
 var nw=a.filter(function(x){return x.time>lastTrT&&x.score>=nt});if(mx>lastTrT)lastTrT=mx;
 if(nw.length){beep();setTimeout(beep,400);var s=nw[0];showToast('<i class="fa-solid fa-bolt text-trade-gold mr-2"></i>'+(s.strategy==='FLOW'?'MOMENTUM':'CONFLUENCE')+' '+s.dir+' <b>'+s.base+'</b> — PUAN %'+s.score,function(){tab='sig';pick('tr',s.id,s.symbol);renderAll()})}}

function posInfo(o){if(!o||o.entry==null||!o.riskAbs)return null;
 var L=o.dir==='LONG'?1:-1,px=(S.px&&S.px[o.symbol])||o.lastPrice||o.entry,open=isOp(o),fin=!open&&o.netR!=null;
 var raw=L*(px-o.entry)/o.riskAbs,rawPct=L*(px-o.entry)/o.entry*100,t1=o.tp1R||((S.brkInfo&&S.brkInfo.tp1)||1),rp=o.riskPct||0,r,pct;
 if(fin){r=o.netR;pct=(o.grossR!=null?o.grossR:o.netR)*rp}
 else if(o.status==='TP1'){r=0.5*t1+0.5*raw;pct=0.5*t1*rp+0.5*rawPct}
 else{r=raw;pct=rawPct}
 return{L:L,px:px,open:open,fin:fin,r:r,pct:pct,levels:{entry:o.entry,stop:o.stop,tp1:o.tp1,tp2:o.tp2,t:o.time}}}

/* TOP */
function renderTop(){var m=S.market,R=S.regime;
 if(!R){$('cBtcDir').innerHTML='<span class="text-dark-muted">BTC:</span> <span class="text-dark-muted">…</span>';$('cReg').innerHTML='<span class="text-dark-muted">Piyasa:</span> <span class="text-dark-muted">…</span>'}
 else{
  var bc=R.btcDir==='LONG'?'text-trade-long':R.btcDir==='SHORT'?'text-trade-short':'text-dark-muted';
  $('cBtcDir').innerHTML='<span class="text-dark-muted">BTC:</span> <span class="'+bc+' font-bold">'+R.btcDir+' <span class="font-mono">'+sg(R.btcScore||0,0)+'</span></span>';
  var rc=R.dir==='LONG'?'text-trade-long':R.dir==='SHORT'?'text-trade-short':'text-dark-muted';
  $('cReg').innerHTML='<span class="text-dark-muted">Piyasa:</span> <span class="'+rc+' font-bold">'+R.dir+' <span class="font-mono">'+sg(R.score,0)+'</span></span><span class="text-dark-muted text-[10px] ml-1">'+R.regime+'</span>';
 }
 $('cBTC').innerHTML=m.btc?'<span class="text-dark-muted">BTC:</span> <span class="text-white font-semibold">'+fp(m.btc.price)+'</span> <span class="'+cl(m.btc.chg)+' text-[10px] ml-1">'+sg(m.btc.chg)+'%</span>':'';
 $('cETH').innerHTML=m.eth?'<span class="text-dark-muted">ETH:</span> <span class="text-white font-semibold">'+fp(m.eth.price)+'</span> <span class="'+cl(m.eth.chg)+' text-[10px] ml-1">'+sg(m.eth.chg)+'%</span>':'';
 var A=(S.trStats&&S.trStats.today)||{totalR:0,n:0};var B=(S.brkStats&&S.brkStats.today)||{totalR:0,n:0};
 $('cHealth').innerHTML='<span class="text-dark-muted">24s:</span> <span class="'+cl(A.totalR)+' font-bold font-mono">'+sg(A.totalR,1)+'R</span> <span class="text-dark-border">|</span> <span class="'+cl(B.totalR)+' font-mono">'+sg(B.totalR,1)+'R</span>';
 $('modeB').textContent=(S.mode||'v49').split('•')[0].trim()}

/* TABS */
function renderTabs(){
 var oc=(S.tr||[]).filter(isFresh).length,nb=(S.breakouts||[]).filter(isFresh).length;
 $('tabs').innerHTML=TABS.map(function(t){
  var cnt=t.k==='sig'&&oc?oc:t.k==='rad'&&nb?nb:0;
  return '<button class="tab-btn'+(tab===t.k?' a':'')+' px-4 py-2 rounded-lg text-xs font-bold text-dark-muted flex items-center gap-2 whitespace-nowrap" data-t="'+t.k+'"><i class="fa-solid '+t.ico+'"></i>'+t.lbl+(cnt?'<span class="px-1.5 py-0.5 rounded-md bg-white/15 text-[10px] font-mono">'+cnt+'</span>':'')+'</button>'
 }).join('');
 Array.prototype.forEach.call($('tabs').children,function(b){b.onclick=function(){tab=b.dataset.t;if(tab!=='stat'&&tab!=='bt')sel=null;if(tab==='bt')pollBT();renderAll()}})}

/* TILE */
function tile(lab,val,extra,cls){return '<div class="tile"><div class="text-[11px] text-dark-muted font-semibold uppercase tracking-wider">'+lab+'</div><div class="text-2xl font-bold font-mono mt-1.5 '+(cls||'text-white')+'">'+val+'</div>'+(extra?'<div class="mt-2 text-[11px]">'+extra+'</div>':'')+'</div>'}

/* SIGNAL CARD ROW */
function sigRow(s){var L=s.dir==='LONG'?1:-1,op=isOp(s),old=op&&!isFresh(s);
 var P=posInfo(s),r=P?P.r:0,pct=P?P.pct:0;var pxc=(S.px&&S.px[s.symbol])||s.lastPrice||s.entry;
 var rTxt=P?sg(r)+'R':'—',rCls=!P?'text-dark-muted':r>0.005?'text-trade-long':r<-0.005?'text-trade-short':'text-dark-muted';
 var selc=(sel&&sel.kind==='tr'&&sel.id===s.id?' sel':'')+(op?'':' closed')+(old?' old':'')+(L===1?' L':' S');
 return '<div class="sig-row '+selc+'" data-kind="tr" data-id="'+esc(s.id)+'" data-sym="'+esc(s.symbol)+'">'+
  '<div class="grid grid-cols-12 gap-3 px-4 py-3 items-center">'+
   '<div class="col-span-3 flex items-center gap-2 min-w-0"><span class="w-1.5 h-1.5 rounded-full '+(L===1?'bg-trade-long':'bg-trade-short')+' shrink-0"></span><div class="min-w-0"><div class="font-bold text-white text-sm truncate">'+esc(s.base)+'</div><div class="text-[10px] text-dark-muted font-mono">'+(s.strategy==='FLOW'?'FLOW '+f2(s.volX,1)+'x':'CF '+(s.passes||0)+'/5')+'</div></div></div>'+
   '<div class="col-span-2">'+dirBadge(s.dir)+'</div>'+
   '<div class="col-span-2 text-xs font-mono text-gray-200 truncate">'+fp(s.entry)+'</div>'+
   '<div class="col-span-2 text-xs font-mono text-dark-muted truncate"><span class="text-trade-short">'+fp(s.stop)+'</span> / <span class="text-trade-long">'+fp(s.tp1)+'</span></div>'+
   '<div class="col-span-1">'+stTag(s.status)+'</div>'+
   '<div class="col-span-2 text-right font-mono font-bold '+rCls+'">'+rTxt+(P&&P.pct!=null?'<div class="text-[10px] '+cl(pct)+' font-normal">'+sg(pct)+'%</div>':'')+'</div>'+
  '</div></div>'}

function radRow(r){var L=r.bias==='LONG'?1:-1;
 var P=(r.broke&&r.entry!=null)?posInfo(r):null;
 var pxc=fp(r.price),st=r.broke?'<span class="px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-400 border border-amber-500/30 text-[10px] font-bold">KIRILDI</span>':'<span class="px-2 py-0.5 rounded-md bg-dark-hover text-dark-muted border border-dark-border text-[10px] font-bold">HAZIR</span>';
 var str=r.strength>=75?'text-trade-long':r.strength>=55?'text-trade-long/80':'text-trade-gold';
 return '<div class="sig-row '+(L===1?'L':'S')+(sel&&sel.kind==='rad'&&sel.sym===r.symbol?' sel':'')+'" data-kind="rad" data-id="" data-sym="'+esc(r.symbol)+'"><div class="grid grid-cols-12 gap-3 px-4 py-3 items-center">'+
  '<div class="col-span-3 flex items-center gap-2"><span class="w-1.5 h-1.5 rounded-full '+(L===1?'bg-trade-long':'bg-trade-short')+'"></span><div><div class="font-bold text-white text-sm">'+esc(r.base)+'</div><div class="text-[10px] text-dark-muted font-mono">'+esc(r.type||'üçgen')+'</div></div></div>'+
  '<div class="col-span-2">'+dirBadge(r.bias)+'</div>'+
  '<div class="col-span-2 text-xs font-mono text-gray-200">'+pxc+'</div>'+
  '<div class="col-span-3 text-[11px] text-dark-muted">'+esc(r.state||'').slice(0,40)+'</div>'+
  '<div class="col-span-1">'+st+'</div>'+
  '<div class="col-span-1 text-right font-mono font-bold '+str+'">%'+r.strength+'</div></div></div>'}

function shRow(s){var L=s.dir==='LONG'?1:-1,op=isOp(s);var px=(S.px&&S.px[s.symbol])||s.entry;var r=op?L*(px-s.entry)/s.riskAbs:(s.netR||0);
 var fails=(s.fails||[]).join('+')||'—';
 return '<div class="sig-row '+(L===1?'L':'S')+'" style="opacity:.55" data-sym="'+esc(s.symbol)+'"><div class="grid grid-cols-12 gap-3 px-4 py-2 items-center">'+
  '<div class="col-span-3 flex items-center gap-2"><span class="text-[10px]">👻</span><div><div class="font-bold text-white text-xs">'+esc(s.base)+'</div><div class="text-[9px] text-dark-muted font-mono">GÖLGE</div></div></div>'+
  '<div class="col-span-2">'+dirBadge(s.dir)+'</div>'+
  '<div class="col-span-3 text-[10px] text-dark-muted font-mono">eksik: '+esc(fails)+'</div>'+
  '<div class="col-span-2">'+stTag(s.status)+'</div>'+
  '<div class="col-span-2 text-right font-mono font-bold '+cl(r)+'">'+sg(r)+'R</div></div></div>'}

/* TABLE / LIST PANEL */
function renderListPanel(){
 var tr=(S.tr||[]).filter(isOp),ac=(S.tr||[]).filter(function(x){return !isOp(x)});
 var fr=tr.filter(isFresh),od=tr.filter(function(x){return !isFresh(x)});
 var ev=S.breakouts||[],rd=S.radar||[],fo=S.forming||[];
 var brk=rd.filter(function(x){return x.broke}),near=rd.filter(function(x){return !x.broke});
 var fresh=ev.filter(isFresh),oldB=ev.filter(function(x){return isOp(x)&&!isFresh(x)}),closedB=ev.filter(function(x){return !isOp(x)});
 var ti=S.trInfo||{},fd=ti.flow;
 var funnel=fd&&fd.funnel?'<div class="glass rounded-xl p-3 mb-3 text-[11px] font-mono"><div class="text-dark-muted mb-1.5"><b class="text-white">Son FLOW huni</b> (5m)</div><div class="grid grid-cols-4 gap-1.5 text-center">'+
  '<div><div class="text-trade-gold font-bold">'+fd.checked+'</div><div class="text-[9px] text-dark-muted">kontrol</div></div>'+
  '<div><div class="text-white font-bold">'+fd.funnel.brk+'</div><div class="text-[9px] text-dark-muted">kırılım</div></div>'+
  '<div><div class="text-white font-bold">'+fd.funnel.plan+'</div><div class="text-[9px] text-dark-muted">plan</div></div>'+
  '<div><div class="text-trade-long font-bold">'+fd.funnel.signal+'</div><div class="text-[9px] text-dark-muted">sinyal</div></div></div>'+
  '<div class="mt-2 text-[10px] text-dark-muted">elenen: '+esc(JSON.stringify(fd.skipped||{}))+' • gölge: <span class="text-trade-gold">'+(fd.shadow||0)+'</span></div></div>':'';
 var html='';
 if(tab==='sig'){
  html+=funnel;
  if(fr.length)html+='<div class="text-[10px] text-dark-muted font-bold uppercase tracking-wider px-3 py-2">🟢 Taze — giriş açık ('+fr.length+')</div>'+fr.map(sigRow).join('');
  if(od.length)html+='<div class="text-[10px] text-dark-muted font-bold uppercase tracking-wider px-3 py-2">⏳ Açık / TP1 — takip ('+od.length+')</div>'+od.map(sigRow).join('');
  if(ac.length)html+='<div class="text-[10px] text-dark-muted font-bold uppercase tracking-wider px-3 py-2">Kapananlar ('+Math.min(20,ac.length)+'/'+ac.length+')</div>'+ac.slice(0,20).map(sigRow).join('');
  var shA=(S.flowShadow||[]).filter(isOp);
  if(shA.length)html+='<div class="text-[10px] text-dark-muted font-bold uppercase tracking-wider px-3 py-2">👻 Gölge açık ('+shA.length+')</div>'+shA.slice(0,8).map(shRow).join('');
  if(!tr.length&&!ac.length&&!shA.length)html='<div class="text-center text-dark-muted py-12 text-xs">Henüz Momentum Flow sinyali yok.<br>OI + hacim + fitil + boşluk koşulları sağlanınca sinyal oluşur.</div>';
 } else if(tab==='rad'){
  var triTf=((S.tri||{}).tf||'2h').toUpperCase();
  html+='<div class="glass rounded-xl p-3 mb-3 text-[11px] text-dark-muted">△ Üçgen (<b class="text-white">'+triTf+'</b>) • yapı: <b class="text-white">'+((S.tri||{}).structs||0)+'</b> • radarda <b class="text-white">'+rd.length+'</b> • onaylı: <b class="text-trade-long">'+ev.length+'</b></div>';
  if(fresh.length)html+='<div class="text-[10px] text-dark-muted font-bold uppercase tracking-wider px-3 py-2">🟢 Taze kırılım ('+fresh.length+')</div>'+fresh.map(brkRow).join('');
  if(oldB.length)html+='<div class="text-[10px] text-dark-muted font-bold uppercase tracking-wider px-3 py-2">⏳ Eski kırılım ('+oldB.length+')</div>'+oldB.map(brkRow).join('');
  if(brk.length)html+='<div class="text-[10px] text-dark-muted font-bold uppercase tracking-wider px-3 py-2">Çizgiyi aşanlar — onaysız ('+brk.length+')</div>'+brk.map(radRow).join('');
  if(near.length)html+='<div class="text-[10px] text-dark-muted font-bold uppercase tracking-wider px-3 py-2">Çizgiye yaklaşanlar ('+near.length+')</div>'+near.map(radRow).join('');
  if(fo.length)html+='<div class="text-[10px] text-dark-muted font-bold uppercase tracking-wider px-3 py-2">Oluşan üçgenler ('+fo.length+')</div>'+fo.map(function(x){return '<div class="sig-row" data-sym="'+esc(x.symbol)+'"><div class="grid grid-cols-12 gap-2 px-4 py-2 items-center"><div class="col-span-3 font-bold text-white text-xs">'+esc(x.base)+'</div><div class="col-span-3 text-[10px] text-dark-muted">'+esc(x.type)+'</div><div class="col-span-2 font-mono text-[10px] text-dark-muted">üst '+f2(x.toUp,2)+'ATR</div><div class="col-span-2 font-mono text-[10px] text-dark-muted">alt '+f2(x.toDn,2)+'ATR</div><div class="col-span-2 text-right text-[10px] text-dark-muted">'+x.touches+' dokunuş</div></div></div>'}).join('');
  if(closedB.length)html+='<div class="text-[10px] text-dark-muted font-bold uppercase tracking-wider px-3 py-2">Kapanan kırılım</div>'+closedB.slice(0,12).map(brkRow).join('');
  if(!rd.length&&!ev.length&&!fo.length)html='<div class="text-center text-dark-muted py-12 text-xs">Yaklaşan yok.</div>';
 } else html='<div class="text-center text-dark-muted py-12 text-xs">Sağ panelde detaylar.</div>';
 $('listPanel').innerHTML=html;
 Array.prototype.forEach.call($('listPanel').querySelectorAll('.sig-row'),function(e){if(!e.dataset.kind)return;e.onclick=function(){pick(e.dataset.kind,e.dataset.id,e.dataset.sym);renderListPanel();renderMain()}})}
function brkRow(e){var L=e.dir==='LONG'?1:-1,op=isOp(e);var P=posInfo(e);var r=P?P.r:0;
 var selc=(sel&&sel.kind==='brk'&&sel.id===e.id?' sel':'')+(op?'':' closed')+(L===1?' L':' S');
 return '<div class="sig-row '+selc+'" data-kind="brk" data-id="'+esc(e.id)+'" data-sym="'+esc(e.symbol)+'"><div class="grid grid-cols-12 gap-3 px-4 py-3 items-center">'+
  '<div class="col-span-3 flex items-center gap-2"><span class="w-1.5 h-1.5 rounded-full '+(L===1?'bg-trade-long':'bg-trade-short')+'"></span><div><div class="font-bold text-white text-sm">'+esc(e.base)+'</div><div class="text-[10px] text-dark-muted font-mono">'+esc(e.type||'')+'</div></div></div>'+
  '<div class="col-span-2">'+dirBadge(e.dir)+'</div>'+
  '<div class="col-span-2 text-xs font-mono text-gray-200">'+fp(e.entry)+'</div>'+
  '<div class="col-span-2 text-xs font-mono text-dark-muted"><span class="text-trade-short">'+fp(e.stop)+'</span> / <span class="text-trade-long">'+fp(e.tp1)+'</span></div>'+
  '<div class="col-span-1">'+stTag(e.status)+'</div>'+
  '<div class="col-span-2 text-right font-mono font-bold '+cl(r)+'">'+(op||e.netR!=null?sg(r)+'R':'—')+'</div></div></div>'}

/* CHART DRAW */
function drawChart(d,V,cid){var c=$(cid);if(!c||!d||!d.c.length)return;var W=c.clientWidth,H=c.clientHeight,dp=window.devicePixelRatio||1;if(c.width!==Math.round(W*dp)||c.height!==Math.round(H*dp)){c.width=Math.round(W*dp);c.height=Math.round(H*dp)}
 var x=c.getContext('2d');x.setTransform(dp,0,0,dp,0,0);x.clearRect(0,0,W,H);
 var lv=V&&V.levels,tri=d.tri,nc=d.c.length,n=nc+(tri?15:4);
 var L=8,R=112,T=42,B=18,volH=56,PW=W-L-R,PH=H-T-B-volH-8;
 var ti=function(t){return (t-d.c[0][0])/d.dur};var px=(V&&V.px!=null)?V.px:d.c[nc-1][4];
 var hi=-1e99,lo=1e99;d.c.forEach(function(k){hi=Math.max(hi,k[2]);lo=Math.min(lo,k[3])});hi=Math.max(hi,px);lo=Math.min(lo,px);
 if(lv)[lv.entry,lv.stop,lv.tp1,lv.tp2].forEach(function(q){if(q==null)return;var v=Number(q);if(isFinite(v)){hi=Math.max(hi,v);lo=Math.min(lo,v)}});
 var tl=[];if(tri)[tri.res,tri.sup].forEach(function(l){var a=ti(l[0][0]),b=ti(l[1][0]),m=(l[1][1]-l[0][1])/((b-a)||1),xa=Math.max(a,0);tl.push([a,l[0][1],b,l[1][1]]);[xa,b].forEach(function(q){var v=l[0][1]+m*(q-a);hi=Math.max(hi,v);lo=Math.min(lo,v)})});
 var pad=(hi-lo)*.07;hi+=pad;lo-=pad;
 var Y=function(p){return T+(hi-p)/(hi-lo)*PH},X=function(k){return L+(k+.5)/n*PW},cw=Math.max(2,PW/n*.7);
 var labs=[];if(lv){labs.push({p:lv.entry,col:'#ffb020',t:V.virtual?'ÇİZGİ':'GİRİŞ'});labs.push({p:lv.stop,col:'#ff4d6d',t:'STOP'});if(lv.tp1!=null)labs.push({p:lv.tp1,col:'#00e0a0',t:lv.tp2!=null?'TP1':'TP'});if(lv.tp2!=null)labs.push({p:lv.tp2,col:'#3b82f6',t:'TP2'})}
 labs.push({p:px,col:'#f3f4f6',t:'',cur:1});labs.forEach(function(l){l.y=Y(l.p);l.yy=l.y});labs.sort(function(a,b){return a.y-b.y});for(var i=1;i<labs.length;i++){if(labs[i].yy-labs[i-1].yy<16)labs[i].yy=labs[i-1].yy+16}
 var si=-1;if(lv&&lv.t){si=Math.floor(ti(lv.t));if(si<0||si>=nc)si=-1}
 if(lv){var zx=si>=0?X(si):L,zw=W-R-zx,ye=Y(lv.entry),ys=Y(lv.stop),far=lv.tp2!=null?lv.tp2:lv.tp1,yt=far!=null?Y(far):ye;x.fillStyle='rgba(255,77,109,.10)';x.fillRect(zx,Math.min(ye,ys),zw,Math.abs(ys-ye));x.fillStyle='rgba(0,224,160,.10)';x.fillRect(zx,Math.min(ye,yt),zw,Math.abs(yt-ye))}
 x.font='10px JetBrains Mono,monospace';for(var g=0;g<=5;g++){var gy=T+PH*g/5,gp=hi-(hi-lo)*g/5;x.strokeStyle='rgba(255,255,255,.04)';x.lineWidth=1;x.beginPath();x.moveTo(L,gy);x.lineTo(W-R,gy);x.stroke();var near=labs.some(function(l){return Math.abs(l.yy-gy)<10});if(!near){x.fillStyle='#7e8ca8';x.fillText(fp(gp),W-R+8,gy+3)}}
 var line=function(arr,col,w){if(!arr)return;x.strokeStyle=col;x.lineWidth=w;x.beginPath();var st=false;arr.forEach(function(v,k){if(v==null)return;st?x.lineTo(X(k),Y(v)):(x.moveTo(X(k),Y(v)),st=true)});x.stroke()};line(d.e50,'#a78bfa',1.1);line(d.e21,'#3b82f6',1.1);
 d.c.forEach(function(k,i){var up=k[4]>=k[1],col=up?'#00e0a0':'#ff4d6d';x.strokeStyle=col;x.fillStyle=col;x.lineWidth=1;x.beginPath();x.moveTo(X(i),Y(k[2]));x.lineTo(X(i),Y(k[3]));x.stroke();x.fillRect(X(i)-cw/2,Math.min(Y(k[1]),Y(k[4])),cw,Math.max(1,Math.abs(Y(k[4])-Y(k[1]))))});
 var vmax=Math.max.apply(null,d.c.map(function(k){return k[5]}))||1,vTop=T+PH+8;x.strokeStyle='rgba(255,255,255,.06)';x.beginPath();x.moveTo(L,vTop);x.lineTo(W-R,vTop);x.stroke();d.c.forEach(function(k,i){var col=k[4]>=k[1]?'#00e0a0':'#ff4d6d',h=(k[5]/vmax)*(volH-4);x.fillStyle=col;x.globalAlpha=0.5;x.fillRect(X(i)-cw/2,vTop+volH-h,cw,h);x.globalAlpha=1});
 if(d.vsma){x.strokeStyle='#ffb020';x.lineWidth=1.1;x.beginPath();var s2=false;d.vsma.forEach(function(v,k){if(v==null)return;var y=vTop+volH-(v/vmax)*(volH-4);s2?x.lineTo(X(k),y):(x.moveTo(X(k),y),s2=true)});x.stroke()}
 if(tri){x.save();x.beginPath();x.rect(L,T,PW,PH);x.clip();tl.forEach(function(l){x.strokeStyle='rgba(255,176,32,.75)';x.lineWidth=1.6;x.beginPath();x.moveTo(X(l[0]),Y(l[1]));x.lineTo(X(l[2]),Y(l[3]));x.stroke()});x.fillStyle='rgba(255,176,32,.9)';tri.hi.concat(tri.lo).forEach(function(p){x.beginPath();x.arc(X(ti(p[0])),Y(p[1]),2.5,0,7);x.fill()});x.restore()}
 x.save();x.beginPath();x.rect(L,T,W-R-L,PH);x.clip();labs.forEach(function(l){if(l.cur)return;x.strokeStyle=l.col;x.lineWidth=1.2;x.globalAlpha=.8;x.setLineDash([6,4]);x.beginPath();x.moveTo(L,l.y);x.lineTo(W-R,l.y);x.stroke();x.setLineDash([]);x.globalAlpha=1});x.restore();
 if(si>=0){var kk=d.c[si],isL=V.dir==='LONG',mx=X(si);x.strokeStyle='rgba(255,176,32,.45)';x.lineWidth=1;x.setLineDash([2,3]);x.beginPath();x.moveTo(mx,T);x.lineTo(mx,T+PH);x.stroke();x.setLineDash([]);x.fillStyle=isL?'#00e0a0':'#ff4d6d';x.beginPath();if(isL){var y0=Y(kk[3])+5;x.moveTo(mx,y0);x.lineTo(mx-8,y0+14);x.lineTo(mx+8,y0+14)}else{var y1=Y(kk[2])-5;x.moveTo(mx,y1);x.lineTo(mx-8,y1-14);x.lineTo(mx+8,y1-14)}x.closePath();x.fill();x.fillStyle='#f3f4f6';x.font='bold 10px JetBrains Mono,monospace';x.fillText('GİRİŞ',mx+10,isL?Y(kk[3])+18:Y(kk[2])-8)}
 x.strokeStyle='rgba(255,255,255,.5)';x.lineWidth=1;x.setLineDash([1,3]);x.beginPath();x.moveTo(L,Y(px));x.lineTo(W-R,Y(px));x.stroke();x.setLineDash([]);
 labs.forEach(function(l){var y=Math.max(T-4,Math.min(T+PH+4,l.yy)),txt=(l.t?l.t+' ':'')+fp(l.p);x.fillStyle=l.col;x.fillRect(W-R+2,y-8,R-4,16);x.fillStyle='#080b12';x.font='bold 10px JetBrains Mono,monospace';x.fillText(txt,W-R+6,y+3.5)});
 x.fillStyle='#7e8ca8';x.font='10px JetBrains Mono,monospace';var stp=Math.max(1,Math.ceil(nc/7));for(var q=0;q<nc;q+=stp){var dt=new Date(d.c[q][0]),hh=('0'+dt.getHours()).slice(-2)+':'+('0'+dt.getMinutes()).slice(-2);x.fillText(hh,X(q)-12,H-5)}
 x.font='10px JetBrains Mono,monospace';x.fillStyle='#3b82f6';x.fillRect(L+6,T+6,10,3);x.fillStyle='#7e8ca8';x.fillText('EMA21',L+20,T+10);
 x.fillStyle='#a78bfa';x.fillRect(L+62,T+6,10,3);x.fillStyle='#7e8ca8';x.fillText('EMA50',L+76,T+10);
 x.fillStyle='#7e8ca8';x.fillText(d.tf,L+118,T+10);
 if(V&&V.dir){var isLg=V.dir==='LONG';x.fillStyle=isLg?'#00e0a0':'#ff4d6d';x.fillRect(8,7,92,24);x.fillStyle='#051412';x.font='bold 13px Inter,sans-serif';x.fillText(isLg?'▲ LONG':'▼ SHORT',16,24);if(V.strat){x.fillStyle='#f3f4f6';x.font='bold 11px Inter,sans-serif';x.fillText(V.strat,108,24)}if(V.pnl){var pc=V.pnl.r>0.005?'#00e0a0':V.pnl.r<-0.005?'#ff4d6d':'#7e8ca8',txt=(V.pnl.fin?'KAPANDI ':(V.pnl.lbl||'CANLI')+' ')+sg(V.pnl.r)+'R   '+sg(V.pnl.pct)+'%';x.font='bold 12px JetBrains Mono,monospace';var w=x.measureText(txt).width+22;x.fillStyle=pc;x.fillRect(W-R-w+L,7,w,24);x.fillStyle='#080b12';x.fillText(txt,W-R-w+L+11,23)}}}
function loadChart(sym,tf){fetch(api('/api/candles?symbol='+encodeURIComponent(sym)+'&tf='+tf)).then(function(r){return r.json()}).then(function(d){if(d.error)return;chartCache[sym+'|'+tf]=d;if(sel&&sel.sym===sym){renderMain()}}).catch(function(){})}
function setTf(v){tfSel=v;chartFor='';renderMain()}
function selData(){if(!sel||!sel.sym)return null;if(sel.kind==='tr')return(S.tr||[]).find(function(x){return x.id===sel.id})||null;if(sel.kind==='brk')return(S.breakouts||[]).find(function(x){return x.id===sel.id})||null;return(S.radar||[]).find(function(x){return x.symbol===sel.sym})||null}
function defTf(){if(sel&&sel.kind==='rad')return S.config.tf;if(sel&&sel.kind==='tr'){var o=selData()||{};return o.chartTf||'15m'}return((S.tri||{}).tf||'2h')}

function whyText(o,kind){
 if(!o)return'Bu sinyal artık listede değil.';
 var fresh=isFresh(o)?'<b class="text-trade-long">Sinyal taze, giriş açık.</b>':(o.status==='OPEN'?'<b class="text-trade-short">Sinyal eski — sadece takip.</b>':'');
 if(kind==='tr'&&o.strategy==='FLOW'){
  var plan=o.riskAbs?' Stop = <b>'+((S.trInfo||{}).flowStopAtr||1.5)+'</b> × ATR(5m) veya son 12 mumun dibi/tepesi (hangisi uzaksa) (risk %'+f2(o.riskPct)+'), TP1 '+o.tp1R+'R, TP2 '+o.tp2R+'R. TP1\'de yarısı kapanır, stop girişe çekilir; en fazla '+f2((o.maxHold||0)/3600e3,0)+' saat tutulur. Maliyet '+f2(o.costR)+'R.':'';
  return '<span class="inline-block px-2 py-0.5 rounded-md bg-trade-purple/15 text-trade-purple border border-trade-purple/30 text-[10px] font-bold mb-1.5">⚡ MOMENTUM FLOW 5M</span><br>Fiyat hareketi <b>'+(o.pricePct>0?'+':'')+o.pricePct+'%</b>, OI değişimi <b>+'+o.oiPct+'%</b>, hacim <b>'+o.volX+'x</b>. Bu puan kazanma olasılığı değildir.'+plan+' Sinyal: '+new Date(o.time).toLocaleString('tr-TR')+'. '+fresh}
 if(kind==='tr'&&o.strategy==='CF')return '<span class="inline-block px-2 py-0.5 rounded-md bg-trade-purple/15 text-trade-purple border border-trade-purple/30 text-[10px] font-bold mb-1.5">🧩 CONFLUENCE '+esc((o.chartTf||'').toUpperCase())+'</span><br>Kernel regresyon dönüşü ZORUNLU; diğer 4 koşuldan en az '+((S.trInfo||{}).minPass||4)+' onayladı: ters hareket, ML, QQE MOD, WaveTrend. Hacim <b>'+(o.volX||0).toFixed(1)+'x</b>. Stop trend başlangıcının ötesinde, TP1 '+o.tp1R+'R, TP2 '+o.tp2R+'R. Puan <b>%'+o.score+'</b> • Onay '+(o.passes||0)+'/5. '+fresh;
 if(kind==='brk')return '<span class="inline-block px-2 py-0.5 rounded-md bg-brand-500/15 text-brand-400 border border-brand-500/30 text-[10px] font-bold mb-1.5">△ ÜÇGEN KIRILIM</span><br>'+esc(o.type)+' üçgenin '+(o.dir==='LONG'?'üst':'alt')+' çizgisi kapanış + hacimle kırıldı ('+(o.touches||'?')+' dokunuş, hacim '+f2(o.volX,1)+'x, güç %'+o.strength+'). TP1 alınca stop girişe çekilir. '+fresh;
 if(o.broke)return '<span class="inline-block px-2 py-0.5 rounded-md bg-amber-500/15 text-amber-400 border border-amber-500/30 text-[10px] font-bold mb-1.5">◎ ONAYSIZ KIRILIM</span><br>'+esc(o.state)+'. Fiyat çizgiyi aştı ama kapanış/hacim onayı yok. Gösterilen R ve % sanal giriştir.';
 return '<span class="inline-block px-2 py-0.5 rounded-md bg-dark-hover text-dark-muted border border-dark-border text-[10px] font-bold mb-1.5">◎ RADAR</span><br>'+esc(o.state)+' — henüz kırılmadı. Kırılım yaklaşırsa Telegram uyarısı düşer.'}

function renderMain(){var M=$('main');
 if(tab==='stat'){M.innerHTML='<div class="glass rounded-2xl p-5">'+statView()+'</div>';return}
 if(tab==='bt'){M.innerHTML=btShell()+(BT?'<div id="btOut" class="mt-4">'+btOut()+'</div>':'<div id="btOut" class="mt-4"></div>');if(BT)$('btOut').innerHTML=btOut();return}
 var hero='',detail='',listPanel='';
 var A=S.trStats||{},Ad=A.today||{totalR:0,n:0},B2=S.brkStats||{},Bd=B2.today||{totalR:0,n:0};
 var trOpen=(S.tr||[]).filter(isOp);
 var longN=trOpen.filter(function(x){return x.dir==='LONG'}).length,shortN=trOpen.length-longN;
 var radBroke=(S.radar||[]).filter(function(x){return x.broke}).length;
 hero='<div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">'+
  tile('Açık Sinyaller',trOpen.length+'<span class="text-xs text-dark-muted font-sans ml-1">poz</span>','<span class="text-trade-long"><i class="fa-solid fa-arrow-up-right"></i> '+longN+' L</span> <span class="text-dark-muted">/</span> <span class="text-trade-short">'+shortN+' S</span>')+
  tile('Trend Bugün',sg(Ad.totalR,1)+'R',(Ad.n||0)+' işlem',cl(Ad.totalR))+
  tile('Kırılım Bugün',sg(Bd.totalR,1)+'R',(Bd.n||0)+' onaylı',cl(Bd.totalR))+
  tile('Radar',radBroke+' / '+(S.radar||[]).length,'<span class="text-amber-400">'+radBroke+' aşan</span> <span class="text-dark-muted">• '+((S.tri||{}).structs||0)+' yapı</span>')+
 '</div>';

 var o=sel&&sel.sym?selData():null;
 if(o){var kind=sel.kind,tf=tfSel||defTf();
  var P=((kind==='tr'&&o.riskAbs)||kind==='brk'||(kind==='rad'&&o.broke&&o.entry!=null))?posInfo(o):null;
  var dir=o.dir||o.bias;
  var curPx=(S.px&&S.px[sel.sym])||o.lastPrice||o.entry;
  var ru=(+cfgC.bal||0)*Math.min(2,+cfgC.risk||0)/100;
  var lvHtml='';
  if(P){var usd=P.r*ru;
   lvHtml='<div class="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">'+
    '<div class="glass rounded-xl p-3 '+(P.r>0.005?'glow-long':P.r<-0.005?'glow-short':'')+'"><div class="text-[10px] text-dark-muted font-bold uppercase">'+(P.fin?'KAPANDI • '+o.status:'CANLI')+'</div><div class="text-2xl font-bold font-mono '+cl(P.r)+' mt-1">'+sg(P.r)+'R</div></div>'+
    '<div class="glass rounded-xl p-3"><div class="text-[10px] text-dark-muted font-bold uppercase">Fiyat Farkı</div><div class="text-2xl font-bold font-mono '+cl(P.pct)+' mt-1">'+sg(P.pct)+'%</div></div>'+
    '<div class="glass rounded-xl p-3"><div class="text-[10px] text-dark-muted font-bold uppercase">≈ K/Z (USDT)</div><div class="text-2xl font-bold font-mono '+cl(usd)+' mt-1">'+sg(usd)+'</div></div>'+
    '<div class="glass rounded-xl p-3"><div class="text-[10px] text-dark-muted font-bold uppercase">MFE / MAE</div><div class="text-2xl font-bold font-mono text-white mt-1">'+(o.mfe!=null?f2(o.mfe,1)+'/'+f2(o.mae||0,1):'—')+'</div></div>'+
   '</div>'}
  var lvGrid='';
  if(P){lvGrid='<div class="grid grid-cols-2 md:grid-cols-5 gap-3 mt-3">'+
   '<div class="glass rounded-xl p-3"><div class="text-[10px] text-dark-muted uppercase">Anlık</div><div class="font-mono font-bold mt-0.5">'+fp(P.fin&&o.exitPrice?o.exitPrice:P.px)+'</div></div>'+
   '<div class="glass rounded-xl p-3"><div class="text-[10px] text-dark-muted uppercase">Giriş</div><div class="font-mono font-bold text-trade-gold mt-0.5">'+fp(o.entry)+'</div></div>'+
   '<div class="glass rounded-xl p-3"><div class="text-[10px] text-dark-muted uppercase">Stop</div><div class="font-mono font-bold text-trade-short mt-0.5">'+fp(o.stop)+'</div></div>'+
   (o.tp1!=null?'<div class="glass rounded-xl p-3"><div class="text-[10px] text-dark-muted uppercase">TP1 ('+o.tp1R+'R)</div><div class="font-mono font-bold text-trade-long mt-0.5">'+fp(o.tp1)+'</div></div>':'')+
   (o.tp2!=null?'<div class="glass rounded-xl p-3"><div class="text-[10px] text-dark-muted uppercase">TP2 ('+f2(o.tp2R,1)+'R)</div><div class="font-mono font-bold text-trade-blue mt-0.5">'+fp(o.tp2)+'</div></div>':'')+
  '</div>'}
  var tfs=['5m','15m','1h','2h','4h'].map(function(t){return '<button class="'+(t===tf?'a':'')+' px-3 py-1.5 rounded-md text-[11px] font-bold font-mono text-dark-muted hover:text-white" data-tf="'+t+'">'+t.toUpperCase()+'</button>'}).join('');
  detail='<div class="glass rounded-2xl p-5 mb-5">'+
   '<div class="flex flex-wrap items-start justify-between gap-3 pb-4 border-b border-dark-border">'+
    '<div class="flex items-center gap-3 min-w-0">'+dirBadge(dir)+'<div class="min-w-0"><h2 class="text-lg font-bold text-white flex items-center gap-2">'+esc(sel.sym.split('/')[0])+'<span class="text-xs text-dark-muted font-normal">/USDT.P</span></h2>'+
     '<p class="text-[11px] text-dark-muted">'+stratName(kind,o)+(o.score?' • Puan '+o.score:'')+(o.strength!=null?' • Güç %'+o.strength:'')+(o.passes?' • '+o.passes+'/5':'')+'</p></div></div>'+
    '<div class="flex items-center gap-2"><div class="flex gap-0.5 bg-dark-bg p-1 rounded-lg border border-dark-border">'+tfs+'</div>'+
    '<a href="https://www.tradingview.com/chart/?symbol=BITGET:'+esc(sel.sym.split('/')[0])+'USDT.P&interval='+(tf==='5m'?'5':tf==='15m'?'15':tf==='2h'?'120':tf==='4h'?'240':'60')+'" target="_blank" class="px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-[11px] text-white font-bold flex items-center gap-1.5"><i class="fa-solid fa-arrow-up-right-from-square text-[10px]"></i>TV</a></div>'+
   '</div>'+
   '<div class="chart-grid relative w-full h-[440px] mt-4 rounded-xl bg-dark-bg/60 border border-dark-border overflow-hidden"><canvas id="cv"></canvas></div>'+
   lvHtml+lvGrid+
   '<div class="glass rounded-xl p-4 mt-4 text-xs text-dark-muted leading-relaxed">'+whyText(o,kind)+'</div>'+
   '<div class="glass rounded-xl p-4 mt-4"><div class="text-[10px] text-dark-muted font-bold uppercase tracking-wider mb-2">Pozisyon Hesabı</div>'+calcBox(P?P.levels.entry:null,P?P.levels.stop:null)+'</div>'+
  '</div>';
  setTimeout(function(){
   var k=sel.sym+'|'+tf;if(chartCache[k]){drawChart(chartCache[k],{dir:dir,levels:P?P.levels:null,virtual:(kind==='rad'),px:(S.px&&S.px[sel.sym])||null,strat:stratName(kind,o),pnl:P?{r:P.r,pct:P.pct,fin:P.fin,lbl:(kind==='rad'?'ÇİZGİDEN':'CANLI')}:null},'cv')}
   if(chartFor!==k){chartFor=k;loadChart(sel.sym,tf)}
   Array.prototype.forEach.call(M.querySelectorAll('[data-tf]'),function(b){b.onclick=function(){setTf(b.dataset.tf)}});
   bindCalc();
  },30);
 } else {
  var R=S.regime;
  var ti=S.trInfo||{},fd=ti.flow,cf=ti.cfDg,tg=S.tri||{};
  var sys='<div class="glass rounded-2xl p-5"><h3 class="text-sm font-bold text-white uppercase tracking-wider mb-3"><i class="fa-solid fa-server text-brand-400 mr-2"></i>Sistem Durumu</h3>';
  if(R)sys+='<div class="grid grid-cols-2 gap-3 mb-3"><div class="glass rounded-lg p-3"><div class="text-[10px] text-dark-muted uppercase">BTC Yön</div><div class="font-bold '+cl(R.btcScore)+' font-mono mt-0.5">'+R.btcDir+' '+sg(R.btcScore,0)+'</div></div><div class="glass rounded-lg p-3"><div class="text-[10px] text-dark-muted uppercase">Piyasa</div><div class="font-bold '+cl(R.score)+' font-mono mt-0.5">'+R.dir+' '+sg(R.score,0)+'</div></div></div>';
  sys+='<div class="space-y-2 text-xs font-mono">'+
   '<div class="flex justify-between p-2.5 rounded-lg bg-dark-bg border border-dark-border"><span class="text-dark-muted">MOMENTUM FLOW (5m)</span><span class="text-trade-long font-bold"><i class="fa-solid fa-circle-check text-[10px] mr-1"></i>Aktif</span></div>'+
   '<div class="flex justify-between p-2.5 rounded-lg bg-dark-bg border border-dark-border"><span class="text-dark-muted">ÜÇGEN MOTORU ('+esc((tg.tf||'2h').toUpperCase())+')</span><span class="'+(tg.liveErr?'text-trade-short':'text-trade-long')+' font-bold">'+(tg.liveErr?'HATA':((tg.structs||0)+' yapı'))+'</span></div>'+
   '<div class="flex justify-between p-2.5 rounded-lg bg-dark-bg border border-dark-border"><span class="text-dark-muted">Evren</span><span class="text-white">'+(S.scan?S.scan.universe:0)+' coin</span></div>'+
   '<div class="flex justify-between p-2.5 rounded-lg bg-dark-bg border border-dark-border"><span class="text-dark-muted">TG Bildirim</span><span class="'+(S.live&&S.live.tgOn?'text-trade-long':'text-dark-muted')+' font-bold">'+(S.live&&S.live.tgOn?'Bağlı':'Kapalı')+'</span></div>'+
  '</div></div>';
  detail='<div class="text-center text-dark-muted py-16"><i class="fa-solid fa-hand-pointer text-3xl mb-3 opacity-40"></i><div class="text-sm">Soldan bir sinyal seç → grafik + giriş/stop/TP + canlı K/Z</div></div>'+sys;
 }

 M.innerHTML=hero+'<div class="grid grid-cols-1 lg:grid-cols-12 gap-5">'+
  '<div class="lg:col-span-8 flex flex-col gap-5">'+detail+'</div>'+
  '<div class="lg:col-span-4 flex flex-col gap-4"><div class="glass rounded-2xl p-4"><div class="text-[11px] text-dark-muted font-bold uppercase tracking-wider mb-2 flex items-center justify-between"><span><i class="fa-solid fa-bolt text-trade-gold mr-1.5"></i>'+(tab==='rad'?'Üçgen Radar':'Sinyal Akışı')+'</span><span class="text-dark-muted font-mono">'+(tab==='rad'?(S.radar||[]).length:(S.tr||[]).length)+'</span></div><div id="listPanel" class="-mx-4 max-h-[calc(100vh-380px)] overflow-y-auto"></div></div></div>'+
 '</div>';
 renderListPanel()}

function calc(e,s){var bal=+cfgC.bal||0,rk=Math.min(2,+cfgC.risk||0),ru=bal*rk/100,d=Math.abs(e-s);if(!d||!bal)return null;var q=ru/d;return{ru:ru,q:q,n:q*e,lev:q*e/bal}}
function calcBox(e,s){return '<div class="flex flex-wrap gap-3 items-end">'+
 '<label><div class="text-[10px] text-dark-muted font-bold uppercase mb-1">Bakiye</div><input id="cBal" type="number" value="'+cfgC.bal+'" class="bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-xs font-mono w-24 focus:border-brand-500 focus:outline-none"></label>'+
 '<label><div class="text-[10px] text-dark-muted font-bold uppercase mb-1">Risk %</div><input id="cRisk" type="number" step="0.1" value="'+cfgC.risk+'" class="bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-xs font-mono w-20 focus:border-brand-500 focus:outline-none"></label>'+
 '<label><div class="text-[10px] text-dark-muted font-bold uppercase mb-1">Giriş</div><input id="cE" type="number" step="any" value="'+(e||'')+'" class="bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-xs font-mono w-28 focus:border-brand-500 focus:outline-none"></label>'+
 '<label><div class="text-[10px] text-dark-muted font-bold uppercase mb-1">Stop</div><input id="cS" type="number" step="any" value="'+(s||'')+'" class="bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-xs font-mono w-28 focus:border-brand-500 focus:outline-none"></label>'+
 '<div id="cOut" class="text-xs text-dark-muted font-mono"></div></div>'}
function bindCalc(){var upd=function(){cfgC.bal=+$('cBal').value;cfgC.risk=Math.min(2,+$('cRisk').value);try{localStorage.setItem('st_calc',JSON.stringify(cfgC))}catch(e){}var c=calc(+$('cE').value,+$('cS').value);$('cOut').innerHTML=c?'1R = <b class="text-trade-gold">'+f2(c.ru)+' USDT</b> • Miktar <b>'+f2(c.q,4)+'</b> • Kaldıraç <b>'+f2(c.lev,1)+'x</b>':'Değer gir.'};
 ['cBal','cRisk','cE','cS'].forEach(function(i){var e=$(i);if(e)e.oninput=upd});if($('cOut'))upd()}

var tbl=function(t,title){return '<h3 class="text-[11px] text-dark-muted font-bold uppercase tracking-wider mt-4 mb-2">'+title+'</h3><div class="overflow-x-auto"><table class="w-full text-xs font-mono"><thead><tr class="text-dark-muted border-b border-dark-border text-[10px] uppercase"><th class="text-left py-2 px-2">Grup</th><th class="text-right py-2 px-2">N</th><th class="text-right py-2 px-2">Win%</th><th class="text-right py-2 px-2">OrtR</th><th class="text-right py-2 px-2">Brüt</th><th class="text-right py-2 px-2">TopR</th><th class="text-right py-2 px-2">PF</th><th class="text-right py-2 px-2">t</th></tr></thead><tbody class="divide-y divide-dark-border/40">'+Object.keys(t).map(function(k){var x=t[k];return '<tr class="hover:bg-dark-hover/40"><td class="py-2 px-2 text-white">'+esc(k)+'</td><td class="text-right py-2 px-2">'+x.n+'</td><td class="text-right py-2 px-2">'+f2(x.win*100,0)+'</td><td class="text-right py-2 px-2 '+cl(x.avgR)+'">'+sg(x.avgR)+'</td><td class="text-right py-2 px-2 '+cl(x.gross)+'">'+sg(x.gross)+'</td><td class="text-right py-2 px-2 '+cl(x.totalR)+'">'+sg(x.totalR,1)+'</td><td class="text-right py-2 px-2">'+f2(x.pf)+'</td><td class="text-right py-2 px-2">'+f2(x.t)+'</td></tr>'}).join('')+'</tbody></table></div>'};
function statView(){var A=S.trStats||{},B=S.brkStats||{},h='<h2 class="text-lg font-bold text-white mb-4"><i class="fa-solid fa-chart-simple text-brand-400 mr-2"></i>İstatistik</h2>';
 h+='<div class="text-[11px] text-dark-muted font-bold uppercase tracking-wider mb-2 text-brand-400">⚡🧩 TREND (Momentum Flow + Confluence) — net R</div>';
 if(A.all&&A.all.n){h+=tbl({'Tümü':A.all,'Bugün':A.today},'Genel')+tbl(A.bySetup||{},'Strateji')+tbl(A.byScore||{},'Puan')+tbl(A.byDir||{},'Yön')+tbl(A.byVol||{},'Hacim')+tbl(A.byReg||{},'Rejim')+tbl(A.byAlign||{},'Yön Uyumu')+tbl(A.byCost||{},'Maliyet')+tbl(A.byExit||{},'Çıkış')}
 else h+='<div class="text-dark-muted text-xs py-3">Henüz kapanan trend sinyali yok.</div>';
 h+='<div class="text-[11px] text-dark-muted font-bold uppercase tracking-wider mt-6 mb-2 text-amber-400">△ ÜÇGEN KIRILIM</div>';
 if(B.all&&B.all.n){h+=tbl({'Tümü':B.all,'Bugün':B.today},'Genel')+tbl(B.byStrength||{},'Güç')+tbl(B.byType||{},'Tip')+tbl(B.byDir||{},'Yön')+tbl(B.byExit||{},'Çıkış')}
 else h+='<div class="text-dark-muted text-xs py-3">Henüz kapanan kırılım yok.</div>';
 return h}

var BT=null,btDays=30,btN=40,btS='cf';
function btStart(){fetch(api('/api/backtest/start?days='+btDays+'&n='+btN+'&s='+btS),{method:'POST'}).then(function(r){return r.json()}).then(function(d){if(d&&d.error)alert(d.error);pollBT()}).catch(function(){})}
function pollBT(){fetch(api('/api/backtest')).then(function(r){return r.json()}).then(function(d){BT=d;if(tab==='bt'&&$('btOut'))$('btOut').innerHTML=btOut()}).catch(function(){})}
function btShell(){var so=function(a,v){return a.map(function(x){return '<option value="'+x+'"'+(String(x)===String(v)?' selected':'')+'>'+x+'</option>'}).join('')};
 return '<div class="glass rounded-2xl p-5"><h2 class="text-lg font-bold text-white mb-3"><i class="fa-solid fa-flask text-brand-400 mr-2"></i>Backtest</h2><div class="text-xs text-dark-muted mb-4">Giriş sinyal mumundan sonraki mumun açılışı. Stop/hedef aynı mumdaysa STOP önce.</div>'+
 '<div class="flex flex-wrap gap-3 items-end">'+
 '<label><div class="text-[10px] text-dark-muted font-bold uppercase mb-1">Strateji</div><select onchange="btS=this.value" class="bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-xs"><option value="cf"'+(btS==='cf'?' selected':'')+'>Confluence</option><option value="tri"'+(btS==='tri'?' selected':'')+'>Üçgen (1h)</option><option value="tri2"'+(btS==='tri2'?' selected':'')+'>Üçgen (2h)</option></select></label>'+
 '<label><div class="text-[10px] text-dark-muted font-bold uppercase mb-1">Gün</div><select onchange="btDays=this.value" class="bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-xs">'+so([14,30,60,90,180],btDays)+'</select></label>'+
 '<label><div class="text-[10px] text-dark-muted font-bold uppercase mb-1">Coin</div><select onchange="btN=this.value" class="bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-xs">'+so([20,40,60,100],btN)+'</select></label>'+
 '<button onclick="btStart()" class="px-5 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-sm font-bold"><i class="fa-solid fa-play mr-1"></i>Başlat</button></div></div>'}
function edgeTbl(e){if(!e||!e.length)return'';return '<h3 class="text-[11px] text-dark-muted font-bold uppercase tracking-wider mt-4 mb-2">Sinyal İsabeti</h3><div class="text-xs text-dark-muted mb-2">Giriş sonrası stop mesafesi kadar ters gitmeden +kR hedefe ulaşma. Rastgele: +1R=%50, +2R=%33, +3R=%25.</div><div class="overflow-x-auto"><table class="w-full text-xs font-mono"><thead><tr class="text-dark-muted border-b border-dark-border text-[10px] uppercase"><th class="text-left py-2">Grup</th><th class="text-left py-2">Hedef</th><th class="text-right py-2">N</th><th class="text-right py-2">İsabet%</th><th class="text-right py-2">Rastgele%</th><th class="text-right py-2">Fark</th><th class="text-right py-2">z</th></tr></thead><tbody class="divide-y divide-dark-border/40">'+e.map(function(x){var d=(x.hit-x.base)*100;return '<tr><td class="py-2 text-white">'+esc(x.g)+'</td><td class="py-2">+'+x.k+'R</td><td class="text-right py-2">'+x.n+'</td><td class="text-right py-2">'+f2(x.hit*100,0)+'</td><td class="text-right py-2">'+f2(x.base*100,0)+'</td><td class="text-right py-2 '+cl(d)+'">'+sg(d,0)+'</td><td class="text-right py-2 '+cl(x.z)+'">'+f2(x.z)+'</td></tr>'}).join('')+'</tbody></table></div>'}
function btOut(){var b=BT;if(!b)return '';var sn=b.strategy==='cf'?'Confluence':b.strategy==='tri2'?'Üçgen (2h)':'Üçgen (1h)';
 if(b.running){var pc=b.total?Math.round(b.i/b.total*100):0;return '<div class="glass rounded-2xl p-5"><div class="text-sm"><b class="text-white">Çalışıyor ('+sn+'):</b> '+b.i+' / '+b.total+' ('+esc(b.sym||'')+') <span class="text-brand-400 font-mono">%'+pc+'</span></div><div class="mt-2 h-1 bg-dark-bg rounded-full overflow-hidden"><div class="h-full bg-brand-500 transition-all" style="width:'+pc+'%"></div></div></div>'}
 if(b.err)return '<div class="glass rounded-2xl p-5 border border-trade-short/40 text-trade-short text-sm">Hata: '+esc(b.err)+'</div>';
 var r=b.result;if(!r)return'';
 if(!r.n)return '<div class="glass rounded-2xl p-5 text-sm">'+sn+': '+r.days+' gün / '+r.coins+' coinde hiç işlem çıkmadı.</div>';
 var col=r.level==='g'?'border-trade-long':r.level==='r'?'border-trade-short':'border-trade-gold';
 var tc=r.level==='g'?'text-trade-long':r.level==='r'?'text-trade-short':'text-trade-gold';
 var h='<div class="glass rounded-2xl p-5 border-l-4 '+col+'"><b class="'+tc+' text-sm">Değerlendirme — '+sn+'</b><div class="text-xs text-dark-muted mt-2 leading-relaxed">'+esc(r.verdict)+'</div></div>';
 var dt=function(x){return x?new Date(x).toISOString().slice(0,10):'—'};
 h+='<div class="text-xs text-dark-muted mt-3 font-mono">'+r.coins+' coin • '+r.days+' gün • '+r.n+' işlem • '+dt(r.tFrom)+' → '+dt(r.tTo)+' • kapsam %'+Math.round((r.coverage||0)*100)+'</div>';
 if((r.coverage||0)<0.9)h+='<div class="glass rounded-xl p-3 mt-3 border border-trade-gold/40 text-trade-gold text-xs">⚠ Veri eksik olabilir</div>';
 if(r.edge)h+=edgeTbl(r.edge);
 Object.keys(r.tables).forEach(function(k){h+=tbl(r.tables[k],k)});return '<div class="mt-3">'+h+'</div>'}

function poll(){fetch(api('/api/state')).then(function(r){return r.json()}).then(function(d){if(d&&d.error){$('dot').className='w-2 h-2 rounded-full bg-trade-short pulse-dot';$('conn').textContent='Hata';return}
 S=d;$('dot').className='w-2 h-2 rounded-full bg-trade-long pulse-dot';$('conn').textContent='Bağlı';try{checkBrk();checkTr();renderAll()}catch(e){console.error(e);$('conn').textContent='UI hata'}}).catch(function(){$('dot').className='w-2 h-2 rounded-full bg-trade-short pulse-dot';$('conn').textContent='Bağlantı yok'})}
function renderAll(){renderTop();renderTabs();renderMain()}
addEventListener('resize',function(){if(S)try{renderMain()}catch(e){}});
setInterval(poll,3000);
setInterval(function(){if(tab==='bt')pollBT()},2000);
setInterval(function(){if(sel&&sel.sym){loadChart(sel.sym,tfSel||defTf())}},8000);
poll();
</script>
</body></html>`;
