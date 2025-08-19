// src/lib/user.ts
import { supabase } from '@/lib/supabaseClient';

/** セッションから user_code を取得（metadata/user_metadata を優先） */
export async function getUserCodeFromSession(): Promise<string | null> {
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    console.error('[getUserCodeFromSession] auth error:', error.message);
    return null;
  }
  const session = data?.session;
  const meta = session?.user?.user_metadata ?? session?.user?.app_metadata ?? {};
  const code: string | undefined = meta.user_code || meta.userCode || meta.code;

  if (code) return code;

  // もし users テーブルに auth の uid と user_code のマッピングがあるならここで取得
  const uid = session?.user?.id;
  if (!uid) return null;

  // 例: users.auth_uid -> users.user_code のマッピングがある場合
  const { data: row, error: uerr } = await supabase
    .from('users')
    .select('user_code')
    .eq('auth_uid', uid)
    .maybeSingle();

  if (uerr) {
    console.warn('[getUserCodeFromSession] fallback query error:', uerr.message);
    return null;
  }
  return row?.user_code ?? null;
}

/** users / profiles などから画面表示用の userInfo を作る */
export async function fetchUserInfoByCode(userCode: string) {
  // users
  const { data: userRow, error: userErr } = await supabase
    .from('users')
    .select('*')
    .eq('user_code', userCode)
    .maybeSingle();
  if (userErr) {
    console.error('[fetchUserInfoByCode] users error:', userErr.message);
  }

  // profiles（存在すれば）
  const { data: profileRow, error: profErr } = await supabase
    .from('profiles')
    .select('*')
    .eq('user_code', userCode)
    .maybeSingle();
  if (profErr) {
    console.warn('[fetchUserInfoByCode] profiles error:', profErr.message);
  }

  // まとめて返す（nullはそのまま）
  return {
    user_code: userCode,
    user: userRow ?? null,
    profile: profileRow ?? null,
    // 画面でよく使う代表値（ニックネーム → プロフィール優先 / なければ users）
    displayName:
      profileRow?.nickname ||
      profileRow?.name ||
      userRow?.nickname ||
      userRow?.name ||
      'ゲスト',
  };
}
