// App 本體（頁面、程式、圖示）先從快取拿，開啟幾乎不用等；同時在背景向網路要新版，下次開就是新版。
// 資料不經過這裡（資料存在 localStorage，同步走 Google Apps Script）。
var CACHE = 'deadline-shell-v5';
var FILES = ['./', 'index.html', 'app.js?v=5', 'app.css?v=5', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png',
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

self.addEventListener('fetch', function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(function (cache) {
    return cache.match(req).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(function () { return hit || cache.match('index.html'); });
      if (hit) { e.waitUntil(net.then(function () {}, function () {})); return hit; }
      return net;
    });
  }));
});
