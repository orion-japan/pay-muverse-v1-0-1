'use client';
export const dynamic = 'force-dynamic';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import PlanSelectPanel from '@/components/PlanSelectPanel';
import CardStyle from '@/components/CardStyle';  // ✅ カード入力UI

function PageInner() {
  const searchParams = useSearchParams();
  const user_code = searchParams.get('user') || '';

  const [userData, setUserData] = useState<any>(null);
  const [payjp, setPayjp] = useState<any>(null);
  const [card, setCard] = useState<any>(null);   // ✅ card は elements 全体を保持
  const [cardReady, setCardReady] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [cardRegistered, setCardRegistered] = useState(false);
  const [showCardForm, setShowCardForm] = useState(false);
  const [userCredit, setUserCredit] = useState<number>(0);

  // ✅ ユーザーデータ取得
  const fetchStatus = async () => {
    console.log('🔍 [fetchStatus] START');
    try {
      console.log(`🌐 [fetchStatus] user_code=${user_code}`);
      const res = await fetch(`/api/account-status?user=${user_code}`);
      const json = await res.json();
      console.log('✅ [fetchStatus] API response:', json);

      setUserData(json);
      setCardRegistered(json.card_registered);
      setUserCredit(json.sofia_credit || 0);
      console.log('✅ [fetchStatus] state updated');
    } catch (err) {
      console.error('⛔ [fetchStatus] ERROR:', err);
    }
    console.log('🔍 [fetchStatus] END');
  };

  useEffect(() => {
    console.log('🌀 [useEffect] user_code changed:', user_code);
    if (user_code) fetchStatus();
  }, [user_code]);

  // ✅ PAY.JP カード入力初期化
  const initPayjpCard = () => {
    console.log('▶ [initPayjpCard] START');

    if (payjp || card || cardRegistered) {
      console.log('⚠️ [initPayjpCard] already initialized or card registered');
      return;
    }

    console.log('📥 PAY.JP script loading...');
    const script = document.createElement('script');
    script.src = 'https://js.pay.jp/v2/pay.js';
    script.async = true;

    script.onload = () => {
      console.log('✅ PAY.JP script loaded');

      const payjpInstance = (window as any).Payjp(process.env.NEXT_PUBLIC_PAYJP_PUBLIC_KEY!);
      console.log('✅ payjp instance created:', payjpInstance ? 'OK' : 'FAILED');
      setPayjp(payjpInstance);

      const elements = payjpInstance.elements();
      console.log('✅ payjp elements created');

      // ✅ 各要素 mount
      const cardNumber = elements.create('cardNumber');
      cardNumber.mount('#card-number');
      console.log('✅ cardNumber mounted');

      const cardExpiry = elements.create('cardExpiry');
      cardExpiry.mount('#card-expiry');
      console.log('✅ cardExpiry mounted');

      const cardCvc = elements.create('cardCvc');
      cardCvc.mount('#card-cvc');
      console.log('✅ cardCvc mounted');

      setCard(elements);
      setCardReady(true);
      console.log('✅ setCard & cardReady = true');

      console.log('✅ PAY.JP init complete');
    };

    script.onerror = () => {
      console.error('❌ PAY.JP script failed to load');
    };

    document.body.appendChild(script);
    console.log('📤 PAY.JP script appended to DOM');

    console.log('▶ [initPayjpCard] END');
  };

  // ✅ カード登録処理
  const handleCardRegistration = async () => {
    console.log('▶ [handleCardRegistration] START');
    setLoading(true);

    try {
      console.log('🔍 Checking payjp & card state:', { payjp, card });

      // ✅ name 取得
      const nameInput = document.querySelector<HTMLInputElement>('input[name="card-holder"]');
      const cardholderName = nameInput?.value || 'TARO YAMADA';
      console.log('✅ cardholderName:', cardholderName);

      console.log('📦 Calling payjp.createToken...');
      const result = await payjp.createToken(card, { name: cardholderName });

      console.log('📦 payjp.createToken response:', result);

      if (result.error) {
        console.error('❌ Token creation error:', result.error);
        throw new Error(result.error.message);
      }

      const token = result.id;
      console.log('✅ PAY.JP token:', token);

      console.log('📡 Calling /api/pay/account/register-card');
      const cardRes = await fetch('/api/pay/account/register-card', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_code, token }),
      });

      const json = await cardRes.json();
      console.log('📩 register-card API response:', json);

      if (!cardRes.ok) {
        console.error('❌ Card register API failed:', json);
        throw new Error('Card registration failed');
      }

      alert('✅ カードが登録されました');
      await fetchStatus();
    } catch (err: any) {
      console.error('❌ [handleCardRegistration] ERROR:', err);
      alert(err.message || 'カード登録に失敗しました');
    } finally {
      setLoading(false);
      console.log('▶ [handleCardRegistration] END');
    }
  };

  // ✅ サブスク登録処理
  const handleSubscribe = async () => {
    console.log('▶ [handleSubscribe] START');
    setLoading(true);

    try {
      if (!selectedPlan?.plan_type) {
        alert('プランを選択してください');
        console.log('⚠️ No plan selected');
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

      console.log('📤 Subscribing payload:', payload);

      const subscribeRes = await fetch('/api/pay/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const result = await subscribeRes.json();
      console.log('📦 Subscribe response:', result);

      if (!subscribeRes.ok || !result.success) {
        console.error('❌ Subscribe API failed:', result);
        alert(`❌ サブスク登録に失敗しました\n${result.detail || '原因不明'}`);
        return;
      }

      window.location.href = `/thanks?user=${user_code}`;
    } catch (err: any) {
      console.error('⨯ Subscription error:', err);
      alert(`サブスク登録中にエラーが発生しました:\n${err.message || err}`);
    } finally {
      setLoading(false);
      console.log('▶ [handleSubscribe] END');
    }
  };

  return (
    <main className="pay-main">
      <h1 className="pay-title">ご利用プラン</h1>

      <PlanSelectPanel
        userCode={user_code}
        cardRegistered={cardRegistered}
        userCredit={userCredit}
        onPlanSelected={(plan) => setSelectedPlan(plan)}
      />

      {!cardRegistered && (
        <>
          {!showCardForm ? (
            <div className="text-center mt-4">
              <button
                className="btn-card-register"
                onClick={() => {
                  console.log('▶ Card register button clicked');
                  setShowCardForm(true);
                  initPayjpCard();
                }}
              >
                カードを登録する
              </button>
            </div>
          ) : (
            <div>
              <CardStyle /> 
              <div className="text-center mt-4">
                <button
                  onClick={handleCardRegistration}
                  disabled={!cardReady || loading}
                  className="btn-card-submit w-full"
                >
                  {loading ? 'カード登録中…' : 'このカードを登録する'}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {cardRegistered && (
        <div className="registered-card-box text-center">
          <p className="text-gray-700">
            💳 登録済みカード: {userData?.card_brand || 'VISA'} **** {userData?.card_last4 || '****'}
          </p>
        </div>
      )}

      {cardRegistered && (
        <div className="text-center mt-4">
          <button
            className="btn-subscribe w-full"
            onClick={handleSubscribe}
            disabled={!selectedPlan || loading}
          >
            {loading ? '処理中…' : 'プランを購入する'}
          </button>
        </div>
      )}
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
