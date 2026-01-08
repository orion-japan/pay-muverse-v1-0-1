import { createClient } from '@supabase/supabase-js';

type ResolveUserIdArgs = {
  supabase: ReturnType<typeof createClient>;
  userCode: string;
};

export async function resolveUserIdByUserCode({ supabase, userCode }: ResolveUserIdArgs) {
  const code = String(userCode ?? '').trim();
  if (!code) return { ok: false as const, error: 'missing_user_code' as const };

  const { data, error } = await supabase
    .from('profiles')
    .select('user_id')
    .eq('user_code', code)
    .maybeSingle();

  if (error) return { ok: false as const, error: 'select_failed' as const, detail: error.message };
  if (!data?.user_id) return { ok: false as const, error: 'not_found' as const };

  return { ok: true as const, userId: data.user_id as string };
}
