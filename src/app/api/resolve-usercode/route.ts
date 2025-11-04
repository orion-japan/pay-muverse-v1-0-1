// src/app/api/resolve-usercode/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic'; // キャッシュ回避

// Service Role はサーバー専用（クライアントに晒さない）
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// 共通: user_code を探す
async function lookupUserCode(uid?: string | null, email?: string | null) {
  // 1) users.firebase_uid
  if (uid) {
    const { data } = await supabase
      .from('users')
      .select('user_code')
      .eq('firebase_uid', uid)
      .maybeSingle();
    if (data?.user_code) return data.user_code;
  }
  // 2) users.email
  if (email) {
    const { data } = await supabase
      .from('users')
      .select('user_code')
      .eq('email', email)
      .maybeSingle();
    if (data?.user_code) return data.user_code;
  }
  // 3) profiles.firebase_uid
  if (uid) {
    const { data } = await supabase
      .from('profiles')
      .select('user_code')
      .eq('firebase_uid', uid)
      .maybeSingle();
    if (data?.user_code) return data.user_code;
  }
  return null;
}

// POST: { uid, email }
export async function POST(req: NextRequest) {
  try {
    const { uid, email } = (await req.json()) as {
      uid?: string | null;
      email?: string | null;
    };
    if (!uid && !email) {
      return NextResponse.json({ error: 'uid or email required' }, { status: 400 });
    }
    const user_code = await lookupUserCode(uid ?? null, email ?? null);
    return NextResponse.json({ user_code }, { status: 200 });
  } catch (e) {
    console.error('[resolve-usercode] POST error', e);
    return NextResponse.json({ error: 'internal error' }, { status: 500 });
  }
}

// GET: /api/resolve-usercode?uid=...&email=...
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const uid = searchParams.get('uid');
    const email = searchParams.get('email');
    // ping 確認用: パラメータなしなら ok 返す
    if (!uid && !email) return NextResponse.json({ ok: true });
    const user_code = await lookupUserCode(uid, email);
    return NextResponse.json({ user_code }, { status: 200 });
  } catch (e) {
    console.error('[resolve-usercode] GET error', e);
    return NextResponse.json({ error: 'internal error' }, { status: 500 });
  }
}
