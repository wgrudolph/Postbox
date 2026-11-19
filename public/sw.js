// Service worker: caches the static shell only. Never touches /api/* or /auth/*.

const CACHE = "postbox-shell-v1";
const SHELL = [
  "/",
  "/styles.css",
  "/app.js",
  "/counter.js",
  "/manifest.webmanifest",
  "/fonts/newsreader-latin-400-normal.woff2",
  "/fonts/newsreader-latin-400-italic.woff2",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) return; // network only, untouched

  // Stale-while-revalidate: serve the cached shell instantly, refresh it in the background.
  const key = req.mode === "navigate" ? "/" : req;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(key);
      const network = fetch(req)
        .then((res) => {
          if (res.ok && res.type === "basic") cache.put(key, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
