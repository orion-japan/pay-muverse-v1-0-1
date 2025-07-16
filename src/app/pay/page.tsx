'use client';

import { useSearchParams } from 'next/navigation';
import CheckoutButton from '../../components/CheckoutButton';

export default function PayContent() {
  const searchParams = useSearchParams();
  const user_code = searchParams.get('user') || '';

  console.log('✅ PayPage user_code:', user_code);

  const plans = [
    {
      name: 'ライトプラン（regular）',
      price_id: 'pln_d3ebb4c720e007c1b9cc7c07780b', // ← 実際のPrice ID
      credit: 45,
      price: 990,
    },
    {
      name: 'スタンダード（premium）',
      price_id: 'pln_3f072ea9c5c8d922f54c8a9ce308',
      credit: 200,
      price: 3300,
    },
    {
      name: 'プロフェッショナル（master）',
      price_id: 'pln_d5892056b2a560f1a7276b6d1780',
      credit: 1500,
      price: 16500,
    },
  ];

  return (
    <main className="p-6">
      <h1 className="text-lg font-bold mb-4">プランを選んで決済</h1>

      {plans.map((plan) => (
        <div key={plan.price_id} className="border p-4 mb-4">
          <h2>{plan.name}</h2>
          <p>月額: ¥{plan.price.toLocaleString()}</p>
          <p>付与クレジット: {plan.credit}回 / 月</p>
          {/* ✅ CheckoutButton に必ず user_code を渡す！ */}
          <CheckoutButton plan={{ price_id: plan.price_id }} user_code={user_code} />
        </div>
      ))}

      <p className="text-xs text-gray-500 mt-4">
        ※ご利用には利用規約への同意が必要です。
      </p>
    </main>
  );
}
