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
            const response = await fetch('/api/user/info', {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            
            if (!response.ok) {
                console.error('Token validation failed:', response.status);
                return false;
            }
            
            const data = await response.json();
            return data.success;
        } catch (error) {
            console.error('Token validation error:', error);
            return false;
        }
    }
};

// Sayfa yüklendiğinde token kontrolü
document.addEventListener('DOMContentLoaded', async () => {
    // Dashboard sayfasındaysak token kontrol et
    if (window.location.pathname === '/dashboard.html' || window.location.pathname === '/dashboard' || window.location.pathname === '/admin.html') {
        const isValid = await auth.validateToken();
        if (!isValid) {
            auth.removeToken();
            window.location.href = '/login.html';
            return;
        } else {
            // Token geçerliyse dashboard'ı göster
            if (dashboard) showBlock(dashboard);
            if (landingPage) hide(landingPage);
            startSocket();
        }
    }
});

// --- WebSocket (Canlı Veri) ---
function startSocket() {
    const token = auth.getToken();
    if (!token) {
        console.log('No token available for WebSocket');
        return;
    }
    
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}`;
    
    console.log('Connecting to WebSocket:', wsUrl);
    
    try {
        const ws = new WebSocket(wsUrl);
        
        ws.onopen = () => {
            console.log('WebSocket connected');
            // Token'i WebSocket üzerinden gönder
            ws.send(JSON.stringify({ type: 'auth', token }));
        };
        
        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                console.log('WebSocket message received:', msg);
                
                if (msg.type === 'signal_list') renderSignals(msg.data);
                if (msg.type === 'system_status') updateSystemStatus(msg.data);
            } catch (e) {
                console.error("Geçersiz WS mesajı:", event.data, e);
            }
        };
        
        ws.onclose = (event) => {
            console.log('WebSocket disconnected:', event.code, event.reason);
            setTimeout(startSocket, 3000);
        };
        
        ws.onerror = (error) => {
            console.error('WebSocket error:', error);
        };
        
        return ws;
    } catch (error) {
        console.error('WebSocket connection error:', error);
        setTimeout(startSocket, 3000);
    }
}

function renderSignals(list) {
    const box = qs('#signals');
    if (!box) return;
    
    box.innerHTML = '';
    
    if (!list || list.length === 0) {
        box.innerHTML = '<div class="text-gray-400 text-center">No signals available</div>';
        return;
    }
    
    list.forEach(s => {
        const el = document.createElement('div');
        el.className = 'card rounded-lg p-3 flex items-center justify-between mb-2';
        const colorClass = s.direction && s.direction.includes('LONG') ? 'text-green-400' : 'text-red-400';
        el.innerHTML = `
            <div>
                <b>${s.coin || 'N/A'}</b> • <span class="${colorClass}">${s.direction || 'N/A'}</span>
                <div class="text-xs text-gray-400">${s.strategy || 'Unknown'}</div>
            </div>
            <div class="text-right">
                <div class="text-sm font-mono">Entry: $${s.giris || '0'}</div>
                <div class="text-sm text-gray-300">Conf: %${s.confidence || '0'}</div>
            </div>`;
        box.appendChild(el);
    });
}

function updateSystemStatus(status) {
    if (!status) return;
    
    console.log('System status updated:', status);
    
    // Sistem durumu güncellemeleri
    const statusElement = qs('#systemStatus');
    if (statusElement) {
        statusElement.textContent = status.marketSentiment || 'ANALİZ EDİLİYOR...';
    }
}

// --- BUTON VE MODAL KONTROLLERİ ---
if (qs('#btnLogin')) {
    qs('#btnLogin').addEventListener('click', () => { 
        show(backdrop); 
        show(loginModal); 
    });
}

if (qs('#btnRegister')) {
    qs('#btnRegister').addEventListener('click', () => { 
        show(backdrop); 
        show(registerModal); 
    });
}

if (qs('#btnCloseLogin')) {
    qs('#btnCloseLogin').addEventListener('click', () => { 
        hide(backdrop); 
        hide(loginModal); 
    });
}

if (qs('#btnCloseReg')) {
    qs('#btnCloseReg').addEventListener('click', () => { 
        hide(backdrop); 
        hide(registerModal); 
    });
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
            
            if (!res.ok) {
                const errorText = await res.text();
                console.error('Login HTTP error:', res.status, errorText);
                alert("Giriş hatası: " + (errorText || res.status));
                return;
            }
            
            const data = await res.json();
            
            if (data.success) {
                // Token'i kaydet
                auth.setToken(data.token);
                
                hide(backdrop); 
                hide(loginModal);
                
                // Başarılı giriş mesajı
                alert("Başarıyla giriş yapıldı!");
                
                // Dashboard'a yönlendir
                window.location.href = '/dashboard.html';
            } else {
                alert("Hata: " + (data.error || 'Bilinmeyen hata'));
            }
        } catch(e) { 
            console.error('Login error:', e);
            alert("Sunucu hatası: " + e.message); 
        }
    });
}

// KAYIT OL
if (qs('#btnSubmitReg')) {
    qs('#btnSubmitReg').addEventListener('click', async () => {
        const email = qs('#regEmail').value;
        const pass = qs('#regPass').value;
        const plan = 'basic'; // Varsayılan plan
        
        if (!email || !pass) {
            alert("Email ve şifre gerekli!");
            return;
        }
        
        try {
            const res = await fetch('/api/register', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ email, password: pass, plan })
            });
            
            if (!res.ok) {
                const errorText = await res.text();
                console.error('Register HTTP error:', res.status, errorText);
                alert("Kayıt hatası: " + (errorText || res.status));
                return;
            }
            
            const data = await res.json();
            
            if(data.success) {
                alert("Kayıt Başarılı! Admin onayı bekleniyor. Giriş yapın.");
                hide(registerModal); 
                show(loginModal);
                
                // Formları temizle
                qs('#regEmail').value = '';
                qs('#regPass').value = '';
            } else {
                alert("Hata: " + (data.error || 'Bilinmeyen hata'));
            }
        } catch(e) { 
            console.error('Register error:', e);
            alert("Sunucu hatası: " + e.message); 
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
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('API request error:', error);
        throw error;
    }
}

// Dashboard özel fonksiyonları
if (window.location.pathname.includes('dashboard.html') || window.location.pathname === '/dashboard') {
    // Dashboard yüklendiğinde kullanıcı bilgilerini getir
    document.addEventListener('DOMContentLoaded', async () => {
        try {
            const userInfo = await apiRequest('/api/user/info');
            if (userInfo && userInfo.success) {
                // Kullanıcı bilgilerini göster
                const userEmailElement = qs('#userEmail');
                const userBalanceElement = qs('#userBalance');
                
                if (userEmailElement) {
                    userEmailElement.textContent = userInfo.user.email;
                }
                if (userBalanceElement) {
                    userBalanceElement.textContent = `$${userInfo.user.balance || '0.00'}`;
                }
            }
        } catch (error) {
            console.error('User info fetch error:', error);
        }
        
        // Sistem durumunu getir
        try {
            const status = await apiRequest('/api/status');
            if (status) {
                updateSystemStatus(status);
            }
        } catch (error) {
            console.error('Status fetch error:', error);
        }
    });
}

// Admin sayfası özel fonksiyonları
if (window.location.pathname.includes('admin.html')) {
    document.addEventListener('DOMContentLoaded', async () => {
        try {
            // Bekleyen kullanıcıları getir
            const pendingUsers = await apiRequest('/api/admin/pending-users');
            if (pendingUsers && pendingUsers.success) {
                renderPendingUsers(pendingUsers.users);
            }
            
            // Tüm kullanıcıları getir
            const allUsers = await apiRequest('/api/admin/all-users');
            if (allUsers && allUsers.success) {
                renderAllUsers(allUsers.users);
            }
        } catch (error) {
            console.error('Admin data fetch error:', error);
        }
    });
}

function renderPendingUsers(users) {
    const container = qs('#pendingUsers');
    if (!container) return;
    
    container.innerHTML = '';
    
    if (!users || users.length === 0) {
        container.innerHTML = '<div class="text-gray-400 text-center">No pending users</div>';
        return;
    }
    
    users.forEach(user => {
        const userEl = document.createElement('div');
        userEl.className = 'card p-4 mb-2';
        userEl.innerHTML = `
            <div class="flex justify-between items-center">
                <div>
                    <strong>${user.email}</strong>
                    <div class="text-sm text-gray-400">Plan: ${user.plan}</div>
                </div>
                <div class="flex gap-2">
                    <button onclick="approveUser(${user.id})" class="btn-success">Onayla</button>
                    <button onclick="rejectUser(${user.id})" class="btn-danger">Reddet</button>
                </div>
            </div>
        `;
        container.appendChild(userEl);
    });
}

function renderAllUsers(users) {
    const container = qs('#allUsers');
    if (!container) return;
    
    container.innerHTML = '';
    
    if (!users || users.length === 0) {
        container.innerHTML = '<div class="text-gray-400 text-center">No users</div>';
        return;
    }
    
    users.forEach(user => {
        const userEl = document.createElement('div');
        userEl.className = 'card p-4 mb-2';
        const statusClass = user.status === 'active' ? 'text-green-400' : 
                           user.status === 'pending' ? 'text-yellow-400' : 'text-red-400';
        userEl.innerHTML = `
            <div class="flex justify-between items-center">
                <div>
                    <strong>${user.email}</strong>
                    <div class="text-sm">
                        <span class="${statusClass}">${user.status}</span> • 
                        ${user.plan} • 
                        Balance: $${user.balance || '0'}
                    </div>
                </div>
                <button onclick="deleteUser(${user.id})" class="btn-danger">Sil</button>
            </div>
        `;
        container.appendChild(userEl);
    });
}

// Global admin fonksiyonları
window.approveUser = async (userId) => {
    try {
        const result = await apiRequest(`/api/admin/approve-user/${userId}`, {
            method: 'POST'
        });
        
        if (result && result.success) {
            alert('Kullanıcı onaylandı');
            location.reload();
        }
    } catch (error) {
        console.error('Approve user error:', error);
        alert('Onaylama hatası: ' + error.message);
    }
};

window.rejectUser = async (userId) => {
    try {
        const result = await apiRequest(`/api/admin/reject-user/${userId}`, {
            method: 'POST'
        });
        
        if (result && result.success) {
            alert('Kullanıcı reddedildi');
            location.reload();
        }
    } catch (error) {
        console.error('Reject user error:', error);
        alert('Reddetme hatası: ' + error.message);
    }
};

window.deleteUser = async (userId) => {
    if (!confirm('Bu kullanıcıyı silmek istediğinizden emin misiniz?')) return;
    
    try {
        const result = await apiRequest(`/api/admin/delete-user/${userId}`, {
            method: 'DELETE'
        });
        
        if (result && result.success) {
            alert('Kullanıcı silindi');
            location.reload();
        }
    } catch (error) {
        console.error('Delete user error:', error);
        alert('Silme hatası: ' + error.message);
    }
};
