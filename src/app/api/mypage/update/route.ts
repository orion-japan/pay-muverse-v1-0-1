// app/api/mypage/update/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { adminAuth } from '@/lib/firebase-admin';

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const SUPABASE_URL = mustEnv('NEXT_PUBLIC_SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = mustEnv('SUPABASE_SERVICE_ROLE_KEY');

// 文字列/配列ゆらぎを配列に正規化
function normArr(v: unknown): string[] {
  if (Array.isArray(v))
    return v
      .map(String)
      .map((s) => s.trim())
      .filter(Boolean);
  if (typeof v === 'string') {
    return v
      .split(/[、,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

// 空文字は null に、文字列は trim
function normStrOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return v == null ? null : String(v);
  const s = v.trim();
  return s === '' ? null : s;
}

export async function POST(req: NextRequest) {
  try {
    // ---- Auth ----
    const authz = req.headers.get('authorization') || '';
    const token = authz.toLowerCase().startsWith('bearer ') ? authz.slice(7).trim() : null;
    if (!token) return NextResponse.json({ error: 'missing token' }, { status: 401 });

    const decoded = await adminAuth.verifyIdToken(token).catch(() => null);
    if (!decoded?.uid) return NextResponse.json({ error: 'invalid token' }, { status: 401 });

    // ---- Supabase (Service Role) ----
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // ---- user_code の特定（usersは「参照のみ」。更新はしない）----
    let user_code: string | null = null;

    // a) firebase_uid で検索
    {
      const { data, error } = await supabase
        .from('users')
        .select('user_code')
        .eq('firebase_uid', decoded.uid)
        .maybeSingle();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      if (data?.user_code) user_code = data.user_code;
    }

    // b) email fallback（参照のみ／firebase_uidの埋めは削除）
    if (!user_code && decoded.email) {
      const { data, error } = await supabase
        .from('users')
        .select('user_code')
        .eq('click_email', decoded.email)
        .maybeSingle();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      if (data?.user_code) user_code = data.user_code;
    }

    if (!user_code) {
      return NextResponse.json({ error: 'user_code not found' }, { status: 404 });
    }

    // ---- Body ----
    const body = await req.json().catch(() => ({}) as any);

    // ==========================================
    // profiles 側：プロフィール項目だけ保存（users は触らない）
    // ==========================================
    const profilesPatch: Record<string, any> = {};
    const profKeys = [
      'bio',
      'birthday',
      'prefecture',
      'city',
      'x_handle',
      'instagram',
      'facebook',
      'linkedin',
      'youtube',
      'website_url',
      'visibility',
      'profile_link',
      'headline',
      'mission',
      'looking_for',
      'organization',
      'position',
      'avatar_url',
      'interests',
      'skills',
      'activity_area',
      'languages',
      'name', // ← ニックネームは profiles.name に保存（DBトリガで users.click_username に同期）
    ] as const;

    for (const k of profKeys) {
      if (!Object.prototype.hasOwnProperty.call(body, k)) continue;

      if (['interests', 'skills', 'activity_area', 'languages'].includes(k)) {
        profilesPatch[k] = normArr(body[k]);
      } else if (k === 'birthday') {
        profilesPatch[k] = body[k] ? String(body[k]) : null; // YYYY-MM-DD or null
      } else {
        profilesPatch[k] = normStrOrNull(body[k]);
      }
    }

    // 互換：古いフロントから click_username が来たら name に詰め替える
    if (Object.prototype.hasOwnProperty.call(body, 'click_username') && !profilesPatch.name) {
      profilesPatch.name = normStrOrNull(body.click_username);
    }

    if (Object.keys(profilesPatch).length) {
      const row = { user_code, ...profilesPatch };
      const { error } = await supabase.from('profiles').upsert(row, { onConflict: 'user_code' });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // NOTE: users テーブルの更新はしない（同期はDBトリガに任せる）

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'unknown' }, { status: 500 });
  }
}
