/* Minimal PWA service worker for static assets. */
const CACHE_NAME = "invoice-admin-pwa-v3";
const ASSETS = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/favicon.svg",
  "/manifest.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(ASSETS);
      self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
      self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Runtime config is injected at deploy time and must never go stale.
  // Network-first, fall back to cache only when offline.
  if (url.pathname === "/config.json") {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req, { cache: "no-store" });
          const cache = await caches.open(CACHE_NAME);
          cache.put(req, res.clone()).catch(() => {});
          return res;
        } catch {
          const cached = await caches.match(req);
          return cached ?? Response.error();
        }
      })()
    );
    return;
  }

  // For navigations: network-first (fresh HTML), fallback to cache.
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          const cache = await caches.open(CACHE_NAME);
          cache.put("/index.html", res.clone()).catch(() => {});
          return res;
        } catch {
          const cached = await caches.match("/index.html");
          return cached ?? Response.error();
        }
      })()
    );
    return;
  }

  // For static assets: cache-first, revalidate in background.
  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) {
        fetch(req)
          .then(async (res) => {
            const cache = await caches.open(CACHE_NAME);
            cache.put(req, res);
          })
          .catch(() => {});
        return cached;
      }
      const res = await fetch(req);
      const cache = await caches.open(CACHE_NAME);
      cache.put(req, res.clone()).catch(() => {});
      return res;
    })()
  );
});

