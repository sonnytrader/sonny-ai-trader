// ========================= YENİ SİNYAL MANTIĞI =========================
// LIQUIDITY SWEEP + FVG STRATEJİSİ

function detectLiquiditySweep(candles, trend1h) {
    const c = closed(candles);
    if (c.length < 50) return null;
    
    // Son 20 mumu analiz et
    const recent = c.slice(-20);
    const lastIndex = recent.length - 1;
    const last = recent[lastIndex];
    const prev = recent[lastIndex - 1];
    const prev2 = recent[lastIndex - 2];
    
    // Fiyat seviyeleri
    const lastOpen = n(last[1]);
    const lastClose = n(last[4]);
    const lastHigh = n(last[2]);
    const lastLow = n(last[3]);
    const lastVolume = n(last[5]);
    
    // Önceki mumların yüksek/düşük seviyeleri
    const prevHigh = n(prev[2]);
    const prevLow = n(prev[3]);
    const prev2High = n(prev2[2]);
    const prev2Low = n(prev2[3]);
    
    // Son 10 mumun ortalama hacmi
    const volHistory = recent.slice(-10, -1).map(x => n(x[5]));
    const avgVol = avg(volHistory.filter(Boolean));
    const volumeSurge = avgVol > 0 ? lastVolume / avgVol : 1;
    
    // Likidite bölgelerini bul (son 50 mumun high/low'ları)
    const highs = c.slice(-50, -1).map(x => n(x[2]));
    const lows = c.slice(-50, -1).map(x => n(x[3]));
    const majorHigh = Math.max(...highs);
    const majorLow = Math.min(...lows);
    const range = majorHigh - majorLow;
    
    if (range <= 0) return null;
    
    // Denge noktası (Equilibrium)
    const equilibrium = (majorHigh + majorLow) / 2;
    const currentPrice = lastClose;
    
    // Premium/Discount hesabı
    const discountZone = equilibrium - range * 0.25;
    const premiumZone = equilibrium + range * 0.25;
    
    let signal = null;
    
    // === LONG SİNYAL: Likidite Süpürmesi + FVG ===
    if (currentPrice < equilibrium && trend1h !== 'SHORT') {
        // Aşağı yönlü likidite süpürmesi ara
        const sweepDetected = lastLow < prevLow && lastClose > prevLow;
        const previousSweep = prevLow < prev2Low && prevClose > prev2Low;
        
        if (sweepDetected || previousSweep) {
            // FVG kontrolü (Bullish FVG)
            const fvg = findBullishFVG(recent.slice(-5));
            
            if (fvg || volumeSurge > 1.2) {
                const entry = lastClose;
                const atrValue = calculateATR(candles, 14);
                const stopDistance = Math.max(atrValue * 1.2, entry * 0.003);
                const stop = Math.min(lastLow, entry - stopDistance);
                
                const risk = entry - stop;
                if (risk > 0) {
                    const tp1 = entry + risk * 1.5;
                    const tp2 = entry + risk * 3.0;
                    
                    let score = 50;
                    if (currentPrice < discountZone) score += 20; // Discount bölgesinde
                    if (fvg) score += 15; // FVG var
                    if (volumeSurge > 1.5) score += 10;
                    if (sweepDetected) score += 10;
                    
                    if (score >= 60) {
                        signal = {
                            direction: 'LONG',
                            entry,
                            stop,
                            tp1,
                            tp2,
                            score,
                            bodyRatio: n(Math.abs(lastClose - lastOpen) / Math.max(lastHigh - lastLow, 0.0001)),
                            volumeSurge,
                            movePercent: n(Math.abs((lastClose - prevClose) / prevClose * 100)),
                            atr: atrValue,
                            time: n(last[0]),
                            pattern: fvg ? 'SWEEP+FVG' : 'SWEEP',
                            zone: currentPrice < discountZone ? 'DISCOUNT' : 'EQUILIBRIUM'
                        };
                    }
                }
            }
        }
    }
    
    // === SHORT SİNYAL: Likidite Süpürmesi + FVG ===
    if (!signal && currentPrice > equilibrium && trend1h !== 'LONG') {
        // Yukarı yönlü likidite süpürmesi ara
        const sweepDetected = lastHigh > prevHigh && lastClose < prevHigh;
        const previousSweep = prevHigh > prev2High && prevClose < prev2High;
        
        if (sweepDetected || previousSweep) {
            // FVG kontrolü (Bearish FVG)
            const fvg = findBearishFVG(recent.slice(-5));
            
            if (fvg || volumeSurge > 1.2) {
                const entry = lastClose;
                const atrValue = calculateATR(candles, 14);
                const stopDistance = Math.max(atrValue * 1.2, entry * 0.003);
                const stop = Math.max(lastHigh, entry + stopDistance);
                
                const risk = stop - entry;
                if (risk > 0) {
                    const tp1 = entry - risk * 1.5;
                    const tp2 = entry - risk * 3.0;
                    
                    let score = 50;
                    if (currentPrice > premiumZone) score += 20; // Premium bölgesinde
                    if (fvg) score += 15; // FVG var
                    if (volumeSurge > 1.5) score += 10;
                    if (sweepDetected) score += 10;
                    
                    if (score >= 60) {
                        signal = {
                            direction: 'SHORT',
                            entry,
                            stop,
                            tp1,
                            tp2,
                            score,
                            bodyRatio: n(Math.abs(lastClose - lastOpen) / Math.max(lastHigh - lastLow, 0.0001)),
                            volumeSurge,
                            movePercent: n(Math.abs((lastClose - prevClose) / prevClose * 100)),
                            atr: atrValue,
                            time: n(last[0]),
                            pattern: fvg ? 'SWEEP+FVG' : 'SWEEP',
                            zone: currentPrice > premiumZone ? 'PREMIUM' : 'EQUILIBRIUM'
                        };
                    }
                }
            }
        }
    }
    
    return signal;
}

