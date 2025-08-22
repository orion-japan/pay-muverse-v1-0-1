// utils/push.ts
function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export async function registerPush(userCode: string) {
  if (!("serviceWorker" in navigator)) return;

  // Service Worker 登録
  const registration = await navigator.serviceWorker.register("/service-worker.js");
  await navigator.serviceWorker.ready; // 念のため待機

  // Push Subscription 取得 or 新規作成
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(
        process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY as string
      ),
    });
  }

  console.log("Push Subscription:", subscription);

  // Supabase に保存するなら API 経由で送信
  await fetch("/api/register-push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_code: userCode,              // 誰の購読か
      endpoint: subscription.endpoint,  // FCM の endpoint
      keys: subscription.toJSON().keys, // { p256dh, auth }
    }),
  });

  return subscription;
}
