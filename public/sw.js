/* public/sw.js */
self.addEventListener("install", (event) => {
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Push 受信
self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || "通知";
  const options = {
    body: data.body || "",
    data: { id: data.id, url: data.url || "/" },
  };

  event.waitUntil((async () => {
    // 通知を表示
    await self.registration.showNotification(title, options);

    // 受信したことを、制御下のウィンドウへ送る（未制御も含む）
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of list) {
      c.postMessage({ type: "PUSH_RECEIVED", id: data.id || null, payload: data });
    }
  })());
});

// （任意）通知クリックでURLを開く
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of list) {
      if ("focus" in c && c.url.includes(location.origin)) return c.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
