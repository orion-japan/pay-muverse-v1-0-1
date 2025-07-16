'use client';

export default function CheckoutButton({
  plan,
  user_code,
}: {
  plan: { price_id: string };
  user_code: string;
}) {
  const handleCheckout = async () => {
    console.log('✅ CheckoutButton user_code:', user_code);

    const res = await fetch('/api/create-checkout-session', {
      method: 'POST',
      body: JSON.stringify({ plan, user_code }),
    });

    const data = await res.json();
    if (data.url) {
      window.location.href = data.url;
    } else {
      alert(data.error || '決済セッションの生成に失敗しました。');
    }
  };

  return (
    <button
      onClick={handleCheckout}
      className="px-4 py-2 bg-blue-600 text-white rounded"
    >
      このプランを選択
    </button>
  );
}
