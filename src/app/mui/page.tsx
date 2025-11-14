import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

import { ClientAuthGate, LoginModalButton } from './ClientAuthGate';
import './mui.css';
import MuiChat from '@/components/mui/MuiChat';

export default async function Page() {
  // ★ Next.js 16 の型バグ回避：cookieStore を any として扱う
  const cookieStore = cookies() as any;

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value ?? null;
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <div className="mui-root">
      {user ? (
        <MuiChat />
      ) : (
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
