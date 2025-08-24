export async function updateUserMeta(
  uid: string,
  fields: Record<string, any>
) {
  const { error } = await supabase
    .from('users')
    .update(fields)
    .eq('firebase_uid', uid);

  if (error) {
    console.error('🔴 Supabase updateUserMeta エラー:', error.message);
    throw new Error('Supabaseユーザーの更新に失敗しました');
  }
}
import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);
