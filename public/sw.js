/* Clario service worker.
 * - Makes the app installable and lets the shell open when offline.
 * - NEVER caches /api/* or anything cross-origin (Supabase, storage, AI): those carry
 *   private data and must always go to the network.
 * Bump CACHE_VERSION when this file's behaviour changes. */
const CACHE_VERSION = 'v1'
const SHELL_CACHE = `clario-shell-${CACHE_VERSION}`
const ASSET_CACHE = `clario-assets-${CACHE_VERSION}`
const PRECACHE = ['/offline.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== SHELL_CACHE && key !== ASSET_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return // never touch cross-origin requests
  if (url.pathname.startsWith('/api/')) return // never cache API traffic

  // Page loads: network first so a deploy is picked up immediately; offline page as the fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone()
          if (response.ok) caches.open(SHELL_CACHE).then((cache) => cache.put('/index.html', copy))
          return response
        })
        .catch(() => caches.match('/index.html').then((cached) => cached || caches.match('/offline.html'))),
    )
    return
  }

  // Hashed build assets never change for a given URL, so serve them from cache.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.open(ASSET_CACHE).then((cache) =>
        cache.match(request).then(
          (cached) =>
            cached ||
            fetch(request).then((response) => {
              if (response.ok) cache.put(request, response.clone())
              return response
            }),
        ),
      ),
    )
  }
})
