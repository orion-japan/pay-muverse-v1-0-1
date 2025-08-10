// src/lib/fetchUserStatus.ts
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
);

export async function fetchUserStatus(user_code: string) {
  const { data, error } = await supabase
    .from('users')
    .select('usertype, sofia_credit, card_registered')
    .eq('user_code', user_code)
    .single();

  if (error || !data) {
    console.error('❌ ユーザーデータ取得失敗:', error);
    return {
      usertype: 'free',
      sofia_credit: 0,
      card_registered: false,
    };
  }

  return data;
}
