--- server.orig.js	2026-10-30 20:25:51.725752409 +0000
+++ server.js	2026-10-30 20:26:50.045754927 +0000
@@ -35,7 +35,7 @@
   } catch (e) { /* sessiz */ }
 })();
 
-const VERSION = 'v90.1';
+const VERSION = 'v90.2';
 const PORT = Number(process.env.PORT) || 3000;
 const M1 = 60 * 1000, M3 = 3 * M1, M5 = 5 * M1, M15 = 15 * M1;
 const H1 = 60 * M1, H2 = 2 * H1, H4 = 4 * H1, D1 = 24 * H1;
@@ -169,7 +169,9 @@
   includeStocks: false, autoAiPerHour: 40, stallSec: 240, aiCommentPerHour: 20, scalpRev: false, ltTfs: ['1h', '2h'],
   pullbackRiskPct: 0.30, maxHeatPct: 1.00, maxDailyTrades: 8, maxConsecLoss: 3,
   // v89.3: autoEntryMode MATH=giriş matematik (AI yalnız çıkışta) | AI=eski AI giriş onayı; trendStrategy EMA_PULLBACK | LEGACY; trendAiMode VETO | GATE
-  autoEntryMode: 'MATH', autoExitAi: true, trendStrategy: 'EMA_PULLBACK', trendAiMode: 'VETO'
+  autoEntryMode: 'MATH', autoExitAi: true, trendStrategy: 'EMA_PULLBACK', trendAiMode: 'VETO',
+  // v90.2: Trend/Patlama/LT = matematik sinyal bulur, AI strateji sorularıyla onaylar (AI yok/hata/kota = matematik sinyali geçer)
+  manualAiGate: true
 };
 
 const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
@@ -218,6 +220,7 @@
   s.autoExitAi = s.autoExitAi !== false;
   s.trendStrategy = s.trendStrategy === 'LEGACY' ? 'LEGACY' : 'EMA_PULLBACK';
   s.trendAiMode = s.trendAiMode === 'GATE' ? 'GATE' : 'VETO';
+  s.manualAiGate = s.manualAiGate !== false;
   return s;
 }
 
@@ -1311,7 +1314,7 @@
   // Sinyal yalnızca AZ ÖNCE kapanan mumun kırılımıyla üretilir. 5-6 saatlik
   // eski kırılımlar listeye geri dönmez; kırılımın üzerinden hareket geçtiyse susar.
   const closedAge = now - (last.t + tfMs);
-  const maxClosedAge = Number(opt.maxClosedAgeMs) > 0 ? Number(opt.maxClosedAgeMs) : 120 * M1;
+  const maxClosedAge = Number(opt.maxClosedAgeMs) > 0 ? Number(opt.maxClosedAgeMs) : 180 * M1;
   if (!opt.live && closedAge > maxClosedAge) return null;
 
   // Kırılım bu mumda mı başladı? Önceki kapanmış mum da çizginin dışındaysa
@@ -1340,20 +1343,20 @@
 
   // Sahte kırılım filtresi: gövde ve hacim teyidi.
   const br = bodyRatio(last), ba = bodyAtr(last, atr);
-  if (!opt.live && (br < 0.25 || ba < 0.20)) return null;
-  if (!opt.live && vr < 0.80) return null;
+  if (!opt.live && (br < 0.18 || ba < 0.15)) return null;
+  if (!opt.live && vr < 0.60) return null;
 
   const dir = (upClosed && (!dnClosed || (last.c - up) >= (dn - last.c))) ? 'LONG' : 'SHORT';
   // Manuel üçgende yön, çizimden okunan eğilimle aynı olmalı. Eğilim LONG iken
   // aşağı kırılım görülürse sinyal üretilmez; önce yeni yapı/eğilim beklenir.
   // v89.6: eğilime ters kırılım engellenmez; güven puanı zaten düşürülür
-  if (tri.maturity < 0.45 || (tri.widthNow < 0.05 * atr && !tri.manual)) return null;
+  if (tri.maturity < 0.35 || (tri.widthNow < 0.05 * atr && !tri.manual)) return null;
 
   const d = dir === 'LONG' ? 1 : -1;
   const line = dir === 'LONG' ? up : dn;
   // Çizgiden çok uzaklaşmışsa (hareket kaçmışsa) kovalamaca yok.
   const ext = d * (px - line) / atr;
-  if (ext < -0.25 || ext > 1.20) return null;
+  if (ext < -0.25 || ext > 1.60) return null;
   // Üçgenin ters tarafına sarkmışsa kırılım geçersiz.
   if (dir === 'LONG' ? px < up - 0.35 * atr : px > dn + 0.35 * atr) return null;
 
@@ -1367,15 +1370,15 @@
     : Math.min(swing + 0.35 * atr, up + 0.35 * atr);
   let risk = Math.abs(entry - sl);
   if (risk < 0.55 * atr) { sl = entry - d * 0.55 * atr; risk = Math.abs(entry - sl); }
