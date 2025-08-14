// lib/uploadAvatar.ts
import { supabase } from './supabaseClient';

// アバターをアップロードし、ファイルパスを返す
export async function uploadAvatar(file: File): Promise<string> {
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    throw new Error('ユーザー情報の取得に失敗しました');
  }

  const filePath = `${user.id}/avatar.png`;

  const { error: uploadError } = await supabase.storage
    .from('avatars')
    .upload(filePath, file, {
      upsert: true,
      cacheControl: '3600',
    });

  if (uploadError) {
    throw new Error(`アップロード失敗: ${uploadError.message}`);
  }

  return filePath;
}
