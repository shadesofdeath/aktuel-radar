// Aktüel Radar — veri toplayıcı
// GitHub Actions üzerinde çalışır, data/*.json dosyalarını gerçek verilerle günceller.
//
// Kaynak: Ticaret Bakanlığı Market Fiyatı API'si (api.marketfiyati.org.tr).
// BİM · A101 · ŞOK ürünlerinin gerçek fiyatlarını tek uçtan verir.
// Bağımlılık YOK: Node 20+ yerleşik fetch.
//
// Akış:
//   1) POST /api/v2/nearest   → konuma en yakın market depolarını (id) bul
//   2) POST /api/v2/search    → o depolarda anahtar kelimelerle ürün ara
//   3) Ürünleri markete göre grupla, data/<market>.json yaz

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const BASE = "https://api.marketfiyati.org.tr";

// İstanbul merkez — yoğun bölge, tüm zincirlerin depoları burada bulunur.
const LOCATION = { latitude: 41.0082, longitude: 28.9784 };
const DISTANCE_KM = 5;
const DEPOTS_PER_MARKET = 6; // her market için taranacak depo sayısı

// Frontend sekmeleriyle eşleşen hedef marketler.
const TARGETS = {
  bim: "BİM",
  a101: "A101",
  sok: "ŞOK",
};

// Geniş ürün yelpazesi için popüler market kalemleri.
const KEYWORDS = [
  "süt", "yumurta", "ekmek", "peynir", "yoğurt", "tereyağı", "kaşar",
  "çay", "kahve", "nescafe", "makarna", "pirinç", "bulgur", "mercimek",
  "ayçiçek yağ", "zeytinyağı", "şeker", "un", "salça", "bal", "zeytin",
  "çikolata", "bisküvi", "cips", "gofret", "kola", "su", "meyve suyu",
  "deterjan", "yumuşatıcı", "şampuan", "diş macunu", "sabun",
  "tuvalet kağıdı", "peçete", "bebek bezi", "islak mendil",
  "kedi maması", "köpek maması", "çamaşır suyu", "bulaşık deterjanı",
];

const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  Origin: "https://marketfiyati.org.tr",
  Referer: "https://marketfiyati.org.tr/",
};

async function post(path, body, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(BASE + path, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await sleep(400 * (i + 1));
    }
  }
  throw lastErr;
}

// marketAdi / marketName -> hedef anahtarımız (bim | a101 | sok | null)
function normalizeMarket(name) {
  if (!name) return null;
  const s = name.toString().toLocaleLowerCase("tr-TR").replace(/ş/g, "s").trim();
  if (s.includes("bim")) return "bim";
  if (s.includes("a101") || s.includes("a-101")) return "a101";
  if (s.includes("sok")) return "sok"; // "şok" -> "sok"
  return null;
}

// 1) En yakın depoları bul, hedef marketler için depo id'lerini topla.
async function collectDepots() {
  const data = await post("/api/v2/nearest", {
    latitude: LOCATION.latitude,
    longitude: LOCATION.longitude,
    distance: DISTANCE_KM,
  });
  const list = Array.isArray(data) ? data : data?.content || [];
  const byMarket = { bim: [], a101: [], sok: [] };
  for (const d of list) {
    const m = normalizeMarket(d.marketName || d.marketAdi);
    if (m && byMarket[m] && byMarket[m].length < DEPOTS_PER_MARKET) {
      byMarket[m].push(d.id);
    }
  }
  const depotIds = [...byMarket.bim, ...byMarket.a101, ...byMarket.sok];
  console.log(
    `Depolar → BİM:${byMarket.bim.length} A101:${byMarket.a101.length} ŞOK:${byMarket.sok.length} (toplam ${depotIds.length})`
  );
  return depotIds;
}

// 2) Bir anahtar kelime için ürünleri ara.
async function searchKeyword(keyword, depots) {
  const data = await post("/api/v2/search", {
    keywords: keyword,
    pages: 0,
    size: 100,
    latitude: LOCATION.latitude,
    longitude: LOCATION.longitude,
    distance: DISTANCE_KM,
    depots,
  });
  return data?.content || [];
}

// 3) Ürünleri markete göre grupla.
function foldProduct(product, buckets, seen) {
  const infos = product.productDepotInfoList || [];
  // Her market için o markette geçerli en düşük fiyatı seç.
  const best = {}; // market -> { price, unitPrice, percentage }
  for (const info of infos) {
    const m = normalizeMarket(info.marketAdi);
    if (!m || typeof info.price !== "number") continue;
    if (!best[m] || info.price < best[m].price) {
      best[m] = {
        price: info.price,
        unitPrice: info.unitPrice || "",
        percentage: typeof info.percentage === "number" ? info.percentage : 0,
      };
    }
  }
  const unit = product.refinedVolumeOrWeight || product.refinedQuantityUnit || "";
  for (const [m, b] of Object.entries(best)) {
    const key = `${m}|${product.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    buckets[m].push({
      name: (product.title || "").trim(),
      brand: (product.brand || "").trim(),
      price: b.price,
      unit,
      unitPrice: b.unitPrice,
      discount: Math.round(b.percentage) || 0,
      image: product.imageUrl || "",
      url: null,
    });
  }
}

function save(market, products) {
  if (!existsSync("data")) mkdirSync("data", { recursive: true });
  const path = `data/${market}.json`;
  const MIN = 5; // bundan az ürün geldiyse mevcut veriyi koru
  if (products.length < MIN && existsSync(path)) {
    const old = JSON.parse(readFileSync(path, "utf8"));
    if ((old.products?.length || 0) >= MIN) {
      console.log(`[${market}] yetersiz veri (${products.length}) — eski veri korunuyor`);
      return;
    }
  }
  // İndirim yüzdesi (varsa) sonra fiyat artan sırada.
  products.sort((a, b) => b.discount - a.discount || a.price - b.price);
  const payload = {
    market,
    label: TARGETS[market],
    updatedAt: now(),
    source: "https://marketfiyati.org.tr",
    count: products.length,
    products: products.slice(0, 300),
  };
  writeFileSync(path, JSON.stringify(payload, null, 2) + "\n");
  console.log(`[${market}] ${payload.products.length} ürün yazıldı`);
}

async function main() {
  const depots = await collectDepots();
  if (!depots.length) throw new Error("Hedef marketler için depo bulunamadı");

  const buckets = { bim: [], a101: [], sok: [] };
  const seen = new Set();

  for (const kw of KEYWORDS) {
    try {
      const content = await searchKeyword(kw, depots);
      for (const p of content) foldProduct(p, buckets, seen);
      console.log(`"${kw}" → ${content.length} sonuç`);
    } catch (e) {
      console.warn(`"${kw}" hata: ${e.message}`);
    }
    await sleep(150);
  }

  for (const m of Object.keys(buckets)) save(m, buckets[m]);
}

main().catch((e) => {
  console.error("HATA:", e.message);
  process.exit(1);
});
