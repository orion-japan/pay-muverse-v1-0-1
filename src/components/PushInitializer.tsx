// 例: src/components/PushInitializer.tsx
'use client';
import { useEffect } from 'react';

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) output[i] = raw.charCodeAt(i);
  return output;
}

export default function PushInitializer({ userCode }: { userCode: string }) {
  useEffect(() => {
    if (!userCode) return;
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

    (async () => {
      try {
        // 1) SW 登録
        const reg = await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready; // 念のため待機

        // 2) 通知許可
        if (Notification.permission === 'default') {
          const perm = await Notification.requestPermission();
          if (perm !== 'granted') return;
        } else if (Notification.permission !== 'granted') {
          return;
        }

        // 3) 既存購読があれば流用
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
          // 4) VAPID公開鍵で購読作成（env から埋め込み）
          const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!;
          sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey),
          });
        }

        // 5) サーバに購読保存
        await fetch('/api/push/save-subscription', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            user_code: userCode,
            endpoint: sub.endpoint,
            keys: sub.toJSON().keys, // { p256dh, auth }
          }),
        });
      } catch (e) {
        console.warn('[push] init failed', e);
      }
    })();
  }, [userCode]);

  return null;
}
