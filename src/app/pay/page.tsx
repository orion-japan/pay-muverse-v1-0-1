'use client';
export const dynamic = 'force-dynamic';

import { Suspense, useEffect, useState, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import PlanSelectPanel from '@/components/PlanSelectPanel';
import CardStyle from '@/components/CardStyle';  // ✅ 分割UIを使う
import { getAuth } from 'firebase/auth';

function PageInner() {
  const searchParams = useSearchParams();
  const user_code = searchParams.get('user') || '';

  // 🔽 状態管理
  const [userData, setUserData] = useState<any>(null);
  const [payjp, setPayjp] = useState<any>(null);
  const [cardNumber, setCardNumber] = useState<any>(null);
  const [cardExpiry, setCardExpiry] = useState<any>(null);
  const [cardCvc, setCardCvc] = useState<any>(null);
  const [cardReady, setCardReady] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [cardRegistered, setCardRegistered] = useState(false);
  const [showCardForm, setShowCardForm] = useState(false);
  const [userCredit, setUserCredit] = useState<number>(0);

  // ✅ 初期化フラグ（script読み込みガード）
  const initCalled = useRef(false);
  // ✅ 登録処理の多重実行ガード
  const registerCalled = useRef(false);

  // ✅ ユーザーデータ取得
  const fetchStatus = async () => {
    try {
      console.log('[fetchStatus] START');
      const res = await fetch(`/api/account-status?user=${user_code}`);
      const json = await res.json();
      console.log('[fetchStatus] response:', json);
      setUserData(json);
      setCardRegistered(json.card_registered);
      setUserCredit(json.sofia_credit || 0);
    } catch (err) {
      console.error('⛔ ユーザー取得失敗:', err);
    }
  };

  useEffect(() => {
    if (user_code) fetchStatus();
  }, [user_code]);

  // ✅ PAY.JP 初期化（1回だけ）
  const initPayjpCard = () => {
    if (initCalled.current) {
      console.log('[initPayjpCard] すでに初期化済みなのでスキップ');
      return;
    }
    initCalled.current = true;

    console.log('[initPayjpCard] START');

    const script = document.createElement('script');
    script.src = 'https://js.pay.jp/v2/pay.js';
    script.async = true;
    script.onload = () => {
      console.log('✅ PAY.JP script loaded');

      const payjpInstance = (window as any).Payjp(process.env.NEXT_PUBLIC_PAYJP_PUBLIC_KEY!);
      setPayjp(payjpInstance);
      console.log('✅ payjp instance created:', payjpInstance);

      const elements = payjpInstance.elements();
      console.log('✅ payjp elements created:', elements);

      // ✅ 分割フィールド作成（DOMに1つずつ存在する前提）
      const cn = elements.create('cardNumber');
      cn.mount('#card-number');
      console.log('✅ cardNumber mounted');
      setCardNumber(cn);

      const ce = elements.create('cardExpiry');
      ce.mount('#card-expiry');
      console.log('✅ cardExpiry mounted');
      setCardExpiry(ce);

      const cc = elements.create('cardCvc');
      cc.mount('#card-cvc');
      console.log('✅ cardCvc mounted');
      setCardCvc(cc);

      setCardReady(true);
      console.log('✅ PAY.JP init complete');
    };

    document.body.appendChild(script);
  };

// ① タイムアウト付きトークン作成ヘルパーを「要素を引数に」変更
const createTokenWithTimeout = async (el: any, ms = 15000) => {
  return Promise.race([
    payjp.createToken(el), // ← el を使う
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('タイムアウトしました')), ms)
    ),
  ]);
};

// ② 登録処理
const handleCardRegistration = async () => {
  setLoading(true);
  try {
    // Firebase → user_code 解決（既存のまま）
    const user = getAuth().currentUser;
    if (!user) throw new Error('ログインしてください');
    const idToken = await user.getIdToken(true);
    const res = await fetch('/api/account-status', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${idToken}`,
        'Content-Type': 'application/json',
      },
    });
    const j = await res.json();
    const resolvedCode = j?.user_code;
    if (!resolvedCode) throw new Error('ユーザーコードが取得できません');

    // ✅ PAY.JP／Elements 準備チェック
    if (!payjp) throw new Error('PAY.JP が初期化されていません');
    if (!cardNumber) throw new Error('カード番号フィールドが初期化されていません');

    // ✅ token 作成（分割 Elements では cardNumber を渡す）
    let tokenRes;
    try {
      tokenRes = await createTokenWithTimeout(cardNumber); // ★ ここを修正
    } catch {
      tokenRes = await createTokenWithTimeout(cardNumber); // 1回リトライ
    }

    if (!tokenRes?.id) {
      // tokenRes?.error?.message があれば表示
      const msg = tokenRes?.error?.message || 'カードトークンの取得に失敗しました';
      throw new Error(msg);
    }
    const token = tokenRes.id;

    // ✅ バックエンドへ送信
// before
let cardRes = await fetch('/api/pay/account/register-card', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ user_code: resolvedCode, token }),
});

// 404 なら /register-card にフォールバック
if (cardRes.status === 404) {
  cardRes = await fetch('/register-card', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_code: resolvedCode, token }),
  });
}



    if (!cardRes.ok) {
      const errMsg = await cardRes.text().catch(() => '');
      throw new Error(`カード登録失敗: ${errMsg}`);
    }

    alert('カード登録が完了しました');
    await fetchStatus();
  } catch (err: any) {
    alert(err.message || 'カード登録に失敗しました');
    console.error('❌ Card registration error:', err);
  } finally {
    setLoading(false);
  }
};

  
  

  // ✅ サブスク登録処理
  const handleSubscribe = async () => {
    if (loading) return;
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
      <h1 className="pay-title">ご利用プラン</h1>

      <PlanSelectPanel
        userCode={user_code}
        cardRegistered={cardRegistered}
        userCredit={userCredit}
        onPlanSelected={(plan) => setSelectedPlan(plan)}
      />

      {/* ✅ カード未登録 → CardStyle UIを表示 */}
      {!cardRegistered && (
        <>
          {!showCardForm ? (
            <div className="text-center mt-4">
              <button
                className="btn-card-register"
                onClick={() => {
                  setShowCardForm(true);
                  initPayjpCard();
                }}
                disabled={loading}
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

      {/* ✅ カード登録済みならプラン購入ボタン */}
      {cardRegistered && (
        <>
          <div className="registered-card-box text-center">
            <p className="text-gray-700">
              💳 登録済みカード: {userData?.card_brand || 'VISA'} **** {userData?.card_last4 || '****'}
            </p>
          </div>

          <div className="text-center mt-4">
            <button
              className="btn-subscribe w-full"
              onClick={handleSubscribe}
              disabled={!selectedPlan || loading}
            >
              {loading ? '処理中…' : 'プランを購入する'}
            </button>
          </div>
        </>
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
