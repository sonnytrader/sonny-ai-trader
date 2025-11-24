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

// Token yönetimi
const auth = {
    getToken() {
        return localStorage.getItem('authToken');
    },
    setToken(token) {
        localStorage.setItem('authToken', token);
    },
    removeToken() {
        localStorage.removeItem('authToken');
    },
    isAuthenticated() {
        return !!this.getToken();
    },
    async validateToken() {
        const token = this.getToken();
        if (!token) return false;
        
        try {
            const response = await fetch('/api/user', {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            return response.ok;
        } catch (error) {
            return false;
        }
    }
};

// Sayfa yüklendiğinde token kontrolü
document.addEventListener('DOMContentLoaded', async () => {
    // Dashboard sayfasındaysak token kontrol et
    if (window.location.pathname === '/dashboard.html' || window.location.pathname === '/dashboard') {
        const isValid = await auth.validateToken();
        if (!isValid) {
            auth.removeToken();
            window.location.href = '/login.html';
            return;
        }
    }
});

// --- WebSocket (Canlı Veri) ---
function startSocket() {
    const token = auth.getToken();
    if (!token) return;
    
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}`);
    
    ws.onopen = () => {
        console.log('WebSocket connected');
        // Token'i WebSocket üzerinden gönder
        ws.send(JSON.stringify({ type: 'auth', token }));
    };
    
    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'signal_list') renderSignals(msg.data);
        if (msg.type === 'system_status') updateSystemStatus(msg.data);
    };
    
    ws.onclose = () => setTimeout(startSocket, 3000);
    ws.onerror = (error) => console.error('WebSocket error:', error);
}

function renderSignals(list) {
    const box = qs('#signals');
    if (!box) return;
    
    box.innerHTML = '';
    list.forEach(s => {
        const el = document.createElement('div');
        el.className = 'card rounded-lg p-3 flex items-center justify-between';
        const colorClass = s.direction === 'LONG' ? 'text-green-400' : 'text-red-400';
        el.innerHTML = `
            <div>
                <b>${s.coin}</b> • <span class="${colorClass}">${s.direction}</span>
                <div class="text-xs text-gray-400">${s.strategy}</div>
            </div>
            <div class="text-right">
                <div class="text-sm font-mono">Entry: $${s.giris}</div>
                <div class="text-sm text-gray-300">Conf: %${s.confidence}</div>
            </div>`;
        box.appendChild(el);
    });
}

function updateSystemStatus(status) {
    if (!status) return;
    
    // Sistem durumu güncellemeleri buraya gelecek
    console.log('System status updated:', status);
}

// --- BUTON VE MODAL KONTROLLERİ ---
if (qs('#btnLogin')) {
    qs('#btnLogin').addEventListener('click', () => { show(backdrop); show(loginModal); });
}
if (qs('#btnRegister')) {
    qs('#btnRegister').addEventListener('click', () => { show(backdrop); show(registerModal); });
}
if (qs('#btnCloseLogin')) {
    qs('#btnCloseLogin').addEventListener('click', () => { hide(backdrop); hide(loginModal); });
}
if (qs('#btnCloseReg')) {
    qs('#btnCloseReg').addEventListener('click', () => { hide(backdrop); hide(registerModal); });
}

// GİRİŞ YAP
if (qs('#btnSubmitLogin')) {
    qs('#btnSubmitLogin').addEventListener('click', async () => {
        const email = qs('#loginEmail').value;
        const pass = qs('#loginPass').value;
        
        if (!email || !pass) {
            alert("Email ve şifre gerekli!");
            return;
        }
        
        try {
            const res = await fetch('/api/login', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ email, password: pass })
            });
            const data = await res.json();
            
            if (data.success) {
                // Token'i kaydet
                auth.setToken(data.token);
                
                hide(backdrop); 
                hide(loginModal);
                
                if (landingPage) hide(landingPage);
                if (dashboard) {
                    showBlock(dashboard);
                    startSocket();
                }
                
                // Dashboard'a yönlendir
                window.location.href = '/dashboard.html';
            } else {
                alert("Hata: " + data.error);
            }
        } catch(e) { 
            console.error('Login error:', e);
            alert("Sunucu hatası"); 
        }
    });
}

// KAYIT OL
if (qs('#btnSubmitReg')) {
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
                hide(registerModal); 
                show(loginModal);
            } else {
                alert("Hata: " + data.error);
            }
        } catch(e) { 
            alert("Sunucu hatası"); 
        }
    });
}

// ÇIKIŞ YAP
if (qs('#btnLogout')) {
    qs('#btnLogout').addEventListener('click', async () => {
        try {
            const token = auth.getToken();
            if (token) {
                await fetch('/api/logout', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                });
            }
        } catch (error) {
            console.error('Logout error:', error);
        } finally {
            auth.removeToken();
            window.location.href = '/';
        }
    });
}

// API istekleri için helper fonksiyon
async function apiRequest(url, options = {}) {
    const token = auth.getToken();
    
    const defaultOptions = {
        headers: {
            'Content-Type': 'application/json',
            ...(token && { 'Authorization': `Bearer ${token}` })
        }
    };
    
    const mergedOptions = {
        ...defaultOptions,
        ...options,
        headers: {
            ...defaultOptions.headers,
            ...options.headers
        }
    };
    
    try {
        const response = await fetch(url, mergedOptions);
        
        // Token geçersizse login sayfasına yönlendir
        if (response.status === 401) {
            auth.removeToken();
            window.location.href = '/login.html';
            return null;
        }
        
        return await response.json();
    } catch (error) {
        console.error('API request error:', error);
        throw error;
    }
}
