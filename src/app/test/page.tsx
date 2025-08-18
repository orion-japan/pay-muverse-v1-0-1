"use client";

import { useState, useRef } from "react";
import { registerAndSendPush } from "@/lib/pushClient";

// Payload 型を拡張して id を追加
type Payload = {
  title: string;
  body: string;
  url?: string;
  id?: string;
};

export default function PushTestPage() {
  const [sending, setSending] = useState(false);
  const resolverMapRef = useRef<Map<string, () => void>>(new Map());

  // 通知送信 ＆ 表示完了待ち
  async function sendAndWaitShown(payload: Payload) {
    const id = crypto.randomUUID(); // 一意のID生成

    const done = new Promise<void>((resolve) => {
      resolverMapRef.current.set(id, resolve);

      // タイムアウト（10秒）
      setTimeout(() => {
        resolverMapRef.current.delete(id);
        resolve();
      }, 10000);
    });

    // push送信（idを含める）
    await registerAndSendPush({ ...payload, id });

    // 表示完了を待つ
    await done;
  }

  const handleClick = async () => {
    try {
      setSending(true);
      await sendAndWaitShown({
        title: "通知テスト",
        body: "これはテスト通知です。",
        url: "/thanks",
      });
      alert("通知を送信しました！");
    } catch (err) {
      console.error("通知送信エラー:", err);
      alert("通知の送信に失敗しました。");
    } finally {
      setSending(false);
    }
  };

  return (
    <div>
      <h1>通知テストページ</h1>
      <button onClick={handleClick} disabled={sending}>
        {sending ? "送信中..." : "通知を送る"}
      </button>
    </div>
  );
}
