<!DOCTYPE html>
<html lang="tr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TrendMaster AI Trader</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
            background: linear-gradient(135deg, #0c0c0c 0%, #1a1a2e 50%, #16213e 100%);
            color: #fff; 
            min-height: 100vh;
        }
        
        .container { 
            max-width: 1400px; 
            margin: 0 auto; 
            padding: 20px; 
        }
        
        .header { 
            text-align: center; 
            margin-bottom: 30px; 
            padding: 20px;
            background: rgba(255,255,255,0.05);
            border-radius: 15px;
            border: 1px solid rgba(255,255,255,0.1);
        }
        
        .header h1 { 
            font-size: 2.5em; 
            margin-bottom: 10px; 
            background: linear-gradient(45deg, #00ff88, #00ccff);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        
        .status-bar {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-bottom: 30px;
        }
        
        .status-card {
            background: rgba(255,255,255,0.08);
            padding: 20px;
            border-radius: 12px;
            border: 1px solid rgba(255,255,255,0.1);
            text-align: center;
        }
        
        .status-card h3 {
            font-size: 0.9em;
            color: #aaa;
            margin-bottom: 8px;
        }
        
        .status-card .value {
            font-size: 1.4em;
            font-weight: bold;
        }
        
        .online { color: #00ff88; }
        .offline { color: #ff4444; }
        .warning { color: #ffaa00; }
        
        .main-content {
            display: grid;
            grid-template-columns: 1fr 400px;
            gap: 20px;
        }
        
        .signals-section {
            background: rgba(255,255,255,0.05);
            border-radius: 15px;
            padding: 20px;
            border: 1px solid rgba(255,255,255,0.1);
        }
        
        .controls-section {
            background: rgba(255,255,255,0.05);
            border-radius: 15px;
            padding: 20px;
            border: 1px solid rgba(255,255,255,0.1);
        }
        
        .section-title {
            font-size: 1.3em;
            margin-bottom: 20px;
            padding-bottom: 10px;
            border-bottom: 2px solid rgba(255,255,255,0.2);
        }
        
        .signal-grid {
            display: grid;
            gap: 12px;
            max-height: 600px;
            overflow-y: auto;
        }
        
        .signal-card {
            background: rgba(255,255,255,0.08);
            border-radius: 10px;
            padding: 15px;
            border: 1px solid rgba(255,255,255,0.1);
            transition: all 0.3s ease;
        }
        
        .signal-card:hover {
            transform: translateY(-2px);
            border-color: rgba(0, 255, 136, 0.3);
        }
        
        .signal-header {
            display: flex;
            justify-content: between;
            align-items: center;
            margin-bottom: 10px;
        }
        
        .coin-name {
            font-weight: bold;
            font-size: 1.1em;
        }
        
        .signal-direction {
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 0.8em;
            font-weight: bold;
        }
        
        .long { background: rgba(0, 255, 136, 0.2); color: #00ff88; }
        .short { background: rgba(255, 68, 68, 0.2); color: #ff4444; }
        
        .signal-details {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8px;
            font-size: 0.9em;
        }
        
        .detail-item {
            display: flex;
            justify-content: space-between;
        }
        
        .confidence-bar {
            height: 6px;
            background: rgba(255,255,255,0.1);
            border-radius: 3px;
            margin-top: 5px;
            overflow: hidden;
        }
        
        .confidence-fill {
            height: 100%;
            border-radius: 3px;
            transition: width 0.3s ease;
        }
        
        .high-confidence { background: linear-gradient(90deg, #00ff88, #00ccff); }
        .medium-confidence { background: linear-gradient(90deg, #ffaa00, #ffcc00); }
        .low-confidence { background: linear-gradient(90deg, #ff4444, #ff6666); }
        
        .control-group {
            margin-bottom: 20px;
        }
        
        .control-label {
            display: block;
            margin-bottom: 8px;
            color: #aaa;
        }
        
        .control-input {
            width: 100%;
            padding: 10px;
            border-radius: 8px;
            border: 1px solid rgba(255,255,255,0.2);
            background: rgba(255,255,255,0.1);
            color: white;
        }
        
        .btn {
            width: 100%;
            padding: 12px;
            border: none;
            border-radius: 8px;
            font-size: 1em;
            font-weight: bold;
            cursor: pointer;
            transition: all 0.3s ease;
            margin-bottom: 10px;
        }
        
        .btn-primary {
            background: linear-gradient(45deg, #00ff88, #00ccff);
            color: #000;
        }
        
        .btn-danger {
            background: linear-gradient(45deg, #ff4444, #ff6666);
            color: white;
        }
        
        .btn:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }
        
        .connection-status {
            padding: 10px;
            border-radius: 8px;
            text-align: center;
            margin-bottom: 20px;
        }
        
        .connected { background: rgba(0, 255, 136, 0.2); color: #00ff88; }
        .disconnected { background: rgba(255, 68, 68, 0.2); color: #ff4444; }
        .connecting { background: rgba(255, 170, 0, 0.2); color: #ffaa00; }
        
        .signal-status {
            font-size: 0.8em;
            padding: 2px 8px;
            border-radius: 10px;
            margin-left: 10px;
        }
        
        .active { background: rgba(0, 255, 136, 0.2); color: #00ff88; }
        .old { background: rgba(255, 170, 0, 0.2); color: #ffaa00; }
        .expired { background: rgba(255, 68, 68, 0.2); color: #ff4444; }
        
        .tradingview-link {
            color: #00ccff;
            text-decoration: none;
            font-size: 0.8em;
        }
        
        .tradingview-link:hover {
            text-decoration: underline;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🚀 TrendMaster AI Trader</h1>
            <p>Advanced Multi-Timeframe Trading Bot</p>
        </div>
        
        <div class="status-bar">
            <div class="status-card">
                <h3>Bağlantı Durumu</h3>
                <div id="connectionStatus" class="value connecting">BAĞLANIYOR...</div>
            </div>
            <div class="status-card">
                <h3>Aktif Sinyaller</h3>
                <div id="activeSignals" class="value">0</div>
            </div>
            <div class="status-card">
                <h3>Toplam Sinyal</h3>
                <div id="totalSignals" class="value">0</div>
            </div>
            <div class="status-card">
                <h3>Bakiye</h3>
                <div id="balance" class="value">$0</div>
            </div>
            <div class="status-card">
                <h3>Piyasa Durumu</h3>
                <div id="marketSentiment" class="value">ANALİZ EDİLİYOR</div>
            </div>
        </div>
        
        <div class="main-content">
            <div class="signals-section">
                <h2 class="section-title">🎯 AI Trading Sinyalleri</h2>
                <div id="signalsContainer" class="signal-grid">
                    <div class="signal-card" style="text-align: center; padding: 40px; color: #aaa;">
                        Sinyal bekleniyor...
                    </div>
                </div>
            </div>
            
            <div class="controls-section">
                <h2 class="section-title">⚙️ Kontroller</h2>
                
                <div class="connection-status connecting" id="wsStatus">
                    WebSocket bağlantısı kuruluyor...
                </div>
                
                <div class="control-group">
                    <label class="control-label">AutoTrade Modu</label>
                    <button id="toggleAutotrade" class="btn btn-primary" onclick="toggleAutotrade()">
                        AUTO TRADE: KAPALI
                    </button>
                </div>
                
                <div class="control-group">
                    <label class="control-label">Min Güven Oranı (%)</label>
                    <input type="number" id="minConfidence" class="control-input" value="75" min="50" max="95">
                </div>
                
                <div class="control-group">
                    <label class="control-label">Kaldıraç</label>
                    <input type="number" id="leverage" class="control-input" value="10" min="1" max="20">
                </div>
                
                <div class="control-group">
                    <label class="control-label">Pozisyon Büyüklüğü (%)</label>
                    <input type="number" id="marginPercent" class="control-input" value="5" min="1" max="20">
                </div>
                
                <button class="btn btn-primary" onclick="updateConfig()">
                    AYARLARI GÜNCELLE
                </button>
                
                <button class="btn btn-danger" onclick="emergencyStop()">
                    🚨 ACİL DURDUR
                </button>
                
                <div class="control-group" style="margin-top: 30px;">
                    <h3 style="color: #aaa; margin-bottom: 15px;">Sistem Bilgisi</h3>
                    <div id="systemInfo" style="font-size: 0.9em; color: #888;">
                        Sistem başlatılıyor...
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script>
        let ws = null;
        let isConnected = false;
        let signals = [];
        let systemStatus = {};
        
        function connectWebSocket() {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = `${protocol}//${window.location.host}`;
            
            ws = new WebSocket(wsUrl);
            
            ws.onopen = function() {
                console.log('✅ WebSocket bağlantısı kuruldu');
                isConnected = true;
                updateConnectionStatus('connected', 'BAĞLANDI');
                document.getElementById('wsStatus').textContent = '✅ WebSocket bağlantısı kuruldu';
                document.getElementById('wsStatus').className = 'connection-status connected';
            };
            
            ws.onmessage = function(event) {
                try {
                    const data = JSON.parse(event.data);
                    handleWebSocketMessage(data);
                } catch (error) {
                    console.error('WebSocket mesaj işleme hatası:', error);
                }
            };
            
            ws.onclose = function() {
                console.log('❌ WebSocket bağlantısı kapandı');
                isConnected = false;
                updateConnectionStatus('disconnected', 'BAĞLANTI KESİLDİ');
                document.getElementById('wsStatus').textContent = '❌ WebSocket bağlantısı kapandı - Yeniden bağlanılıyor...';
                document.getElementById('wsStatus').className = 'connection-status disconnected';
                
                // 3 saniye sonra yeniden bağlan
                setTimeout(connectWebSocket, 3000);
            };
            
            ws.onerror = function(error) {
                console.error('WebSocket hatası:', error);
                updateConnectionStatus('error', 'BAĞLANTI HATASI');
            };
        }
        
        function handleWebSocketMessage(data) {
            switch(data.type) {
                case 'connection':
                    console.log('Server mesajı:', data.data.message);
                    break;
                    
                case 'signal':
                    updateSignal(data.data);
                    break;
                    
                default:
                    console.log('Bilinmeyen mesaj tipi:', data.type);
            }
        }
        
        function updateSignal(signal) {
            // Sinyali güncelle veya ekle
            const existingIndex = signals.findIndex(s => s.id === signal.id);
            if (existingIndex >= 0) {
                signals[existingIndex] = signal;
            } else {
                signals.unshift(signal);
            }
            
            // Sinyalleri tarihe göre sırala (yeniden eskiye)
            signals.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
            
            // En son 50 sinyali tut
            signals = signals.slice(0, 50);
            
            renderSignals();
            updateStatusBar();
        }
        
        function renderSignals() {
            const container = document.getElementById('signalsContainer');
            
            if (signals.length === 0) {
                container.innerHTML = `
                    <div class="signal-card" style="text-align: center; padding: 40px; color: #aaa;">
                        🤖 Sinyal taraması devam ediyor...<br>
                        <small>AI sistemimiz piyasayı analiz ediyor</small>
                    </div>
                `;
                return;
            }
            
            container.innerHTML = signals.map(signal => `
                <div class="signal-card">
                    <div class="signal-header">
                        <div class="coin-name">${signal.coin}</div>
                        <div class="signal-direction ${signal.taraf.toLowerCase()}">
                            ${signal.taraf}
                        </div>
                    </div>
                    
                    <div class="signal-details">
                        <div class="detail-item">
                            <span>Giriş:</span>
                            <span>${signal.giris}</span>
                        </div>
                        <div class="detail-item">
                            <span>TP/SL:</span>
                            <span>${signal.tp1} / ${signal.sl}</span>
                        </div>
                        <div class="detail-item">
                            <span>R/R:</span>
                            <span>${signal.riskReward}</span>
                        </div>
                        <div class="detail-item">
                            <span>Güven:</span>
                            <span>%${signal.confidence}</span>
                        </div>
                    </div>
                    
                    <div class="confidence-bar">
                        <div class="confidence-fill ${getConfidenceClass(signal.confidence)}" 
                             style="width: ${signal.confidence}%"></div>
                    </div>
                    
                    <div style="margin-top: 10px; font-size: 0.8em; color: #aaa;">
                        ${signal.tuyo}
                        <br>
                        <span class="signal-status ${getStatusClass(signal.status)}">
                            ${getStatusText(signal.status, signal.timestamp)}
                        </span>
                        ${signal.refreshCount > 0 ? `<span style="color: #00ccff;"> • ${signal.refreshCount}x yenilendi</span>` : ''}
                    </div>
                    
                    <div style="margin-top: 8px; text-align: center;">
                        <a href="https://www.tradingview.com/chart/?symbol=BITGET:${signal.ccxt_symbol.replace('/USDT', 'USDT')}" 
                           target="_blank" class="tradingview-link">
                           📊 TradingView'de aç
                        </a>
                        <button onclick="manualTrade('${signal.id}')" 
                                style="margin-left: 10px; padding: 4px 8px; background: #00ccff; border: none; border-radius: 4px; color: black; font-size: 0.7em; cursor: pointer;">
                            🚀 MANUEL TRADE
                        </button>
                    </div>
                </div>
            `).join('');
        }
        
        function getConfidenceClass(confidence) {
            if (confidence >= 75) return 'high-confidence';
            if (confidence >= 65) return 'medium-confidence';
            return 'low-confidence';
        }
        
        function getStatusClass(status) {
            switch(status) {
                case 'ACTIVE': return 'active';
                case 'OLD': return 'old';
                case 'EXPIRED': return 'expired';
                default: return 'expired';
            }
        }
        
        function getStatusText(status, timestamp) {
            const now = Date.now();
            const diff = now - timestamp;
            const minutes = Math.floor(diff / (1000 * 60));
            
            switch(status) {
                case 'ACTIVE': return `AKTİF (${minutes} dk önce)`;
                case 'OLD': return `FIRSAT KAÇTI (${minutes} dk)`;
                case 'EXPIRED': return `SÜRESİ DOLDU (${minutes} dk)`;
                default: return `Bilinmeyen (${minutes} dk)`;
            }
        }
        
        function updateConnectionStatus(status, text) {
            const element = document.getElementById('connectionStatus');
            element.textContent = text;
            element.className = `value ${status}`;
        }
        
        function updateStatusBar() {
            document.getElementById('activeSignals').textContent = signals.filter(s => s.status === 'ACTIVE').length;
            document.getElementById('totalSignals').textContent = signals.length;
        }
        
        async function fetchSystemStatus() {
            try {
                const response = await fetch('/api/status');
                const data = await response.json();
                systemStatus = data;
                
                document.getElementById('balance').textContent = `$${data.system.balance.toFixed(2)}`;
                document.getElementById('marketSentiment').textContent = data.system.marketSentiment;
                document.getElementById('minConfidence').value = data.config.minConfidenceForAuto || 75;
                document.getElementById('leverage').value = data.config.leverage || 10;
                document.getElementById('marginPercent').value = data.config.marginPercent || 5;
                
                // Aktif sinyalleri de güncelle
                if (data.activeSignals && Array.isArray(data.activeSignals)) {
                    data.activeSignals.forEach(signal => updateSignal(signal));
                }
                
                // AutoTrade butonunu güncelle
                const autotradeBtn = document.getElementById('toggleAutotrade');
                autotradeBtn.textContent = `AUTO TRADE: ${data.config.autotradeMaster ? 'AÇIK' : 'KAPALI'}`;
                autotradeBtn.style.background = data.config.autotradeMaster ? 
                    'linear-gradient(45deg, #00ff88, #00ccff)' : 
                    'linear-gradient(45deg, #666, #888)';
                    
            } catch (error) {
                console.error('Status fetch hatası:', error);
            }
        }
        
        async function toggleAutotrade() {
            try {
                const response = await fetch('/api/config/update', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        autotradeMaster: !systemStatus.config.autotradeMaster 
                    })
                });
                
                await fetchSystemStatus(); // Durumu yenile
            } catch (error) {
                console.error('AutoTrade toggle hatası:', error);
            }
        }
        
        async function updateConfig() {
            try {
                const response = await fetch('/api/config/update', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        minConfidenceForAuto: parseInt(document.getElementById('minConfidence').value),
                        leverage: parseInt(document.getElementById('leverage').value),
                        marginPercent: parseInt(document.getElementById('marginPercent').value)
                    })
                });
                
                alert('Ayarlar güncellendi!');
                await fetchSystemStatus();
            } catch (error) {
                console.error('Config update hatası:', error);
                alert('Ayarlar güncellenirken hata oluştu!');
            }
        }
        
        async function manualTrade(signalId) {
            const signal = signals.find(s => s.id === signalId);
            if (!signal) {
                alert('Sinyal bulunamadı!');
                return;
            }
            
            if (!confirm(`${signal.coin} ${signal.taraf} işlemini manuel olarak açmak istediğinize emin misiniz?`)) {
                return;
            }
            
            try {
                const response = await fetch('/api/trade/manual', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(signal)
                });
                
                const result = await response.json();
                if (result.success) {
                    alert('Manuel işlem emri gönderildi!');
                } else {
                    alert('İşlem gönderilemedi: ' + (result.error || 'Bilinmeyen hata'));
                }
            } catch (error) {
                console.error('Manual trade hatası:', error);
                alert('İşlem gönderilirken hata oluştu!');
            }
        }
        
        async function emergencyStop() {
            if (!confirm('🚨 TÜM OTOMATİK İŞLEMLER DURDURULACAK! Emin misiniz?')) {
                return;
            }
            
            try {
                const response = await fetch('/api/config/update', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ autotradeMaster: false })
                });
                
                alert('🛑 ACİL DURDURMA AKTİF! Tüm otomatik işlemler durduruldu.');
                await fetchSystemStatus();
            } catch (error) {
                console.error('Emergency stop hatası:', error);
                alert('Acil durdurma sırasında hata oluştu!');
            }
        }
        
        // Sayfa yüklendiğinde başlat
        document.addEventListener('DOMContentLoaded', function() {
            connectWebSocket();
            fetchSystemStatus();
            
            // Her 10 saniyede bir durumu güncelle
            setInterval(fetchSystemStatus, 10000);
        });
    </script>
</body>
</html>
