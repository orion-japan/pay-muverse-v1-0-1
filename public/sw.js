// pushイベントを必ず通知するテスト
self.addEventListener('push', (event) => {
  console.log('[sw.js] push event received:', event);

  event.waitUntil(
    self.registration.showNotification("テスト通知", {
      body: "これは Service Worker からのテストです"
    })
  );
});