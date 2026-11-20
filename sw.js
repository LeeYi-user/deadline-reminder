// App 本體（頁面、程式、樣式、圖示）整包裝在有版本號的快取裡，一律先用快取，開啟不用等網路。
// 新版只在這個檔案的版本號變了時才整包下載，下載完整才換上，所以頁面和程式一定是同一版，不會半新半舊。
// 資料不經過這裡（資料存在 localStorage，同步走 Google Apps Script）。
var CACHE = 'deadline-shell-v12';
var FILES = ['./', 'index.html', 'app.js?v=12', 'app.css?v=12', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png',
  'maskable-192.png', 'maskable-512.png', 'apple-touch-icon.png', 'favicon-64.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(FILES.map(function (f) { return new Request(f, { cache: 'reload' }); }));   // 不用瀏覽器裡的舊檔
  }));
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
  var nav = req.mode === 'navigate';
  e.respondWith(caches.open(CACHE).then(function (cache) {
    var hit = nav ? cache.match('index.html')
      : cache.match(req).then(function (r) { return r || cache.match(req, { ignoreSearch: true }); });
    return hit.then(function (r) {
      if (r) return r;
      // 快取裡沒有：向網路要。失敗時只有開頁面才退回快取的 index.html；程式、樣式絕不拿頁面頂替（以前會因此卡在「載入中」）
      return fetch(req).catch(function (err) {
        if (nav) return caches.match('index.html', { ignoreSearch: true }).then(function (x) { if (x) return x; throw err; });
        throw err;
      });
    });
  }));
});
