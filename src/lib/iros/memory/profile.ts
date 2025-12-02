// src/lib/iros/memory/profile.ts
import { createClient } from '@supabase/supabase-js';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
// サーバー側から呼ばれる想定なので、あれば service-role を優先
const KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const sb = createClient(URL, KEY);

export type ProfilePrefs = {
  user_code: string;
  // ここは string も JSON も受けられるようにしておく
  style?: any;
  taboos?: string[];
  terms?: Record<string, string>;
  updated_at?: string;
};

// これは従来どおり prefs テーブルを見るだけで OK
export async function getProfile(
  user_code: string,
): Promise<ProfilePrefs | null> {
  const { data, error } = await sb
    .from('iros_profile_prefs')
    .select('*')
    .eq('user_code', user_code)
    .maybeSingle();

  if (error) throw error;
  return (data as any) ?? null;
}

export async function upsertProfile(p: ProfilePrefs) {
  const now = new Date().toISOString();

  // --- style の正規化 --------------------
  // ・settings 画面からは string（'friendly' など）が飛んでくる
  // ・将来 JSON で渡したい場合も考えて両対応にする
  let styleJson: any = {};
  let styleCode: string | null = null;

  if (typeof p.style === 'string') {
    styleCode = p.style;
    // prefs 側には JSON として保存しておく（キー名は任意だが分かりやすく）
    styleJson = { iros_style: p.style };
  } else if (p.style && typeof p.style === 'object') {
    styleJson = p.style;
    if (typeof (p.style as any).iros_style === 'string') {
      styleCode = (p.style as any).iros_style;
    } else if (typeof (p.style as any).style === 'string') {
      styleCode = (p.style as any).style;
    }
  }

  // --- 1) iros_profile_prefs を更新 --------------------
  const { error: prefErr } = await sb.from('iros_profile_prefs').upsert({
    user_code: p.user_code,
    style: styleJson,
    taboos: p.taboos ?? [],
    terms: p.terms ?? {},
    updated_at: now,
  });

  if (prefErr) {
    console.error('[IROS/profile] upsert iros_profile_prefs failed', prefErr);
    throw prefErr;
  }

  // --- 2) iros_user_profile.style も同期（文字列） --------------------
  // あなたが SQL で見ているのはこちらなので、ここを更新します
  if (styleCode) {
    const { error: userErr } = await sb
      .from('iros_user_profile')
      .upsert(
        {
          user_code: p.user_code,
          style: styleCode,
          updated_at: now,
        },
        { onConflict: 'user_code' },
      );

    if (userErr) {
      console.error(
        '[IROS/profile] upsert iros_user_profile failed',
        userErr,
      );
      throw userErr;
    }
  }

  return p.user_code;
}
