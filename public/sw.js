/**
 * ============================================================================
 * PYKACHU GO v3.5 — 2G & OFFLINE-FIRST SERVICE WORKER CACHE
 * ============================================================================
 * Features:
 *   - Pre-caches ultra-lightweight .webp assets, /data/*.json, audio, and shell.
 *   - Stale-While-Revalidate for /api/bootstrap and /data/*.json (0ms warm boot).
 *   - Cache-First + immutable for /api/pokemon/*.webp, /assets/*, and fonts.
 *   - Network-Only for telemetry POSTs and /api/admin/* endpoints.
 * ============================================================================
 */

const CACHE_NAME = 'pykachu-cache-v4.5.0';

const STATIC_PRECACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/data/config.json',
  '/data/puzzle.json',
  '/data/teams.json',
  '/data/meme.json',
  '/data/admin.json',
  '/assets/fonts/material-symbols-rounded.woff2',
  '/assets/img/pokeball.svg',
  '/assets/img/cpp.svg',
  '/assets/img/oak.webp',
  '/assets/img/ash-3.webp',
  '/assets/img/brock.webp',
  '/assets/img/jenny.webp',
  '/assets/img/pikachu.webp',
  '/assets/img/poketropy.webp',
  '/assets/img/pykachu.webp',
  '/assets/img/go.webp',
  '/assets/img/logo1.webp',
  '/assets/img/csi.webp',
  '/assets/img/auron.webp',
  '/assets/img/python.webp',
  '/assets/img/grass.webp',
  '/assets/img/fire.webp',
  '/assets/img/water.webp',
  '/assets/img/ground.webp',
  '/assets/img/ghost.webp',
  '/assets/img/fairy.webp',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        cache.addAll(STATIC_PRECACHE).catch((err) => {
          console.warn('[SW] Precache partial miss:', err);
        })
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((name) => name !== CACHE_NAME)
            .map((name) => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 1. Never cache telemetry POSTs, Apps Script, or admin/health API calls
  if (
    req.method !== 'GET' ||
    url.hostname.includes('script.google.com') ||
    url.hostname.includes('script.googleusercontent.com') ||
    url.pathname.startsWith('/api/admin') ||
    url.pathname.startsWith('/api/health') ||
    url.pathname.startsWith('/api/epoch')
  ) {
    return;
  }

  // The install step refreshes index.html before activating a new worker, so
  // cached navigation can open immediately, including as an installed PWA.
  if (req.mode === 'navigate' && url.origin === self.location.origin) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = (await cache.match(req)) || (await cache.match('/index.html')) || (await cache.match('/'));
        if (cached) return cached;
        const response = await fetch(req);
        if (response.ok) {
          await cache.put(req, response.clone());
          await cache.put('/index.html', response.clone());
        }
        return response;
      }).catch(() => new Response('Offline and app shell not cached', { status: 503 }))
    );
    return;
  }

  // Vite's content-hashed JS/CSS never changes at a URL; serve it locally on
  // repeat launches and cache it after its first network request.
  if (
    url.origin === self.location.origin &&
    /\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(?:js|css)$/.test(url.pathname)
  ) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        const response = await fetch(req);
        if (response.ok) await cache.put(req, response.clone());
        return response;
      })
    );
    return;
  }

  // Puzzle art URLs are user-edited data, so always try the newest puzzle catalog first.
  if (url.pathname === '/data/puzzle.json') {
    event.respondWith(
      fetch(req)
        .then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            caches.open(CACHE_NAME).then((cache) => cache.put(req, networkRes.clone()));
          }
          return networkRes;
        })
        .catch(async () => (await caches.match(req)) || new Response('', { status: 503 }))
    );
    return;
  }

  // Always fetch the latest server puzzle catalog before using an offline copy.
  if (url.pathname === '/api/bootstrap') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(req);
        const storedAt = Number(cached?.headers.get('x-pykachu-cached-at') || 0);
        if (cached && storedAt && Date.now() - storedAt < 5000) {
          event.waitUntil(
            fetch(req).then(async (networkRes) => {
              if (networkRes.ok) {
                const headers = new Headers(networkRes.headers);
                headers.set('x-pykachu-cached-at', String(Date.now()));
                const copy = networkRes.clone();
                await cache.put(req, new Response(copy.body, {
                  status: copy.status,
                  statusText: copy.statusText,
                  headers,
                }));
              }
            }).catch(() => undefined)
          );
          return cached;
        }
        try {
          const networkRes = await fetch(req);
          if (networkRes.ok) {
            const headers = new Headers(networkRes.headers);
            headers.set('x-pykachu-cached-at', String(Date.now()));
            const copy = networkRes.clone();
            await cache.put(req, new Response(copy.body, {
              status: copy.status,
              statusText: copy.statusText,
              headers,
            }));
          }
          return networkRes;
        } catch {
          return cached || new Response('', { status: 503 });
        }
      })()
    );
    return;
  }

  // Cache versioned PokeAPI sprite URLs after the first fetch so later puzzles
  // and repeat visits do not redownload the same artwork on slow connections.
  if (
    url.hostname === 'raw.githubusercontent.com' &&
    url.pathname.startsWith('/PokeAPI/sprites/master/sprites/pokemon/')
  ) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        const response = await fetch(req);
        if (response.ok || response.type === 'opaque') {
          await cache.put(req, response.clone());
        }
        return response;
      })
    );
    return;
  }

  // Stale-While-Revalidate for remaining /data/*.json.
  if (url.pathname.startsWith('/data/')) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(req);
        const fetchPromise = fetch(req)
          .then((networkRes) => {
            if (networkRes && networkRes.status === 200) {
              cache.put(req, networkRes.clone());
            }
            return networkRes;
          })
          .catch(() => cached);

        return cached || fetchPromise;
      })
    );
    return;
  }

  // 3. Pokémon artwork is network-first so corrected sprites and puzzle art links
  // replace any older fallback image cached by previous app versions.
  if (url.pathname.startsWith('/api/pokemon/')) {
    event.respondWith(
      fetch(req)
        .then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            caches.open(CACHE_NAME).then((cache) => cache.put(req, networkRes.clone()));
          }
          return networkRes;
        })
        .catch(async () => (await caches.match(req)) || new Response('', { status: 503 }))
    );
    return;
  }

  // 4. Cache-First for static assets, fonts, and audio.
  if (
    url.pathname.startsWith('/assets/') ||
    url.pathname.endsWith('.webp') ||
    url.pathname.endsWith('.woff2') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.mp3')
  ) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            caches.open(CACHE_NAME).then((cache) => cache.put(req, networkRes.clone()));
          }
          return networkRes;
        });
      })
    );
    return;
  }

  // 5. App Shell / Vite chunks: Network-first with offline cache fallback
  event.respondWith(
    fetch(req)
      .then((networkRes) => {
        if (networkRes && networkRes.status === 200 && url.origin === self.location.origin) {
          caches.open(CACHE_NAME).then((cache) => cache.put(req, networkRes.clone()));
        }
        return networkRes;
      })
      .catch(async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        if (req.mode === 'navigate') {
          return caches.match('/index.html');
        }
        return new Response('Offline and resource not cached', { status: 503 });
      })
  );
});
