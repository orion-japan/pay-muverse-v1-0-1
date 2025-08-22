self.addEventListener("push", (event) => {
    console.log("[Service Worker] Push received:", event);
  
    let data = {};
    if (event.data) {
      data = event.data.json();
    }
  
    const title = data.title || "Muverse 通知";
    const options = {
      body: data.body || "本文がありません",
      data: { url: data.url || "/" }
    };
  
    event.waitUntil(
      self.registration.showNotification(title, options)
    );
  });
  
  self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    event.waitUntil(clients.openWindow(event.notification.data.url));
  });
  