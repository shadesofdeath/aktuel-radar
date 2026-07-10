# Aktüel Radar

**BİM · A101 · ŞOK** marketlerinin **gerçek ürün fiyatlarını** tek ekranda karşılaştıran statik web sitesi.

Günlük güncellenen fiyatlar, birim fiyat, indirim yüzdesi, market filtresi ve arama — hepsi tek sayfada. Karanlık mod destekli, mobil öncelikli tasarım.

## Nasıl çalışır?

- **`index.html`** — Tüm arayüz. `data/*.json` dosyalarını okuyup ürünleri listeler. Derleme adımı yok, doğrudan tarayıcıda açılır.
- **`data/bim.json`, `data/a101.json`, `data/sok.json`** — Her market için ürün verisi. Şema:
  ```json
  {
    "market": "bim",
    "updatedAt": "2026-07-10T06:00:00.000Z",
    "source": "https://marketfiyati.org.tr",
    "count": 240,
    "products": [
      {
        "name": "Ürün adı", "brand": "Marka", "price": 39.5,
        "unit": "1 L", "unitPrice": "39,50 ₺/L", "discount": 12, "image": "https://…", "url": null
      }
    ]
  }
  ```
- **`scripts/scrape.mjs`** — Veriyi **T.C. Ticaret Bakanlığı Market Fiyatı API'sinden** (`api.marketfiyati.org.tr`) çeker. Bu servis BİM/A101/ŞOK gerçek fiyatlarını tek uçtan sunar. Node 20+, harici bağımlılık yok. Akış:
  1. `POST /api/v2/nearest` — konuma en yakın market depolarını bulur
  2. `POST /api/v2/search` — o depolarda popüler ürünleri arar
  3. Ürünleri markete göre gruplayıp `data/<market>.json` yazar

  Veri yetersizse (< 5 ürün) mevcut dosya korunur; site boş kalmaz.
- **`.github/workflows/update-data.yml`** — Günde iki kez (06:00 / 18:00 UTC) toplayıcıyı çalıştırır, değişiklik varsa otomatik commit eder. **Actions** sekmesinden **Run workflow** ile elle de tetiklenebilir.

## Yerelde çalıştırma

```bash
node scripts/scrape.mjs        # verileri güncelle
python3 -m http.server 8080    # siteyi servis et → http://localhost:8080
```

## GitHub Pages ile yayınlama

**Settings → Pages → Source: `main` / root**. Site `https://<kullanıcı>.github.io/aktuel-radar/` adresinde yayınlanır.

## Not

Fiyatlar bilgilendirme amaçlıdır; fiyat farkı olursa mağaza fiyatı geçerlidir. Konum İstanbul merkez olarak alınır (`scripts/scrape.mjs` içindeki `LOCATION` ile değiştirilebilir).

## Lisans

MIT
