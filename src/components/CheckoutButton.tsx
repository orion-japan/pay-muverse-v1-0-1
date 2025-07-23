'use client';

import { useState } from 'react';

type Plan = {
  plan_type: string;
  price: number;
  credit: number;
};

type CheckoutResponse = {
  redirect?: string;
  warning?: string;
  error?: string;
  detail?: string;
  success?: boolean;
  logTrail?: string[];
};

type Props = {
  plan: Plan;
  user_code: string;
  hasCard: boolean;
};

export default function CheckoutButton({ plan, user_code, hasCard }: Props) {
  const [loading, setLoading] = useState(false);

  const handleCheckout = async (force = false) => {
    setLoading(true);

    try {
      const res = await fetch(`/api/pay/subscribe${force ? '?force=true' : ''}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_code,
          plan_type: plan.plan_type,
          charge_amount: plan.price,
          sofia_credit: plan.credit,
        }),
      });

      const data: CheckoutResponse = await res.json();

      if (!res.ok) {
        console.error('❌ APIエラー:', data);
        alert(`❌ 通信エラー: ${data.error || '不明なエラー'}`);
        return;
      }

      // 🚨 warningチェック → 最優先
      if (data.warning) {
        const proceed = window.confirm(`${data.warning}\n\nこのまま続行しますか？`);
        if (proceed) {
          console.log('⚠️ 警告後に再実行します（force=true）');
          await handleCheckout(true); // 再実行
        }
        return; // 🚫 必ずここで終了
      }

      // ❌ エラー返却がある場合
      if (data.error || !data.success) {
        alert(`❌ エラー: ${data.error || data.detail || '不明なエラー'}\n\n${data.logTrail?.join('\n') || ''}`);
        console.error('エラー内容:', data);
        return;
      }

      // ✅ 成功時だけ THANKS ページへ
      window.location.href = `/thanks?user=${user_code}`;
    } catch (err: any) {
      console.error('⛔ 実行時エラー:', err);
      alert(`実行エラーが発生しました: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  if (!hasCard) {
    return (
      <p className="text-sm text-red-600 mt-4">
        🚫 カード情報が登録されていません。まずはカードを登録してください。
      </p>
    );
  }

  return (
    <button
      onClick={() => handleCheckout()}
      disabled={loading}
      className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
    >
      {loading ? '処理中...' : 'このプランを選択'}
    </button>
  );
}
