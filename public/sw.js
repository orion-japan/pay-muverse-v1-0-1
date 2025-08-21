// pushイベント（テスト用・必ず通知を出す）
self.addEventListener('push', (event) => {
  console.log('[sw.js] push event received:', event);
  event.waitUntil(
    self.registration.showNotification("Pushテスト", {
      body: "Service Worker からのテスト通知です"
    })
  );
});
