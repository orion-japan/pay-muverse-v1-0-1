// src/lib/server/sb.ts
import { createClient } from '@supabase/supabase-js';
export function sbAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

// src/lib/server/authz.ts
export async function requireUserCode(sb = sbAdmin()) {
  const {
    data: { user },
  } = await sb.auth.getUser(); // cookieから
  if (!user) throw new Error('UNAUTHENTICATED');
  const { data, error } = await sb
    .from('users')
    .select('user_code')
    .eq('auth_uid', user.id)
    .single();
  if (error || !data?.user_code) throw new Error('USER_CODE_NOT_FOUND');
  return { user, user_code: data.user_code as string };
}

// 例: すべてのAPIの先頭で
const { user_code } = await requireUserCode();
