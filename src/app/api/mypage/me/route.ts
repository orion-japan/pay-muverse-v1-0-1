// app/api/mypage/me/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { adminAuth } from '@/lib/firebase-admin';
import { createClient } from '@supabase/supabase-js';

/* ===== types（ゆるめ。存在しない項目は undefined でOK）===== */
type ProfileRow = {
  avatar_url?: string | null;
  birthday?: string | null;
  prefecture?: string | null;
  city?: string | null;
  instagram?: string | null;
  twitter?: string | null;
  facebook?: string | null;
  linkedin?: string | null;
  youtube?: string | null;
  interests?: string[] | null;
  skills?: string[] | null;
  activity_area?: string | null;
  languages?: string[] | null;
  created_at?: string | null;
  updated_at?: string | null;
  // 将来追加してもここは壊れません
};

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
    const token = authz.toLowerCase().startsWith('bearer ') ? authz.slice(7).trim() : null;
    if (!token) {
      return NextResponse.json({ error: 'missing token' }, { status: 401 });
    }

    // 2) Firebase token verify
    const decoded = await adminAuth.verifyIdToken(token);
    const uid = decoded.uid;
    const email = decoded.email || '';

    // 3) Supabase admin client
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // 4) user_code 解決（firebase_uid -> click_email の順にフォールバック）
    let user_code: string | null = null;

    // (a) firebase_uid で一致
    {
      const { data, error } = await supabase
        .from('users')
        .select('user_code')
        .eq('firebase_uid', uid)
        .maybeSingle();
      if (!error && data?.user_code) user_code = data.user_code as string;
    }

    // (b) メールで一致（見つかったら firebase_uid を埋める）
    if (!user_code && email) {
      const { data, error } = await supabase
        .from('users')
        .select('user_code')
        .eq('click_email', email)
        .maybeSingle();

      if (!error && data?.user_code) {
        user_code = data.user_code as string;
        // ベストエフォートで紐付け
        await supabase.from('users').update({ firebase_uid: uid }).eq('user_code', user_code);
      }
    }

    if (!user_code) {
      return NextResponse.json({ error: 'user_code not found for this account' }, { status: 404 });
    }

    // ====== 5) 直読み：users / profiles から組み立て ======
    // 5.0) users から click_username
    let click_username: string | null = null;
    {
      const { data } = await supabase
        .from('users')
        .select('click_username')
        .eq('user_code', user_code)
        .maybeSingle();
      click_username = (data?.click_username ?? null) as string | null;
    }

    // 5.1) profiles は * で取得（存在しないカラムで落ちないようにする）
    const { data: profileData, error: eProfile } = await supabase
      .from('profiles')
      .select('*') // ← ここをワイルドカードに
      .eq('user_code', user_code)
      .maybeSingle();

    if (eProfile && (eProfile as any).code !== 'PGRST116') {
      // PGRST116 = 0件（maybeSingle想定）。それ以外だけ500扱い
      return NextResponse.json({ error: eProfile.message }, { status: 500 });
    }

    const profile: ProfileRow | null = (profileData as any as ProfileRow) ?? null;

    // 6) avatar_url のフルURL化
    const BASE = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
    let avatar_url: string | null = profile?.avatar_url ?? null;
    if (avatar_url && !/^https?:\/\//i.test(avatar_url)) {
      const key = avatar_url.startsWith('avatars/')
        ? avatar_url.slice('avatars/'.length)
        : avatar_url;
      avatar_url = `${BASE}/storage/v1/object/public/avatars/${key}`;
    }

    // 既存レスポンス構造を維持
    const meOut: Record<string, any> = {
      ...(profile ?? {}),
      click_username,
      avatar_url,
      user_code,
    };

    // 7) no-store でキャッシュ無効化
    return new NextResponse(JSON.stringify({ ok: true, me: meOut, user_code }), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'unknown' }, { status: 500 });
  }
}
