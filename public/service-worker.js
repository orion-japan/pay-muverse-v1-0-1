// v2025-08-23-4

self.addEventListener('install', (event) => {
  console.log('[SW] install');
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('[SW] activate');
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  console.log('[SW] Push received. raw=', event);

  let data = {};
  try {
    // 通常: JSON ペイロード
    data = event.data ? event.data.json() : {};
  } catch (e) {
    console.warn('[SW] payload not JSON:', e);
    try {
      const rawText = event.data && typeof event.data.text === 'function' ? event.data.text() : '';
      data = { title: 'Muverse', body: rawText || '' };
    } catch {
      data = { title: 'Muverse', body: '' };
    }
  }

  const title = data.title || 'Muverse';
  const options = {
    body: data.body || '',
    icon: data.icon || '/pwaicon192.png',
    badge: data.badge || '/pwaicon512.png',
    image: data.image || undefined,       // iOS は無視されることあり
    tag: data.tag || 'muverse',
    renotify: !!data.renotify,
    vibrate: Array.isArray(data.vibration) ? data.vibration : [80, 40, 80],
    requireInteraction: true,             // iOS は無視
    silent: false,
    timestamp: Date.now(),
    data: {
      url: data.url || '/',               // クリック先
    },
  };

  console.log('[SW] showNotification ->', title, options);

  event.waitUntil((async () => {
    try {
      await self.registration.showNotification(title, options);
      console.log('[SW] showNotification success');
    } catch (err) {
      console.error('[SW] showNotification error:', err);
      // 互換性重視の最小オプションで再トライ
      try {
        await self.registration.showNotification(title, {
          body: options.body,
          tag: options.tag,
          renotify: options.renotify,
          data: options.data,
        });
        console.log('[SW] fallback showNotification success');
      } catch (err2) {
        console.error('[SW] fallback showNotification error:', err2);
      }
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  console.log('[SW] notificationclick:', event.notification);
  event.notification.close();

  const targetUrl = event.notification?.data?.url || '/';

  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });

    // 既存で同一パスのタブがあればそれをフォーカス
    for (const c of all) {
      try {
        const cu = new URL(c.url);
        const tu = new URL(targetUrl, cu.origin);
        if (cu.origin === tu.origin && cu.pathname === tu.pathname) {
          if ('focus' in c) return await c.focus();
        }
      } catch {}
    }

    // 既存タブがあればフォーカス（URL違い）
    if (all.length > 0) {
      try { if ('focus' in all[0]) await all[0].focus(); } catch {}
    }

    // 新規で開く（iOS PWA でも可）
    if (clients.openWindow) {
      const opened = await clients.openWindow(targetUrl);
      if (opened && 'focus' in opened) return await opened.focus();
      return opened;
    }
  })());
});

// 任意：ページからのデバッグ受信
self.addEventListener('message', (event) => {
  console.log('[SW] message from page:', event.data);
});
