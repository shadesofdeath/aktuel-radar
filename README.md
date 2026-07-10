# Aktüel Radar

**BİM · A101 · ŞOK** aktüel ürünlerini ve indirimlerini tek ekranda takip eden statik web sitesi.

Haftalık kataloglar, fiyatlar, market filtresi ve arama — hepsi tek sayfada. Karanlık mod destekli, mobil öncelikli tasarım.

## Nasıl çalışır?

- **`index.html`** — Tüm arayüz. `data/*.json` dosyalarını okuyup ürünleri listeler. Ekstra derleme adımı yoktur, doğrudan tarayıcıda açılır.
- **`data/bim.json`, `data/a101.json`, `data/sok.json`** — Her market için ürün verisi. Şema:
  ```json
  {
    "market": "bim",
    "updatedAt": "2026-07-10T06:00:00.000Z",
    "source": "https://...",
    "products": [
      { "name": "Ürün adı", "brand": "Marka", "price": 599.0, "unit": "1 adet", "image": "", "url": "https://..." }
    ]
  }
  ```
- **`scripts/scrape.mjs`** — Marketlerin sitelerinden ürünleri derleyip `data/*.json` dosyalarını üretir (Node 20+, harici bağımlılık yok). Bir market'ten veri çekilemezse mevcut dosya korunur.
- **`.github/workflows/update-data.yml`** — Günde iki kez (06:00 / 18:00 UTC) toplayıcıyı çalıştırır, değişiklik varsa otomatik commit eder. Elle tetiklemek için Actions sekmesinden **Run workflow** kullanılabilir.

## Yerelde çalıştırma

```bash
# Verileri güncelle (opsiyonel)
node scripts/scrape.mjs

# Siteyi servis et
python3 -m http.server 8080
# → http://localhost:8080
```

> `data/*.json` içindeki örnek ürünler yer tutucudur. GitHub Actions ilk kez çalıştığında gerçek veriyle değiştirilir.

## GitHub Pages ile yayınlama

Repo ayarlarından **Settings → Pages → Source: `main` / root** seçin. Site `https://<kullanıcı>.github.io/aktuel-radar/` adresinde yayınlanır.

## Not

Veriler marketlerin resmi sitelerinden bilgilendirme amacıyla derlenir. Fiyat farkı olursa mağaza fiyatı geçerlidir. Market sayfa yapıları değişirse `scripts/scrape.mjs` içindeki ayrıştırıcıların güncellenmesi gerekebilir.

## Lisans

MIT
