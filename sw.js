/**
 * OmniSense Lab — Service Worker（離線快取）
 * 對應釋出：0.2.2 · 版本規則：docs/VERSIONING.md
 * 作者：小威老師 · 授權：見倉庫 LICENSE
 */
const CACHE_NAME = 'omnisense-lab-v0.2.2';
const ASSETS_TO_CACHE = [
  './index.html',
  './manifest.json',
  './sw.js',
  './assets/icons/icon-192x192.png',
  './assets/icons/icon-512x512.png'
];

// 安裝階段：只快取本機檔案（CDN 常因 CORS 無法 cache.addAll，導致整體安裝失敗）
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('OmniSense SW: 正在快取本機資源');
      return cache.addAll(ASSETS_TO_CACHE).catch((err) => {
        console.warn('OmniSense SW: addAll 部分失敗', err);
        return cache.add('./index.html').catch(() => {});
      });
    }).then(() => self.skipWaiting())
  );
});

// 激活階段：清理舊快取
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            console.log('OmniSense SW: 清理舊快取', cache);
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// 攔截請求：HTML 優先網路更新（避免舊版 index 導致按鈕腳本失效）；其餘先網路後快取
self.addEventListener('fetch', (event) => {
  const url = event.request.url;
  const isHtml =
    event.request.mode === 'navigate' ||
    /\/index\.html(\?|$)/.test(url) ||
    url.endsWith('/') ||
    (event.request.headers.get('accept') || '').includes('text/html');

  if (isHtml) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return res;
        })
        .catch(() => caches.match('./index.html') || caches.match('/index.html'))
    );
    return;
  }

  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});