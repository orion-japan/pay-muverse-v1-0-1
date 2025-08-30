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
    const authz = req.headers.get('authorization') || '';
    const token = authz.toLowerCase().startsWith('bearer ')
      ? authz.slice(7).trim()
      : null;
    if (!token) return NextResponse.json({ error: 'missing token' }, { status: 401 });

    const decoded = await adminAuth.verifyIdToken(token);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // user_code の解決（プロジェクトの実データに合わせて要調整）
    const { data: u } = await supabase
      .from('users')
      .select('user_code')
      .eq('id', decoded.uid) // ←必要なら firebase_uid などに変更
      .single();

    const user_code = u?.user_code;
    if (!user_code) return NextResponse.json({ error: 'user_code not found' }, { status: 404 });

    const body = await req.json();

    // users 側: 表示・編集可フィールド
    const usersPatch: Record<string, any> = {};
    for (const k of [
      'click_email', 'click_username',
      'headline', 'mission', 'looking_for', 'position', 'organization',
    ]) {
      if (typeof body[k] !== 'undefined') usersPatch[k] = body[k];
    }

    if (Object.keys(usersPatch).length > 0) {
      const { error: ue } = await supabase.from('users').update(usersPatch).eq('user_code', user_code);
      if (ue) return NextResponse.json({ error: ue.message }, { status: 500 });
    }

    // profiles 側: 表示系
    const profilesPatch: Record<string, any> = {};
    for (const k of [
      'bio', 'prefecture', 'city',
      'x_handle', 'instagram', 'facebook', 'linkedin', 'youtube', 'website_url',
      'interests', 'skills', 'activity_area', 'languages',
      'profile_link', // あれば
      'visibility',   // 単一可視
      'avatar_url',   // 既にストレージキーにアップ済みを想定（このAPIでは文字列のみ受ける）
    ]) {
      if (typeof body[k] !== 'undefined') profilesPatch[k] = body[k];
    }

    if (Object.keys(profilesPatch).length > 0) {
      const { error: pe } = await supabase.from('profiles').update(profilesPatch).eq('user_code', user_code);
      if (pe) return NextResponse.json({ error: pe.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'unknown' }, { status: 500 });
  }
}
