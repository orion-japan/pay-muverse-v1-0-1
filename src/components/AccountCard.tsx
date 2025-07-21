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

  // ステータス取得
  const fetchStatus = async () => {
    const res = await fetch('/api/account-status?user=U-73NJMoON'); // ←動的にするなら修正OK
    const data = await res.json();
    setUserStatus(data);
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  // カード登録ボタン処理
  const handleRegisterCard = async () => {
    setLoading(true);
    const res = await fetch('/api/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: userStatus?.usercode }),
    });

    const data = await res.json();
    if (data.url) {
      window.location.href = data.url; // Checkout画面へ遷移
    } else {
      alert('セッション作成に失敗しました');
      setLoading(false);
    }
  };

  if (!userStatus) return <p>読み込み中...</p>;

  return (
    <div className="p-4 space-y-3 text-center">
      <h2 className="text-xl font-semibold">アカウント情報</h2>
      <p>ユーザーコード：{userStatus.usercode}</p>
      <p>現在のプラン：{userStatus.planName}</p>
      <p>
        カード状態：
        {userStatus.cardRegistered ? '✅ 登録済み' : '❌ 未登録'}
      </p>

      {/* カード未登録 or フリープランのときだけ表示 */}
      {!userStatus.cardRegistered && (
        <button
          onClick={handleRegisterCard}
          disabled={loading}
          className="bg-purple-600 text-white px-4 py-2 rounded"
        >
          {loading ? '処理中...' : 'カードを登録'}
        </button>
      )}
    </div>
  );
}
