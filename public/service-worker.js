// v2025-08-23-2  ← 変更のたび数字を上げると更新が確実

self.addEventListener('install', (event) => {
  console.log('[SW] install');
  self.skipWaiting(); // 即時有効化
});

self.addEventListener('activate', (event) => {
  console.log('[SW] activate');
  event.waitUntil(self.clients.claim()); // 既存タブにも即反映
});

self.addEventListener('push', (event) => {
  console.log('[SW] Push received. raw=', event);

  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    console.warn('[SW] payload not JSON:', e);
    // 非JSONのときは text をそのまま body に入れる
    try {
      data = { title: 'Muverse 通知', body: event.data?.text?.() ?? '' };
    } catch {}
  }

  const title = data.title || 'Muverse 通知';
  const options = {
    body: data.body || '',
    icon: data.icon || '/pwaicon192.png',   // 既定アイコン
    badge: data.badge || '/pwaicon512.png', // 既定バッジ
    image: data.image || undefined,
    tag: data.tag || 'muverse',
    renotify: !!data.renotify,
    vibrate: typeof data.vibration !== 'undefined' ? data.vibration : [80, 40, 80],
    requireInteraction: true, // 通知を残す（すぐ消えにくく）
    silent: false,
    data: { url: data.url || '/' },
  };

  console.log('[SW] showNotification ->', title, options);

  event.waitUntil((async () => {
    try {
      await self.registration.showNotification(title, options);
      console.log('[SW] showNotification success');
    } catch (err) {
      console.error('[SW] showNotification error:', err);
      // 画像等が原因の可能性に備えて最小構成で再トライ
      try {
        await self.registration.showNotification(title, { body: options.body, requireInteraction: true });
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
    for (const c of all) {
      // 既存タブを再利用
      if ('focus' in c) {
        try {
          await c.navigate(targetUrl);
        } catch {}
        return c.focus();
      }
    }
    return clients.openWindow(targetUrl);
  })());
});

// 任意：ページ側からのデバッグメッセージ受け取り
self.addEventListener('message', (event) => {
  console.log('[SW] message from page:', event.data);
});
