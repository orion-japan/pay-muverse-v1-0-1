import { createClient } from '@supabase/supabase-js';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const sb = createClient(URL, KEY);

export type ProfilePrefs = {
  user_code: string;
  style?: Record<string, any>;
  taboos?: string[];
  terms?: Record<string, string>;
  updated_at?: string;
};

export async function getProfile(user_code: string): Promise<ProfilePrefs|null> {
  const { data, error } = await sb.from('iros_profile_prefs')
    .select('*').eq('user_code', user_code).maybeSingle();
  if (error) throw error;
  return data as any;
}

export async function upsertProfile(p: ProfilePrefs) {
  const { data, error } = await sb.from('iros_profile_prefs').upsert({
    user_code: p.user_code,
    style: p.style ?? {},
    taboos: p.taboos ?? [],
    terms: p.terms ?? {},
    updated_at: new Date().toISOString()
  }).select('user_code').maybeSingle();
  if (error) throw error;
  return data?.user_code as string;
}
