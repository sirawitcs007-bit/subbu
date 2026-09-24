// SUBBU service worker: keeps the app usable offline.
// VERSION is rewritten by build.js on every build, which retires the old cache.
const VERSION = "subbu-e84368c206";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png",
  "./firebase-config.js"
];
// Fonts and the Firebase SDK (www.gstatic.com) are versioned files, so a cached copy is safe to serve.
const CDN_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com", "www.gstatic.com"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Pages: network first so updates show up, cached copy when offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put("./index.html", copy)); return res; })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  // Fonts and SDK: serve from cache, refresh in the background.
  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.open(VERSION).then(cache => cache.match(req).then(hit => {
        const fresh = fetch(req).then(res => { cache.put(req, res.clone()); return res; }).catch(() => hit);
        return hit || fresh;
      }))
    );
    return;
  }

  // Firebase config: network first so a changed config reaches installed copies.
  if (url.origin === self.location.origin && url.pathname.endsWith("/firebase-config.js")) {
    event.respondWith(fetch(req).then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return res; }).catch(() => caches.match(req)));
    return;
  }

  // Our own files (icons, manifest): cache first.
  if (url.origin === self.location.origin) {
    event.respondWith(caches.match(req).then(hit => hit || fetch(req)));
  }
});
