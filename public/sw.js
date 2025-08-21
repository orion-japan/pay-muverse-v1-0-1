self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => self.clients.claim());

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
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

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification?.data?.url || '/';
  event.waitUntil(
    (async () => {
      const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = allClients.find(c => c.url.includes(new URL(url, self.location.origin).pathname));
      if (existing) return existing.focus();
      return clients.openWindow(url);
    })()
  );
});
