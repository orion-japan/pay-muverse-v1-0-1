'use client';

import { useEffect, useState } from 'react';

export default function AccountPage() {
  const [userData, setUserData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [payjp, setPayjp] = useState<any>(null);
  const [card, setCard] = useState<any>(null);

  // 🔍 クエリから user_code を取得
  const searchParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
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

  // 📦 PAY.JP 初期化
  useEffect(() => {
    const initPayjp = async () => {
      if (!userData || userData?.card_registered) return;

      const script = document.createElement('script');
      script.src = 'https://js.pay.jp/v2/pay.js';
      script.async = true;
      script.onload = () => {
        const pubKey = process.env.NEXT_PUBLIC_PAYJP_PUBLIC_KEY;
        if (!pubKey) {
          console.error('❌ PAY.JP 公開鍵が未定義です');
          return;
        }

        const payjpInstance = (window as any).Payjp(pubKey);
        const elements = payjpInstance.elements();
        const cardElement = elements.create('card');

        const mountTarget = document.getElementById('card-element');
        if (!mountTarget) {
          console.error('❌ #card-element がDOMに存在しません');
          return;
        }

        cardElement.mount('#card-element');

        setPayjp(payjpInstance);
        setCard(cardElement);
        console.log('✅ PAY.JP 初期化完了');
      };

      document.body.appendChild(script);
    };

    initPayjp();
  }, [userData]);

  // 💳 カード登録処理
  const handleSubmit = async (e: any) => {
    e.preventDefault();

    if (!payjp || !card) {
      alert('PAY.JPの初期化が完了していません');
      return;
    }

    const result = await payjp.createToken(card);

    if (result.error) {
      console.error('❌ トークン作成エラー:', result.error);
      alert(result.error.message);
    } else {
      const token = result.id;
      let customerId = userData?.payjp_customer_id;

      console.log('📮 登録前カスタマーID:', customerId);

      // 顧客IDが未定義なら作成
      if (!customerId) {
        const res = await fetch('/api/payjp/create-customer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ usercode: userCode }),
        });
        const json = await res.json();
        console.log('🧾 create-customerからの応答:', json);

        if (!json?.customer?.id) {
          alert('登録に失敗しました: Error 顧客IDが取得できません');
          return;
        }

        customerId = json.customer.id;
        console.log('🧾 PAY.JP 顧客ID:', customerId);

        // Supabase に登録
        const supaRes = await fetch('/api/supabase/register-user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            usercode: userCode,
            payjpCustomerId: customerId,
          }),
        });

        const supaJson = await supaRes.json();
        console.log('📥 Supabase登録応答:', supaJson);

        if (!supaRes.ok) {
          alert('登録に失敗しました: Supabase登録失敗');
          return;
        }
      }

      // 💳 顧客IDを確定させてカード登録
      const cardRes = await fetch('/api/payjp/register-card', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer: customerId,
          token,
        }),
      });

      const cardJson = await cardRes.json();
      console.log('📨 カード登録応答:', cardJson);

      if (cardRes.ok) {
        alert('カード登録が完了しました！');
        window.location.reload();
      } else {
        alert('カード登録に失敗しました');
      }
    }
  };

  if (loading) return <p className="text-center mt-10">読み込み中...</p>;

  return (
    <div className="max-w-xl mx-auto mt-10 p-4">
      <h1 className="text-xl font-bold mb-4">アカウント情報</h1>
      <p>ユーザーコード: {userData?.user_code}</p>
      <p>現在のプラン: {userData?.planName || 'free'}</p>
      <p>カード状態: {userData?.card_registered ? '✅ 登録済' : '❌ 未登録'}</p>
      <hr className="my-4" />

      {!userData?.card_registered && (
        <form id="card-form" onSubmit={handleSubmit}>
          <div id="card-element" className="border p-3 rounded mb-4" />
          <button
            type="submit"
            className={`px-4 py-2 rounded w-full ${
              userData?.card_registered
                ? 'bg-gray-400 cursor-not-allowed'
                : 'bg-blue-600 text-white hover:bg-blue-700'
            }`}
            disabled={userData?.card_registered}
          >
            カードを登録
          </button>
        </form>
      )}
    </div>
  );
}
