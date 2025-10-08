// Server Component（'use client' は不要）
import './mui.css';
import MuiChat from '@/components/mui/MuiChat';

import { cookies } from 'next/headers';
import { createServerComponentClient } from '@supabase/auth-helpers-nextjs';

// ★ 追加：クライアントのゲート＆モーダルトリガを分離モジュールから import
import { ClientAuthGate, LoginModalButton } from './ClientAuthGate';

export default async function Page() {
  // まず Supabase Cookie を確認（本番の正規ルート）
  const supabase = createServerComponentClient({ cookies });
  const { data: { user } } = await supabase.auth.getUser();

  return (
    <div className="mui-root">
      {user ? (
        // Supabase でログイン済み → そのまま表示（構造維持）
        <MuiChat />
      ) : (
        // Supabase 未ログイン → クライアント側で Firebase / __USER_CODE__ を判定
        <ClientAuthGate>
          <div style={{ padding: 24, maxWidth: 560 }}>
            <h1 className="mui-title">Mui — 恋愛相談</h1>
            <p style={{ marginTop: 8 }}>このページを使うにはログインが必要です。</p>
            <LoginModalButton />
          </div>
        </ClientAuthGate>
      )}
    </div>
  );
}
