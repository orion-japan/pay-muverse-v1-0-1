// src/types/post.ts
export type Post = {
  post_id: string;
  title?: string;         // ← null を含めない
  content?: string;       // ← null を含めない
  media_urls: string[];
  tags?: string[];
  created_at: string;     // ← 必須（常に string を渡す）
  board_type?: 'album' | 'default' | 'self' | string;
};
