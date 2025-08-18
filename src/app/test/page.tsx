"use client";

import { useEffect, useRef, useState } from "react";
import { registerAndSendPush } from "@/lib/pushClient";

type Payload = {
  title: string;
  body: string;
  url?: string;
  id?: string;
};

export default function PushTestPage() {
  const [status, setStatus] = useState<"idle" | "sending" | "received">("idle");
  const pendingIdRef = useRef<string | null>(null);

  // SW からのメッセージを受け取る → 「受信しました！」を出す
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    const onMessage = (e: MessageEvent) => {
      const d = e.data;
      if (!d || d.type !== "PUSH_RECEIVED") return;

      // id を付けて送っているので一致したら確定
      if (!pendingIdRef.current || !d.id || d.id === pendingIdRef.current) {
        setStatus("received");
        pendingIdRef.current = null;
      }
    };

    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  // 送信 → 受信待ち（10秒でタイムアウトして送信中表示を解除）
  const handleClick = async () => {
    const id = crypto.randomUUID();
    pendingIdRef.current = id;
    setStatus("sending");

    // 10秒で自動リセット（受信が来なければ送信中を解除）
    const tm = setTimeout(() => {
      if (status === "sending") {
        pendingIdRef.current = null;
        setStatus("idle");
        alert("受信が確認できませんでした（タイムアウト）");
      }
    }, 10_000);

    try {
      await registerAndSendPush({
        id,                       // ★識別子を付与
        title: "通知テスト",
        body: "これはテスト通知です。",
        url: "/thanks",
      });
    } finally {
      clearTimeout(tm);
    }
  };

  return (
    <div style={{ padding: 12 }}>
      <h1>通知テストページ</h1>
      <button onClick={handleClick} disabled={status === "sending"}>
        {status === "sending" ? "送信中..." : "通知を送る"}
      </button>

      <div style={{ marginTop: 12, minHeight: 28 }}>
        {status === "received" && (
          <span style={{ padding: "6px 8px", borderRadius: 6, background: "#e6ffed", color: "#0a6b2a" }}>
            受信しました！
          </span>
        )}
      </div>
    </div>
  );
}
