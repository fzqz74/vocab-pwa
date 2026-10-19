/* 离线缓存: 首次访问后所有资源本地化, 无网络可用 */
const CACHE = 'cet6-vocab-v19';
const ASSETS = [
  './',
  'index.html',
  'css/style.css',
  'js/words.js',
  'js/words_full.js',
  'js/words_zsb.js',
  'js/app.js',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    /* v17 之前的页面没有 controllerchange 监听器，需要由这里强制刷新一次。 */
    const needsLegacyReload = keys.some(k => {
      const version = Number((k.match(/^cet6-vocab-v(\d+)$/) || [])[1]);
      return version > 0 && version < 17;
    });
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
    if (needsLegacyReload) {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      /* 不等待 navigate：激活完成前等待导航结果会与页面请求互相锁住。 */
      windows.forEach(client => {
        client.navigate(client.url).catch(() => {});
      });
    }
  })());
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match('./')))
  );
});
