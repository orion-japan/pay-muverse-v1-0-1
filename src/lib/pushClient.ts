// src/lib/pushClient.ts
import { urlBase64ToUint8Array } from "./utils"; // VAPID鍵変換ユーティリティを用意してください

// VAPID 公開鍵（環境変数から注入するのがベスト）
const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!;

// API 認証キー（環境変数から注入）
const PUSH_API_KEY = process.env.NEXT_PUBLIC_PUSH_API_KEY!;

export async function registerAndSendPush(payload?: any) {
  console.log("[push] START registerAndSendPush");

  // Service Worker 登録
  const registration = await navigator.serviceWorker.register("/sw.js");
  console.log("[push] SW registered:", !!registration);

  // 既存 subscription を取得
  let subscription = await registration.pushManager.getSubscription();

  // 無ければ新規作成
  if (!subscription) {
    try {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
      console.log("[push] New subscription:", subscription);

      // サーバーに保存
      await fetch("/api/save-subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subscription),
      });
    } catch (err) {
      console.error("[push] Subscription error:", err);
      return;
    }
  } else {
    console.log("[push] has subscription? true");
  }

  // 通知を送信する API 呼び出し（payload付き）
  try {
    const res = await fetch("/api/push/dispatch", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Authorization": `Bearer ${PUSH_API_KEY}`, // 🔑 認証ヘッダー追加
      },
      body: JSON.stringify({
        subscriptions: [subscription],
        payload: payload ?? {
          title: "通知テスト",
          body: "これは本番環境のテスト通知です",
          url: "/thanks",
        },
      }),
    });

    const text = await res.text();   // ← textで受け取る
    let result;
    try {
      result = JSON.parse(text);     // JSONならparse
    } catch {
      result = text;                 // JSONじゃなければそのまま
    }

    console.log("[push] invoke result:", result);
  } catch (err) {
    console.error("[push] Dispatch error:", err);
  }
}
