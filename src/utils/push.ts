// src/utils/push.ts
export async function registerPush(user_code: string) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.warn("Push通知非対応ブラウザ");
    return;
  }

  // Service Worker 登録
  const reg = await navigator.serviceWorker.register('/sw.js');

  // 既存 subscription があるか確認
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(
        process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!
      )
    });
  }

  // サーバーに保存
  const res = await fetch('/api/save-subscription', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_code, subscription: sub })
  });

  return res.json();
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
