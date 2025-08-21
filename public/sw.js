// public/sw.js

// 即時に更新を反映させる
self.addEventListener('install', (e) => {
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

// プッシュ通知受信
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    console.error("Push event data parse error", e);
  }

  const title = data.title || 'Muverse';
  const body = data.body || '';
  const url = data.url || '/';
  const tag = data.tag || 'muverse';

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      data: { url },
      icon: '/pwaicon-192.png',
      badge: '/pwaicon-192.png'
    })
  );
});

// 通知クリック時の遷移
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification?.data?.url || '/';

  event.waitUntil((async () => {
    const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const targetUrl = new URL(url, self.location.origin).href;

    const existing = allClients.find(c => c.url === targetUrl);
    if (existing) {
      return existing.focus();
    }
    return clients.openWindow(targetUrl);
  })());
});
