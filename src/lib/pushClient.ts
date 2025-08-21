// src/lib/pushClient.ts
const PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '';

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

/**
 * SW登録 → 通知権限（未決なら要求）→ Push購読 → サーバへ送信 までをまとめて実行
 */
export async function registerAndSendPush(
  payload: { title: string; body?: string; url?: string; tag?: string },
  user_code: string
) {
  if (!('serviceWorker' in navigator)) throw new Error('ServiceWorker not supported');

  // 1) SW登録
  const reg = await navigator.serviceWorker.register('/sw.js');

  // 2) 通知権限（未決だけ要求）
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    try { await Notification.requestPermission(); } catch {}
  }

  // 3) Push購読
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    if (!PUBLIC_KEY) throw new Error('Missing NEXT_PUBLIC_VAPID_PUBLIC_KEY');
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(PUBLIC_KEY),
    });
  }

  // 4) サーバへ購読情報を保存（存在しない環境でも無視）
  try {
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        user_code,
        subscription: sub,
        user_agent: navigator.userAgent,
        platform: (navigator as any).platform ?? '',
      }),
    });
  } catch (_) {}

  // 5) 送信
  const res = await fetch('/api/push/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user_code, kind: 'ai', ...payload }),
  });
  if (!res.ok) throw new Error(`send failed: ${res.status}`);
  return res.json();
}
