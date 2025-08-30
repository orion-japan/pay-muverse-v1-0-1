// app/api/mypage/me/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { adminAuth } from '@/lib/firebase-admin';
import { createClient } from '@supabase/supabase-js';

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const SUPABASE_URL = mustEnv('NEXT_PUBLIC_SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = mustEnv('SUPABASE_SERVICE_ROLE_KEY');

export async function POST(req: NextRequest) {
  try {
    // 1) Authorization
    const authz = req.headers.get('authorization') || '';
    const token = authz.toLowerCase().startsWith('bearer ')
      ? authz.slice(7).trim()
      : null;
    if (!token) {
      return NextResponse.json({ error: 'missing token' }, { status: 401 });
    }

    // 2) Firebase token verify
    const decoded = await adminAuth.verifyIdToken(token);
    const uid = decoded.uid;
    const email = decoded.email || '';

    // 3) Supabase admin client
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // 4) user_code 解決（firebase_uid -> click_email の順にフォールバック）
    let user_code: string | null = null;

    // (a) firebase_uid で一致
    {
      const { data, error } = await supabase
        .from('users')
        .select('user_code')
        .eq('firebase_uid', uid)
        .maybeSingle();

      if (!error && data?.user_code) user_code = data.user_code;
    }

    // (b) メールで一致
    if (!user_code && email) {
      const { data, error } = await supabase
        .from('users')
        .select('user_code')
        .eq('click_email', email)
        .maybeSingle();

      if (!error && data?.user_code) user_code = data.user_code;
    }

    if (!user_code) {
      return NextResponse.json(
        { error: 'user_code not found for this account' },
        { status: 404 }
      );
    }

    // 5) v_mypage_user ビューから自分の編集用データ取得
    const { data: me, error: e2 } = await supabase
      .from('v_mypage_user')
      .select('*')
      .eq('user_code', user_code)
      .single();

    if (e2) {
      return NextResponse.json({ error: e2.message }, { status: 500 });
    }

    // 6) avatar_url のフルURL化（キーで保存されているケースに対応）
    const BASE = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
    let avatar_url: string | null = (me as any)?.avatar_url ?? null;
    if (avatar_url && !/^https?:\/\//i.test(avatar_url)) {
      avatar_url = `${BASE}/storage/v1/object/public/avatars/${avatar_url}`;
    }

    const meOut = { ...(me as any), avatar_url };

    return NextResponse.json({ ok: true, me: meOut, user_code }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'unknown' }, { status: 500 });
  }
}
