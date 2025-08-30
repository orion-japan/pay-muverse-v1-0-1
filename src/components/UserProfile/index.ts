// src/components/UserProfile/index.ts
export type ResonanceLog = {
  type: 'quote' | 'follow' | 'echo'; // 引用 / 追従 / 共鳴
  content?: string | null;
  link?: string | null;
  by?: string | null;
  at?: string | null;
};

export type Profile = {
  user_code: string;
  name?: string;
  avatar_url?: string | null;

  // 追加項目
  headline?: string | null;
  mission?: string | null;
  looking_for?: string | null;
  organization?: string | null;
  position?: string | null;

  birthday?: string | null;
  prefecture?: string | null;
  city?: string | null;

  x_handle?: string | null;
  instagram?: string | null;
  facebook?: string | null;
  linkedin?: string | null;
  youtube?: string | null;
  website_url?: string | null;

  // 文字列/配列どちらでもOK（UI側で整形）
  interests?: string[] | string | null;
  skills?: string[] | string | null;
  activity_area?: string[] | string | null;
  languages?: string[] | string | null;

  visibility?: string | null;
  bio?: string | null;

  REcode?: string | null;                // ← 本人ページ見出しで表示
  resonance?: ResonanceLog[] | null;     // ← 共鳴履歴（無くてもOK）
};
