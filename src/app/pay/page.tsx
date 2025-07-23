'use client';
export const dynamic = 'force-dynamic';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import PlanSelectPanel from '@/components/PlanSelectPanel';

function PageInner() {
  const searchParams = useSearchParams();
  const user_code = searchParams.get('user') || '';

  const [userData, setUserData] = useState<any>(null);
  const [payjp, setPayjp] = useState<any>(null);
  const [card, setCard] = useState<any>(null);
  const [cardReady, setCardReady] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [cardRegistered, setCardRegistered] = useState(false);
  const [showCardInput, setShowCardInput] = useState(false);
  const [userCredit, setUserCredit] = useState<number>(0);

  const fetchStatus = async () => {
    try {
      const res = await fetch(`/api/account-status?user=${user_code}`);
      const json = await res.json();
      setUserData(json);
      setCardRegistered(json.card_registered);
      setUserCredit(json.sofia_credit || 0);
      console.log('✅ ユーザーデータ取得:', json);
    } catch (err) {
      console.error('⛔ ユーザー取得失敗:', err);
    }
  };

  useEffect(() => {
    if (user_code) fetchStatus();
  }, [user_code]);

  const initPayjpCard = () => {
    if (payjp || card || cardRegistered) return;

    const script = document.createElement('script');
    script.src = 'https://js.pay.jp/v2/pay.js';
    script.async = true;
    script.onload = () => {
      const payjpInstance = (window as any).Payjp(process.env.NEXT_PUBLIC_PAYJP_PUBLIC_KEY!);
      setPayjp(payjpInstance);

      const elements = payjpInstance.elements();
      const cardElement = elements.create('card');
      cardElement.mount('#card-form');
      setCard(cardElement);
      setCardReady(true);
    };
    document.body.appendChild(script);
  };

  const handleCardRegistration = async () => {
    setLoading(true);
    try {
      const tokenRes = await payjp.createToken(card);
      if (tokenRes.error) throw new Error(tokenRes.error.message);
      const token = tokenRes.id;

      const cardRes = await fetch('/api/pay/account/register-card', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_code, token }),
      });

      if (!cardRes.ok) throw new Error('カード登録に失敗しました');

      alert('カード登録が完了しました');
      await fetchStatus(); // 再取得
    } catch (err: any) {
      console.error('❌ カード登録エラー:', err);
      alert(err.message || 'カード登録中にエラーが発生しました');
    } finally {
      setLoading(false);
    }
  };

  const handleSubscribe = async () => {
    setLoading(true);
    try {
      if (!selectedPlan?.plan_type) {
        alert('プランを正しく選択してください');
        return;
      }

      await fetchStatus();

      const payload = {
        user_code,
        user_email: userData?.click_email || '',
        plan_type: selectedPlan.plan_type,
        customer_id: userData?.payjp_customer_id || '',
        charge_amount: selectedPlan.price || 0,
        sofia_credit: selectedPlan.credit || 0,
      };

      console.log('📤 サブスク送信ペイロード:', payload);

      const subscribeRes = await fetch('/api/pay/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const result = await subscribeRes.json();
      console.log('📦 サブスク登録レスポンス:', result);

      if (result.logTrail) {
        console.log('🪵 logTrail:', result.logTrail);
      }

      if (!subscribeRes.ok || !result.success) {
        alert(`❌ サブスク登録に失敗しました\n${result.detail || '原因不明'}\n\n【ログ】\n${result.logTrail?.join('\n')}`);
        return;
      }

      window.location.href = `/thanks?user=${user_code}`;
    } catch (err: any) {
      console.error('⨯ サブスク登録エラー:', err);
      alert(`サブスク登録中にエラーが発生しました\n${err.message || err}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen flex flex-col items-center justify-start p-6 bg-background text-foreground space-y-6">
      <h1 className="text-xl font-bold mb-4">プランを選択してください</h1>

      <PlanSelectPanel
        userCode={user_code}
        cardRegistered={cardRegistered}
        userCredit={userCredit}
        onPlanSelected={(plan) => {
          console.log('🟢 プランが選ばれました:', plan);
          setSelectedPlan(plan);
        }}
      />

      <div className="bg-blue-50 border rounded-xl p-4 mt-6 w-full max-w-md shadow-inner">
        <h2 className="font-semibold mb-2">カード登録</h2>
        {cardRegistered ? (
          <p className="text-green-600">✅ 登録済みのカードがあります</p>
        ) : (
          <>
            {!showCardInput ? (
              <button
                onClick={() => {
                  setShowCardInput(true);
                  initPayjpCard();
                }}
                className="bg-gray-700 text-white px-4 py-2 rounded"
              >
                カードを登録する
              </button>
            ) : (
              <>
                <div id="card-form" className="border p-2 my-2" />
                <button
                  onClick={handleCardRegistration}
                  disabled={!cardReady || loading}
                  className="bg-blue-500 text-white px-4 py-2 rounded mt-2"
                >
                  {loading ? '登録中...' : 'このカードを登録'}
                </button>
              </>
            )}
          </>
        )}
      </div>

      <button
        className="bg-green-600 hover:bg-green-700 text-white px-6 py-3 rounded-xl transition disabled:opacity-50 mt-4 w-full max-w-md"
        onClick={handleSubscribe}
        disabled={!selectedPlan || !cardRegistered || loading}
      >
        {loading ? '処理中...' : '登録して購入'}
      </button>
    </main>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<div>読み込み中...</div>}>
      <PageInner />
    </Suspense>
  );
}
