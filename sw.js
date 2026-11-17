// Guarda la app en el equipo para que abra sin internet.
// Cuando cambies cualquier archivo, sube el número de VERSION para que los equipos se actualicen.
const VERSION = "facturador-v8-3b";
const ARCHIVOS = [
  "./", "./index.html", "./app.css", "./app.js", "./pdf.js", "./logo.png", "./manifest.webmanifest",
  "./lib/jspdf.umd.min.js", "./lib/jspdf.plugin.autotable.min.js",
  "./fuentes/barlow-latin-400-normal.woff2", "./fuentes/barlow-latin-500-normal.woff2",
  "./fuentes/barlow-latin-600-normal.woff2", "./fuentes/barlow-semi-condensed-latin-500-normal.woff2",
  "./fuentes/barlow-semi-condensed-latin-600-normal.woff2", "./fuentes/barlow-semi-condensed-latin-700-normal.woff2",
  "./iconos/icono-192.png", "./iconos/icono-512.png",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(claves => Promise.all(claves.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Primero intenta internet (para recibir actualizaciones); si no hay, usa la copia guardada.
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: "no-cache" })   // siempre pregunta a GitHub si hay algo nuevo
      .then(r => { const copia = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copia)); return r; })
      .catch(() => caches.match(e.request, {ignoreSearch: true}))
  );
});
