// file: src/lib/iros/server/loadUserProfile.ts
// Iros 用ユーザープロファイル読込ヘルパー
// - users テーブル … sofia_credit を取得（必須）
// - iros_user_profile テーブル … user_call_name / style / plan_status を取得（任意）

import type { SupabaseClient } from '@supabase/supabase-js';

export type IrosUserProfileRow = {
  user_code: string;
  user_call_name: string | null;
  style: string | null;
  plan_status: string | null;
  sofia_credit: number | null;
};

type UsersRow = {
  user_code: string;
  sofia_credit: number | null;
  [key: string]: any;
};

type IrosProfileRow = {
  user_call_name: string | null;
  style: string | null;
  plan_status: string | null;
  [key: string]: any;
};

export async function loadIrosUserProfile(
  client: SupabaseClient,
  userCode: string,
): Promise<IrosUserProfileRow | null> {
  try {
    // 1) users からクレジットだけ取る（必須）
    const { data: userRowRaw, error: userErr } = await client
      .from('users')
      .select('user_code, sofia_credit')
      .eq('user_code', userCode)
      .maybeSingle();

    // maybeSingle は環境によって「0件」を PGRST116 にすることがあるので吸収
    if (userErr && (userErr as any).code !== 'PGRST116') {
      console.warn('[IROS/UserProfile] users fetch error', {
        userCode,
        error: userErr,
      });
      return null;
    }

    const userRow = (userRowRaw as UsersRow | null) ?? null;

    if (!userRow) {
      console.warn('[IROS/UserProfile] users row not found', { userCode });
      return null;
    }

    // 2) iros_user_profile から Iros 専用プロフィールを取得（任意）
    const { data: irosRowRaw, error: irosErr } = await client
      .from('iros_user_profile')
      .select('user_call_name, style, plan_status')
      .eq('user_code', userCode)
      .maybeSingle();

    if (irosErr && (irosErr as any).code !== 'PGRST116') {
      console.warn('[IROS/UserProfile] iros_user_profile fetch error', {
        userCode,
        error: irosErr,
      });
      // users 側だけでも返す（ここは落とさない）
    }

    const irosRow = (irosRowRaw as IrosProfileRow | null) ?? null;

    const sofiaCredit =
      typeof (userRow as any).sofia_credit === 'number'
        ? (userRow as any).sofia_credit
        : userRow.sofia_credit ?? null;

    const profile: IrosUserProfileRow = {
      user_code: userRow.user_code,
      user_call_name: irosRow?.user_call_name ?? null,
      style: irosRow?.style ?? null,
      plan_status: irosRow?.plan_status ?? null,
      sofia_credit: sofiaCredit,
    };

    console.log('[IROS/UserProfile] load ok', {
      userCode,
      hasIrosRow: !!irosRow,
      sofia_credit: profile.sofia_credit,
      style: profile.style,
      user_call_name: profile.user_call_name,
      plan_status: profile.plan_status,
    });

    return profile;
  } catch (e) {
    console.warn('[IROS/UserProfile] load error', {
      userCode,
      error: e,
    });
    return null;
  }
}
