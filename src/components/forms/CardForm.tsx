'use client';

import { useEffect, useState } from 'react';

export default function CardForm({ userCode }: { userCode: string }) {
  const [userData, setUserData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [payjp, setPayjp] = useState<any>(null);
  const [card, setCard] = useState<any>(null);

  useEffect(() => {
    console.log("🟢 正しい CardForm.tsx が読み込まれました");
  }, []);

  // ✅ Supabaseからユーザーデータ取得
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

  // ✅ PAY.JP 初期化
  useEffect(() => {
    const initPayjp = async () => {
      if (!userData || userData?.card_registered) {
        console.log("⛔ userDataがないか、既にカード登録済みです");
        return;
      }

      const script = document.createElement('script');
      script.src = 'https://js.pay.jp/v2/pay.js';
      script.async = true;
      script.onload = () => {
        console.log("📦 PAY.JP script 読み込み完了");

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
        console.log("✅ cardElement をマウントしました");

        setPayjp(payjpInstance);
        setCard(cardElement);
      };

      document.body.appendChild(script);
    };

    initPayjp();
  }, [userData]);

  // ✅ カード登録処理
  const handleSubmit = async (e: any) => {
    e.preventDefault();
    console.log("🚀 カード登録処理スタート");

    if (!payjp || !card) {
      console.error("❌ payjp または card が未初期化");
      alert("PAY.JPの初期化が完了していません");
      return;
    }

    const result = await payjp.createToken(card);
    console.log("🎫 トークン生成結果:", result);

    if (result.error) {
      console.error('❌ トークン作成エラー:', result.error);
      alert(result.error.message);
    } else {
      const token = result.id;
      console.log("✅ トークン取得成功:", token);

      let customerId = userData?.payjp_customer_id;
      console.log("👤 顧客ID（既存）:", customerId);

      // ❗ 顧客が未登録なら新規作成
      if (!customerId) {
        const res = await fetch('/api/payjp/create-customer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ usercode: userCode }),
        });
        const json = await res.json();
        console.log('🧾 create-customerからの応答:', json);

        if (!json?.customer?.id) {
          alert('登録に失敗しました: 顧客IDが取得できません');
          return;
        }

        customerId = json.customer.id;

        // 🔄 Supabaseに customerId 登録
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

      // ✅ カード登録APIへ送信（usercodeは送らない）
      const cardRes = await fetch('/api/payjp/register-card', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer: customerId,
          token,
        }),
      });

      const cardJson = await cardRes.json();
      console.log("📨 カード登録API結果:", cardJson);

      if (cardRes.ok) {
        alert('カード登録が完了しました！');

        // 🔁 状態を再取得して反映（もしくはreload）
        const res = await fetch(`/api/account-status?user=${userCode}`);
        const json = await res.json();
        setUserData(json);

        // または：window.location.reload();
      } else {
        alert('カード登録に失敗しました');
      }
    }
  };

  if (loading) return <p className="text-center mt-4">読み込み中...</p>;

  return (
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
        {userData?.card_registered ? '登録済み' : 'カードを登録'}
      </button>
    </form>
  );
}
