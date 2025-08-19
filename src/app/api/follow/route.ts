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
    // 🔒 認証
    const authHeader = req.headers.get('authorization');
    if (!authHeader) return NextResponse.json({ error: 'No token' }, { status: 401 });

    const token = authHeader.replace('Bearer ', '');
    const decoded = await getAuth().verifyIdToken(token);

    // 📦 リクエストボディ
    const body = await req.json();
    const to_user_code: string | undefined = body?.to_user_code;
    let from_user_code: string | undefined = body?.from_user_code;
    const ship_type: 'S' | 'F' | 'R' | 'C' | 'I' | undefined = body?.ship_type;

    if (!to_user_code) {
      return NextResponse.json({ error: 'Missing to_user_code' }, { status: 400 });
    }

    // フォールバック: トークン内の custom claim
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

    if (!ship_type) {
      return NextResponse.json({ error: 'Missing ship_type' }, { status: 400 });
    }

    // 👥 両ユーザーの存在チェック
    const { data: usersFound, error: usersErr } = await supabase
      .from('users')
      .select('user_code')
      .in('user_code', [from_user_code, to_user_code]);

    if (usersErr) throw usersErr;
    if (!usersFound || usersFound.length < 2) {
      return NextResponse.json({ error: 'user_code not found in users table' }, { status: 400 });
    }

    // 🔁 既存フォローの有無チェック
    const { data: existing, error: chkErr } = await supabase
      .from('follows')
      .select('id')
      .eq('follower_code', from_user_code)
      .eq('following_code', to_user_code)
      .maybeSingle();

    if (chkErr) throw chkErr;

    if (existing?.id) {
      // UPDATE
      const { error: updErr } = await supabase
        .from('follows')
        .update({ ship_type })
        .eq('id', existing.id);

      if (updErr) throw updErr;

      return NextResponse.json({ ok: true, updated: true });
    }

    // ➕ INSERT
    const { error: insErr } = await supabase.from('follows').insert({
      follower_code: from_user_code,
      following_code: to_user_code,
      ship_type,
    });

    if (insErr) throw insErr;

    return NextResponse.json({ ok: true, inserted: true });
  } catch (e: any) {
    console.error('[follow] error', e);
    return NextResponse.json({ error: e?.message ?? 'unknown error' }, { status: 500 });
  }
}
