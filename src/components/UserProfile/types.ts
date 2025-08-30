// src/components/UserProfile/types.ts
export type Profile = {
    user_code: string;
    name: string;                  // ← 必須に統一（食い違いの原因だったので固定）
    birthday: string;
    prefecture: string;
    city: string;
    x_handle: string;
    instagram: string;
    facebook: string;
    linkedin: string;
    youtube: string;
    website_url: string;
    interests: string[] | string;
    skills: string[] | string;
    activity_area: string[] | string;
    languages: string[] | string;
    avatar_url: string | null;
  };
  