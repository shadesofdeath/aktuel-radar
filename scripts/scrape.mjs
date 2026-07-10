// Aktüel Radar — veri toplayıcı
// GitHub Actions üzerinde çalışır, data/*.json dosyalarını günceller.
// Bağımlılık YOK: Node 20+ yerleşik fetch + regex/JSON tabanlı çözümleme.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const now = () => new Date().toISOString();

async function get(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept-Language": "tr-TR,tr;q=0.9",
      Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

const decode = (s) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

// "315, 00 ₺" / "39,50 ₺" / "425 ₺" -> 315.00
function parsePrice(text) {
  if (!text) return null;
  const m = text.match(/(\d{1,3}(?:\.\d{3})*)\s*,\s*(\d{2})/);
  if (m) return parseFloat(m[1].replace(/\./g, "") + "." + m[2]);
  const p = text.match(/(\d{2,6})\s*₺/);
  return p ? parseFloat(p[1]) : null;
}

// ---------------------------------------------------------------- BİM
// Sayfa sunucu tarafında render ediliyor; sınıf adlarına bağlı kalmadan
// ürün detay linklerine (/aktuel-urunler/<slug>/aktuel.aspx) göre bölüyoruz.
async function scrapeBim() {
  const html = await get("https://www.bim.com.tr/categories/100/aktuel-urunler.aspx");

  // Katalog tarihleri (sağdaki sekmeler)
  const catalogs = [];
  const catRe =
    /href="[^"]*aktuel-urunler\.aspx\?(?:top=1&)?Bim_AktuelTarihKey=(\d+)"[^>]*>([^<]{3,40})</g;
  const seenCat = new Set();
  let cm;
  while ((cm = catRe.exec(html))) {
    const label = decode(cm[2]);
    if (!label || seenCat.has(label)) continue;
    seenCat.add(label);
    catalogs.push({
      label,
      url: `https://www.bim.com.tr/categories/100/aktuel-urunler.aspx?Bim_AktuelTarihKey=${cm[1]}`,
    });
  }

  // Ürün blokları
  const parts = html.split(/href="\/aktuel-urunler\//).slice(1);
  const products = [];
  const seen = new Set();
  for (const part of parts) {
    const chunk = part.slice(0, 2500);
    const slug = chunk.match(/^([^"/]+)\//)?.[1];
    const h2s = [...chunk.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map((x) =>
      decode(x[1].replace(/<[^>]+>/g, ""))
    );
    if (!h2s.length) continue;
    const brand = h2s.length > 1 ? h2s[0] : "";
    const name = h2s.length > 1 ? h2s[1] : h2s[0];
    const unit = decode(chunk.match(/•\s*([^<•]{1,60})/)?.[1] || "");
    const price = parsePrice(chunk);
    if (!name || price === null) continue;
    const key = `${brand}|${name}|${price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    products.push({
      brand,
      name,
      unit,
      price,
      image: null,
      url: slug ? `https://www.bim.com.tr/aktuel-urunler/${slug}/aktuel.aspx` : null,
    });
  }
  return { market: "bim", updatedAt: now(), catalogs, products };
}

// ------------------------------------------------- A101 & ŞOK (Next.js)
// Her iki site de Next.js tabanlı: __NEXT_DATA__ ya da self.__next_f
// içindeki JSON'da ürün nesnelerini genel bir tarama ile buluyoruz.
function extractJsonBlobs(html) {
  const blobs = [];
  const nd = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nd) {
    try {
      blobs.push(JSON.parse(nd[1]));
    } catch {}
  }
  // App Router flight verisi: self.__next_f.push([1,"..."])
  const flight = [...html.matchAll(/self\.__next_f\.push\(\[1,\s*"([\s\S]*?)"\]\)/g)];
  if (flight.length) {
    const joined = flight.map((m) => m[1]).join("");
    let text;
    try {
      text = JSON.parse(`"${joined.replace(/"/g, '\\"').replace(/\\\\"/g, '\\"')}"`);
    } catch {
      text = joined.replace(/\\"/g, '"').replace(/\\n/g, "\n");
    }
    // Metin içindeki JSON dizi/nesnelerini kabaca yakala
    for (const m of text.matchAll(/\{"[^"]{2,40}":[\s\S]*?\}(?=[,\]\}])/g)) {
      try {
        blobs.push(JSON.parse(m[0]));
      } catch {}
    }
  }
  return blobs;
}

function walkForProducts(root, opts = {}) {
  const out = [];
  const seen = new Set();
  const stack = [root];
  let guard = 0;
  while (stack.length && guard++ < 500000) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (const v of node) stack.push(v);
      continue;
    }
    const name =
      typeof node.name === "string"
        ? node.name
        : typeof node.title === "string"
          ? node.title
          : typeof node.attributes?.name === "string"
            ? node.attributes.name
            : null;

    // Fiyat: nesnenin herhangi bir yerinde "39,50 ₺" biçimli metin
    // ya da price/discounted alanları
    let price = null;
    const flat = JSON.stringify(node).slice(0, 4000);
    const priceText = flat.match(/(\d{1,3}(?:\.\d{3})*,\d{2})\s*(?:₺|TL)/);
    if (priceText) price = parsePrice(priceText[1] + " ₺");
    if (price === null) {
      const cand =
        node.prices?.discounted?.value ??
        node.prices?.normal?.value ??
        node.discounted_price ??
        node.discountedPrice ??
        node.price;
      if (typeof cand === "number" && cand > 0) {
        // ŞOK API'si kuruş cinsinden tam sayı döndürür
        price = opts.kurus && Number.isInteger(cand) && cand >= 500 ? cand / 100 : cand;
      }
    }

    if (name && name.length > 2 && name.length < 120 && price !== null && price > 0.5) {
      const brand =
        (typeof node.brand === "string" ? node.brand : node.brand?.name) ||
        node.attributes?.brand ||
        "";
      const image =
        node.image_url ||
        node.imageUrl ||
        (Array.isArray(node.images)
          ? typeof node.images[0] === "string"
            ? node.images[0]
            : node.images[0]?.url
          : null) ||
        node.image ||
        null;
      const key = `${name}|${price}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({
          brand: typeof brand === "string" ? brand : "",
          name: decode(name),
          unit: "",
          price,
          image: typeof image === "string" ? image : null,
          url: null,
        });
      }
    }
    for (const v of Object.values(node)) stack.push(v);
  }
  return out;
}

async function scrapeNextSite(market, urls, opts = {}) {
  let products = [];
  for (const url of urls) {
    try {
      const html = await get(url);
      for (const blob of extractJsonBlobs(html)) {
        products = products.concat(walkForProducts(blob, opts));
      }
      if (products.length >= 20) break;
    } catch (e) {
      console.warn(`[${market}] ${url}: ${e.message}`);
    }
  }
  // Tekilleştir
  const seen = new Set();
  products = products.filter((p) => {
    const k = `${p.name}|${p.price}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { market, updatedAt: now(), catalogs: [], products: products.slice(0, 300) };
}

const scrapeA101 = () =>
  scrapeNextSite("a101", [
    "https://www.a101.com.tr/kapida/haftanin-yildizlari",
    "https://www.a101.com.tr/kapida/aldin-aldin",
    "https://www.a101.com.tr/aktuel-urunler",
    "https://www.a101.com.tr/",
  ]);

const scrapeSok = () =>
  scrapeNextSite(
    "sok",
    [
      "https://www.sokmarket.com.tr/kampanyalar",
      "https://www.sokmarket.com.tr/indirimli-urunler",
      "https://www.sokmarket.com.tr/",
    ],
    { kurus: true }
  );

// ----------------------------------------------------------------- main
function save(result) {
  const path = `data/${result.market}.json`;
  const min = 3; // bundan az ürün geldiyse eski veriyi koru
  if (result.products.length < min && existsSync(path)) {
    const old = JSON.parse(readFileSync(path, "utf8"));
    if ((old.products?.length || 0) >= min) {
      console.log(`[${result.market}] yeni veri yetersiz (${result.products.length}), eski veri korunuyor`);
      return;
    }
  }
  writeFileSync(path, JSON.stringify(result, null, 2));
  console.log(`[${result.market}] ${result.products.length} ürün yazıldı`);
}

for (const job of [scrapeBim, scrapeA101, scrapeSok]) {
  try {
    save(await job());
  } catch (e) {
    console.error(`HATA: ${e.message} (mevcut veri korunuyor)`);
  }
}
