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
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof v === 'string')
    return v
      .split(/[、,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
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
    const token = authz.toLowerCase().startsWith('bearer ')
      ? authz.slice(7).trim()
      : null;
    if (!token) return NextResponse.json({ error: 'missing token' }, { status: 401 });

    const decoded = await adminAuth.verifyIdToken(token).catch(() => null);
    if (!decoded?.uid) return NextResponse.json({ error: 'invalid token' }, { status: 401 });

    // ---- Supabase(Admin) ----
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // ---- Resolve user_code (firebase_uid -> click_email) ----
    let user_code: string | null = null;

    // a) firebase_uid
    {
      const { data, error } = await supabase
        .from('users')
        .select('user_code')
        .eq('firebase_uid', decoded.uid)
        .maybeSingle();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      if (data?.user_code) user_code = data.user_code;
    }

    // b) email fallback
    if (!user_code && decoded.email) {
      const { data, error } = await supabase
        .from('users')
        .select('user_code')
        .eq('click_email', decoded.email)
        .maybeSingle();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      if (data?.user_code) {
        user_code = data.user_code;
        // 移行：firebase_uid を埋める
        await supabase.from('users').update({ firebase_uid: decoded.uid }).eq('user_code', user_code);
      }
    }

    if (!user_code) {
      return NextResponse.json({ error: 'user_code not found' }, { status: 404 });
    }

    // ---- Body ----
    const body = await req.json().catch(() => ({} as any));

    // ==========================================
    // users 側：編集可能なフィールドだけ
    // （Rcode/REcode/その他コードはここでは更新しない）
    // ==========================================
    const usersPatch: Record<string, any> = {};

    // click_email は NOT NULL 想定なので空は送らない
    if (Object.prototype.hasOwnProperty.call(body, 'click_email')) {
      const ce = typeof body.click_email === 'string' ? body.click_email.trim() : body.click_email;
      if (ce) usersPatch.click_email = ce;
    }

    // 表示名（ニックネーム）/電話番号は任意
    for (const k of ['click_username', 'phone_number'] as const) {
      if (Object.prototype.hasOwnProperty.call(body, k)) {
        usersPatch[k] = normStrOrNull(body[k]);
      }
    }

    if (Object.keys(usersPatch).length) {
      const { error } = await supabase.from('users').update(usersPatch).eq('user_code', user_code);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // ==========================================
    // profiles 側：プロフィール項目を upsert（無ければ作成）
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
      'name', // プロフィール側に残っている場合の互換（優先は click_username）
    ] as const;

    for (const k of profKeys) {
      if (!Object.prototype.hasOwnProperty.call(body, k)) continue;

      if (['interests', 'skills', 'activity_area', 'languages'].includes(k)) {
        profilesPatch[k] = normArr(body[k]);
      } else if (k === 'birthday') {
        // YYYY-MM-DD 文字列 or null を許容
        const v = body[k];
        profilesPatch[k] = v ? String(v) : null;
      } else {
        profilesPatch[k] = normStrOrNull(body[k]);
      }
    }

    if (Object.keys(profilesPatch).length) {
      // user_code を必ず含めて upsert
      const row = { user_code, ...profilesPatch };
      const { error } = await supabase
        .from('profiles')
        .upsert(row, { onConflict: 'user_code' });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'unknown' }, { status: 500 });
  }
}