-  const riskPct = risk / entry * 100;
-  if (!moduleRiskOk('LT', riskPct)) return null;
+  let riskPct = risk / entry * 100;
+  // v90.2: LT yalnızca sinyal; parasal risk/R:R kapısı yok. Plan yalnızca grafik referansı.
+  if (riskPct > STRAT.LT.maxRiskPct) { sl = entry - d * entry * STRAT.LT.maxRiskPct / 100; risk = Math.abs(entry - sl); riskPct = risk / entry * 100; }
 
   // Ölçülü hareket: üçgen yüksekliği kadar ilk hedef, iki katı ikinci hedef.
   const height = Math.max(Math.min(tri.widthStart, 5 * atr), 1.15 * risk);
   const tp1 = entry + d * Math.max(0.60 * height, STRAT.LT.tp1GrossR * risk);
   const tp2 = entry + d * Math.max(1.00 * height, STRAT.LT.tp2GrossR * risk);
   const q1 = rrNet(entry, sl, tp1), q2 = rrNet(entry, sl, tp2);
-  if (q1.net + 1e-6 < STRAT.LT.tp1NetR || q2.net + 1e-6 < STRAT.LT.tp2NetR) return null;
 
   const htfUp = (() => {
     if (cs.length < 130) return null;
@@ -1493,7 +1496,7 @@
         if (!tri) { LT_CACHE.delete(key); return; }
         const old = LT_CACHE.get(key);
         LT_CACHE.set(key, { sym, tf, cs, tri, at: now, barAt: now, ai: old ? old.ai : null });
-        const raw = ltSignalFrom(sym, cs, tf, tri);
+        const raw = ltSignalFrom(sym, cs, tf, tri) || ltSignalFrom(sym, cs, tf, tri, { live: true });
         if (raw) found.push(raw);
       });
       scanned += list.length;
@@ -1985,7 +1988,7 @@
    1h yön: EMA20>EMA50 + eğim (short için ters). 5m: fiyat EMA20 bölgesine geri çekilir,
    sonra son kapanmış mum önceki mumun tepesini/dibini yön lehine kapanışla geçer.
    AI onayı yoktur (AI yalnızca net dönüş kanıtında veto eder). */
-const PB_CFG = { zoneAtr: 0.65, minSwingAtr: 0.35, maxExtAtr: 2.2, minAtrPct: 0.10, maxAtrPct: 3.2, freshMs: 150e3, volMin: 0.60, bodyMin: 0.30, stopPadAtr: 0.18, maxBrokenAtr: 1.00, tp1Fraction: 0.50 };
+const PB_CFG = { zoneAtr: 0.90, minSwingAtr: 0.25, maxExtAtr: 2.8, minAtrPct: 0.10, maxAtrPct: 3.2, freshMs: 210e3, volMin: 0.40, bodyMin: 0.22, stopPadAtr: 0.18, maxBrokenAtr: 1.80, tp1Fraction: 0.50, pbWin: 12 };
 
 function pbRegime(h1) {
   if (!h1 || h1.length < 60) return null;
@@ -1994,8 +1997,9 @@
   const a = e20[n - 1], b = e50[n - 1], a3 = e20[n - 4];
   if (a == null || b == null || a3 == null) return null;
   const last = cl[n - 1];
-  if (a > b && a >= a3 && last > b) return { dir: 'LONG', e20: a, e50: b, slopePct: (a / a3 - 1) * 100 };
-  if (a < b && a <= a3 && last < b) return { dir: 'SHORT', e20: a, e50: b, slopePct: (a3 / a - 1) * 100 };
+  // v90.2: eğim toleransı + EMA50'ye %0.15 tolerans (15m'de tek mumluk dalgalanma yönü 'yatay' yapmasın)
+  if (a > b && a >= a3 * 0.9996 && last > b * 0.9985) return { dir: 'LONG', e20: a, e50: b, slopePct: (a / a3 - 1) * 100 };
+  if (a < b && a <= a3 * 1.0004 && last < b * 1.0015) return { dir: 'SHORT', e20: a, e50: b, slopePct: (a3 / a - 1) * 100 };
   return { dir: null, e20: a, e50: b, slopePct: 0 };
 }
 
@@ -2035,7 +2039,7 @@
   const E20 = e20[n - 1], E50 = e50[n - 1];
   if (E20 == null || E50 == null) return out('5m EMA hesaplanamadı', 0);
   const rsi = rsiLast(cl, 14);
-  const win = cs.slice(-8, -1);
+  const win = cs.slice(-(PB_CFG.pbWin + 1), -1);
   const pbExtreme = dir === 'LONG' ? Math.min.apply(null, win.map(c => c.l)) : Math.max.apply(null, win.map(c => c.h));
   const swing = dir === 'LONG' ? Math.max.apply(null, cs.slice(-20, -1).map(c => c.h)) : Math.min.apply(null, cs.slice(-20, -1).map(c => c.l));
   const distAtr = d * (px - E20) / atr;
