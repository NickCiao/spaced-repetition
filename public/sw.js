const SHELL = "sr-shell-v2";
self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)));
  await clients.claim();
})()));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Branding assets must not be cached here — stale icons poison bookmarks and home-screen tiles.
  if (/^\/static\/(favicon(?:-\d+)?\.(?:svg|png)|apple-touch-icon\.png|icon(?:-maskable)?-\d+\.png|manifest\.webmanifest)$/.test(url.pathname)) return;
  const cacheable = e.request.method === "GET" &&
    (url.pathname === "/capture" || url.pathname.startsWith("/static/"));
  if (!cacheable) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      if (res.ok) { // never cache errors — a 401 must not poison the shell
        const copy = res.clone();
        e.waitUntil(caches.open(SHELL).then((c) => c.put(e.request, copy)));
      }
      return res;
    } catch {
      const hit = await caches.match(e.request);
      if (hit) return hit;
      return new Response("offline", { status: 503 });
    }
  })());
});
