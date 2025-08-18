// src/app/api/follow/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

if (!getApps().length) initializeApp();

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!, // Service Role Key
);

export async function POST(req: NextRequest) {
  try {
    // 認証
    const authHeader = req.headers.get('authorization');
    if (!authHeader) return NextResponse.json({ error: 'No token' }, { status: 401 });
    const token = authHeader.replace('Bearer ', '');
    const decoded = await getAuth().verifyIdToken(token);

    // 受信ボディ
    const body = await req.json();
    const to_user_code: string | undefined = body?.to_user_code;
    // クライアントから自分の user_code を受け取る（推奨）
    let from_user_code: string | undefined = body?.from_user_code;

    if (!to_user_code) {
      return NextResponse.json({ error: 'No target' }, { status: 400 });
    }

    // 受け取れない場合はトークンの custom claim をフォールバックに
    if (!from_user_code) {
      const claimUserCode = (decoded as any)?.user_code as string | undefined;
      if (claimUserCode) from_user_code = claimUserCode;
    }

    if (!from_user_code) {
      return NextResponse.json({ error: 'cannot resolve your user_code' }, { status: 400 });
    }
    if (from_user_code === to_user_code) {
      return NextResponse.json({ error: 'cannot follow yourself' }, { status: 400 });
    }

    // 両者が users に存在するか事前チェック
    const { data: usersFound, error: usersErr } = await supabase
      .from('users')
      .select('user_code')
      .in('user_code', [from_user_code, to_user_code]);

    if (usersErr) throw usersErr;
    if (!usersFound || usersFound.length < 2) {
      return NextResponse.json({ error: 'user_code not found in users table' }, { status: 400 });
    }

    // 既存チェック（head + count）
    const { count, error: chkErr } = await supabase
      .from('follows')
      .select('*', { head: true, count: 'exact' })
      .eq('follower_code', from_user_code)
      .eq('following_code', to_user_code);

    if (chkErr) throw chkErr;
    if ((count ?? 0) > 0) {
      return NextResponse.json({ ok: true, message: 'already following' });
    }

    // 追加
    const { error: insErr } = await supabase.from('follows').insert({
      follower_code: from_user_code,
      following_code: to_user_code,
    });
    if (insErr) throw insErr;

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error('[follow] error', e);
    return NextResponse.json({ error: e?.message ?? 'unknown error' }, { status: 500 });
  }
}
