// app/api/get-current-user/route.ts
import { NextResponse } from 'next/server';
import { adminAuth } from '@/lib/firebase-admin';
import { supabaseServer } from '@/lib/supabaseServer';

export async function POST(req: Request) {
  console.log('========== [get-current-user] API開始 ==========');

  try {
    const body = await req.json().catch(() => ({}));
    let idToken = body?.idToken || body?.auth?.idToken;

    if (!idToken) {
      const authHeader = req.headers.get('authorization') || '';
      if (authHeader.startsWith('Bearer ')) {
        idToken = authHeader.substring(7);
      }
    }

    if (!idToken) {
      return NextResponse.json({ error: 'idToken is required' }, { status: 400 });
    }

    // Firebase IDトークン検証
    const decoded = await adminAuth.verifyIdToken(idToken, true);
    const firebase_uid = decoded.uid;

    // ① users から user_code を取得
    const { data: userData, error: userErr } = await supabaseServer
      .from('users')
      .select('user_code')
      .eq('firebase_uid', firebase_uid)
      .maybeSingle();

    if (userErr) {
      return NextResponse.json({ error: 'Database error: users' }, { status: 500 });
    }

    if (!userData?.user_code) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // ② profiles からプロフィール取得
    const { data: profileData, error: profileErr } = await supabaseServer
      .from('profiles')
      .select('*')
      .eq('user_code', userData.user_code)
      .maybeSingle();

    if (profileErr) {
      return NextResponse.json({ error: 'Database error: profiles' }, { status: 500 });
    }

    return NextResponse.json({
      user_code: userData.user_code,
      profile: profileData
    });

  } catch (err: any) {
    console.error('[get-current-user] ❌ Unexpected error', err);
    return NextResponse.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