@@ -2056,7 +2060,10 @@
   if (broken) return out('Geri çekilme EMA50\'yi bozdu', 1);
   if (!swingOk) return out('Geri çekilme öncesi itki zayıf (< ' + PB_CFG.minSwingAtr + ' ATR)', 1);
 
-  const trig = dir === 'LONG' ? (last.c > prev.h && last.c > last.o && last.c > E20) : (last.c < prev.l && last.c < last.o && last.c < E20);
+  // v90.2: tetik = önceki mumun ucu kapanışla geçildi VEYA EMA20 geri alındı (EMA20 altından/üstünden dönüş mumu)
+  const trig = dir === 'LONG'
+    ? (last.c > last.o && last.c > E20 && (last.c > prev.h || prev.c <= E20 + 0.10 * atr))
+    : (last.c < last.o && last.c < E20 && (last.c < prev.l || prev.c >= E20 - 0.10 * atr));
   if (!trig) return out('Tetik yok (önceki mumun ' + (dir === 'LONG' ? 'tepesi' : 'dibi') + ' kapanışla geçilmedi)', 2, mkRow('BEKLİYOR', 'TETİK BEKLENİYOR', 'Geri çekilme tamam; ' + (dir === 'LONG' ? 'önceki tepe' : 'önceki dip') + ' kırılımı bekleniyor', 2));
   const body = bodyRatio(last);
   if (body < PB_CFG.bodyMin) return out('Tetik mumu gövdesi zayıf (' + body.toFixed(2) + ')', 3);
