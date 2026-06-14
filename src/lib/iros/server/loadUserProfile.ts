// file: src/lib/iros/server/loadUserProfile.ts
// Iros 用ユーザープロファイル読込ヘルパー
// - users テーブル … sofia_credit を取得（必須）
// - iros_user_profile テーブル … user_call_name / style / plan_status を取得（任意）

import type { SupabaseClient } from '@supabase/supabase-js';

export type IrosUserProfileRow = {
  user_code: string;
  /** Muが実際に呼ぶ名前。敬称設定があれば「orionさん」のように合成済みで返す */
  user_call_name: string | null;
  /** 敬称を除いた呼び名 */
  user_call_base_name: string | null;
  user_call_suffix: string | null;
  user_call_suffix_text: string | null;
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
  user_call_suffix?: string | null;
  user_call_suffix_text?: string | null;
  style: string | null;
  plan_status: string | null;
  [key: string]: any;
};

function buildUserCallName(row: IrosProfileRow | null): {
  displayName: string | null;
  baseName: string | null;
  suffix: string | null;
  suffixText: string | null;
} {
  const baseName = typeof row?.user_call_name === 'string' ? row.user_call_name.trim() : '';
  if (!baseName) {
    return {
      displayName: null,
      baseName: null,
      suffix: null,
      suffixText: null,
    };
  }

  const suffix = typeof row?.user_call_suffix === 'string' && row.user_call_suffix.trim()
    ? row.user_call_suffix.trim()
    : 'san';

  if (suffix === 'custom') {
    const suffixText = typeof row?.user_call_suffix_text === 'string' ? row.user_call_suffix_text.trim() : '';
    return {
      displayName: `${baseName}${suffixText}`,
      baseName,
      suffix,
      suffixText,
    };
  }

  if (suffix === 'none') {
    return {
      displayName: baseName,
      baseName,
      suffix,
      suffixText: null,
    };
  }

  const suffixMap: Record<string, string> = {
    san: 'さん',
    chan: 'ちゃん',
    kun: 'くん',
    sama: 'さま',
  };

  return {
    displayName: `${baseName}${suffixMap[suffix] ?? 'さん'}`,
    baseName,
    suffix,
    suffixText: null,
  };
}

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
    // select('*') にして、敬称カラム追加前の環境でも壊れないようにする
    const { data: irosRowRaw, error: irosErr } = await client
      .from('iros_user_profile')
      .select('*')
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
    const callName = buildUserCallName(irosRow);

    const sofiaCredit =
      typeof (userRow as any).sofia_credit === 'number'
        ? (userRow as any).sofia_credit
        : userRow.sofia_credit ?? null;

    const profile: IrosUserProfileRow = {
      user_code: userRow.user_code,
      user_call_name: callName.displayName,
      user_call_base_name: callName.baseName,
      user_call_suffix: callName.suffix,
      user_call_suffix_text: callName.suffixText,
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
      user_call_base_name: profile.user_call_base_name,
      user_call_suffix: profile.user_call_suffix,
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
