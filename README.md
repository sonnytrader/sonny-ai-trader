# AlphaSon v87.0 — Tam Sunucu

Bitget USDT-M verisiyle çalışan Node.js sinyal ve paper trading sunucusu. AUTO, PUMP ve LT modülleri tek `server.js` içindedir. Varsayılan işlem modu **PAPER** olup canlı emir varsayılan olarak kapalıdır.

> Bu yazılım kârlılık garantisi vermez. Parametreler piyasa koşullarına göre yeniden doğrulanmalı; canlı kullanımdan önce yeterli örnekli backtest, walk-forward ve paper test yapılmalıdır.

## Hızlı kurulum

Gereksinim: Node.js 18.17 veya üzeri (Node 22 önerilir).

```bash
npm install
cp .env.example .env
# .env içinde en az ALPHASON_API_TOKEN değerini değiştirin.
npm test
npm start
```

Sunucu: `http://localhost:3000`

Sağlık kontrolü:

```bash
curl http://localhost:3000/health
```

Token ayarlandığında tüm `/api` isteklerinde kimlik doğrulama gerekir:

```bash
curl -H "Authorization: Bearer TOKENINIZ" http://localhost:3000/api/state
```

## Docker ile çalıştırma

```bash
cp .env.example .env
# .env dosyasını düzenleyin.
docker compose up --build -d
```

Kalıcı durum `./data` veya Docker’da `alphason-data` biriminde tutulur. Yeniden dağıtımlarda `DATA_DIR` dizininin silinmediğinden emin olun.

## Modüller ve yeni risk planı

Net R formülü:

```text
Net R = (brüt fiyat getirisi % - %0,24) / (stop mesafesi % + %0,24)
```

`%0,24 = %0,20 tahmini tur komisyonu + %0,04 slippage varsayımı`. Canlı işlemlerde gerçekleşen fill fiyatı slippage’ı zaten içerdiğinden canlı PnL’ye ayrıca slippage yazılmaz.

| Modül | Zaman | İşlem türü | Stop riski | TP1 / TP2 net hedef |
|---|---|---|---:|---:|
| AUTO | 1m | AI onaylı otomatik paper/canlı | %0,50–2,50 | 0,75R / 1,75R |
| PUMP | 15m | AI kontrollü sanal sinyal | %0,50–1,75 | 1,00R / 2,00R |
| LT | 2h | Sanal üçgen kırılımı sinyali | %0,60–3,50 | en az 0,85R / 1,75R |

TP1’de pozisyonun yarısı kapatılır; kalan stop maliyet düzeltilmiş başa baş seviyesine taşınır. Aynı mumda stop ve hedefin ikisi de görünüyorsa backtest önce stopu kabul eder.

## Canlı işlem güvenliği

Canlı mod için `.env` içinde şunların tamamı gerekir:

- `BITGET_API_KEY`
- `BITGET_SECRET`
- `BITGET_PASSPHRASE`
- `ALPHASON_API_TOKEN`

Bitget anahtarına yalnızca okuma ve futures işlem yetkisi verin; **çekim yetkisi vermeyin**. Mümkünse IP beyaz listesi kullanın. Kaldıraç ayarlanamazsa giriş iptal edilir. Borsa stopu kurulamazsa sistem açılan pozisyonu kapatmayı dener.

Canlı modu açma:

```bash
curl -X POST \
  -H "Authorization: Bearer TOKENINIZ" \
  -H "Content-Type: application/json" \
  -d '{"mode":"live"}' \
  http://localhost:3000/api/trade/mode
```

Paper moda dönme:

```bash
curl -X POST \
  -H "Authorization: Bearer TOKENINIZ" \
  -H "Content-Type: application/json" \
  -d '{"mode":"paper"}' \
  http://localhost:3000/api/trade/mode
```

## AUTO ve AI

AUTO işlem açmak için hem `autoTrade` hem AI’nin açık olmasını ve en az bir geçerli AI anahtarı bulunmasını ister. AI kararı 90 saniyelik giriş penceresini aşarsa sinyal kapatılır; geç yanıtla eski fiyattan işlem açılmaz.

```bash
# AI’yı aç
curl -X POST -H "Authorization: Bearer TOKENINIZ" \
  -H "Content-Type: application/json" -d '{"enabled":true}' \
  http://localhost:3000/api/ai/toggle

# Çalışan modelleri keşfet
curl -X POST -H "Authorization: Bearer TOKENINIZ" \
  http://localhost:3000/api/ai/discover

# AUTO’yu aç
curl -X POST -H "Authorization: Bearer TOKENINIZ" \
  -H "Content-Type: application/json" -d '{"enabled":true}' \
  http://localhost:3000/api/auto/toggle
```

## Backtest

```bash
curl -X POST -H "Authorization: Bearer TOKENINIZ" \
  -H "Content-Type: application/json" -d '{"module":"PUMP","coins":8}' \
  http://localhost:3000/api/backtest
```

`module`: `AUTO`, `PUMP` veya `LT`. Yanıttaki `id` ile sonucu okuyun:

```bash
curl -H "Authorization: Bearer TOKENINIZ" \
  http://localhost:3000/api/backtest/IS_ID
```

PUMP backtest’i her geçmiş mum için o ana kadarki BTC serisinden rejim üretir; güncel piyasa yönünü geçmişe taşımaz. Backtest AI’yı, emir kuyruğunu ve gerçek borsa yürütmesini simüle etmez. Kısa veri penceresi ve tek piyasa dönemiyle yapılan test yeterli değildir; en az 30 değil, tercihen yüzlerce bağımsız örnek ve farklı piyasa dönemleri kullanın.

## Başlıca API yolları

- `GET /health` — herkese açık sağlık kontrolü
- `GET /api/state` — genel durum
- `GET /api/signals?module=AUTO|PUMP|LT` — sinyaller
- `GET /api/paper` — paper hesap ve pozisyonlar
- `POST /api/auto/scan` — AUTO taraması
- `GET /api/watch/auto|scalp|lt` — izleme listeleri
- `POST /api/backtest` — backtest başlatma
- `GET /api/stats` — modül istatistikleri
- `GET /api/ai/status` — AI sağlayıcıları ve kotalar
- `GET /api/diag` — çalışma zamanı tanılaması

## Bu sürümdeki önemli düzeltmeler

- Önceki 20 mum kırılımında mevcut mumun zirve/dip hesabına yanlışlıkla katılması giderildi.
- PUMP üst zaman dilimi 15m’den 1h’ye doğru şekilde toplanıyor.
- Farklı limitlerdeki eşzamanlı OHLCV isteklerinin eksik seri döndürmesi önlendi.
- Komisyon ve slippage bütün sinyal, sanal sonuç ve backtest hesaplarına işlendi.
- Geç gelen AUTO/AI kararları ve gerçekleşen fiyatla bozulan planlar engellendi.
- Canlı pozisyon yönü eşleştirme, kaldıraç hatası, fill sonrası plan kontrolü ve koruma emirleri güçlendirildi.
- Paper hesabın açık pozisyonlar varken sıfırlanması ve çift kapanışla bakiyenin iki kez değişmesi engellendi.
- AUTO, PUMP ve LT için backtest; PUMP için geçmiş BTC rejimi eklendi.

## Test

```bash
npm run check
npm test
```

Testler Bitget veya AI çağrısı yapmaz; canlı emir göndermez.