@@ -2119,17 +2126,17 @@
 const BURST_CFG = {
   boxBars: 12,          // sıkışma kutusu: tetik öncesi son 12 kapanmış 5m mum
   bwLookback: 120,      // BB genişliği yüzdelik sıralaması penceresi
-  bwMaxPct: 0.50,       // genişlik son 120 mumun en dar %50'sinde olmalı
-  atrSqueeze: 1.00,     // ATR14 / ATR50 (daralma)
-  boxMaxAtr: 3.20,      // kutu yüksekliği en fazla 3.2 ATR
+  bwMaxPct: 0.65,       // v90.2: genişlik son 120 mumun en dar %65'inde
+  atrSqueeze: 1.12,     // v90.2: ATR14 / ATR50 (daralma)
+  boxMaxAtr: 4.20,      // v90.2: kutu yüksekliği en fazla 4.2 ATR
   minAtrPct: 0.10, maxAtrPct: 3.50,
-  bodyMin: 0.45, bodyAtrMin: 0.60, rangeAtrMin: 0.90,
-  closePosMin: 0.60,
-  volMin: 1.40,         // tetik hacmi / 20 mum ortalaması
+  bodyMin: 0.38, bodyAtrMin: 0.50, rangeAtrMin: 0.80,
+  closePosMin: 0.55,
+  volMin: 1.20,         // v90.2: tetik hacmi / 20 mum ortalaması
   breakAtrMin: 0.05,    // kutu kenarının en az 0.05 ATR dışında kapanış
   maxExtAtr: 2.60,      // tetik kapanışı kutunun en fazla 2.6 ATR dışında
-  givebackMax: 0.55,    // tetik mumunun zirvesinden geri verilen kısım
-  freshMs: 150e3,       // tetik mumu en fazla ~2.5 dakika önce kapanmış olmalı
+  givebackMax: 0.65,    // tetik mumunun zirvesinden geri verilen kısım
+  freshMs: 210e3,       // tetik mumu en fazla ~3.5 dakika önce kapanmış olmalı
   stopPadAtr: 0.25,
   minRiskPct: 0.45, maxRiskPct: 2.60,
   tp1Fraction: 0.50,
@@ -2248,7 +2255,7 @@
   const atrTight = ctx.atrRatio <= BURST_CFG.atrSqueeze;
   const boxTight = ctx.boxAtr <= BURST_CFG.boxMaxAtr;
   if (!tight || !atrTight || !boxTight) {
-    const near = ctx.bwRank <= 0.55 && ctx.boxAtr <= 3.20;
+    const near = ctx.bwRank <= 0.80 && ctx.boxAtr <= 4.80;
     return out('Sıkışma yok (BB %' + (ctx.bwRank * 100).toFixed(0) + ' · ATR oranı ' + ctx.atrRatio.toFixed(2) + ' · kutu ' + ctx.boxAtr.toFixed(2) + ' ATR)', 1,
       near ? mkRow('BEKLİYOR', 'SIKIŞMA', 'Daralma izleniyor; patlama kırılımı bekleniyor', 1) : null);
   }
@@ -2269,7 +2276,7 @@
   if (ctx.volRatio < BURST_CFG.volMin) return out('Hacim patlaması yok (' + ctx.volRatio.toFixed(2) + 'x < ' + BURST_CFG.volMin + 'x)', 3);
 
   if (ctx.htf.dir && ctx.htf.dir !== dir) {
-    const against = d === 1 ? ctx.htf.slopePct < -0.30 : ctx.htf.slopePct > 0.30;
+    const against = d === 1 ? ctx.htf.slopePct < -0.50 : ctx.htf.slopePct > 0.50;
     if (against) return out('15m trend ters ve eğimli (' + ctx.htf.slopePct + '%) — patlamaya karşı işlem yok', 3);
   }
 
@@ -2519,6 +2526,7 @@
   const last = REJ.find(r => r.symbol === sym && r.reason === reason && now - r.t < 10 * M1);
   if (last) { last.n = (last.n || 1) + 1; last.t = now; REJ.splice(REJ.indexOf(last), 1); REJ.push(last); }
   else { REJ.push({ t: now, module, symbol: sym, base, reason, price: rp(price || priceOf(sym)), n: 1 }); capArr(REJ, 200); }
+  if (module !== 'AUTO' && /soğuma|açık sinyal|günlük limit|circuit|kilidi/i.test(reason)) logOnce('rej|' + module + '|' + sym + '|' + reason, MODS[module].label + ' ADAY ELENDİ: ' + base + ' → ' + reason, 10 * M1);
   const k = module + '|' + reason;
   REJ_STAT[k] = (REJ_STAT[k] || 0) + 1;
   dirty = true;
@@ -2558,7 +2566,9 @@
   if (market.dir === sig.dir) { score += 3; reasons.push('Piyasa yönü uyumlu'); }
   else if (market.dir !== 'NOTR') { score -= 4; risks.push('Piyasa yönüne ters'); }
   score = clamp(score, 0, 100);
-  const verdict = score >= settings.minConf ? 'GİRİLİR' : 'BEKLE';
+  const approved = !!(sig.aiGate && sig.aiGate.state === 'APPROVED');
+  if (approved) { score = Math.max(score, settings.minConf); reasons.push('AI onayladı'); }
+  const verdict = score >= settings.minConf - 10 ? 'GİRİLİR' : 'BEKLE';
   return {
     verdict, verdictLabel: verdict, score,
     reasons: Array.from(new Set(reasons)).slice(0, 8),
@@ -2651,9 +2661,12 @@
   } else {
     // Manuel sinyaller matematikle hemen AKTİF olur. AI kararı bilgi amaçlıdır;
     // AI "GİRME" dese bile sinyal kullanıcıdan saklanmaz, yalnızca not düşülür.
-    sig.status = 'AKTIF'; sig.startedAt = now;
+    // v90.2: matematik sinyali bulur, AI strateji sorularıyla onaylar. AI kapalı/hatalı/kota dolu/gecikmeli ise
+    // matematik sinyali AKTIF olur (AI eksikliği sinyali asla engellemez).
+    const gate = aiOn && settings.manualAiGate !== false;
+    sig.status = gate ? 'AI_BEKLIYOR' : 'AKTIF'; sig.startedAt = now;
     sig.aiGate = aiOn
-      ? { state: 'QUEUED', queuedAt: now, note: 'Sinyal aktif; AI onay/risk görüşü bilgi amaçlı bekleniyor' }
+      ? { state: 'QUEUED', queuedAt: now, note: gate ? 'Matematik sinyali bulundu; AI onayı bekleniyor' : 'Sinyal aktif; AI görüşü bilgi amaçlı bekleniyor' }
       : { state: 'MATH_ONLY', queuedAt: now, decidedAt: now, note: 'AI kapalı — matematik sinyali' };
   }
 
@@ -2663,7 +2676,7 @@
   dirty = true;
   log('SİNYAL: ' + M.label + ' | ' + sig.base + ' | ' + sig.dir + ' | güven ' + sig.conf + ' | ' + sig.analysis.verdictLabel + ' ' + sig.analysis.score + ' | ' + (sig.info.setup || sig.info.shape || sig.info.tf || ''));
   onSignalAdded(sig);
-  if (aiOn && !(raw.module === 'AUTO' && settings.autoEntryMode !== 'AI')) queueAI(sig);   // LT dahil: LT'de AI yorum ekler, girişi elemez
+  if (aiOn && !(raw.module === 'AUTO' && settings.autoEntryMode !== 'AI')) queueAI(sig, raw.module === 'AUTO' ? undefined : { force: true });   // v90.2: Trend/Patlama/LT AI onayı (saatlik yorum bütçesine takılmaz)
   return sig;
 }
 
@@ -4751,7 +4764,7 @@
   return { flags, block, blockReason, conflict, ruleScore: Math.round(ruleScore), ruleVerdict: rule.verdict, aiScore: aiScore != null ? Math.round(aiScore) : null, counter, vol, ext };
 }
 
