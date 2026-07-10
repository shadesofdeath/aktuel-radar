// Aktüel Radar — veri toplayıcı
// GitHub Actions üzerinde çalışır, data/*.json dosyalarını gerçek verilerle günceller.
//
// Kaynak: T.C. Ticaret Bakanlığı Market Fiyatı API'si (api.marketfiyati.org.tr).
// Konuma yakın TÜM market zincirlerini otomatik keşfeder — sabit market listesi yok.
// Bağımlılık YOK: Node 20+ yerleşik fetch.
//
// Akış:
//   1) POST /api/v2/nearest → konuma yakın tüm depoları bul, markete göre grupla
//   2) POST /api/v2/search  → o depolarda anahtar kelimelerle ürün ara
//   3) Ürünleri markete göre grupla → data/<slug>.json + data/markets.json

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const BASE = "https://api.marketfiyati.org.tr";

// İstanbul merkez — en geniş zincir çeşitliliği burada bulunur.
const LOCATION = { latitude: 41.0082, longitude: 28.9784 };
const DISTANCE_KM = 15;
const DEPOTS_PER_MARKET = 5; // her market için taranacak depo sayısı
const MIN_PRODUCTS = 8; // bir market en az bu kadar ürün verirse sekme açılır

// Bilinen zincirler için görünen ad + marka rengi. Bilinmeyenler otomatik
// başlıklandırılır ve slug'dan türetilen bir renk alır.
const KNOWN = {
  bim: ["BİM", "#E4001B"],
  a101: ["A101", "#00A0DF"],
  sok: ["ŞOK", "#F0A500"],
  migros: ["Migros", "#FF6A13"],
  carrefour: ["CarrefourSA", "#0E4C92"],
  carrefoursa: ["CarrefourSA", "#0E4C92"],
  metro: ["Metro", "#003D7D"],
  hakmar: ["Hakmar", "#D6001C"],
  "hakmar-ekspres": ["Hakmar Ekspres", "#D6001C"],
  onur: ["Onur Market", "#ED1C24"],
  tarimkredi: ["Tarım Kredi", "#0A7D34"],
  "tarim-kredi": ["Tarım Kredi", "#0A7D34"],
  mopas: ["Mopaş", "#8B1E3F"],
  ismar: ["İsmar", "#1B6CA8"],
  happycenter: ["Happy Center", "#E6007E"],
  sec: ["Seç Market", "#00843D"],
  file: ["File Market", "#E4002B"],
  kim: ["Kim Market", "#00A651"],
  snowy: ["Snowy", "#0072BC"],
  uyum: ["Uyum", "#EC1C24"],
  ekomini: ["Ekomini", "#0067B1"],
  marka: ["Marka Market", "#D2232A"],
  caglar: ["Çağlar", "#0057A8"],
  begendik: ["Beğendik", "#E30613"],
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

// Market adını kararlı bir slug'a çevir: "CarrefourSA" -> "carrefoursa",
// "Tarım Kredi" -> "tarimkredi", "ŞOK" -> "sok"
function slugify(name) {
  if (!name) return null;
  const map = { ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u", İ: "i" };
  const s = name
    .toString()
    .trim()
    .toLocaleLowerCase("tr-TR")
    .replace(/[çğıöşüİ]/g, (c) => map[c] || c)
    .replace(/[^a-z0-9]+/g, "");
  return s || null;
}

function titleCase(slug) {
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

// Bilinmeyen marketler için slug'dan kararlı, canlı bir renk üret.
function colorFromSlug(slug) {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) % 360;
  return `hsl(${h}, 62%, 45%)`;
}

function metaFor(slug) {
  if (KNOWN[slug]) return { label: KNOWN[slug][0], color: KNOWN[slug][1] };
  return { label: titleCase(slug), color: colorFromSlug(slug) };
}

// 1) En yakın depoları bul, her market için depo id'lerini topla.
async function collectDepots() {
  const data = await post("/api/v2/nearest", {
    latitude: LOCATION.latitude,
    longitude: LOCATION.longitude,
    distance: DISTANCE_KM,
  });
  const list = Array.isArray(data) ? data : data?.content || [];
  const byMarket = new Map(); // slug -> [depotId]
  for (const d of list) {
    const slug = slugify(d.marketName || d.marketAdi);
    if (!slug) continue;
    if (!byMarket.has(slug)) byMarket.set(slug, []);
    const arr = byMarket.get(slug);
    if (arr.length < DEPOTS_PER_MARKET) arr.push(d.id);
  }
  const depotIds = [...byMarket.values()].flat();
  console.log(
    `Keşfedilen market sayısı: ${byMarket.size} — ${[...byMarket.keys()].join(", ")}`
  );
  console.log(`Toplam depo: ${depotIds.length}`);
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

// 3) Ürünü markete göre böl (her markette geçerli en düşük fiyat).
function foldProduct(product, buckets, seen) {
  const infos = product.productDepotInfoList || [];
  const best = {}; // slug -> { price, unitPrice }
  for (const info of infos) {
    const slug = slugify(info.marketAdi);
    if (!slug || typeof info.price !== "number") continue;
    if (!best[slug] || info.price < best[slug].price) {
      best[slug] = { price: info.price, unitPrice: info.unitPrice || "" };
    }
  }
  const unit = product.refinedVolumeOrWeight || product.refinedQuantityUnit || "";
  for (const [slug, b] of Object.entries(best)) {
    const key = `${slug}|${product.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!buckets[slug]) buckets[slug] = [];
    buckets[slug].push({
      name: (product.title || "").trim(),
      brand: (product.brand || "").trim(),
      price: b.price,
      unit,
      unitPrice: b.unitPrice,
      image: product.imageUrl || "",
      url: null,
    });
  }
}

function save(slug, products, stamp) {
  const path = `data/${slug}.json`;
  if (products.length < MIN_PRODUCTS && existsSync(path)) {
    const old = JSON.parse(readFileSync(path, "utf8"));
    if ((old.products?.length || 0) >= MIN_PRODUCTS) {
      console.log(`[${slug}] yetersiz (${products.length}) — eski veri korunuyor`);
      return old.products.length;
    }
  }
  products.sort((a, b) => a.price - b.price);
  const trimmed = products.slice(0, 400);
  const { label, color } = metaFor(slug);
  const payload = {
    market: slug,
    label,
    color,
    updatedAt: stamp,
    source: "https://marketfiyati.org.tr",
    count: trimmed.length,
    products: trimmed,
  };
  writeFileSync(path, JSON.stringify(payload, null, 2) + "\n");
  return trimmed.length;
}

async function main() {
  if (!existsSync("data")) mkdirSync("data", { recursive: true });
  const stamp = now();

  const depots = await collectDepots();
  if (!depots.length) throw new Error("Hiç depo bulunamadı");

  const buckets = {}; // slug -> [products]
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

  // Yaz + manifest oluştur.
  const manifest = [];
  for (const slug of Object.keys(buckets)) {
    const count = save(slug, buckets[slug], stamp);
    if (count >= MIN_PRODUCTS) {
      const { label, color } = metaFor(slug);
      manifest.push({ slug, label, color, count });
    }
  }
  manifest.sort((a, b) => b.count - a.count);

  writeFileSync(
    "data/markets.json",
    JSON.stringify({ updatedAt: stamp, markets: manifest }, null, 2) + "\n"
  );
  console.log(
    `\nManifest: ${manifest.length} market — ` +
      manifest.map((m) => `${m.label}(${m.count})`).join(", ")
  );
}

main().catch((e) => {
  console.error("HATA:", e.message);
  process.exit(1);
});
