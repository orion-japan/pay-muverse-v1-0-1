// /src/utils/push.ts
export async function registerPush(userCode: string) {
  if (typeof window === 'undefined') return;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('Push not supported');
  }

  // SW 登録（既に登録済みならそのインスタンスを使う）
  const reg = (await navigator.serviceWorker.getRegistration())
    ?? (await navigator.serviceWorker.register('/service-worker.js', { scope: '/' }));

  // 通知権限
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('permission denied');

  // VAPID 公開鍵（環境変数をページに埋めておく）
  const vapidPublicKey = (window as any).__VAPID_PUBLIC_KEY__ as string | undefined;
  if (!vapidPublicKey) throw new Error('missing VAPID public key');

  // 既存購読があれば流用
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    });
  }

  // サーバへ保存
  const body = {
    user_code: userCode,
    endpoint: sub.endpoint,
    keys: {
      p256dh: arrayBufferToBase64(sub.getKey('p256dh')),
      auth: arrayBufferToBase64(sub.getKey('auth')),
    },
  };

  const res = await fetch('/api/register-push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`register-push failed: ${await res.text()}`);
  }
  return true;
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

function arrayBufferToBase64(buf: ArrayBuffer | null) {
  if (!buf) return '';
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
