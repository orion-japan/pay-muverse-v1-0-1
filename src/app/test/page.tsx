'use client';

import { useCallback } from 'react';
import { registerAndSendPush } from '@/lib/pushClient';

export default function TestPushPage() {
  const handleClick = useCallback(async () => {
    // 送信先ユーザーコード（ローカルに保存してある想定。無ければ仮の値）
    const user_code =
      (typeof window !== 'undefined' && localStorage.getItem('user_code')) ||
      'U-CKxc5NQQ';

    const id = `test-${Date.now()}`;

    await registerAndSendPush(
      {
        id,                       // 任意の識別子
        title: '通知テスト',
        body: 'これはテスト通知です。',
        url: '/',                 // クリック時に開くURL
        tag: id,                  // 同一タグの重複抑止
      },
      user_code                   // ★ 第2引数を渡す
    );
    alert('送信リクエストを出しました（サーバー側ログで確認可）');
  }, []);

  return (
    <main style={{ padding: 24 }}>
      <h1>Push 通知テスト</h1>
      <button onClick={handleClick}>通知を送る</button>
    </main>
  );
}
