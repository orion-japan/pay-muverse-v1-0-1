self.addEventListener('push', (event) => {
  console.log('[Service Worker] Push received.', event);

  let data = {};
  try {
    if (event.data) {
      data = event.data.json();
    }
  } catch (e) {
    console.error('[Service Worker] Failed to parse push data', e);
  }

  const title = data.title || 'お知らせ';
  const options = {
    body: data.body || '通知きた',
    icon: '/icons/icon-192x192.png', // PWAアイコンがあれば使う
    badge: '/icons/icon-72x72.png', // 小さいアイコン
    data: {
      url: data.url || '/', // クリックした時に開くURL
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// 通知クリック時の処理
self.addEventListener('notificationclick', (event) => {
  console.log('[Service Worker] Notification click received.');
  event.notification.close();

  const url = event.notification.data.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url === url && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    }),
  );
});
