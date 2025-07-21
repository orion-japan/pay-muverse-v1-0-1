// /app/mypage/page.tsx
"use client";

import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

export default function MyPageEntry() {
  const params = useSearchParams();
  const user_code = params.get('user');

  const [userExists, setUserExists] = useState<boolean | null>(null);

  useEffect(() => {
    if (!user_code) {
      setUserExists(false); // user_code無し → 新規ボタン表示
      return;
    }
    // Supabaseに存在チェック
    fetch(`/api/check-user?code=${user_code}`)
      .then((res) => res.json())
      .then((json) => setUserExists(json.exists))
      .catch(() => setUserExists(false));
  }, [user_code]);

  if (userExists === null) return <p>🔄 ロード中...</p>;

  if (!user_code || userExists === false) {
    return (
      <div className="text-center mt-10">
        <p className="mb-4">まだマイページがありません</p>
        <button
          className="bg-purple-600 text-white px-6 py-3 rounded-lg"
          onClick={() => window.location.href = `/register?code=${user_code || ''}`}
        >
          マイページを作成する
        </button>
      </div>
    );
  }

  return (
    <iframe
      src={`/account?user=${user_code}`}
      className="w-full h-screen border-none"
    />
  );
}
