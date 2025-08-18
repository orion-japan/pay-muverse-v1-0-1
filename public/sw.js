self.addEventListener("install", (event) => {
  console.log("[sw.js] Installed");
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  console.log("[sw.js] Activated");
  event.waitUntil(clients.claim());
});

// Push イベント受信
self.addEventListener("push", (event) => {
  console.log("[sw.js] push event:", event);

  if (!event.data) return;

  const payload = event.data.json();
  console.log("[sw.js] push payload:", payload);

  const title = payload.title || "通知";
  const options = {
    body: payload.body || "",
    data: { url: payload.url || "/", id: payload.id },
    icon: "/icon-192x192.png",   // 任意のアイコン
    badge: "/badge-72x72.png",   // 任意のバッジ
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// 通知クリック時
self.addEventListener("notificationclick", (event) => {
  console.log("[sw.js] notification click:", event.notification);

  event.notification.close();
  const url = event.notification.data?.url || "/";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(url) && "focus" in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    })
  );
});
