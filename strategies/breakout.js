const BaseStrategy = require('./base_strategy');

class BreakoutStrategy extends BaseStrategy {
    constructor() {
        super();
        this.name = 'Breakout';
        this.description = 'Support/Resistance Breakout Strategy';
    }

    async analyze(symbol, multiTFData, ticker, snr) {
        const ohlcv15m = multiTFData['15m'];
        const ohlcv1h = multiTFData['1h'];
        const currentPrice = ticker.last;
        
        const snrTolerance = currentPrice * (global.CONFIG.snrTolerancePercent / 100);
        const nearSupport = Math.abs(currentPrice - snr.support) <= snrTolerance;
        const nearResistance = Math.abs(currentPrice - snr.resistance) <= snrTolerance;

        if (!nearSupport && !nearResistance) return null;

        const marketStructure = this.analyzeMarketStructure(ohlcv1h);
        const indicators = this.calculateIndicators(ohlcv15m);

        if (!indicators.ema9.length || !indicators.adx.length) return null;

        const lastEMA9 = indicators.ema9[indicators.ema9.length - 1];
        const lastEMA21 = indicators.ema21[indicators.ema21.length - 1];
        const lastRSI = indicators.rsi[indicators.rsi.length - 1];
        const lastADX = indicators.adx[indicators.adx.length - 1]?.adx || 0;
        const lastATR = indicators.atr[indicators.atr.length - 1];
        const volumeRatio = this.calculateVolumeRatio(indicators.volumes, 20);

        let direction = 'HOLD';
        let confidence = 60;

        if (nearResistance && lastEMA9 > lastEMA21 && marketStructure !== 'BEARISH') {
            direction = 'LONG_BREAKOUT';
            confidence += 15;
        } else if (nearSupport && lastEMA9 < lastEMA21 && marketStructure !== 'BULLISH') {
            direction = 'SHORT_BREAKOUT';
            confidence += 15;
        }

        if (direction === 'HOLD') return null;

        if (lastADX > global.CONFIG.minTrendStrength) confidence += 10;
        if (volumeRatio > 1.5) confidence += 8;
        if ((direction === 'LONG_BREAKOUT' && lastRSI < 65) || (direction === 'SHORT_BREAKOUT' && lastRSI > 35)) {
            confidence += 7;
        }

        const slDist = lastATR * global.CONFIG.atrSLMultiplier;
        const tpDist = lastATR * global.CONFIG.atrTPMultiplier;

        let entryPrice, sl_final, tp1_final;
        if (direction === 'LONG_BREAKOUT') {
            entryPrice = snr.resistance;
            sl_final = entryPrice - slDist;
            tp1_final = entryPrice + tpDist;
        } else {
            entryPrice = snr.support;
            sl_final = entryPrice + slDist;
            tp1_final = entryPrice - tpDist;
        }

        const risk = Math.abs(entryPrice - sl_final);
        const reward = Math.abs(tp1_final - entryPrice);
        const rr = reward / risk;

        return {
            direction: direction,
            confidence: Math.round(confidence),
            entry: this.roundToTick(entryPrice),
            stopLoss: this.roundToTick(sl_final),
            takeProfit: this.roundToTick(tp1_final),
            riskReward: Number(rr.toFixed(2)),
            strategy: this.name,
            reasoning: `${direction === 'LONG_BREAKOUT' ? 'Direnç' : 'Destek'} kırılımı - ADX:${lastADX.toFixed(1)} Hacim:${volumeRatio.toFixed(1)}x`
        };
    }
}

module.exports = BreakoutStrategy;
