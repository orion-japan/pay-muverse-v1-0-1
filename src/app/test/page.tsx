'use client';

import { registerAndSendPush } from '@/lib/pushClient';

export default function TestPushPage() {
  const onClick = async () => {
    const user_code =
      (typeof window !== 'undefined' && localStorage.getItem('user_code')) ||
      'U-CKxc5NQQ';

    const tag = `test-${Date.now()}`; // 重複抑止用

    await registerAndSendPush(
      {
        title: '通知テスト',
        body: 'これはテスト通知です。',
        url: '/',
        tag, // ★ id は渡さない
      },
      user_code // ★ 第2引数は必須
    );

    alert('送信リクエストを出しました');
  };

  return (
    <main style={{ padding: 24 }}>
      <h1>Push 通知テスト</h1>
      <button onClick={onClick}>通知を送る</button>
    </main>
  );
}
