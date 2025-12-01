// src/lib/iros/profileMemory.ts
// v_iros_user_profile ビューを読むための薄いヘルパー

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * v_iros_user_profile の1行分（ビューのカラム定義に合わせる）
 */
export type IrosUserProfileRow = {
  user_code: string;
  display_name: string | null;

  bio: string | null;
  headline: string | null;
  mission: string | null;
  looking_for: string | null;

  organization: string | null;
  position: string | null;

  activity_area: string[] | null;
  interests: string[] | null;
  skills: string[] | null;

  prefecture: string | null;
  city: string | null;

  plan: string | null;
  plan_status: string | null;

  sofia_credit: string;   // numeric が JSON では文字列で返る
  credit_balance: string; // 同上

  x_handle: string | null;
  instagram: string | null;
  facebook: string | null;
  linkedin: string | null;
  youtube: string | null;
  website_url: string | null;

  email_verified: boolean | null;
  is_leader: boolean | null;
  leader_origin: string | null;

  last_login_at: string | null;
  user_updated_at: string;
  profile_updated_at: string;
};

/**
 * user_code から v_iros_user_profile を1件取得する
 * - なければ null を返す
 * - エラー時は Error を投げる（上位で try/catch）
 */
export async function fetchIrosUserProfileByUserCode(
  client: SupabaseClient,
  userCode: string,
): Promise<IrosUserProfileRow | null> {
  const { data, error } = await client
    .from('v_iros_user_profile')
    .select('*')
    .eq('user_code', userCode)
    .maybeSingle();

  if (error) {
    // ログに出しておくとデバッグしやすい
    console.error('[IROS][profile] fetch error', { userCode, error });
    throw error;
  }

  if (!data) return null;

  return data as IrosUserProfileRow;
}
