const BreakoutStrategy = require('./breakout');
const TrendFollowStrategy = require('./trendfollow');
const PumpDumpStrategy = require('./pumpdump');
const BaseStrategy = require('./base_strategy');

class StrategyManager {
    constructor() {
        this.strategies = {
            breakout: new BreakoutStrategy(),
            trendfollow: new TrendFollowStrategy(),
            pumpdump: new PumpDumpStrategy()
        };
        this.activeStrategies = new Set(['breakout', 'trendfollow', 'pumpdump']);
    }

    setStrategyActive(strategyName, isActive) {
        if (isActive) {
            this.activeStrategies.add(strategyName);
        } else {
            this.activeStrategies.delete(strategyName);
        }
    }

    getActiveStrategies() {
        return Array.from(this.activeStrategies).map(name => ({
            name,
            instance: this.strategies[name],
            description: this.strategies[name].description
        }));
    }

    async analyzeSymbol(symbol, multiTFData, ticker, snr) {
        if (!this.isOptimalTradingTime()) return null;

        const lastSignalTime = global.signalHistory.get(symbol) || 0;
        if (Date.now() - lastSignalTime < global.CONFIG.signalCooldownMs) return null;

        if (!ticker || ticker.last < global.CONFIG.minPrice) return null;

        const strategyResults = [];

        for (const strategyName of this.activeStrategies) {
            try {
                const strategy = this.strategies[strategyName];
                const result = await strategy.analyze(symbol, multiTFData, ticker, snr);
                if (result && result.confidence >= 50) {
                    strategyResults.push(result);
                }
            } catch (error) {
                console.log(`   ❌ ${strategyName} analiz hatası:`, error.message);
            }
        }

        if (strategyResults.length === 0) return null;

        const bestResult = strategyResults.reduce((best, current) => 
            current.confidence > best.confidence ? current : best
        );

        const volumeInfo = await this.confirmBreakoutWithVolume(symbol, bestResult.entry, bestResult.direction);

        let finalConfidence = bestResult.confidence;
        if (volumeInfo.strength === 'STRONG') finalConfidence += 10;
        else if (volumeInfo.strength === 'MEDIUM') finalConfidence += 5;

        global.signalHistory.set(symbol, Date.now());
        global.systemStatus.performance.totalSignals++;

        return this.formatSignal(symbol, bestResult, finalConfidence, volumeInfo);
    }

    async confirmBreakoutWithVolume(symbol, breakoutLevel, direction) {
        const recentOhlcv = await this.fetchOHLCV(symbol, '5m', 15);
        if (!recentOhlcv || recentOhlcv.length < 10) {
            return { confirmed: false, strength: 'WEAK', ratio: 0 };
        }
        const breakoutCandle = recentOhlcv[recentOhlcv.length - 1];
        
        const previousVolumes = recentOhlcv.slice(0, -1).map(c => c[5]); 
        const avgVolume = previousVolumes.reduce((a, b) => a + b, 0) / previousVolumes.length;
        
        const volumeRatio = breakoutCandle[5] / avgVolume;
        
        let volumeConfirmed = volumeRatio > global.CONFIG.volumeConfirmationThreshold;
        let strength = 'WEAK';
        if (volumeRatio > 2.0) strength = 'STRONG';
        else if (volumeRatio > 1.5) strength = 'MEDIUM';
        
        return { confirmed: volumeConfirmed, strength: strength, ratio: volumeRatio };
    }

    formatSignal(symbol, bestResult, finalConfidence, volumeInfo) {
        return {
            id: `${symbol}_${bestResult.strategy}_${Date.now()}`,
            coin: this.cleanSymbol(symbol),
            ccxt_symbol: symbol,
            taraf: bestResult.direction.includes('LONG') ? 'LONG_BREAKOUT' : 'SHORT_BREAKOUT',
            giris: bestResult.entry,
            tp1: bestResult.takeProfit,
            sl: bestResult.stopLoss,
            riskReward: bestResult.riskReward,
            confidence: Math.round(finalConfidence),
            positionSize: 1.0,
            positionSizeType: 'NORMAL',
            riskLevel: finalConfidence >= 75 ? 'LOW' : 'MEDIUM',
            tuyo: `${bestResult.strategy}: ${bestResult.reasoning} | Hacim: ${volumeInfo.strength} (${volumeInfo.ratio.toFixed(2)}x)`,
            timestamp: Date.now(),
            adx: 0,
            rsi: 0,
            obvTrend: '→',
            signalQuality: Math.round(finalConfidence),
            marketStructure: 'ANALYZED',
            volumeConfirmed: volumeInfo.confirmed,
            signalSource: bestResult.strategy,
            isAISignal: false,
            orderType: 'limit'
        };
    }

    // Helper functions
    isOptimalTradingTime() {
        if (!global.CONFIG.enableTimeFilter) return true;
        const hour = new Date().getUTCHours();
        return global.CONFIG.optimalTradingHours.includes(hour);
    }

    cleanSymbol(symbol) {
        if (!symbol) return '';
        const parts = symbol.split('/');
        return parts[0] + '/USDT';
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

    roundToTick(price) {
        if (!price || isNaN(price)) return 0;
        if (price < 0.00001) return Number(price.toFixed(8));
        if (price < 0.001) return Number(price.toFixed(7));
        if (price < 1) return Number(price.toFixed(5));
        if (price < 10) return Number(price.toFixed(4));
        return Number(price.toFixed(2));
    }
}

module.exports = StrategyManager;
