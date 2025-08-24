'use client';
export const dynamic = 'force-dynamic';

import { Suspense, useEffect, useState, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import PlanSelectPanel from '@/components/PlanSelectPanel';
import CardStyle from '@/components/CardStyle'; // ✅ 分割UI
import { getAuth } from 'firebase/auth';
import dayjs from 'dayjs'; // ★ 期限判定

// Pay.js v2 の型ガード（ビルド時のエラー防止）
declare global {
  interface Window { Payjp?: any }
}

/* 軽量モーダル（ページ内で完結） */
function PayResultModal({
  open,
  title,
  message,
  onClose,
}: {
  open: boolean;
  title: string;
  message: string;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-[92%] max-w-sm rounded-2xl bg-white p-5 shadow-xl"
      >
        <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
        <p className="mt-2 text-sm text-gray-700 whitespace-pre-line">{message}</p>
        <div className="mt-4 flex justify-end">
          <button
            className="rounded-xl bg-indigo-600 px-4 py-2 text-white hover:bg-indigo-700"
            onClick={onClose}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

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
  const [expired, setExpired] = useState(false); // ★ 期限切れフラグ

  // ✅ モーダル
  const [modalOpen, setModalOpen] = useState(false);
  const [modalTitle, setModalTitle] = useState('');
  const [modalMessage, setModalMessage] = useState('');

  // ✅ 初期化/多重送信ガード
  const initCalled = useRef(false);
  const registerCalled = useRef(false);

  // ✅ ユーザーデータ取得（未ログイン時は静かにスキップ）
  const fetchStatus = async (forceAuth = false) => {
    try {
      let res: Response;

      if (forceAuth) {
        const user = getAuth().currentUser;
        if (!user) {
          // 未ログインなら何もしない（画面にエラーを出さない）
          console.debug('[fetchStatus] skip: not logged in');
          return;
        }
        const idToken = await user.getIdToken(true);
        res = await fetch('/api/account-status', {
          method: 'POST',
          headers: { Authorization: `Bearer ${idToken}` },
          cache: 'no-store',
        });
      } else {
        // ★ user_code が空のときは投げない（400ノイズ防止）
        if (!user_code) {
          console.debug('[fetchStatus] skip: user_code empty');
          return;
        }
        res = await fetch(`/api/account-status?user=${user_code}`, { cache: 'no-store' });
      }

      if (!res.ok) {
        // 404などは初期状態として無視
        console.warn('[fetchStatus] non-OK:', res.status);
        return;
      }

      const json = await res.json();
      console.debug('[fetchStatus] user:', json);
      setUserData(json);
      setCardRegistered(!!json.card_registered);
      setUserCredit(json.sofia_credit || 0);

      // ★ 期限切れ判定（sub_next_payment が今日以前なら期限切れ）
      const next = json?.sub_next_payment;
      const isExpired = !!next && dayjs(next).isBefore(dayjs(), 'day');
      setExpired(!!isExpired);
    } catch (err) {
      console.error('⛔ ユーザー取得失敗:', err);
    }
  };

  // 初回：GETで軽取得 → ログインしたらPOSTで再取得
  useEffect(() => {
    if (user_code) fetchStatus(false); // ★ 条件付き
    const unsub = getAuth().onAuthStateChanged((u) => {
      if (u) fetchStatus(true);
    });
    return () => unsub();
  }, [user_code]);

  // ✅ PAY.JP 初期化（1回だけ）
  const initPayjpCard = () => {
    if (initCalled.current) {
      console.log('[initPayjpCard] すでに初期化済みなのでスキップ');
      return;
    }
    initCalled.current = true;

    const script = document.createElement('script');
    script.src = 'https://js.pay.jp/v2/pay.js';
    script.async = true;
    script.onload = () => {
      const payjpInstance = (window as any).Payjp?.(process.env.NEXT_PUBLIC_PAYJP_PUBLIC_KEY!);
      if (!payjpInstance) {
        console.error('PAY.JP 初期化に失敗: window.Payjp が見つかりません');
        return;
      }
      setPayjp(payjpInstance);

      const elements = payjpInstance.elements();
      const cn = elements.create('cardNumber');
      cn.mount('#card-number');
      setCardNumber(cn);

      const ce = elements.create('cardExpiry');
      ce.mount('#card-expiry');
      setCardExpiry(ce);

      const cc = elements.create('cardCvc');
      cc.mount('#card-cvc');
      setCardCvc(cc);

      setCardReady(true);
      console.log('✅ PAY.JP init complete');
    };

    document.body.appendChild(script);
  };

  // タイムアウト付きトークン作成
  const createTokenWithTimeout = async (el: any, ms = 15000) =>
    Promise.race([
      payjp.createToken(el),
      new Promise((_, reject) => setTimeout(() => reject(new Error('タイムアウトしました')), ms)),
    ]);

  // ✅ カード登録処理
  const handleCardRegistration = async () => {
    if (registerCalled.current || loading) return;
    registerCalled.current = true;
    setLoading(true);
    try {
      // Firebase → user_code 解決
      const user = getAuth().currentUser;
      if (!user) throw new Error('ログインしてください');
      const idToken = await user.getIdToken(true);
      const res = await fetch('/api/account-status', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        cache: 'no-store',
      });
      const j = await res.json();
      const resolvedCode = j?.user_code;
      if (!resolvedCode) throw new Error('ユーザーコードが取得できません');

      // PAY.JP 準備
      if (!payjp) throw new Error('PAY.JP が初期化されていません');
      if (!cardNumber) throw new Error('カード番号フィールドが初期化されていません');

      // トークン作成
      let tokenRes;
      try {
        tokenRes = await createTokenWithTimeout(cardNumber);
      } catch {
        tokenRes = await createTokenWithTimeout(cardNumber); // 1回リトライ
      }
      if (!tokenRes?.id) {
        console.error('[createToken] error payload:', tokenRes);
        throw new Error(tokenRes?.error?.message || 'カードトークンの取得に失敗しました');
      }
      const token = tokenRes.id;
      console.debug('[createToken] token:', token);

      // サーバーへ送信（idToken 同梱）
      // ★ 顧客IDは「あれば渡す」。無ければサーバー側が自動作成する。
      const customerIdMaybe = j?.payjp_customer_id;

      const cardRes = await fetch('/api/pay/account/register-card', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          user_code: resolvedCode,
          token,                         // ← サーバー仕様に合わせて "token"
          ...(customerIdMaybe ? { customer_id: customerIdMaybe } : {}),
        }),
      });

      const cardJson = await cardRes.json().catch(() => ({}));
      console.debug('[register-card] response:', cardRes.status, cardJson);

      if (!cardRes.ok || !cardJson?.success) {
        throw new Error(cardJson?.error || `カード登録失敗: ${cardRes.status}`);
      }

      // 即時UI反映→最新取り直し
      setCardRegistered(true);
      setModalTitle('カード登録が完了しました');
      setModalMessage('次にプランを選んで購入できます。');
      setModalOpen(true);

      await fetchStatus(true);
    } catch (err: any) {
      console.error('❌ Card registration error:', err);
      setModalTitle('カード登録に失敗しました');
      setModalMessage(String(err?.message || err));
      setModalOpen(true);
    } finally {
      setLoading(false);
      registerCalled.current = false;
    }
  };

  // ✅ サブスク登録処理（Firebase ID トークンを必ず付与）
  const handleSubscribe = async () => {
    if (loading) return;
    setLoading(true);
    try {
      if (!selectedPlan?.plan_type) {
        setModalTitle('エラー');
        setModalMessage('プランを選択してください');
        setModalOpen(true);
        return;
      }

      // 1) Firebase から idToken 取得
      const user = getAuth().currentUser;
      if (!user) throw new Error('ログインしてください');
      const idToken = await user.getIdToken(true);

      // 2) 最新の user_code / payjp_customer_id / email を解決
      const accRes = await fetch('/api/account-status', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        cache: 'no-store',
      });
      if (!accRes.ok) {
        const t = await accRes.text().catch(() => '');
        throw new Error(`アカウント情報の取得に失敗しました: ${t || accRes.status}`);
      }
      const acc = await accRes.json();

      const resolvedCode: string | undefined = acc?.user_code;
      const customerId: string | undefined = acc?.payjp_customer_id;
      const userEmail: string | undefined = acc?.click_email;

      // 3) 必須チェック
      if (!resolvedCode) throw new Error('user_code を解決できませんでした');
      if (!customerId) throw new Error('PAY.JP の顧客IDがありません（カード登録が必要です）');

      // 4) 送信ペイロード
      const payload = {
        user_code: resolvedCode,
        user_email: userEmail || '',
        plan_type: selectedPlan.plan_type,
        customer_id: customerId,
        charge_amount: selectedPlan.price || 0,
        sofia_credit: selectedPlan.credit || 0,
        force_cancel_existing: true,
      };

      console.log('[subscribe] payload:', payload);

      // 5) サブスク作成（★ Authorization ヘッダを付ける）
      const subscribeRes = await fetch('/api/pay/subscribe', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,   // ★必須
        },
        body: JSON.stringify(payload),
      });

      const result = await subscribeRes.json().catch(() => ({}));
      console.log('[subscribe] response:', subscribeRes.status, result);

      if (!subscribeRes.ok || !result?.success) {
        const detail =
          result?.detail ||
          (Array.isArray(result?.missing) && result.missing.length
            ? `欠落フィールド: ${result.missing.join(', ')}`
            : '原因不明');
        setModalTitle('サブスク登録に失敗しました');
        setModalMessage(detail);
        setModalOpen(true);
        return;
      }

      // 成功
      window.location.href = `/thanks?user=${resolvedCode}`;
    } catch (err: any) {
      console.error('⨯ Subscription error:', err);
      setModalTitle('サブスク登録エラー');
      setModalMessage(String(err?.message || err));
      setModalOpen(true);
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

      {/* ★ 期限切れ表示（プラン再購入の案内） */}
      {expired && (
        <div className="mt-3 rounded-xl bg-amber-50 border border-amber-200 p-3 text-amber-900">
          ⚠ サブスクリプションの有効期限が切れています。プランを再購入してください。
        </div>
      )}

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
              {loading ? '処理中…' : (expired ? 'プランを再購入する' : 'プランを購入する')}
            </button>
          </div>
        </>
      )}

      {/* ✅ モーダル */}
      <PayResultModal
        open={modalOpen}
        title={modalTitle}
        message={modalMessage}
        onClose={() => setModalOpen(false)}
      />
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
