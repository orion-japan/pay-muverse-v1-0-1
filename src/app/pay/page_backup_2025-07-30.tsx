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

      if (!cardRes.ok) throw new Error('Card registration failed');

      alert('Card registered successfully');
      await fetchStatus(); // Refresh
    } catch (err: any) {
      console.error('❌ Card registration error:', err);
      alert(err.message || 'Card registration failed');
    } finally {
      setLoading(false);
    }
  };

  const handleSubscribe = async () => {
    setLoading(true);
    try {
      if (!selectedPlan?.plan_type) {
        alert('Please select a plan');
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

      if (result.logTrail) {
        console.log('🪵 logTrail:', result.logTrail);
      }

      if (!subscribeRes.ok || !result.success) {
        alert(`❌ Subscription failed\n${result.detail || 'Unknown error'}\n\n【Logs】\n${result.logTrail?.join('\n')}`);
        return;
      }

      window.location.href = `/thanks?user=${user_code}`;
    } catch (err: any) {
      console.error('⨯ Subscription error:', err);
      alert(`Error during subscription:\n${err.message || err}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen flex flex-col items-center justify-start p-6 bg-gradient-to-b from-blue-50 to-white text-foreground space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 text-center mt-4">
        Your Subscription Plan
      </h1>

      <PlanSelectPanel
        userCode={user_code}
        cardRegistered={cardRegistered}
        userCredit={userCredit}
        onPlanSelected={(plan) => {
          console.log('🟢 Plan selected:', plan);
          setSelectedPlan(plan);
        }}
      />

      <div className="bg-white border rounded-xl p-4 w-full max-w-md shadow-lg mt-4">
        <h2 className="text-xl font-semibold text-gray-800 mb-2">💳 Card Registration</h2>
        {cardRegistered ? (
          <p className="text-green-500 font-semibold">✅ Card is registered</p>
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
                Register Card
              </button>
            ) : (
              <>
                <div id="card-form" className="border p-2 my-2" />
                <button
                  onClick={handleCardRegistration}
                  disabled={!cardReady || loading}
                  className="bg-blue-500 text-white px-4 py-2 rounded mt-2"
                >
                  {loading ? 'Registering...' : 'Register this card'}
                </button>
              </>
            )}
          </>
        )}
      </div>

      <button
        className="bg-green-600 hover:bg-green-700 text-white px-6 py-3 rounded-xl transition disabled:opacity-50 mt-6 w-full max-w-md"
        onClick={handleSubscribe}
        disabled={!selectedPlan || !cardRegistered || loading}
      >
        {loading ? 'Processing...' : 'Subscribe & Purchase'}
      </button>
    </main>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <PageInner />
    </Suspense>
  );
}
