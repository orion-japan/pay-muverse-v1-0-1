'use client';

import { getAuth } from 'firebase/auth';

export default function MuAiButton() {
  const handleClick = async () => {
    console.log('🚀 [MU_AI] ボタン押下');

    try {
      const auth = getAuth();
      const user = auth.currentUser;

      if (!user) {
        console.error('❌ ログインしていません');
        return;
      }

      console.log('👤 ログイン中ユーザー:', user.uid);

      // Firebase ID トークン取得
      const idToken = await user.getIdToken(/* forceRefresh */ true);
      console.log('🔑 Firebase IDトークン取得成功:', idToken.slice(0, 20) + '...');

      // UUID生成（ブラウザ対応）
      const requestId =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : String(Date.now()) + '-' + Math.random().toString(16).slice(2);

      // MU 側APIに送信
      const muApiUrl = 'https://mu.muverse.jp/api/get-user-info';
      console.log('🌐 MU側API送信開始:', muApiUrl);

      const res = await fetch(muApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          version: '2025-08-11',
          request_id: requestId,
          auth: {
            mode: 'firebase',
            idToken: idToken,
          },
        }),
      });

      console.log('📡 MU側応答ステータス:', res.status);

      const data = await res.json().catch(() => ({}));
      console.log('📦 MU側応答データ:', data);
    } catch (err) {
      console.error('❌ MU側送信エラー:', err);
    }
  };

  return (
    <button onClick={handleClick} className="px-4 py-2 bg-blue-600 text-white rounded">
      Mu_AIへ
    </button>
  );
}
