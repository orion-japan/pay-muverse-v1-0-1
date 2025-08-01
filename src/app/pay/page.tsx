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
  const [showCardForm, setShowCardForm] = useState(false); // ✅ ← フォーム表示用
  const [userCredit, setUserCredit] = useState<number>(0);

  // ✅ ユーザーデータ取得
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

  // ✅ PAY.JP カード入力初期化（カードフォーム表示時にだけ実行）
  const initPayjpCard = () => {
    if (payjp || card || cardRegistered) return;

    console.log('▶ PAY.JP スクリプト読み込み開始');

    const script = document.createElement('script');
    script.src = 'https://js.pay.jp/v2/pay.js';
    script.async = true;
    script.onload = () => {
      console.log('✅ PAY.JP スクリプト読み込み完了');

      const payjpInstance = (window as any).Payjp(process.env.NEXT_PUBLIC_PAYJP_PUBLIC_KEY!);
      setPayjp(payjpInstance);

      // ✅ Elements 初期化
      const elements = payjpInstance.elements();

      // ✅ cardNumber / cardExpiry / cardCvc を個別にマウント
      const cardNumber = elements.create('cardNumber');
      cardNumber.mount('#card-number');
      console.log('✅ cardNumber mount 完了');

      const cardExpiry = elements.create('cardExpiry');
      cardExpiry.mount('#card-expiry');
      console.log('✅ cardExpiry mount 完了');

      const cardCvc = elements.create('cardCvc');
      cardCvc.mount('#card-cvc');
      console.log('✅ cardCvc mount 完了');

      // ✅ elements 全体を state に格納（token 作成時に使用）
      setCard(elements);
      setCardReady(true);

      console.log('✅ PAY.JP 初期化完了');
    };

    document.body.appendChild(script);
  };

  // ✅ カード登録処理
const handleCardRegistration = async () => {
  setLoading(true);
  try {
    if (!payjp || !card) {
      alert('❌ PAY.JP がまだ初期化されていません');
      return;
    }

    // ✅ 名前を取得
    const nameInput = (document.querySelector<HTMLInputElement>('input[placeholder="TARO YAMADA"]')?.value) || 'NO NAME';

    // ✅ cardNumber だけを取得（elements 全体ではなく）
    const cardNumberElement = (card as any).getElement('cardNumber');

    if (!cardNumberElement) {
      throw new Error('カード番号入力欄が見つかりません');
    }

    // ✅ token 作成時に name を一緒に送る
    const tokenRes = await payjp.createToken(cardNumberElement, { name: nameInput });

    if (tokenRes.error) throw new Error(tokenRes.error.message);
    const token = tokenRes.id;
    console.log('✅ PAY.JP token 作成成功:', token);

    // ✅ API 経由でサーバーに登録
    const cardRes = await fetch('/api/pay/account/register-card', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_code, token }),
    });

    if (!cardRes.ok) throw new Error('Card registration failed');

    alert('✅ カードが登録されました');
    await fetchStatus(); // Refresh
  } catch (err: any) {
    console.error('❌ Card registration error:', err);
    alert(err.message || 'カード登録に失敗しました');
  } finally {
    setLoading(false);
  }
};


  // ✅ サブスク登録処理
  const handleSubscribe = async () => {
    setLoading(true);
    try {
      if (!selectedPlan?.plan_type) {
        alert('プランを選択してください');
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
        alert(`❌ サブスク登録に失敗しました\n${result.detail || '原因不明'}`);
        return;
      }

      window.location.href = `/thanks?user=${user_code}`;
    } catch (err: any) {
      console.error('⨯ Subscription error:', err);
      alert(`サブスク登録中にエラーが発生しました:\n${err.message || err}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="pay-main">
      {/* ✅ 見出し */}
      <h1 className="pay-title">ご利用プラン</h1>

      {/* ✅ プラン選択 */}
      <PlanSelectPanel
        userCode={user_code}
        cardRegistered={cardRegistered}
        userCredit={userCredit}
        onPlanSelected={(plan) => setSelectedPlan(plan)}
      />

      {/* ✅ カード未登録ユーザー */}
      {!cardRegistered && (
        <>
          {!showCardForm ? (
            // ⭐ 最初は「カードを登録する」ボタンのみ
            <div className="text-center mt-4">
              <button
                className="btn-card-register"
                onClick={() => {
                  setShowCardForm(true);
                  initPayjpCard();
                }}
              >
                カードを登録する
              </button>
            </div>
          ) : (
            // ⭐ 押したらフォームが出現
            <div>
              <CardStyle /> {/* ✅ UIだけ表示（カードで支払うボタンは削除済み） */}
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

      {/* ✅ カード登録済ユーザー */}
      {cardRegistered && (
        <div className="registered-card-box text-center">
          <p className="text-gray-700">
            💳 登録済みカード: {userData?.card_brand || 'VISA'} **** {userData?.card_last4 || '****'}
          </p>
        </div>
      )}

      {/* ✅ カード登録済ならプラン購入ボタン */}
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
