// public/app.js
const qs = (s) => document.querySelector(s);
const show = (el) => el && (el.style.display = 'flex');
const hide = (el) => el && (el.style.display = 'none');
const showBlock = (el) => el && (el.style.display = 'block');

// Elementler
const loginModal = qs('#loginModal');
const registerModal = qs('#registerModal');
const backdrop = qs('#modalBackdrop');
const dashboard = qs('#dashboard');
const landingPage = qs('#landingPage');

// --- WebSocket (Canlı Veri) ---
function startSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}`);
    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'signal_list') renderSignals(msg.data);
    };
    ws.onclose = () => setTimeout(startSocket, 3000);
}

function renderSignals(list) {
    const box = qs('#signals');
    box.innerHTML = '';
    list.forEach(s => {
        const el = document.createElement('div');
        // Senin orijinal tasarımındaki card yapısı
        el.className = 'card rounded-lg p-3 flex items-center justify-between';
        const colorClass = s.direction === 'LONG' ? 'text-green-400' : 'text-red-400';
        el.innerHTML = `
            <div>
                <b>${s.symbol}</b> • <span class="${colorClass}">${s.direction}</span>
                <div class="text-xs text-gray-400">${s.strategy}</div>
            </div>
            <div class="text-right">
                <div class="text-sm font-mono">Price: ${s.price}</div>
                <div class="text-sm text-gray-300">Conf: %${s.confidence}</div>
            </div>`;
        box.appendChild(el);
    });
}

// --- BUTON VE MODAL KONTROLLERİ ---
qs('#btnLogin').addEventListener('click', () => { show(backdrop); show(loginModal); });
qs('#btnRegister').addEventListener('click', () => { show(backdrop); show(registerModal); });
qs('#btnCloseLogin').addEventListener('click', () => { hide(backdrop); hide(loginModal); });
qs('#btnCloseReg').addEventListener('click', () => { hide(backdrop); hide(registerModal); });

// GİRİŞ YAP
qs('#btnSubmitLogin').addEventListener('click', async () => {
    const email = qs('#loginEmail').value;
    const pass = qs('#loginPass').value;
    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ email, password: pass })
        });
        const data = await res.json();
        if (data.success) {
            hide(backdrop); hide(loginModal);
            if(landingPage) hide(landingPage);
            showBlock(dashboard);
            startSocket();
        } else {
            alert("Hata: " + data.error);
        }
    } catch(e) { alert("Sunucu hatası"); }
});

// KAYIT OL
qs('#btnSubmitReg').addEventListener('click', async () => {
    const email = qs('#regEmail').value;
    const pass = qs('#regPass').value;
    const apiKey = qs('#apiKey').value;
    const apiSecret = qs('#apiSecret').value;
    try {
        const res = await fetch('/api/register', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ email, password: pass, apiKey, apiSecret, plan: 'basic' })
        });
        const data = await res.json();
        if(data.success) {
            alert("Kayıt Başarılı! Giriş yapın.");
            hide(registerModal); show(loginModal);
        } else {
            alert("Hata: " + data.error);
        }
    } catch(e) { alert("Sunucu hatası"); }
});

// --- ÖZELLİK: MANUEL İŞLEM (Senin İstediğin Özellik) ---
qs('#btnManualTrade').addEventListener('click', async () => {
    const payload = {
        symbol: qs('#manSymbol').value,
        direction: qs('#manDirection').value,
        amount: qs('#manAmount').value,
        price: qs('#manPrice').value,
        type: qs('#manType').value
    };
    
    qs('#manMsg').textContent = "İşlem gönderiliyor...";
    
    try {
        const res = await fetch('/api/trade/manual', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if(data.success) qs('#manMsg').textContent = "İşlem Başarılı: " + (data.orderId || "OK");
        else qs('#manMsg').textContent = "Hata: " + data.error;
    } catch(e) {
        qs('#manMsg').textContent = "Sunucu hatası.";
    }
});

// --- ÖZELLİK: AYARLARI KAYDET ---
qs('#btnSaveCfg').addEventListener('click', async () => {
    const config = {
        minConfidenceForAuto: qs('#confMin').value,
        orderType: qs('#orderType').value,
        leverage: qs('#leverage').value,
        marginPercent: qs('#margin').value,
        riskProfile: qs('#riskProfile').value,
        scalpMode: qs('#scalp').checked,
        autotradeMaster: qs('#autotrade').checked,
        strategies: {
            breakout: qs('#stgBreakout').checked,
            trendfollow: qs('#stgTrend').checked,
            pumpdump: qs('#stgPump').checked
        }
    };

    try {
        const res = await fetch('/api/config/update', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(config)
        });
        qs('#cfgMsg').textContent = "Ayarlar kaydedildi.";
    } catch(e) { qs('#cfgMsg').textContent = "Hata oluştu."; }
});

// ÇIKIŞ YAP
const btnLogout = qs('#btnLogout');
if(btnLogout) btnLogout.addEventListener('click', () => location.reload());
