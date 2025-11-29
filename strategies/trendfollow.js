const BaseStrategy = require('./base_strategy');

class TrendFollowStrategy extends BaseStrategy {
    constructor() {
        super();
        this.name = 'TrendFollow';
        this.description = 'Trend Following Strategy';
    }

    async analyze(symbol, multiTFData, ticker) {
        const ohlcv1h = multiTFData['1h'];
        if (!ohlcv1h || ohlcv1h.length < 50) return null;

        const indicators = this.calculateIndicators(ohlcv1h);

        if (!indicators.ema20 || !indicators.ema50) return null;

        const last = {
            ema20: indicators.ema20[indicators.ema20.length - 1],
            ema50: indicators.ema50[indicators.ema50.length - 1],
            rsi: indicators.rsi[indicators.rsi.length - 1],
            adx: indicators.adx[indicators.adx.length - 1]?.adx || 0,
            macd: indicators.macd[indicators.macd.length - 1],
            price: ticker.last
        };

        let direction = 'HOLD';
        let confidence = 55;

        if (last.ema20 > last.ema50 && last.adx > global.CONFIG.minTrendStrength && last.rsi < 70) {
            direction = 'LONG_TREND';
            confidence = 70;
        } else if (last.ema20 < last.ema50 && last.adx > global.CONFIG.minTrendStrength && last.rsi > 30) {
            direction = 'SHORT_TREND';
            confidence = 70;
        }

        if (direction === 'HOLD') return null;

        if (last.adx > 35) confidence += 10;
        if (last.macd && last.macd.MACD > last.macd.signal && direction === 'LONG_TREND') confidence += 8;
        if (last.macd && last.macd.MACD < last.macd.signal && direction === 'SHORT_TREND') confidence += 8;

        const lastATR = indicators.atr[indicators.atr.length - 1];
        const slDist = lastATR * 2.0;
        const tpDist = lastATR * 3.0;

        let sl, tp;
        if (direction === 'LONG_TREND') {
            sl = last.price - slDist;
            tp = last.price + tpDist;
        } else {
            sl = last.price + slDist;
            tp = last.price - tpDist;
        }

        const risk = Math.abs(last.price - sl);
        const reward = Math.abs(tp - last.price);
        const rr = reward / risk;

        return {
            direction: direction === 'LONG_TREND' ? 'LONG' : 'SHORT',
            confidence: Math.round(confidence),
            entry: this.roundToTick(last.price),
            stopLoss: this.roundToTick(sl),
            takeProfit: this.roundToTick(tp),
            riskReward: Number(rr.toFixed(2)),
            strategy: this.name,
            reasoning: `Trend takip - ${direction === 'LONG_TREND' ? 'Yükseliş' : 'Düşüş'} trendi, ADX:${last.adx.toFixed(1)}`
        };
    }
}

module.exports = TrendFollowStrategy;
