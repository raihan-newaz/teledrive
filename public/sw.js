/**
 * TeleDrive — Secure Service Worker (PWA)
 * Version: 1.0.0
 * 
 * SECURITY ADVISORY:
 * TeleDrive holds user encrypted cloud data. This Service Worker ONLY caches
 * the static UI app-shell (HTML, CSS, JS, UI Icons).
 * 
 * NEVER CACHED BY SW:
 * - /api/* (API endpoints, uploads, metadata, settings)
 * - /api/files/stream, /api/files/download (decrypted or encrypted payloads)
 * - /api/files/thumb (media thumbnails)
 * - /webdav/* (WebDAV access)
 * - Non-GET requests (POST, PUT, DELETE)
 */

const CACHE_NAME = 'teledrive-shell-v1';

const STATIC_SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.svg',
  '/css/styles.css',
  '/css/responsive.css',
  '/css/themes.css',
  '/js/app.js',
  '/js/ui.js',
  '/js/api.js',
  '/js/upload.js',
  '/js/preview.js',
  '/js/setup.js',
  '/js/pwa.js',
  '/icons/icon.svg',
  '/icons/icon-180.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable.png'
];

// 1. Install: Precache Static App Shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_SHELL_ASSETS).catch((err) => {
        console.warn('[SW] Precache warning:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// 2. Activate: Purge Old Shell Caches & Take Control Immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// 3. Fetch: Dynamic Route Filtering
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // STRICT BYPASS: Never intercept or cache API, streaming, WebDAV, or dynamic mutation requests
  if (
    request.method !== 'GET' ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/webdav/') ||
    url.searchParams.has('token') ||
    request.headers.has('range')
  ) {
    return; // Let browser handle network request natively
  }

  // Cross-origin Google Fonts & CDN fonts: Stale-While-Revalidate
  if (url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com')) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cachedResponse = await cache.match(request);
        const fetchPromise = fetch(request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            cache.put(request, networkResponse.clone());
          }
          return networkResponse;
        }).catch(() => cachedResponse);
        return cachedResponse || fetchPromise;
      })
    );
    return;
  }

  // Same-origin static assets: Network-First with Cache Fallback (for instant offline shell)
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
            const resClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, resClone));
          }
          return networkResponse;
        })
        .catch(async () => {
          const cachedResponse = await caches.match(request);
          if (cachedResponse) {
            return cachedResponse;
          }
          if (request.mode === 'navigate') {
            return caches.match('/index.html') || caches.match('/');
          }
          return new Response('Network unavailable', { status: 503, statusText: 'Offline' });
        })
    );
  }
});
