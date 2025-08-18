// src/lib/utils.ts

// className を結合するユーティリティ
export function cn(...inputs: any[]) {
  return inputs.filter(Boolean).join(" ");
}

// VAPID 公開鍵を Uint8Array に変換するユーティリティ
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
