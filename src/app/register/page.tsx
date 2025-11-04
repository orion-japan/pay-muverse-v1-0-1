// /app/register/page.tsx
'use client';

import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';

export default function RegisterPage() {
  useEffect(() => {
    const registerUser = async () => {
      const searchParams = new URLSearchParams(window.location.search);
      const userCode = searchParams.get('user');

      if (!userCode) {
        alert('URLにユーザーコードがありません');
        return;
      }

      console.log('✅ register-userに送信されるusercode:', userCode);

      try {
        // ① PAY.JP 顧客作成
        const payjpRes = await fetch('/api/payjp/create-customer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: `${userCode}@example.com` }), // 仮のメール
        });

        const payjpData = await payjpRes.json();
        console.log('🧾 PAY.JPで顧客作成成功:', payjpData);

        const payjpCustomerId = payjpData.id;

        // ② Supabase ユーザー登録
        const supabaseRes = await fetch('/api/supabase/register-user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user: userCode,
            payjpCustomerId: payjpCustomerId,
          }),
        });

        const supabaseData = await supabaseRes.json();

        if (!supabaseRes.ok) {
          console.error('❌ Supabase登録エラー:', supabaseData);
          alert('Supabase 登録に失敗しました');
          return;
        }

        console.log('✅ Supabase 登録完了:', supabaseData);
        alert('登録が完了しました！');
        window.location.href = '/account?user=' + userCode;
      } catch (err) {
        console.error('❌ 登録処理エラー:', err);
        alert('登録中にエラーが発生しました');
      }
    };

    registerUser();
  }, []);

  return (
    <main className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <h2 className="text-xl font-bold">ユーザーを登録しています…</h2>
        <p className="text-gray-500 mt-4">お待ちください</p>
      </div>
    </main>
  );
}
