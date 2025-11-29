const { EMA, RSI, ADX, ATR, MACD } = require('technicalindicators');

class BaseStrategy {
    constructor() {
        if (new.target === BaseStrategy) {
            throw new Error("BaseStrategy abstract class cannot be instantiated directly");
        }
        this.name = 'Base';
        this.description = 'Base Strategy Class';
    }

    async analyze(symbol, multiTFData, ticker, snr) {
        throw new Error("Analyze method must be implemented by subclass");
    }

    calculateIndicators(ohlcv) {
        const closes = ohlcv.map(c => c[4]);
        const highs = ohlcv.map(c => c[2]);
        const lows = ohlcv.map(c => c[3]);
        const volumes = ohlcv.map(c => c[5]);

        const ema9 = EMA.calculate({ period: 9, values: closes });
        const ema21 = EMA.calculate({ period: 21, values: closes });
        const rsi = RSI.calculate({ period: 14, values: closes });
        const adx = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
        const atr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
        const macd = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });

        return {
            ema9, ema21, rsi, adx, atr, macd,
            closes, highs, lows, volumes
        };
    }

    calculateVolumeRatio(volumes, period = 20) {
        if (!volumes || volumes.length < period) return 1;
        const currentVolume = volumes[volumes.length - 1];
        const recentVolumes = volumes.slice(-period);
        const avgVolume = recentVolumes.reduce((sum, vol) => sum + vol, 0) / recentVolumes.length;
        return currentVolume / avgVolume;
    }

    analyzeMarketStructure(ohlcv) {
        if (!ohlcv || ohlcv.length < 10) return "RANGING";
        const highs = ohlcv.map(c => c[2]);
        const lows = ohlcv.map(c => c[3]);
        const lastHigh = Math.max(...highs.slice(-5));
        const prevHigh = Math.max(...highs.slice(-10, -5));
        const lastLow = Math.min(...lows.slice(-5));
        const prevLow = Math.min(...lows.slice(-10, -5));
        if (lastHigh > prevHigh && lastLow > prevLow) return "BULLISH";
        if (lastHigh < prevHigh && lastLow < prevLow) return "BEARISH";
        return "RANGING";
    }

    findSimpleSnR(ohlcv) {
        if (!ohlcv || ohlcv.length < 20) return { support: 0, resistance: 0 };
        const recentCandles = ohlcv.slice(-20);
        const highs = recentCandles.map(c => c[2]);
        const lows = recentCandles.map(c => c[3]);
        const support = Math.min(...lows);
        const resistance = Math.max(...highs);
        return {
            support: this.roundToTick(support),
            resistance: this.roundToTick(resistance),
            quality: Math.abs(resistance - support) / ((resistance + support) / 2)
        };
    }

    roundToTick(price) {
        if (!price || isNaN(price)) return 0;
        if (price < 0.00001) return Number(price.toFixed(8));
        if (price < 0.001) return Number(price.toFixed(7));
        if (price < 1) return Number(price.toFixed(5));
        if (price < 10) return Number(price.toFixed(4));
        return Number(price.toFixed(2));
    }
}

module.exports = BaseStrategy;
