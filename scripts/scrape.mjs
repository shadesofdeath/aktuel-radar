// Aktüel Radar — veri toplayıcı
// BİM · A101 · ŞOK aktüel ürünlerini derleyip data/<market>.json dosyalarına yazar.
//
// Node 20+ (yerleşik fetch) ile çalışır, harici bağımlılık yoktur.
// Kullanım:  node scripts/scrape.mjs
//
// Not: Marketlerin sayfa yapıları zaman zaman değişir. Bir market'ten veri
// çekilemezse mevcut data/<market>.json korunur; site boş kalmaz.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const SOURCES = {
  bim: "https://www.bim.com.tr/categories/100/aktuel-urunler.aspx",
  a101: "https://www.a101.com.tr",
  sok: "https://www.sokmarket.com.tr",
};

// ---- yardımcılar -----------------------------------------------------------

async function getHtml(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "tr-TR,tr;q=0.9" },
  });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return await res.text();
}

// Türk lokal fiyat metnini (ör. "1.299,90 TL") sayıya çevirir.
function parsePrice(text) {
  if (text == null) return null;
  const m = String(text).match(/(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{1,2}))?/);
  if (!m) return null;
  const whole = m[1].replace(/\./g, "");
  const frac = m[2] || "0";
  const val = parseFloat(`${whole}.${frac}`);
  return Number.isFinite(val) ? val : null;
}

function cleanText(s) {
  return (s || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function readExisting(market) {
  try {
    const raw = await readFile(join(DATA_DIR, `${market}.json`), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---- market ayrıştırıcıları -------------------------------------------------
// Her biri { name, brand, price, unit, image, url } dizisi döndürür.
// Sayfa yapısı değişirse burada seçicileri güncelleyin.

async function scrapeBim() {
  const html = await getHtml(SOURCES.bim);
  const products = [];
  // BİM aktüel ürünleri "productListItem" bloklarında listeler.
  const blocks = html.split(/class="[^"]*productName[^"]*"/i).slice(1);
  for (const b of blocks) {
    const name = cleanText(b.split(/<\/[a-z]+>/i)[0]);
    const priceText = (b.match(/class="[^"]*text-danger[^"]*"[^>]*>([^<]+)/i) || [])[1];
    const price = parsePrice(priceText);
    const image = (b.match(/<img[^>]+src="([^"]+)"/i) || [])[1] || "";
    if (name && price != null) {
      products.push({ name, brand: "", price, unit: "", image, url: SOURCES.bim });
    }
  }
  return products;
}

async function scrapeA101() {
  const html = await getHtml(SOURCES.a101);
  const products = [];
  // A101 ürün kartlarını __NEXT_DATA__ veya kart HTML'inden okumayı dener.
  const next = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (next) {
    try {
      const json = JSON.parse(next[1]);
      const stack = [json];
      while (stack.length) {
        const node = stack.pop();
        if (Array.isArray(node)) stack.push(...node);
        else if (node && typeof node === "object") {
          if (node.name && (node.price || node.priceValue)) {
            const price = parsePrice(node.price ?? node.priceValue);
            if (price != null)
              products.push({
                name: cleanText(node.name),
                brand: cleanText(node.brand || ""),
                price,
                unit: "",
                image: node.image || node.imageUrl || "",
                url: SOURCES.a101,
              });
          }
          stack.push(...Object.values(node));
        }
      }
    } catch {
      /* JSON okunamadı, yoksay */
    }
  }
  return products;
}

async function scrapeSok() {
  const html = await getHtml(SOURCES.sok);
  const products = [];
  // ŞOK ürün kartları "ProductCard" bloklarında yer alır.
  const blocks = html.split(/class="[^"]*ProductCard[^"]*"/i).slice(1);
  for (const b of blocks) {
    const name = cleanText((b.match(/alt="([^"]+)"/i) || [])[1]);
    const priceText = (b.match(/class="[^"]*price[^"]*"[^>]*>([^<]+)/i) || [])[1];
    const price = parsePrice(priceText);
    const image = (b.match(/<img[^>]+src="([^"]+)"/i) || [])[1] || "";
    if (name && price != null) {
      products.push({ name, brand: "", price, unit: "", image, url: SOURCES.sok });
    }
  }
  return products;
}

const SCRAPERS = { bim: scrapeBim, a101: scrapeA101, sok: scrapeSok };

// ---- ana akış --------------------------------------------------------------

async function run() {
  await mkdir(DATA_DIR, { recursive: true });
  const now = new Date().toISOString();

  for (const [market, scraper] of Object.entries(SCRAPERS)) {
    let products = [];
    let ok = false;
    try {
      products = await scraper();
      ok = products.length > 0;
      console.log(`[${market}] ${products.length} ürün bulundu`);
    } catch (err) {
      console.warn(`[${market}] hata: ${err.message}`);
    }

    if (!ok) {
      // Çekilemedi → mevcut veriyi koru, boş dosya yazma.
      const existing = await readExisting(market);
      if (existing) {
        console.log(`[${market}] mevcut veri korunuyor (${existing.products?.length || 0} ürün)`);
        continue;
      }
    }

    const payload = {
      market,
      updatedAt: now,
      source: SOURCES[market],
      products,
    };
    await writeFile(
      join(DATA_DIR, `${market}.json`),
      JSON.stringify(payload, null, 2) + "\n",
      "utf8"
    );
    console.log(`[${market}] data/${market}.json güncellendi`);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
