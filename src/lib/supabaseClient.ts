import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// ✅ Supabase プロファイルを取得する関数（テーブル名を 'users' に修正）
export async function getUserProfile(user_code: string) {
  const { data, error } = await supabase
    .from('users') // ← ここを 'click_users' → 'users' に修正
    .select('*')
    .eq('user_code', user_code)
    .single();

  if (error) {
    throw new Error(`ユーザー情報の取得に失敗しました: ${error.message}`);
  }

  return data;
}
