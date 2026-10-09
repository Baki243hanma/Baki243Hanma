/* ShopFlow RDC - service worker.
 * Rôle : permettre le chargement de l'INTERFACE hors ligne. Les données métier ne passent PAS
 * par ce cache : elles sont stockées dans IndexedDB (voir src/db).
 * La version de cache et la liste de précache sont injectées au build (vite.config.ts).
 */
const CACHE_NAME = 'shopflow-rdc-' + '__SW_VERSION__';
const PRECACHE_URLS = __PRECACHE_ASSETS__;
const RUNTIME_CONFIG = '/api/config';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        PRECACHE_URLS.map((url) =>
          fetch(url, { cache: 'reload' })
            .then((res) => (res.ok ? cache.put(url, res) : null))
            .catch(() => null),
        ),
      ),
    ),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('shopflow-rdc-') && k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Les requêtes vers Supabase (autre origine) ne sont jamais mises en cache : la sync gère les données.
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put('/index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('/index.html').then((r) => r || caches.match('/')).then((r) => r || offlineResponse())),
    );
    return;
  }

  if (url.pathname === RUNTIME_CONFIG) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || new Response('{}', { headers: { 'Content-Type': 'application/json' } }))),
    );
    return;
  }

  if (url.pathname.startsWith('/api/')) return;

  // Fichiers statiques : cache d'abord (les noms d'assets sont versionnés), réseau sinon.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => offlineResponse());
    }),
  );
});

function offlineResponse() {
  return new Response('Hors ligne', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