// === FVG (Fair Value Gap) Tespiti ===
function findBullishFVG(candles) {
    // Bullish FVG: 3 mumda oluşur
    // 1. mumun high'ı < 3. mumun low'u
    for (let i = 0; i < candles.length - 2; i++) {
        const c1 = candles[i];
        const c2 = candles[i + 1];
        const c3 = candles[i + 2];
        
        const c1High = n(c1[2]);
        const c3Low = n(c3[3]);
        
        // FVG boşluğu
        if (c3Low > c1High) {
            return {
                top: c3Low,
                bottom: c1High,
                size: n(c3Low - c1High)
            };
        }
    }
    return null;
}

function findBearishFVG(candles) {
    // Bearish FVG: 3 mumda oluşur
    // 1. mumun low'u > 3. mumun high'ı
    for (let i = 0; i < candles.length - 2; i++) {
        const c1 = candles[i];
        const c2 = candles[i + 1];
        const c3 = candles[i + 2];
        
        const c1Low = n(c1[3]);
        const c3High = n(c3[2]);
        
        // FVG boşluğu
        if (c1Low > c3High) {
            return {
                top: c1Low,
                bottom: c3High,
                size: n(c1Low - c3High)
            };
        }
    }
    return null;
}

// ========================= ANALYZE COIN (GÜNCELLENMİŞ) =========================
async function analyzeCoin(row) {
    try {
        if (row.volumeTier === 'LOW') return null;
        
        const cleanSym = cleanSymbol(row.symbol);
        
        const cooldownTime = STATE.cooldowns.get(cleanSym);
        if (cooldownTime && Date.now() - cooldownTime < CFG.COOLDOWN_MS) return null;
        
        const existing = [...STATE.signals.values()].find(s => s.symbol === cleanSym);
        if (existing) return null;
        
        const trend1h = await get1hTrend(row.symbol);
        
        const c15 = await getCandles(row.symbol, '15m', CFG.M15_HISTORY);
        if (c15.length < 50) return null;
        
        // Yeni sinyal tespiti
        const sig = detectLiquiditySweep(c15, trend1h);
        if (!sig) return null;
        
        const now = Date.now();
        
        const signal = {
            id: `${cleanSym}-${sig.direction}-${now}`,
            symbol: cleanSym,
            marketSymbol: row.symbol,
            direction: sig.direction,
            strategy: sig.pattern === 'SWEEP+FVG' ? 'LIQ SWEEP + FVG' : 'LIQ SWEEP',
            score: sig.score,
            confidence: sig.score,
            currentPrice: row.price,
            entry: sig.entry,
            entryPrice: sig.entry.toFixed(8),
            giris: sig.entry,
            stop: sig.stop,
            stopLoss: sig.stop,
            SL: sig.stop.toFixed(8),
            tp1: sig.tp1,
            TP1: sig.tp1.toFixed(8),
            tp2: sig.tp2,
            TP2: sig.tp2.toFixed(8),
            RR: '1.5',
            rr: 1.5,
            reason: `${sig.direction} | ${sig.pattern} | ${sig.zone} | 1H: ${trend1h} | Hacim: ${sig.volumeSurge.toFixed(1)}x`,
            tacticalAnalysis: `Formasyon: ${sig.pattern} | Bölge: ${sig.zone} | 1H Trend: ${trend1h} | Hacim: ${sig.volumeSurge.toFixed(1)}x`,
            volumeFormatted: row.volumeFormatted,
            volumeTier: row.volumeTier,
            volumeSurge: Number(sig.volumeSurge.toFixed(2)),
            bodyRatio: Number(sig.bodyRatio.toFixed(2)),
            movePercent: Number(sig.movePercent.toFixed(2)),
            trend1h: trend1h,
            pattern: sig.pattern,
            zone: sig.zone,
            timestamp: now,
            time: new Date().toLocaleTimeString('tr-TR'),
            signalAt: now,
            status: 'AKTİF',
            paperEntry: sig.entry,
            entryTime: now,
            cooldownKey: cleanSym
        };
        
        STATE.signals.set(signal.id, signal);
        
        if (sig.direction === 'LONG') STATE.stats.longSignals++;
        else STATE.stats.shortSignals++;
        
        console.log(`✅ ${cleanSym} ${sig.direction} | ${sig.pattern} | ${sig.zone} | Giriş: ${sig.entry.toFixed(6)} | SL: ${sig.stop.toFixed(6)} | TP1: ${sig.tp1.toFixed(6)} | Skor: ${sig.score}`);
        
        return signal;
    } catch (error) {
        return null;
    }
}
