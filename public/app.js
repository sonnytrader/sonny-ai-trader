const qs = (s) => document.querySelector(s);
const loginModal = qs('#loginModal');
const dashboard = qs('#dashboard');
const signalBox = qs('#signals');

// WebSocket Başlat
function startSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}`);

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'signal_list') {
            updateSignals(msg.data);
        }
    };
}

function updateSignals(list) {
    signalBox.innerHTML = '';
    list.forEach(s => {
        const el = document.createElement('div');
        el.className = 'card rounded-lg p-3 flex justify-between border-l-4 ' + (s.direction === 'LONG' ? 'border-green-500' : 'border-red-500');
        el.innerHTML = `
            <div><b>${s.symbol}</b> <span class="${s.direction === 'LONG'?'text-green-400':'text-red-400'}">${s.direction}</span></div>
            <div class="text-sm">Giriş: ${s.price}</div>
        `;
        signalBox.appendChild(el);
    });
}

// Login Butonu
qs('#btnSubmitLogin').addEventListener('click', async () => {
    const email = qs('#loginEmail').value;
    const pass = qs('#loginPass').value;
    
    const res = await fetch('/api/login', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ email, password: pass })
    });
    
    const data = await res.json();
    if (data.success) {
        qs('#loginModal').style.display = 'none';
        qs('#dashboard').style.display = 'block';
        startSocket(); // Giriş başarılıysa canlı veriyi aç
    } else {
        alert(data.error);
    }
});

// Modal Açma/Kapama (Mevcut kodlarından uyarlandı)
qs('#btnLogin').addEventListener('click', () => qs('#loginModal').style.display = 'flex');
qs('#btnCloseLogin').addEventListener('click', () => qs('#loginModal').style.display = 'none');
