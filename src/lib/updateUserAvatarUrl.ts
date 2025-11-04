// lib/updateUserAvatarUrl.ts
import { supabase } from './supabaseClient';

export async function updateUserAvatarUrl(filePath: string): Promise<string> {
  const { data: publicUrlData } = supabase.storage.from('avatars').getPublicUrl(filePath);

  const publicUrl = publicUrlData.publicUrl;

  // プロフィールに保存（例：avatar_url カラム）
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    throw new Error('ユーザー取得エラー');
  }

  const { error: updateError } = await supabase
    .from('users')
    .update({ avatar_url: publicUrl })
    .eq('firebase_uid', user.id); // ← user_codeではなくauth.uid()

  if (updateError) {
    throw new Error(`プロフィール更新失敗: ${updateError.message}`);
  }

  return publicUrl;
}
