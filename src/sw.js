// Andén — service worker
// La interfaz se guarda en caché para abrir al instante.
// El horario y el feed de Renfe van siempre a la red primero; sin red se usa la última copia.
const VERSION = "anden-trenes-v2";
const SHELL = ["./", "index.html", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png", "favicon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const esDato = url.pathname.endsWith("horario.json") || url.hostname === "gtfsrt.renfe.com" || url.pathname.endsWith("/rt") || url.pathname.startsWith("/api/");

  if (esDato) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) { const copia = res.clone(); caches.open(VERSION + "-datos").then((c) => c.put(req, copia)); }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((hit) =>
      hit ||
      fetch(req).then((res) => {
        if (res.ok && (url.origin === location.origin || url.hostname.startsWith("fonts.g"))) {
          const copia = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copia));
        }
        return res;
      })
    )
  );
});
