// src/lib/push/subscribePush.ts
export type EnsureResult = { ok: true } | { ok: false; reason: string };

export async function ensurePushSubscribed(uid: string): Promise<EnsureResult> {
  try {
    // 1) VAPID公開鍵を text で取得
    const keyRes = await fetch('/api/push/vapid-public-key', { cache: 'no-store' });
    if (!keyRes.ok) throw new Error('vapid-fetch-failed');
    const vapidPublicKey = (await keyRes.text()).trim();

    // 2) Service Worker
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;

    // 3) 購読
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });
    }

    // 4) 送信用ペイロードを堅牢に作る
    const json = sub.toJSON() as any; // { endpoint, keys?:{p256dh,auth} }
    const endpoint: string = json.endpoint || sub.endpoint;

    let p256dh: string | undefined = json.keys?.p256dh;
    let auth: string | undefined = json.keys?.auth;

    // toJSON に keys が無いブラウザ用フォールバック
    if (!p256dh || !auth) {
      const getKey = (name: 'p256dh' | 'auth') => {
        const buf = sub.getKey(name);
        return buf ? btoa(String.fromCharCode(...new Uint8Array(buf))) : undefined;
      };
      p256dh = p256dh || getKey('p256dh');
      auth   = auth   || getKey('auth');
    }
    if (!endpoint || !p256dh || !auth) throw new Error('subscription-incomplete');

    // 5) サーバ保存（どちらの形式でも受けられるが keys 付きで送る）
    const saveRes = await fetch('/api/push/save-subscription', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uid,
        subscription: { endpoint, keys: { p256dh, auth } },
        user_agent: navigator.userAgent,
        platform: navigator.platform,
      }),
    });
    if (!saveRes.ok) {
      const t = await saveRes.text().catch(()=>'');
      throw new Error(`save-subscription-failed${t ? `: ${t}` : ''}`);
    }

    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: e?.message ?? 'unknown' };
  }
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}
