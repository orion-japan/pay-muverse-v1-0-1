import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

if (!getApps().length) initializeApp();

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: NextRequest) {
  try {
    // 🔒 認証
    const authHeader = req.headers.get('authorization');
    if (!authHeader) return NextResponse.json({ error: 'No token' }, { status: 401 });

    const token = authHeader.replace('Bearer ', '');
    const decoded = await getAuth().verifyIdToken(token);

    // 📦 リクエストボディ
    const body = await req.json();
    const to_user_code: string | undefined = body?.to_user_code;
    let from_user_code: string | undefined = body?.from_user_code;

    if (!to_user_code) {
      return NextResponse.json({ error: 'Missing to_user_code' }, { status: 400 });
    }

    // fallback: トークンから from_user_code を補完
    if (!from_user_code) {
      const claimUserCode = (decoded as any)?.user_code as string | undefined;
      if (claimUserCode) from_user_code = claimUserCode;
    }

    if (!from_user_code) {
      return NextResponse.json({ error: 'cannot resolve your user_code' }, { status: 400 });
    }

    // 🗑️ 削除
    const { error: delErr } = await supabase
      .from('follows')
      .delete()
      .eq('follower_code', from_user_code)
      .eq('following_code', to_user_code);

    if (delErr) throw delErr;

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error('[unfollow] error', e);
    return NextResponse.json({ error: e?.message ?? 'unknown error' }, { status: 500 });
  }
}
