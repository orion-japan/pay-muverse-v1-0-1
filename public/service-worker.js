// pushイベントを受信したとき
self.addEventListener("push", (event) => {
  console.log("[Service Worker] Push received.", event);

  let data = {};
  try {
    data = event.data.json();
  } catch (e) {
    console.warn("Push event data is not JSON", e);
  }

  const title = data.title || "Muverse 通知";
  const options = {
    body: data.body || "新しい通知があります",
    icon: "/pwaicon192.png",   // 通知に表示されるアイコン
    badge: "/pwaicon512.png",  // ステータスバーや小さなアイコン
    data: { url: data.url || "/" }, // 通知クリック時に開くURL
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// 通知クリック時の処理
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data.url)
  );
});
