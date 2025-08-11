import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// ✅ Supabase プロファイルを取得する関数（取得カラム制限付き）
export async function getUserProfile(user_code: string) {
  const { data, error } = await supabase
    .from('users')
    .select('user_code, click_username, click_type') // 必要なカラムだけ取得
    .eq('user_code', user_code)
    .single();

  if (error) {
    console.error('❌ getUserProfile エラー:', error.message);
    throw new Error(`ユーザー情報の取得に失敗しました`);
  }

  return data;
}
