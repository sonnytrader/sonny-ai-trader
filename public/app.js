// public/app.js
const modal = (id, show)=>{ const el=document.getElementById(id); el.classList.toggle('hidden', !show); el.classList.toggle('flex', show); };

// Landing modals
document.getElementById('btnRegister').onclick = ()=> modal('registerModal', true);
document.getElementById('btnLogin').onclick = ()=> modal('loginModal', true);
document.getElementById('btnCloseReg').onclick = ()=> modal('registerModal', false);
document.getElementById('btnCloseLogin').onclick = ()=> modal('loginModal', false);

// Dashboard açma – login sonrası
document.getElementById('btnSubmitLogin').onclick = ()=>{
  modal('loginModal', false);
  document.getElementById('dashboard').classList.remove('hidden');
  refresh();
};

// Paket seçimi highlight (demo amaçlı)
let selectedPlan = 'basic';
document.querySelectorAll('[data-plan]').forEach(el=>{
  el.onclick = ()=> { document.querySelectorAll('[data-plan]').forEach(x=> x.classList.remove('border-blue-500')); el.classList.add('border-blue-500'); selectedPlan = el.getAttribute('data-plan'); };
});

async function api(path, method='GET', body=null){
  const res = await fetch(path, { method, headers:{'Content-Type':'application/json'}, body: body?JSON.stringify(body):undefined });
  return await res.json();
}

// Register – config sync (ödemeyi sen onaylıyorsun)
document.getElementById('btnSubmitReg').onclick = async ()=>{
  const strategies = {
    breakout: document.getElementById('stBreakout').checked,
    trendfollow: document.getElementById('stTrend').checked,
    pumpdump: document.getElementById('stPump').checked
  };
  await api('/api/config/update','POST',{ strategies });
  document.getElementById('regMsg').innerText = 'Kayıt alındı. E-posta doğrulaması ve ödeme onayı sonrası aktivasyon yapılır.';
};

// Dashboard controls
document.getElementById('btnRefresh').onclick = refresh;
document.getElementById('btnManualTrade').onclick = async ()=>{
  const symbol = document.getElementById('manSymbol').value;
  const direction = document.getElementById('manDirection').value; // LONG | SHORT
  const amount = parseFloat(document.getElementById('manAmount').value);
  const price = parseFloat(document.getElementById('manPrice').value);
  const type = document.getElementById('manType').value;

  const payload = {
    ccxt_symbol: symbol,
    direction,
    giris: price||0,
    tp1: price? (direction==='LONG'? price*1.02 : price*0.98) : 0,
    sl:  price? (direction==='LONG'? price*0.98 : price*1.02) : 0,
    orderType: type,
    confidence: 100,
    signalQuality: 100,
    positionSize: 1.0
  };
  const r = await api('/api/trade/manual','POST',payload);
  document.getElementById('manMsg').innerText = r.success ? 'Emir gönderildi' : ('Hata: '+(r.error||''));
};

document.getElementById('btnSaveCfg').onclick = async ()=>{
  const payload = {
    minConfidenceForAuto: parseInt(document.getElementById('confMin').value),
    orderType: document.getElementById('orderType').value,
    leverage: parseInt(document.getElementById('leverage').value),
    marginPercent: parseFloat(document.getElementById('margin').value),
    riskProfile: document.getElementById('riskProfile').value,
    scalpMode: document.getElementById('scalp').checked,
    autotradeMaster: document.getElementById('autotrade').checked,
    strategies: {
      breakout: document.getElementById('stgBreakout').checked,
      trendfollow: document.getElementById('stgTrend').checked,
      pumpdump: document.getElementById('stgPump').checked
    },
    // API bilgileri buradan backend'e gider
    apiKey: document.getElementById('cfgApiKey').value,
    secret: document.getElementById('cfgApiSecret').value,
    password: document.getElementById('cfgApiPass').value
  };
  const r = await api('/api/config/update','POST',payload);
  document.getElementById('cfgMsg').innerText = r.success ? 'Ayarlar güncellendi' : 'Hata';
};

(function connectWS(){
  try{
    const ws = new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host);
    ws.onmessage = (ev)=>{
      const msg = JSON.parse(ev.data);
      if (msg.type==='signal_list'){ renderSignals(msg.data); }
    };
    ws.onclose = ()=> setTimeout(connectWS, 2000);
  }catch(e){}
})();

async function refresh(){
  const r = await api('/api/status');
  renderSignals(r.signals || []);
  renderPositions(r.positions || []);
}

