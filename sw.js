const CACHE_NAME = 'omnisense-lab-v1';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  'https://cdn.tailwindcss.com',
  'https://cdnjs.cloudflare.com/ajax/libs/p5.js/1.4.0/p5.js',
  'https://unpkg.com/lucide@latest'
];

// 安裝階段：快取靜態資源
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('OmniSense SW: 正在快取靜態資源');
      return cache.addAll(ASSETS_TO_CACHE);
    })
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
    })
  );
});

// 攔截請求：優先從網路獲取，失敗後使用快取 (適用於科學儀器頻繁更新的特性)
self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request).catch(() => {
      return caches.match(event.request);
    })
  );
});