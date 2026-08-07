/* eslint-disable no-restricted-globals */
/**
 * TARTAN service worker.
 *
 * Build-time placeholders __VERSION__ and __PRECACHE__ are substituted by the
 * `tartanServiceWorker` plugin in vite.config.ts.
 *
 * Strategy:
 *   - App shell + hashed bundles: precached, cache-first (they are immutable).
 *   - Navigations: network-first with a 3s budget, falling back to the cached
 *     shell so the game boots fully offline.
 *   - Supabase / analytics traffic: never cached, never intercepted.
 */
const VERSION = '__VERSION__';
const CACHE = 'tartan-' + VERSION;
const PRECACHE = __PRECACHE__;
const SHELL = '/index.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // addAll is atomic-or-nothing; add individually so one 404 cannot brick
      // the whole install on a partially deployed CDN.
      await Promise.all(
        PRECACHE.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => undefined)),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('tartan-') && k !== CACHE).map((k) => caches.delete(k)));
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function isBypassed(url) {
  return (
    url.pathname.startsWith('/rest/') ||
    url.pathname.startsWith('/auth/') ||
    url.pathname.startsWith('/functions/') ||
    url.pathname.startsWith('/realtime/')
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Cross-origin (Supabase, ad networks, fonts) goes straight to the network.
  if (url.origin !== self.location.origin || isBypassed(url)) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const preloaded = await event.preloadResponse;
          if (preloaded) return preloaded;
          const fresh = await withTimeout(fetch(req), 3000);
          const cache = await caches.open(CACHE);
          cache.put(SHELL, fresh.clone());
          return fresh;
        } catch {
          const cached = (await caches.match(SHELL)) || (await caches.match(req));
          return cached || Response.error();
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const fresh = await fetch(req);
        // Only persist successful, non-opaque same-origin responses.
        if (fresh && fresh.status === 200 && fresh.type === 'basic') {
          const cache = await caches.open(CACHE);
          cache.put(req, fresh.clone());
        }
        return fresh;
      } catch {
        return cached || Response.error();
      }
    })(),
  );
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