-function promptPB(sig, f) {
+function promptPB_old(sig, f) {
   const base = promptPB_base(sig, f);
   const cut = base.lastIndexOf("Yanıtı tek bir JSON");
   const head = cut > 0 ? base.slice(0, cut) : base;
@@ -4914,7 +4927,7 @@
   };
 }
 
-function promptLT(sig, f) {
+function promptLT_old(sig, f) {
   const i = sig.info;
   return 'LT ÜÇGEN — ' + (i.tf || '2h') + ' ' + (i.shape || '') + ' üçgen kırılımı — ' + sig.base + ' ' + sig.dir + '\n' + CODE_NOTE + planLine(sig) +
     'Üçgen: üst çizgi ' + (i.upperNow || i.upper) + ' | alt çizgi ' + (i.lowerNow || i.lower) + ' | genişlik %' + i.widthPct + ' | olgunluk ' + i.maturity + ' | sıkışma ' + i.compression + ' | dokunma ' + i.touches + '\n' +
@@ -4923,6 +4936,75 @@
     'Son 8 kapanmış ' + (i.tf || '2h') + ' mum:\n' + fmtCandles(f.cs, 8) + '\n\n' +
     'Maddeler:\n- close_beyond_line: kırılım mumu çizginin dışında kapandı mı (canlıysa gövde çizgiyi geçti mi)?\n- volume_pattern: hacim sıkışmada azaldı, kırılımda arttı mı?\n- htf_aligned: 4s trend kırılım yönüyle uyumlu mu?\n- fakeout_signs: uzun ters fitil veya hemen geri dönüş var mı?\n' + schemaText('LT');
 }
+
+/* ── v90.2 AI ONAY İSTEMLERİ ─────────────────────────────────────────────────
+   İlke: matematik sinyali bulur, AI yalnızca STRATEJİYE UYGUN tek bir soruyu yanıtlar:
+   "bu sinyal belirgin biçimde bozuldu mu / sahte mi?". Kodun zaten doğruladığı şeyler
+   (sıkışma, hacim eşiği, tazelik, R:R, spread, piyasa yönü) AI'a yeniden SORULMAZ.
+   Nihai karar kodla verilir (manualDecision): yalnızca veto maddesi true ise GIRME. */
+function manualDecision(setup, checks, sig) {
+  const c = checks || {};
+  if (setup === 'TREND') return (c.trend_intact === false || c.reversal_signs === true) ? 'GIRME' : 'GIR';
+  if (setup === 'BURST') return c.fakeout_signs === true ? 'GIRME' : 'GIR';
+  if (setup === 'LT') {
+    const live = !!(sig && sig.info && sig.info.live);
+    return (c.fakeout_signs === true || (!live && c.close_beyond_line === false)) ? 'GIRME' : 'GIR';
+  }
+  return 'GIR';
+}
+
+function promptPB(sig, f) {
+  const up = f.d === 1;
+  const counter = market.dir !== 'NOTR' && market.dir !== sig.dir;
+  return 'TREND TAKİP (5 dakikalık EMA20 geri çekilme devamı) — ' + sig.base + ' ' + sig.dir + '\n' +
+    'Plan referansı: giriş ' + sig.entry + ' (bu modül çıkış ve parasal hesap kullanmaz; yalnızca yön ve girişe göre % takip edilir).\n\n' +
+    'KODLA DOĞRULANDI, İTİRAZ ETME: 15 dakikalık trend yönü, fiyatın 5 dakikalık EMA20 bölgesine geri çekilmesi, son KAPANMIŞ 5 dakikalık mumun ' + (up ? 'önceki mumun tepesini' : 'önceki mumun dibini') + ' veya EMA20\'yi trend yönünde geçmesi, mum tazeliği, hacim ve gövde eşikleri, spread, R:R. Geri çekilme sırasında fiyatın EMA20\'nin ters tarafında kalması NORMALDİR.\n\n' +
+    'Veri: 15 dakikalık yön ' + f.h1Dir + ' | tetik hacmi ' + f.volRatio + 'x | gövde oranı ' + f.bodyRatio + ' | EMA20\'ye uzaklık ' + f.distEma20Atr + ' ATR | geri çekilme derinliği ' + f.pullbackDepthAtr + ' ATR.\n' +
+    'Son 8 mumdan 5 dakikalık EMA50\'nin trend TERSİNDE kapanan: ' + f.beyondE50 + '/8 | son kapanış EMA50\'nin trend tersinde mi: ' + (f.lastBeyondE50 ? 'EVET' : 'HAYIR') + ' | son 3 mumda trend tersi en büyük gövde: ' + f.tersGovdeAtr + ' ATR.\n' +
+    'Genel piyasa yönü: ' + market.dir + (counter ? ' (sinyale ters — yalnızca bilgi, tek başına GIRME sebebi DEĞİL)' : '') + '.\n\n' +
+    'Son 10 KAPANMIŞ 5 dakikalık mum (en yeni sonda):\n' + fmtCandles(f.cs, 10) + '\n\n' +
+    'Maddeler (hepsi evet/hayır):\n' +
+    '- trend_intact: Geri çekilme düzenli bir düzeltme mi (trend yapısı bozulmadı mı)? Son kapanış EMA50\'nin trend tersine geçmediyse VE son 8 mumdan en fazla 3\'ü EMA50\'nin tersinde kapandıysa true.\n' +
+    '- volume_confirmation: Trend yönündeki mumların hacmi ters yöndekilerden fazla mı? (yalnızca bilgi)\n' +
+    '- reversal_signs: Son 3 mumda trend tersi yönde ≥1.5 ATR gövdeli güçlü mum VAR MI, veya trend yönünü açıkça tersine çeviren engulfing/sert reddedilme var mı?\n\n' +
+    'Karar kuralı: GIRME yalnızca trend_intact false veya reversal_signs true ise. Düşük hacim, piyasa yönü, EMA20 uzaklığı veya küçük fitiller tek başına GIRME sebebi değildir; şüphede GIR de.\n' +
+    schemaText('TREND');
+}
+
+function promptBurst(sig, f) {
+  const up = f.d === 1;
+  return 'PATLAMA (5 DAKİKA SIKIŞMA KIRILIMI) — ' + sig.base + ' ' + sig.dir + '\n' +
+    'Plan referansı: giriş ' + sig.entry + ' (bu modül çıkış ve parasal hesap kullanmaz; yalnızca yön ve girişe göre % takip edilir).\n\n' +
+    'KODLA DOĞRULANDI, YENİDEN SORGULAMA: sıkışma (Bollinger/ATR daralması, kutu), kırılım kapanışı, gövde ve menzil eşikleri, hacim eşiği, tazelik, spread. 15 dakikalık yön ve genel piyasa yönü yalnızca bilgidir.\n\n' +
+    'Veri: kutu ' + f.boxLo + '–' + f.boxHi + ' | kırılım ' + f.brkAtr + ' ATR | hacim ' + f.volRatio + 'x | gövde ' + f.bodyAtr + ' ATR | kapanış konumu ' + f.closePos + ' | fiyat kutu kenarından ' + f.extAtr + ' ATR uzakta | tetik yaşı ' + f.sinceCloseMin + ' dk | 15m ' + f.htf + ' | piyasa ' + f.marketAlign + '.\n\n' +
+    'Son 8 KAPANMIŞ 5 dakikalık mum (en yeni sonda):\n' + fmtCandles(f.cs, 8) + '\n\n' +
+    'Maddeler (hepsi evet/hayır):\n' +
+    '- squeeze_valid: Kutu grafikte gerçekten dar ve yatay bir sıkışma gibi mi? (kodla doğrulandı; yalnızca bariz çelişki varsa false)\n' +
+    '- breakout_fresh: Kırılım son 1-3 mum içinde mi? (bilgi)\n' +
+    '- volume_expansion: Kırılım mumunun hacmi önceki mumlardan belirgin yüksek mi? (bilgi)\n' +
+    '- fakeout_signs: SADECE şu durumlarda true: (a) kırılım mumunun kapanışı ' + (up ? 'kutunun üst kenarının altına' : 'kutunun alt kenarının üstüne') + ' geri döndü, (b) kırılım mumunda kırılım yönünün tersine aralığın %60\'ından uzun fitil var, (c) kırılımdan sonra gelen mum kırılımı tamamen geri aldı.\n\n' +
+    'Karar kuralı: GIRME yalnızca fakeout_signs true ise. Diğer maddeler bilgi amaçlıdır, tek başına GIRME sebebi değildir; şüphede GIR de.\n' +
+    schemaText('BURST');
+}
+
+function promptLT(sig, f) {
+  const i = sig.info || {};
+  const live = !!i.live;
+  return 'LT ÜÇGEN KIRILIMI (' + (i.tf || '2h') + ' ' + (i.shape || '') + ') — ' + sig.base + ' ' + sig.dir + '\n' +
+    'Plan referansı: giriş ' + sig.entry + ' (bu modül çıkış ve parasal hesap kullanmaz; yalnızca yön ve girişe göre % takip edilir).\n\n' +
+    'KODLA DOĞRULANDI, YENİDEN SORGULAMA: üçgen yapısı (üst/alt çizgi, dokunma, olgunluk, sıkışma), kırılımın tazeliği, gövde/hacim alt eşikleri. Üst çizgi ' + (i.upperNow || i.upper) + ' | alt çizgi ' + (i.lowerNow || i.lower) + ' | genişlik %' + i.widthPct + ' | dokunma ' + i.touches + '.\n' +
+    (live ? 'Bu bir CANLI kırılımdır: son kapanmış mum henüz çizginin içinde olabilir; fiyat çizgiyi geçtiyse kırılım geçerlidir.\n' : '') +
+    'Veri: son mum çizginin ' + (f.closeBeyond ? 'DIŞINDA' : 'içinde') + ' | çizgiden uzaklık ' + f.beyondAtr + ' ATR | ters yönde fitil oranı ' + f.wickAgainst + ' | sıkışma hacmi/önceki dönem ' + f.squeezeVolRatio + 'x | kırılım mumu hacmi ' + f.breakVolRatio + 'x | 4 saatlik trend ' + f.htf4h + '.\n\n' +
+    'Son 8 kapanmış ' + (i.tf || '2h') + ' mum (en yeni sonda):\n' + fmtCandles(f.cs, 8) + '\n\n' +
+    'Maddeler (hepsi evet/hayır):\n' +
+    '- close_beyond_line: ' + (live ? 'Fiyat kırılan çizgiyi ATR\'nin belirgin bir kısmı kadar geçti mi?' : 'Kırılım mumu çizginin dışında kapandı mı?') + '\n' +
+    '- volume_pattern: Hacim sıkışmada azaldı, kırılımda arttı mı? (yalnızca bilgi)\n' +
+    '- htf_aligned: 4 saatlik trend kırılım yönüyle uyumlu mu? (yalnızca bilgi)\n' +
+    '- fakeout_signs: SADECE şu durumlarda true: kırılım mumu üçgenin içine geri döndü, kırılım yönünün tersine uzun fitil (aralığın %60+\'ı) bıraktı veya ters yönde güçlü engulfing mum oluştu.\n\n' +
+    'Karar kuralı: GIRME yalnızca fakeout_signs true ise' + (live ? '' : ' veya close_beyond_line false ise') + '. Hacim ve 4 saatlik trend tek başına GIRME sebebi değildir; şüphede GIR de.\n' +
+    schemaText('LT');
+}
+
 function promptAutoEntry(sig, ctx, f, cs) {
   return 'OTOTRADE GİRİŞ KARARI — ' + sig.base + ' ' + sig.dir + ' (pump/dump hızlı scalp)\n' + CODE_NOTE + planLine(sig) +
     'Kod hesapları: hareketin başından beri ' + f.atrProgress + ' ATR ilerledi (başlangıç ' + f.start + ') | son mum ' + (f.forming ? 'HENÜZ KAPANMADI, yaşı ' + f.candleAgeSec + ' sn' : 'kapandı') +
@@ -4964,7 +5046,7 @@
   };
 }
 
