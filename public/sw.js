/* public/sw.js */

// すぐ新SWを有効化
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Push 受信（通知 or フォールバック）
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    // 1) ペイロードを安全に読む（空でもOK）
    let data = {};
    try {
      data = event.data ? (event.data.json ? event.data.json() : JSON.parse(event.data.text())) : {};
    } catch { data = {}; }

    const title = data.title || '通知';
    const body  = data.body  || '';
    const url   = data.url   || '/';

    // 2) まずはネイティブ通知を試す
    try {
      await self.registration.showNotification(title, {
        body,
        data: { url },
      });
      return; // 成功したら終わり
    } catch (err) {
      // 通知権限なし / OS 側ブロックなど
      // 3) すべてのウィンドウへフォールバックをブロードキャスト
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of list) {
        c.postMessage({ type: 'PUSH_FALLBACK', title, body, url });
      }
    }
  })());
});

// 通知クリックで遷移
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification?.data?.url || '/';
  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      try {
        const originOk = new URL(client.url).origin === self.location.origin;
        if (originOk && 'focus' in client) {
          await client.focus();
          if ('navigate' in client) await client.navigate(targetUrl);
          return;
        }
      } catch {}
    }
    if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
  })());
});
