// src/lib/album.ts
import { supabase } from '@/lib/supabase';

export type AlbumItem = {
  name: string;
  url: string;    // 表示用（署名URL or /api/media のフォールバック）
  path: string;   // private-posts 内のパス: <userCode>/<filename>
  size?: number | null;
  updated_at?: string | null;
};

const ALBUM_BUCKET = 'private-posts';

export async function listAlbumImages(userCode: string): Promise<AlbumItem[]> {
  try {
    const ucode = (userCode || '').trim();
    if (!ucode) return [];

    const prefix = `${ucode}`;

    // 1) 一覧取得（隠しファイル・ディレクトリ除外）
    const { data, error } = await supabase.storage.from(ALBUM_BUCKET).list(prefix, {
      limit: 200,
      sortBy: { column: 'updated_at', order: 'desc' },
    });
    if (error) throw error;

    const files = (data || []).filter(
      (f) => f && !f.name.startsWith('.') && !f.name.endsWith('/')
    );

    // 2) 各ファイルの署名URL生成。失敗時は /api/media にフォールバック
    const resolved = await Promise.all(
      files.map(async (f: any) => {
        const path = `${prefix}/${f.name}`;

        // 署名URL（30分）
        let url = '';
        try {
          const { data: signed } = await supabase.storage
            .from(ALBUM_BUCKET)
            .createSignedUrl(path, 60 * 30);
          url = signed?.signedUrl || '';
        } catch {
          // no-op
        }

        // フォールバック（/api/media 経由で安定表示）
        if (!url) {
          const q = encodeURIComponent(`${ALBUM_BUCKET}/${path}`);
          url = `/api/media?path=${q}`;
        }

        return {
          name: f.name as string,
          url,
          path,                                     // 相対パスはそのまま
          size: (f?.metadata?.size as number) ?? null,
          updated_at: (f?.updated_at as string) ?? null,
        } as AlbumItem;
      })
    );

    return resolved;
  } catch (e) {
    console.warn('[album] listAlbumImages error:', e);
    return [];
  }
}