-function promptBurst(sig, f) {
+function promptBurst_old(sig, f) {
   const up = f.d === 1;
   return 'PATLAMA (SIKIŞMA KIRILIMI) — ' + sig.base + ' ' + sig.dir + '\n' +
     'Plan referansı: giriş ' + sig.entry + ' | stop ' + sig.sl + ' | hedef1 ' + sig.tp1 + ' (bu modül ÇIKIŞ kullanmaz; yalnızca yön ve % takip)\n\n' +
@@ -5028,10 +5110,14 @@
   }
 
   const p = parseChecksJSON(ai.text, built.setup);
-  const decision = p.decision;
-  const view = Object.assign({}, ai, legacyFields(decision), { decisionV85: decision, aiSaid: p.decision, checks: p.checks, reason: p.reason, summary: p.reason, setupPrompt: built.setup });
+  if (p.parseError) { log('AI YANIT OKUNAMADI: ' + MODS[sig.module].label + ' ' + sig.base + ' → ' + (p.reason || '') + ' | matematik kararı'); return aiFallback(sig, 'OFFLINE', 'AI yanıtı okunamadı — matematik kararı'); }
+  // v90.2: nihai karar, stratejiye uygun tek veto maddesine göre KODLA verilir (AI'ın serbest 'GIRME'si sinyali tek başına düşürmez)
+  const aiSaidDecision = p.decision;
+  const decision = manualDecision(built.setup, p.checks, sig);
+  p.decision = decision;
+  const view = Object.assign({}, ai, legacyFields(decision), { decisionV85: decision, aiSaid: aiSaidDecision, checks: p.checks, reason: p.reason, summary: p.reason, setupPrompt: built.setup });
   if (p.confidence != null) { view.score = p.confidence; view.scoreSource = 'AI'; } else { view.scoreSource = 'SABIT'; }
-  const audit = sig.module === 'PUMP' ? auditAiVsRules(sig, p, built.facts, view, decision) : { flags: [], block: false, conflict: false };
+  const audit = { flags: [], block: false, conflict: false };   // v90.2: AI-kural çelişki bloğu kaldırıldı (yanlış soru sinyali engellemesin)
   sig.aiAudit = audit; view.audit = audit;
   sig.ai = view;
   const rec = {
@@ -5043,26 +5129,23 @@
   AI_HIST.push(rec); capArr(AI_HIST, 600);
   countCheckStats(built.setup, p.checks, decision);
   addShadow(sig, decision, rec);
-  appendDecision({ type: 'karar', sigId: sig.id, module: sig.module, base: sig.base, dir: sig.dir, setup: built.setup, conf: sig.conf, checks: p.checks, aiSaid: p.decision, decision, entry: sig.entry, sl: sig.sl, tp1: sig.tp1, tp2: sig.tp2, reason: p.reason });
+  appendDecision({ type: 'karar', sigId: sig.id, module: sig.module, base: sig.base, dir: sig.dir, setup: built.setup, conf: sig.conf, checks: p.checks, aiSaid: aiSaidDecision, decision, entry: sig.entry, sl: sig.sl, tp1: sig.tp1, tp2: sig.tp2, reason: p.reason });
 
-  if (sig.module === 'PUMP') {
-    // Danışman AI: karar sinyali silmez. Matematik sinyali zaten AKTİF;
-    // AI yalnızca onay/risk görüşünü not olarak ekler.
-    const approved = decision === 'GIR' && !audit.block;
-    const note = (approved ? 'AI GİR — ' : 'AI GİRME (bilgi, sinyal silinmez) — ') + (p.reason || '') + auditNote(audit);
-    sig.aiGate = { state: approved ? 'APPROVED' : 'COMMENT', note, decidedAt: Date.now(), provider: ai.provider };
-    sig.status = 'AKTIF';
-    if (sig.startedAt == null) sig.startedAt = Date.now();
+  // v90.2 AI ONAY KAPISI (Trend / Patlama / LT): GIR → sinyal AKTIF; veto → sinyal kapatılır (AI GİRİLMEZ).
+  const gateOn = settings.manualAiGate !== false;
+  if (decision === 'GIR' || !gateOn || sig.status !== 'AI_BEKLIYOR') {
+    const approved = decision === 'GIR';
+    sig.aiGate = { state: approved ? 'APPROVED' : 'COMMENT', note: (approved ? 'AI onayı: GİR — ' : 'AI GİRME (bilgi; sinyal açık kalır) — ') + (p.reason || ''), decidedAt: Date.now(), provider: ai.provider };
+    if (sig.status !== 'KAPALI') { sig.status = 'AKTIF'; if (sig.startedAt == null) sig.startedAt = Date.now(); }
     sig.analysis = analyzeManual(sig);
     dirty = true;
-    log((approved ? 'AI ONAY (bilgi): TREND ' : 'AI YORUM (sinyal açık): TREND ') + sig.base + ' ' + sig.dir + ' → ' + decision + ' | ' + (p.reason || ''));
+    log((approved ? 'AI ONAY: ' : 'AI YORUM (sinyal açık): ') + MODS[sig.module].label + ' ' + sig.base + ' ' + sig.dir + ' (' + built.setup + ') → ' + decision + ' | ' + (p.reason || '') + ' (' + ai.providerName + '/' + ai.model + ', ' + ai.latencyMs + 'ms)');
     return view;
   }
-
-  sig.aiGate = Object.assign({}, sig.aiGate || {}, { state: 'COMMENT', note: 'AI onayı: ' + (decision === 'GIR' ? 'GİR' : 'GİRME') + (p.reason ? ' — ' + p.reason : '') + ' (bilgi; sinyal açık kalır)', decidedAt: Date.now(), provider: ai.provider });
-  sig.analysis = MANUAL_MODS.has(sig.module) ? analyzeManual(sig) : analyzeSignal(sig);
-  dirty = true;
-  log('AI YORUM: ' + MODS[sig.module].label + ' ' + sig.base + ' (' + built.setup + ') → ' + decision + ' (' + ai.providerName + '/' + ai.model + ', ' + ai.latencyMs + 'ms)');
+  sig.aiGate = Object.assign({}, sig.aiGate || {}, { state: 'AI_RED', note: 'AI GİRME — ' + (p.reason || ''), decidedAt: Date.now(), provider: ai.provider });
+  if (sig.module === 'LT') OPP.delete('LT|' + sig.symbol);
+  skipSignal(sig, 'AI_RED', p.reason || 'AI yapıyı bozulmuş buldu');
+  log('AI RED: ' + MODS[sig.module].label + ' ' + sig.base + ' ' + sig.dir + ' (' + built.setup + ') → ' + (p.reason || '') + ' (' + ai.providerName + '/' + ai.model + ')');
   return view;
 }
 
@@ -5455,6 +5538,8 @@
 function monitorVirtual() {
   const now = Date.now();
   for (const sig of signals) {
+    // v90.2: AI yanıtı 2 dk içinde gelmezse matematik sinyali AKTIF olur (kuyruk kayıpları sinyali yutmasın)
+    if (sig.status === 'AI_BEKLIYOR' && MANUAL_MODS.has(sig.module) && now - sig.createdAt > 120e3) armSignal(sig, 'AI yanıtı gecikti — matematik sinyali');
     if (sig.status !== 'AKTIF' || sig.tradeable !== false) continue;
     const px = priceOf(sig.symbol);
     const d = sig.dir === 'LONG' ? 1 : -1;
