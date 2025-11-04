/* ===== Service Worker for Web Push ===== */

self.addEventListener('install', (event) => {
  // すぐにアクティブ化
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // 既存ページにも即適用
  event.waitUntil(self.clients.claim());
});

/**
 * 受信したPushの表示
 * 期待payload例:
 * {
 *   "title": "通知タイトル",
 *   "body": "本文",
 *   "url": "/talk/xxxx",
 *   "vibration": true,        // Androidのみ
 *   "badge": "/badge.png",
 *   "icon": "/icon.png",
 *   "image": "/banner.png",
 *   "tag": "ftalk-123",       // 重複抑止に使用可
 *   "renotify": true          // 同tagで再通知時にバイブ/音を再生
 * }
 */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data?.json() || {};
  } catch (_) {}

  const title = data.title || '通知';
  const options = {
    body: data.body || '',
    icon: data.icon || '/icon.png',
    badge: data.badge || undefined,
    image: data.image || undefined,
    tag: data.tag || undefined,
    renotify: !!data.renotify,
    data, // notificationclick で参照
  };

  // バイブレーション（Androidのみ有効）
  if (data.vibration) {
    options.vibrate = Array.isArray(data.vibration) ? data.vibration : [200, 100, 200];
  }

  // アクションボタン（必要なら）
  if (Array.isArray(data.actions)) {
    options.actions = data.actions.slice(0, 2); // 最大2つを推奨
  }

  event.waitUntil(self.registration.showNotification(title, options));
});

/**
 * クリック時：URLがあればそれを開く（既存タブ優先）
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification?.data?.url || '/';

  event.waitUntil(
    (async () => {
      const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      // 既存で同URLが開いていればフォーカス
      for (const client of allClients) {
        try {
          const cUrl = new URL(client.url);
          if (cUrl.pathname === new URL(url, self.location.origin).pathname) {
            await client.focus();
            return;
          }
        } catch (_) {}
      }
      // 無ければ新規で開く
      await clients.openWindow(url);
    })(),
  );
});

/**
 * 閉じた時のハンドラ（必要なら解析送信など）
 */
self.addEventListener('notificationclose', (_event) => {
  // 解析イベントなどを送る場合はここで fetch する
});

/**
 * 購読が失効した場合の再購読フック
 * ここでは雛形のみ（アプリ側で再購読ボタンを案内するのが確実）
 */
self.addEventListener('pushsubscriptionchange', async (_event) => {
  // 端末依存/ブラウザ依存が強いため、明示の再購読ボタンでの対応を推奨
  // 必要であれば、ここで registration.pushManager.subscribe(...) を試行
});
