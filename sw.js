// Aktüel Radar — Service Worker (PWA offline + hız)
const VERSION = "v1";
const SHELL = `ar-shell-${VERSION}`;
const DATA = `ar-data-${VERSION}`;
const SHELL_ASSETS = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // dış kaynaklar (fontlar, görseller) tarayıcıya bırakılır

  // Veri (JSON): network-first, çevrimdışıysa cache.
  if (url.pathname.includes("/data/")) {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(DATA).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Kabuk: cache-first, arkada güncelle (stale-while-revalidate).
  e.respondWith(
    caches.match(req).then((cached) => {
      const net = fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put(req, copy));
        return res;
      }).catch(() => cached);
      return cached || net;
    })
  );
});
