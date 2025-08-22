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
    icon: data.icon || "/icon-192x192.png", // 任意のアイコン
    badge: data.badge || "/badge-72x72.png",
    data: { url: data.url || "/" },
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// 通知クリック時に遷移
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data.url)
  );
});
