// src/components/UserProfile/types.ts

// 共鳴ログの種類
export type ResonanceType = 'echo' | 'follow' | 'quote';

// 共鳴ログ：APIのキー差異も吸収（created_at/text/url など）
export type ResonanceLog = {
  id?: string | number;
  type: ResonanceType;
  at?: string;
  created_at?: string;
  content?: string;
  text?: string;
  link?: string;
  url?: string;
  by?: string;
};

export type ProfileVisibility = 'public' | 'friends' | 'private';

export type Profile = {
  // 必須
  user_code: string;

  // 基本情報
  name?: string;
  birthday?: string;
  prefecture?: string;
  city?: string;

  // 名刺系（ProfileBasic.tsx が参照）
  headline?: string;
  organization?: string;
  position?: string;
  mission?: string;
  bio?: string;
  looking_for?: string;

  // SNS/リンク
  x_handle?: string;
  instagram?: string;
  facebook?: string;
  linkedin?: string;
  youtube?: string;
  website_url?: string;

  // タグ系（配列 or 文字列で来る可能性を許容）
  interests?: string[] | string;
  skills?: string[] | string;
  activity_area?: string[] | string;
  languages?: string[] | string;

  // 画像
  avatar_url?: string | null;

  // 公開範囲（UserProfileEditor.tsx が参照）
  visibility?: ProfileVisibility;

  // 追加フィールド
  REcode?: string;

  // 共鳴ログ
  resonance?: ResonanceLog[];
};
