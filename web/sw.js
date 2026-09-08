const SHELL_CACHE = 'sandwich-shell-v31';
const SHELL = [
  '/', '/index.html', '/config.js', '/styles.css', '/app.js',
  '/js/i18n.js', '/js/i18n/en-core.js', '/js/i18n/en-app.js',
  '/js/api.js', '/js/ui.js', '/manifest.json',
  '/shantech-logo-192.png', '/shantech-logo-512.png', '/github-mark.svg'
];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(SHELL_CACHE).then(function (cache) { return cache.addAll(SHELL); }));
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (key) { return key !== SHELL_CACHE; }).map(function (key) { return caches.delete(key); }));
  }));
  self.clients.claim();
});

self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.indexOf('/api/') === 0) { return; }
  event.respondWith(fetch(event.request).then(function (response) {
    if (response.ok) {
      var copy = response.clone();
      event.waitUntil(caches.open(SHELL_CACHE).then(function (cache) { return cache.put(event.request, copy); }));
    }
    return response;
  }).catch(function () { return caches.match(event.request).then(function (cached) { return cached || caches.match('/index.html'); }); }));
});
