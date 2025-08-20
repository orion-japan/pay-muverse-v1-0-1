// src/app/api/get-current-user/route.ts
import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabaseServer';
import { adminAuth } from '@/lib/firebase-admin';

export async function POST(req: Request) {
  try {
    // ① Supabase セッション（Cookie）で取得
    const { data: { user }, error } = await supabaseServer.auth.getUser();
    if (!error && user) {
      return NextResponse.json({ user_code: user.id }, { status: 200 });
    }

    // ② Authorization: Bearer <idToken> または JSON body の idToken
    const authz = req.headers.get('authorization') || '';
    let idToken = '';

    if (authz.startsWith('Bearer ')) {
      idToken = authz.slice('Bearer '.length).trim();
    } else {
      // Content-Type が JSON のときだけ安全に読む
      const ctype = req.headers.get('content-type') || '';
      if (ctype.includes('application/json')) {
        const body = await req.json().catch(() => ({} as any));
        if (body?.idToken) idToken = String(body.idToken);
      }
    }

    if (!idToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // ③ Firebase ID トークン検証
    const decoded = await adminAuth.verifyIdToken(idToken).catch(() => null);
    if (!decoded) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });

    const uid = decoded.uid;
    const email = decoded.email ?? null;

    // ④ users から user_code を引く（uid 優先 → email）
    const { data: byUid } = await supabaseServer
      .from('users')
      .select('user_code')
      .eq('uid', uid)
      .maybeSingle();

    let userCode: string | null = byUid?.user_code ?? null;

    if (!userCode && email) {
      const { data: byEmail } = await supabaseServer
        .from('users')
        .select('user_code')
        .eq('email', email)
        .maybeSingle();
      userCode = byEmail?.user_code ?? null;
    }

    if (!userCode) {
      return NextResponse.json({ error: 'user_code not found' }, { status: 404 });
    }

    return NextResponse.json({ user_code: userCode }, { status: 200 });
  } catch (e) {
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}

export async function GET() {
  // メソッド固定（任意）
  return NextResponse.json({ error: 'Method Not Allowed' }, { status: 405 });
}
