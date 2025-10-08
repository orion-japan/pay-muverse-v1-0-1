// Server Component（'use client' は不要）
import './mui.css';
import MuiChat from '@/components/mui/MuiChat';

// 追加: 認証チェック（構造は維持し、同じラッパ内で分岐表示）
import { cookies } from 'next/headers';
import { createServerComponentClient } from '@supabase/auth-helpers-nextjs';

export default async function Page() {
  const supabase = createServerComponentClient({ cookies });
  const { data: { user } } = await supabase.auth.getUser();

  return (
    <div className="mui-root">
      {user ? (
        <MuiChat />
      ) : (
        // ラッパ構造は変えず、中身のみ未ログイン時の最小UI
        <div style={{ padding: 24, maxWidth: 560 }}>
          <h1 className="mui-title">Mui — 恋愛相談</h1>
          <p style={{ marginTop: 8 }}>このページを使うにはログインが必要です。</p>
          <a href="/login" className="btn">ログインへ</a>
        </div>
      )}
    </div>
  );
}
