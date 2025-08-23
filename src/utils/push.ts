// src/utils/push.ts
function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const out = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) out[i] = rawData.charCodeAt(i);
  return out;
}

export async function registerPush(userCode: string) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.warn('[push] not supported');
    return { ok: false, reason: 'unsupported' as const };
  }

  // 通知権限（default→許可を取りに行く）
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    try {
      await Notification.requestPermission();
    } catch {}
  }
  if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
    console.warn('[push] notification permission denied');
    return { ok: false, reason: 'denied' as const };
  }

  // SW 登録（/service-worker.js に統一）
  const reg = await navigator.serviceWorker.register('/service-worker.js');
  await navigator.serviceWorker.ready;

  // 既存 or 新規購読
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const vapidPublic = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    if (!vapidPublic) {
      console.warn('[push] NEXT_PUBLIC_VAPID_PUBLIC_KEY is missing');
      return { ok: false, reason: 'no-vapid' as const };
    }
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublic),
    });
  }

  const json = sub.toJSON() as any;
  const endpoint: string | undefined = json?.endpoint;
  const p256dh: string | undefined = json?.keys?.p256dh;
  const auth: string | undefined = json?.keys?.auth;
  console.log('[push] subscription:', { endpoint, p256dh, auth });

  if (!endpoint || !p256dh || !auth) {
    console.warn('[push] subscription keys missing', json);
    return { ok: false, reason: 'no-keys' as const };
  }

  // サーバへ登録
  const res = await fetch('/api/register-push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({
      user_code: userCode,
      endpoint,
      keys: { p256dh, auth },
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok !== true) {
    console.error('[push] register API failed:', data);
    return { ok: false, reason: 'api-failed' as const, data };
  }

  return { ok: true as const, endpoint, p256dh, auth };
}
