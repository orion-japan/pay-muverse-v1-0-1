// utils/registerPush.ts
export function isStandalone(): boolean {
  // iOS判定：Safari PWAはどちらかで取れる
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window as any).navigator.standalone === true
  );
}

function urlBase64ToUint8Array(base64: string) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const base64Safe = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64Safe);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) output[i] = rawData.charCodeAt(i);
  return output;
}

export async function enablePushOnClick() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('このブラウザはプッシュ非対応です');
  }

  // iPhoneはホーム画面アプリが必須
  if (!isStandalone()) {
    throw new Error('iPhoneでは「ホーム画面に追加」したアプリでのみ通知できます');
  }

  // 1) SW登録（ルート配下）
  const reg = await navigator.serviceWorker.register('/service-worker.js');

  // 2) パーミッション取得（ユーザ操作直後で呼ぶ）
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('通知が許可されませんでした');

  // 3) サブスク作成
  const vapid = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapid),
  });

  // 4) あなたのAPIに登録（既に /api/register-push がある想定）
  await fetch('/api/register-push', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(sub), // エンドポイント・鍵などを保存
  });

  return sub;
}
