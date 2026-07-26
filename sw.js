/* App-shell cache. Exists so the PWA is installable and starts instantly
 * offline. It never registers notifications, sync, or any background task —
 * nothing here can produce a sound, a banner, or a badge.
 */
var CACHE = 'terminal-v3';
var SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './transcript.js',
  './store.js',
  './recorder.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', function (ev) {
  ev.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (ev) {
  ev.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

/* Network first, cache as fallback.
 *
 * This was cache first, which meant a home-screen install kept serving the
 * build it was first installed with and never picked up a deploy. Offline
 * still works — the cache is refreshed on every successful fetch — but code
 * on the phone now matches what was actually shipped. */
self.addEventListener('fetch', function (ev) {
  if (ev.request.method !== 'GET') return;
  if (new URL(ev.request.url).origin !== location.origin) return;
  // no-store bypasses the browser's own HTTP cache, which sits underneath the
  // service worker and will happily hand back the previous build. Without it
  // "network first" can still mean "stale first".
  ev.respondWith(
    fetch(ev.request, { cache: 'no-store' }).catch(function () {
      return fetch(ev.request);
    }).then(function (res) {
      if (res && res.ok && res.type === 'basic') {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(ev.request, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(ev.request).then(function (hit) {
        return hit || caches.match('./index.html');
      });
    })
  );
});
