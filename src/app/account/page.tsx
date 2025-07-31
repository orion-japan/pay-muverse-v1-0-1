'use client';

import { useEffect, useState } from 'react';
import CardRegisterModal from '@/components/CardRegisterModal';

export default function AccountPage() {
  const [userData, setUserData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  // ✅ モーダルの開閉管理
  const [showCardModal, setShowCardModal] = useState(false);

  // 🔍 URLから user_code を取得
  const searchParams =
    typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const userCode = searchParams?.get('user') || '';

  // 🌐 Supabaseからユーザーデータを取得
  useEffect(() => {
    const fetchStatus = async () => {
      console.log('🔍 ユーザーコード取得:', userCode);
      const res = await fetch(`/api/account-status?user=${userCode}`);
      const json = await res.json();
      console.log('📦 ユーザーデータ取得:', json);
      setUserData(json);
      setLoading(false);
    };
    if (userCode) fetchStatus();
  }, [userCode]);

  if (loading) return <p className="text-center mt-10">読み込み中...</p>;

  return (
    <div className="max-w-xl mx-auto mt-10 p-4">
      <h1 className="text-xl font-bold mb-4">アカウント情報</h1>
      <p>ユーザーコード: {userData?.user_code}</p>
      <p>現在のプラン: {userData?.planName || 'free'}</p>
      <p>カード状態: {userData?.card_registered ? '✅ 登録済' : '❌ 未登録'}</p>
      <hr className="my-4" />

      {/* ✅ カード未登録なら「カード登録」ボタンだけ表示 */}
      {!userData?.card_registered && (
        <button
          className="px-4 py-2 rounded w-full bg-blue-600 text-white hover:bg-blue-700"
          onClick={() => setShowCardModal(true)}
        >
          💳 カードを登録
        </button>
      )}

      {/* ✅ カード登録モーダル（CardForm.tsx を含む） */}
      <CardRegisterModal
        isOpen={showCardModal}
        onClose={() => setShowCardModal(false)}
        userCode={userCode}
      />
    </div>
  );
}
