import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// uid -> user_code
async function uidToUserCode(uid: string) {
  const { data, error } = await supabase
    .from('users')
    .select('user_code')
    .eq('firebase_uid', uid)
    .maybeSingle();
  if (error || !data?.user_code) throw new Error('user_code not found');
  return data.user_code as string;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const uid = searchParams.get('uid');
    if (!uid) return NextResponse.json({ error: 'uid required' }, { status: 400 });

    const user_code = await uidToUserCode(uid);

    const { data, error } = await supabase
      .from('profiles')
      .select('consents')
      .eq('user_code', user_code)
      .maybeSingle();
    if (error) throw error;

    // 無ければ空オブジェクト
    return NextResponse.json(data?.consents ?? {});
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'server error' }, { status: 500 });
  }
}