// UI renderers
function renderSignals(sigs){
  const cont = document.getElementById('signals');
  cont.innerHTML = '';
  sigs.forEach(s=>{
    const isLong = s.direction==='LONG';
    const strat = s.strategy;
    const borderClass = isLong ? 'border-green-500' : 'border-red-500';
    const titleClass = isLong ? 'text-green-400' : 'text-red-400';
    const volLabel = s.volumeLevel==='high' ? 'Hacim: Yüksek' : s.volumeLevel==='medium' ? 'Hacim: Orta' : 'Hacim: Düşük';
    const qualLabel = s.signalQuality>=90 ? 'Çok güçlü' : s.signalQuality>=75 ? 'Güçlü' : 'Uygun';

    const div = document.createElement('div');
    div.className = `p-4 rounded border ${borderClass}`;

    div.innerHTML = `
      <div class="flex justify-between items-start">
        <div class="font-semibold ${titleClass}">${s.coin} • ${isLong?'LONG':'SHORT'}</div>
        <div class="badge">${strat}</div>
      </div>

      <div class="grid md:grid-cols-4 gap-2 text-sm mt-2">
        <div>Giriş: <span class="${isLong?'text-green-400':'text-red-400'}">${s.giris}</span></div>
        <div>TP: <span class="text-blue-400">${s.tp1}</span></div>
        <div>SL: <span class="text-red-400">${s.sl}</span></div>
        <div>RR: ${s.riskReward}</div>
      </div>

      <div class="grid md:grid-cols-4 gap-2 text-xs mt-2 text-gray-300">
        <div>Güven: ${s.confidence}%</div>
        <div>Kalite: ${s.signalQuality} • ${qualLabel}</div>
        <div>ADX: ${s.adx} • RSI: ${s.rsi} • OBV: ${s.obvTrend}</div>
        <div>${volLabel}</div>
      </div>

      <div class="text-sm mt-3">
        <div><span class="text-gray-400">Neden:</span> ${s.narrative?.why || '-'}</div>
        <div class="mt-1"><span class="text-gray-400">Öngörü:</span> ${s.narrative?.outlook || '-'}</div>
      </div>

      <div class="grid md:grid-cols-3 gap-2 mt-3">
        <a href="${s.tvLink}" target="_blank" class="btn btn-link">TradingView</a>
        <button class="btn btn-success" onclick='auto("${s.id}")'>Oto trade</button>
        <button class="btn btn-primary" onclick='enter("${s.id}")'>İşleme giriş</button>
      </div>
    `;
    cont.appendChild(div);
  });
}

function renderPositions(pos){
  const pcont = document.getElementById('positions');
  pcont.innerHTML = '';
  pos.forEach(p=>{
    const d = document.createElement('div');
    d.className='p-2 rounded border border-gray-700';
    d.innerHTML = `
      <div class="flex justify-between">
        <div>${p.info?.symbol || p.symbol}</div>
        <div>${p.side} • ${p.contracts}</div>
      </div>
      <button class="mt-2 btn btn-danger btn-sm" onclick='closePos("${p.symbol}","${p.side}",${p.contracts})'>Kapat</button>
    `;
    pcont.appendChild(d);
  });
}

// Actions
async function auto(id){
  const r = await api('/api/status');
  const s = (r.signals||[]).find(x=>x.id===id);
  if (s){ await api('/api/trade/manual','POST',s); alert('Oto trade gönderildi'); }
}

async function enter(id){
  const r = await api('/api/status');
  const s = (r.signals||[]).find(x=>x.id===id);
  if (!s) return alert('Sinyal bulunamadı');

  const payload = {
    ccxt_symbol: s.ccxt_symbol,
    direction: s.direction,
    giris: s.giris,
    tp1: s.tp1,
    sl: s.sl,
    orderType: s.orderType,
    confidence: s.confidence,
    signalQuality: s.signalQuality,
    positionSize: s.positionSize
  };
  const res = await api('/api/trade/manual','POST',payload);
  alert(res.success ? 'İşleme giriş gönderildi' : ('Hata: '+(res.error||'')));
}

async function closePos(symbol, side, contracts){
  const r = await api('/api/position/close','POST',{ symbol, side, contracts });
  alert(r.success ? 'Pozisyon kapatıldı' : ('Hata: '+(r.error||'')));
}

async function refresh(){
  const r = await api('/api/status');
  renderSignals(r.signals || []);
  renderPositions(r.positions || []);
}
