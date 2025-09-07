// src/lib/album.ts
import { supabase } from '@/lib/supabase';

export type AlbumItem = {
  name: string;
  url: string;    // 表示用（署名URL）
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
    const { data, error } = await supabase.storage.from(ALBUM_BUCKET).list(prefix, {
      limit: 200,
      sortBy: { column: 'updated_at', order: 'desc' },
    });
    if (error) throw error;

    const files = (data || []).filter((f) => !f.name.startsWith('.') && !f.name.endsWith('/'));
    const resolved = await Promise.all(
      files.map(async (f) => {
        const path = `${prefix}/${f.name}`;
        const { data: signed } = await supabase.storage
          .from(ALBUM_BUCKET)
          .createSignedUrl(path, 60 * 30); // 30分
        return {
          name: f.name,
          url: signed?.signedUrl ?? '',
          path,
          size: (f as any)?.metadata?.size ?? null,
          updated_at: (f as any)?.updated_at ?? null,
        };
      })
    );
    return resolved;
  } catch (e) {
    console.warn('[album] listAlbumImages error:', e);
    return [];
  }
}
