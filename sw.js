// 只快取這個外框（頁面和圖示），讓 App 開得快、離線時也能顯示「沒有網路」。
// 實際資料由 Google Apps Script 網頁提供，不經過這裡。
var CACHE = 'deadline-shell-v2';
var FILES = ['./', 'index.html', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png',
  'maskable-192.png', 'maskable-512.png', 'apple-touch-icon.png', 'favicon-64.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }));
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

// 先用網路（拿到最新版），沒網路才用快取
self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(function (r) {
    var copy = r.clone();
    caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
    return r;
  }).catch(function () {
    return caches.match(e.request, { ignoreSearch: true }).then(function (r) { return r || caches.match('index.html'); });
  }));
});
