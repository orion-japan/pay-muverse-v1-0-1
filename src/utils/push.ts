// /src/utils/push.ts
import { authedFetch } from '@/context/AuthContext';

export async function registerPush(userCode: string) {
  if (typeof window === 'undefined') return;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('Push not supported');
  }

  const reg =
    (await navigator.serviceWorker.getRegistration()) ??
    (await navigator.serviceWorker.register('/sw.js', { scope: '/' })); // ← 統一

  // Permission は default のときだけ問い合わせ（既存 granted/denied は尊重）
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('permission denied');
  } else if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
    throw new Error('permission denied');
  }

  // ---- VAPID key: env → window → <meta> の順で取得し、どこから来たかログ ----
  const fromEnv = (process as any)?.env?.NEXT_PUBLIC_VAPID_PUBLIC_KEY as string | undefined;
  const fromWin = (window as any).__VAPID_PUBLIC_KEY__ as string | undefined;
  const fromMeta = (document.querySelector('meta[name="vapid"]') as HTMLMetaElement | null)
    ?.content;

  const vapidPublicKey = fromEnv || fromWin || fromMeta || '';
  const src = fromEnv ? 'env' : fromWin ? 'window' : fromMeta ? 'meta' : 'none';
  console.info('[push] VAPID src =', src, 'prefix =', vapidPublicKey?.slice(0, 12));

  if (!vapidPublicKey) throw new Error('missing VAPID public key');

  // 既存がなければ購読
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    });
  }

  const body = {
    user_code: userCode,
    endpoint: sub.endpoint,
    keys: {
      p256dh: abToB64(sub.getKey('p256dh')),
      auth: abToB64(sub.getKey('auth')),
    },
  };

  // ★ 認証付き fetch に統一（401/403 自己回復）
  const res = await authedFetch('/api/register-push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`register-push failed: ${await res.text()}`);
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
function abToB64(buf: ArrayBuffer | null) {
  if (!buf) return '';
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
