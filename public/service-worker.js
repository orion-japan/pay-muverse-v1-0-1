// v2025-08-23-3  ← 変更のたび数字を上げると更新が確実

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
    // まず JSON を試す（iOSでもここは標準）
    data = event.data ? event.data.json() : {};
  } catch (e) {
    console.warn('[SW] payload not JSON:', e);
    // 非JSONのときは text をそのまま body に入れる（PushMessageData.text() は同期）
    try {
      const rawText = event.data && typeof event.data.text === 'function' ? event.data.text() : '';
      data = { title: 'Muverse 通知', body: rawText || '' };
    } catch (e2) {
      console.warn('[SW] fallback text parse failed:', e2);
      data = { title: 'Muverse 通知', body: '' };
    }
  }

  const title = data.title || 'Muverse 通知';
  const options = {
    body: data.body || '',
    icon: data.icon || '/pwaicon192.png',   // 既定アイコン
    badge: data.badge || '/pwaicon512.png', // 既定バッジ（iOSは無視される可能性あり）
    image: data.image || undefined,         // iOS Safariは image を無視する場合あり
    tag: data.tag || 'muverse',             // 同一tagなら上書き
    renotify: !!data.renotify,
    vibrate: Array.isArray(data.vibration) ? data.vibration : [80, 40, 80], // iOSは無視の可能性
    requireInteraction: true,               // iOSは無視されるが他環境で有効
    silent: false,                           // iOSはサイレント不可（明示）
    timestamp: Date.now(),
    data: {
      // クリック先を保持（相対/絶対どちらでもOK）
      url: data.url || '/'
    }
  };

  console.log('[SW] showNotification ->', title, options);

  event.waitUntil((async () => {
    try {
      await self.registration.showNotification(title, options);
      console.log('[SW] showNotification success');
    } catch (err) {
      console.error('[SW] showNotification error:', err);
      // 画像や未対応オプションで落ちるケースに備え、最小構成で再トライ
      try {
        await self.registration.showNotification(title, {
          body: options.body,
          // iOSの互換性重視で最小限に
          data: options.data,
          tag: options.tag,
          renotify: options.renotify
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
    try {
      const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });

      // 1) すでに目的URLを表示しているクライアントがあればそれをフォーカス
      for (const c of all) {
        try {
          const cu = new URL(c.url);
          // 絶対URL/相対URLの両対応
          const tu = (() => {
            try { return new URL(targetUrl, cu.origin); } catch { return null; }
          })();
          if (tu && cu.origin === tu.origin && cu.pathname === tu.pathname) {
            if ('focus' in c) return await c.focus();
          }
        } catch {}
      }

      // 2) 既存ウィンドウはあるがURLが違う → 最初のクライアントをフォーカスしつつ openWindow
      if (all.length > 0) {
        try { if ('focus' in all[0]) await all[0].focus(); } catch {}
      }

      // 3) 新規で開く（iOS PWAでも有効）
      if (clients.openWindow) {
        const opened = await clients.openWindow(targetUrl);
        if (opened && 'focus' in opened) return await opened.focus();
        return opened;
      }
    } catch (e) {
      console.error('[SW] notificationclick handler error:', e);
    }
    return undefined;
  })());
});

// 任意：ページ側からのデバッグメッセージ受け取り
self.addEventListener('message', (event) => {
  console.log('[SW] message from page:', event.data);
});
