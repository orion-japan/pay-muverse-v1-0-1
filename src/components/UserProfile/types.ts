// src/components/UserProfile/types.ts

export type ResonanceKind = 'quote' | 'follow' | 'echo';

export type ResonanceLog = {
  id?: string | number;
  type: ResonanceKind;

  // 主に使うフィールド
  by?: string;
  at?: string;
  content?: string;
  link?: string;

  // API 名のゆらぎにフォールバック
  created_at?: string;
  text?: string;
  url?: string;
};

export type Profile = {
  user_code: string;

  // 基本プロフィール
  name?: string;
  headline?: string;            // ★ 追加（今回のビルドエラーの原因）
  birthday?: string;
  prefecture?: string;
  city?: string;

  // SNS / URL
  x_handle?: string;
  instagram?: string;
  facebook?: string;
  linkedin?: string;
  youtube?: string;
  website_url?: string;

  // 配列/文字列どちらも来る可能性に対応
  interests?: string[] | string;
  skills?: string[] | string;
  activity_area?: string[] | string;
  languages?: string[] | string;

  // 画像・その他
  avatar_url?: string | null;
  REcode?: string;

  // 共鳴ログ
  resonance?: ResonanceLog[];
};
