'use client';

import { useEffect, useState } from 'react';

type UserStatus = {
  usercode: string;
  planName: string;
  payjpCustomerId: string | null;
  cardRegistered: boolean;
};

export default function AccountCard() {
  const [userStatus, setUserStatus] = useState<UserStatus | null>(null);
  const [loading, setLoading] = useState(false);

  // ユーザーステータス取得
  const fetchStatus = async () => {
    try {
      console.log('[AccountCard] 🔄 ステータス取得開始...');
      const res = await fetch('/api/account-status?user=U-73NJMoON');
      const data = await res.json();
      console.log('[AccountCard] ✅ ステータス取得成功:', data);
      setUserStatus(data);
    } catch (err) {
      console.error('[AccountCard] ❌ ステータス取得失敗:', err);
    }
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  // カード登録処理
  const handleRegisterCard = async () => {
    if (!userStatus?.usercode) return;
    setLoading(true);
    console.log('[AccountCard] 🪪 カード登録処理開始');

    try {
      const res = await fetch('/api/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: userStatus.usercode }),
      });

      const data = await res.json();

      if (data.url) {
        console.log('[AccountCard] ✅ チェックアウトURL取得成功:', data.url);
        window.location.href = data.url;
      } else {
        console.error('[AccountCard] ❌ セッション作成失敗:', data);
        alert('セッション作成に失敗しました');
        setLoading(false);
      }
    } catch (err) {
      console.error('[AccountCard] ❌ エラー:', err);
      alert('通信エラーが発生しました');
      setLoading(false);
    }
  };

  if (!userStatus) return <p className="text-center">読み込み中...</p>;

  return (
    <div className="p-4 space-y-3 text-center">
      <h2 className="text-xl font-semibold">アカウント情報</h2>

      <p>ユーザーコード：{userStatus.usercode}</p>
      <p>現在のプラン：{userStatus.planName}</p>
      <p>
        カード状態：
        {userStatus.cardRegistered ? '✅ 登録済み' : '❌ 未登録'}
      </p>

      {/* 未登録 or 無料プランユーザーのみ表示 */}
      {!userStatus.cardRegistered && (
        <button
          onClick={handleRegisterCard}
          disabled={loading}
          className="bg-purple-600 text-white px-4 py-2 rounded hover:bg-purple-700 transition"
        >
          {loading ? '処理中...' : 'カードを登録'}
        </button>
      )}
    </div>
  );
}
