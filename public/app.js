const qs = (s) => document.querySelector(s);
const loginModal = qs('#loginModal');
const registerModal = qs('#registerModal');
const dashboard = qs('#dashboard');
const landingPage = qs('#landingPage');
const signalBox = qs('#signals');

// --- WebSocket Başlat ---
function startSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}`);

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'signal_list') {
            updateSignals(msg.data);
        }
    };
    
    ws.onclose = () => setTimeout(startSocket, 3000);
}

function updateSignals(list) {
    signalBox.innerHTML = '';
    if(list.length === 0) {
        signalBox.innerHTML = '<div class="text-center text-gray-500">Henüz sinyal yok...</div>';
        return;
    }
    list.forEach(s => {
        const el = document.createElement('div');
        el.className = 'card rounded-lg p-3 flex justify-between border-l-4 ' + (s.direction === 'LONG' ? 'border-green-500' : 'border-red-500');
        el.innerHTML = `
            <div>
                <b class="text-lg">${s.symbol}</b> 
                <span class="${s.direction === 'LONG'?'text-green-400':'text-red-400'} font-bold ml-2">${s.direction}</span>
                <div class="text-xs text-gray-400">${s.strategy}</div>
            </div>
            <div class="text-right">
                <div class="text-sm font-mono">Giriş: ${s.price}</div>
                <div class="text-xs text-gray-500">%${s.confidence} Güven</div>
            </div>
        `;
        signalBox.appendChild(el);
    });
}

// --- MODAL KONTROLLERİ ---

// Login Modal Aç/Kapa
const btnLoginOpen = qs('#btnLogin');
if(btnLoginOpen) btnLoginOpen.addEventListener('click', () => loginModal.style.display = 'flex');
qs('#btnCloseLogin').addEventListener('click', () => loginModal.style.display = 'none');

// Register Modal Aç/Kapa
const btnRegisterOpen = qs('#btnRegister');
if(btnRegisterOpen) btnRegisterOpen.addEventListener('click', () => registerModal.style.display = 'flex');
qs('#btnCloseReg').addEventListener('click', () => registerModal.style.display = 'none');


// --- GİRİŞ VE KAYIT İŞLEMLERİ ---

// Giriş Yap (Login)
qs('#btnSubmitLogin').addEventListener('click', async () => {
    const email = qs('#loginEmail').value;
    const pass = qs('#loginPass').value;
    
    if(!email || !pass) return alert("Email ve şifre giriniz.");

    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ email, password: pass })
        });
        
        const data = await res.json();
        if (data.success) {
            // Başarılı giriş
            loginModal.style.display = 'none';
            landingPage.style.display = 'none'; // Karşılama ekranını gizle
            dashboard.style.display = 'block'; // Paneli aç
            
            // Token'ı kaydet (opsiyonel ilerisi için)
            localStorage.setItem('token', data.token);
            
            startSocket(); // Canlı veriyi başlat
        } else {
            alert("Hata: " + data.error);
        }
    } catch (e) {
        console.error(e);
        alert("Sunucu hatası!");
    }
});

// Kayıt Ol (Register) - BURASI DÜZELTİLDİ
qs('#btnSubmitReg').addEventListener('click', async () => {
    const email = qs('#regEmail').value;
    const pass = qs('#regPass').value;

    if(!email || !pass) return alert("Email ve şifre zorunlu.");

    try {
        const res = await fetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                email, 
                password: pass,
                plan: 'basic'
            })
        });

        const data = await res.json();
        if (data.success) {
            alert("Kayıt başarılı! Lütfen giriş yapın.");
            registerModal.style.display = 'none';
            loginModal.style.display = 'flex';
        } else {
            alert("Kayıt hatası: " + (data.error || "Bilinmeyen hata"));
        }
    } catch (e) {
        console.error(e);
        alert("Sunucu hatası!");
    }
});

// Çıkış Yap (Logout)
const btnLogout = qs('#btnLogout');
if(btnLogout) {
    btnLogout.addEventListener('click', () => {
        location.reload(); // Sayfayı yenilemek en temiz çıkıştır
    });
}
