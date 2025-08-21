import { getAuth } from 'firebase/auth';

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) output[i] = raw.charCodeAt(i);
  return output;
}

/**
 * プッシュ購読を確実に作成・保存する
 * - /sw.js が public に配置済みであること
 * - Firebase Auth でログイン済みであること
 */
export async function ensurePushSubscribed(user_code: string) {
  if (typeof window === 'undefined') return { ok: false, reason: 'ssr' };
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { ok: false, reason: 'unsupported' };
  }

  // 通知権限
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    return { ok: false, reason: 'permission-denied' };
  }

  // SW登録（既に登録済みならそれを使う）
  const registration = await navigator.serviceWorker.register('/sw.js');

  // VAPID公開鍵を取得
  const res = await fetch('/api/push/vapid-public-key', { method: 'GET', cache: 'no-store' });
  if (!res.ok) return { ok: false, reason: 'vapid-fetch-failed' };
  const { key } = await res.json();
  const appServerKey = urlBase64ToUint8Array(key);

  // 既存購読を確認
  let subscription = await registration.pushManager.getSubscription();

  if (!subscription) {
    // 新規購読
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: appServerKey,
    });
  }

  // サーバ保存
  const auth = getAuth();
  const user = auth.currentUser;
  const idToken = user ? await user.getIdToken() : null;

  const saveRes = await fetch('/api/push/save-subscription', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
    },
    body: JSON.stringify({
      user_code,
      subscription: subscription.toJSON(), // { endpoint, keys:{p256dh, auth} }
      user_agent: navigator.userAgent,
      platform: /android/i.test(navigator.userAgent) ? 'android'
               : /iphone|ipad|ipod/i.test(navigator.userAgent) ? 'ios'
               : 'web',
    }),
  });

  if (!saveRes.ok) {
    // 失敗時は購読解除しておくとクリーン
    try { await subscription.unsubscribe(); } catch {}
    return { ok: false, reason: 'save-failed' };
  }
  return { ok: true };
}
