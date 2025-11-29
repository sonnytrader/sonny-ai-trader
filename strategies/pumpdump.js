const BaseStrategy = require('./base_strategy');

class PumpDumpStrategy extends BaseStrategy {
    constructor() {
        super();
        this.name = 'PumpDump';
        this.description = 'Ani Hacim ve Fiyat Hareketi Tespiti';
        this.lastSignals = new Map();
    }

    async analyze(symbol, multiTFData, ticker) {
        // 5 dakikalık veriyi al
        const ohlcv5m = await this.fetchOHLCV(symbol, '5m', 30);
        if (!ohlcv5m || ohlcv5m.length < 20) return null;

        const now = Date.now();
        const lastSignal = this.lastSignals.get(symbol);
        // Aynı coine 10 dakika içinde tekrar pump sinyali verme
        if (lastSignal && (now - lastSignal) < global.CONFIG.pumpCooldownMs) return null;

        const currentCandle = ohlcv5m[ohlcv5m.length - 1];
        const prevCandle = ohlcv5m[ohlcv5m.length - 2];
        
        const currentClose = currentCandle[4];
        const prevClose = prevCandle[4];
        const currentVolume = currentCandle[5];

        // Son mum hariç ortalamayı hesapla
        const volumes = ohlcv5m.slice(0, -1).map(c => c[5]);
        const avgVolume = volumes.slice(-15).reduce((a, b) => a + b, 0) / 15;

        const priceChange = (currentClose - prevClose) / prevClose;
        const volumeRatio = currentVolume / avgVolume;

        // Optimize edilmiş eşik değerleri
        if (volumeRatio < global.CONFIG.pumpVolumeRatio || Math.abs(priceChange) < global.CONFIG.pumpPriceChange) return null;

        let direction = 'HOLD';
        let confidence = 60;

        // Pump (Yükseliş)
        if (priceChange > global.CONFIG.pumpPriceChange && volumeRatio > 2.5) {
            direction = 'LONG_PUMP';
            confidence += 20;
        } 
        // Dump (Düşüş)
        else if (priceChange < -global.CONFIG.pumpPriceChange && volumeRatio > 2.5) {
            direction = 'SHORT_DUMP';
            confidence += 20;
        }

        if (direction === 'HOLD') return null;

        // ATR ile Stop Loss ve Take Profit
        const indicators = this.calculateIndicators(ohlcv5m);
        const lastATR = indicators.atr[indicators.atr.length - 1] || (currentClose * 0.01);
        
        const slDist = lastATR * 2.0;
        const tpDist = lastATR * 3.0;

        let sl, tp;
        if (direction === 'LONG_PUMP') {
            sl = currentClose - slDist;
            tp = currentClose + tpDist;
        } else {
            sl = currentClose + slDist;
            tp = currentClose - tpDist;
        }

        this.lastSignals.set(symbol, now);

        return {
            direction: direction === 'LONG_PUMP' ? 'LONG' : 'SHORT',
            confidence: Math.round(confidence),
            entry: this.roundToTick(currentClose),
            stopLoss: this.roundToTick(sl),
            takeProfit: this.roundToTick(tp),
            riskReward: Number((tpDist / slDist).toFixed(2)),
            strategy: this.name,
            reasoning: `${direction === 'LONG_PUMP' ? 'Pump' : 'Dump'} Tespit! Değişim: %${(priceChange * 100).toFixed(2)} | Hacim: ${volumeRatio.toFixed(1)}x`
        };
    }

    async fetchOHLCV(symbol, timeframe, limit = 100) {
        const key = `${symbol}_${timeframe}`;
        const cached = global.ohlcvCache.get(key);
        if (cached && (Date.now() - cached.ts < 120000)) return cached.data;
        
        try {
            const data = await global.requestQueue.push(() => global.publicExchange.fetchOHLCV(symbol, timeframe, undefined, limit));
            if (data && data.length) global.ohlcvCache.set(key, { data, ts: Date.now() });
            return data;
        } catch (e) {
            console.log(`   ❌ OHLCV hatası ${symbol}:`, e.message);
            return null;
        }
    }
}

module.exports = PumpDumpStrategy;
