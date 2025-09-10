// app/api/mypage/update/route.ts
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
    // ---- Auth ----
    const authz = req.headers.get('authorization') || '';
    const token = authz.toLowerCase().startsWith('bearer ')
      ? authz.slice(7).trim()
      : null;
    if (!token) return NextResponse.json({ error: 'missing token' }, { status: 401 });

    const decoded = await adminAuth.verifyIdToken(token).catch(() => null);
    if (!decoded?.uid) {
      return NextResponse.json({ error: 'invalid token' }, { status: 401 });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // ---- Resolve user_code (prefer firebase_uid) ----
    let user_code: string | null = null;

    // 1) firebase_uid で検索
    const { data: byFirebase, error: e1 } = await supabase
      .from('users')
      .select('user_code')
      .eq('firebase_uid', decoded.uid)
      .maybeSingle();

    if (e1) return NextResponse.json({ error: e1.message }, { status: 500 });
    if (byFirebase?.user_code) user_code = byFirebase.user_code;

    // 2) 見つからなければ、メールで照合（任意）
    if (!user_code && decoded.email) {
      const { data: byEmail, error: e2 } = await supabase
        .from('users')
        .select('user_code')
        .eq('click_email', decoded.email)
        .maybeSingle();
      if (e2) return NextResponse.json({ error: e2.message }, { status: 500 });

      if (byEmail?.user_code) {
        user_code = byEmail.user_code;
        // このタイミングで firebase_uid を埋める（移行）
        await supabase
          .from('users')
          .update({ firebase_uid: decoded.uid })
          .eq('user_code', user_code);
      }
    }

    // 3) さらに保険：もし supabase_uid(uuid) を使っていた履歴があるなら一応試す（失敗しても無視）
    if (!user_code) {
      const { data: bySupabaseUid } = await supabase
        .from('users')
        .select('user_code')
        .eq('supabase_uid', decoded.uid as any) // 型が違うので通常はヒットしない
        .maybeSingle();
      if (bySupabaseUid?.user_code) {
        user_code = bySupabaseUid.user_code;
        await supabase
          .from('users')
          .update({ firebase_uid: decoded.uid })
          .eq('user_code', user_code);
      }
    }

    if (!user_code) {
      return NextResponse.json({ error: 'user_code not found' }, { status: 404 });
    }

    // ---- Body ----
    const body = await req.json().catch(() => ({} as any));

    // ---- users: editable fields ----
    const usersPatch: Record<string, any> = {};
    for (const k of [
      'click_email',
      'click_username',
      'headline',
      'mission',
      'looking_for',
      'position',
      'organization',
      'name', // users側で管理するなら
    ]) {
      if (Object.prototype.hasOwnProperty.call(body, k)) usersPatch[k] = body[k];
    }
    if (Object.keys(usersPatch).length) {
      const { error } = await supabase
        .from('users')
        .update(usersPatch)
        .eq('user_code', user_code);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // ---- profiles: editable fields ----
    const profilesPatch: Record<string, any> = {};
    for (const k of [
      'bio',
      'prefecture',
      'city',
      'x_handle',
      'instagram',
      'facebook',
      'linkedin',
      'youtube',
      'website_url',
      'interests',
      'skills',
      'activity_area',
      'languages',
      'profile_link',
      'visibility',
      'avatar_url',
      'birthday',
      'name',         // profiles側にあるなら
      'headline',
      'mission',
      'looking_for',
      'organization',
      'position',
    ]) {
      if (Object.prototype.hasOwnProperty.call(body, k)) profilesPatch[k] = body[k];
    }
    if (Object.keys(profilesPatch).length) {
      const { error } = await supabase
        .from('profiles')
        .update(profilesPatch)
        .eq('user_code', user_code);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'unknown' }, { status: 500 });
  }
}
