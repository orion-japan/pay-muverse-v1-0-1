// src/lib/supabaseServerClient.ts
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

/**
 * Next.js 15 では cookies() が Promise を返すため await が必要。
 * 返す cookies 実装は同期メソッド（get/set/remove）で渡す。
 */
export async function getSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        set() {}, // 必要なら実装
        remove() {}, // 必要なら実装
      },
    },
  );
}

// 余計な混乱を避けるため、他の export は作らないで OK
// （もしこのファイルに supabaseServer という別名 export が残っていたら削除してください）
