// file: src/lib/iros/server/loadUserProfile.ts
// Iros 用ユーザープロファイル読込ヘルパー
// - users テーブル … sofia_credit を取得
// - iros_user_profile テーブル … user_call_name / style / plan_status を取得

import type { SupabaseClient } from '@supabase/supabase-js';

export type IrosUserProfileRow = {
  user_code: string;
  user_call_name: string | null;
  style: string | null;
  plan_status: string | null;
  sofia_credit: number | null;
};

export async function loadIrosUserProfile(
  client: SupabaseClient,
  userCode: string,
): Promise<IrosUserProfileRow | null> {
  try {
    // 1) users からクレジットだけ取る
    const { data: userRow, error: userErr } = await client
      .from('users')
      .select('user_code, sofia_credit')
      .eq('user_code', userCode)
      .maybeSingle();

    if (userErr) {
      console.warn('[IROS/UserProfile] users fetch error', {
        userCode,
        error: userErr,
      });
      return null;
    }

    if (!userRow) {
      console.warn('[IROS/UserProfile] users row not found', { userCode });
      return null;
    }

    // 2) iros_user_profile から Iros 専用プロフィールを取得
    const { data: irosRow, error: irosErr } = await client
      .from('iros_user_profile')
      .select('user_call_name, style, plan_status')
      .eq('user_code', userCode)
      .maybeSingle();

    if (irosErr) {
      console.warn('[IROS/UserProfile] iros_user_profile fetch error', {
        userCode,
        error: irosErr,
      });
      // users 側だけでもプロファイルとして返す
    }

    const profile: IrosUserProfileRow = {
      user_code: userRow.user_code,
      user_call_name: irosRow?.user_call_name ?? null,
      style: irosRow?.style ?? null,
      plan_status: irosRow?.plan_status ?? null,
      sofia_credit:
        typeof (userRow as any).sofia_credit === 'number'
          ? (userRow as any).sofia_credit
          : userRow.sofia_credit ?? null,
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
