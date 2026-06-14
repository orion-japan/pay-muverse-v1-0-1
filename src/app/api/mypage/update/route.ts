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
const CALL_SUFFIX_VALUES = new Set(['san', 'chan', 'kun', 'sama', 'none', 'custom']);

function normArr(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map(String).map((s) => s.trim()).filter(Boolean);
  }
  if (typeof v === 'string') {
    return v.split(/[、,]+/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function normStrOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return v == null ? null : String(v);
  const s = v.trim();
  return s === '' ? null : s;
}

function normalizeCallSuffix(v: unknown): string {
  const raw = typeof v === 'string' ? v.trim() : '';
  return CALL_SUFFIX_VALUES.has(raw) ? raw : 'san';
}

export async function POST(req: NextRequest) {
  try {
    const authz = req.headers.get('authorization') || '';
    const token = authz.toLowerCase().startsWith('bearer ') ? authz.slice(7).trim() : null;
    if (!token) return NextResponse.json({ error: 'missing token' }, { status: 401 });

    const decoded = await adminAuth.verifyIdToken(token).catch(() => null);
    if (!decoded?.uid) return NextResponse.json({ error: 'invalid token' }, { status: 401 });

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    let user_code: string | null = null;

    {
      const { data, error } = await supabase
        .from('users')
        .select('user_code')
        .eq('firebase_uid', decoded.uid)
        .maybeSingle();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      if (data?.user_code) user_code = data.user_code;
    }

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

    const body = await req.json().catch(() => ({}) as any);
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
      'name',
    ] as const;

    for (const k of profKeys) {
      if (!Object.prototype.hasOwnProperty.call(body, k)) continue;
      if (['interests', 'skills', 'activity_area', 'languages'].includes(k)) {
        profilesPatch[k] = normArr(body[k]);
      } else if (k === 'birthday') {
        profilesPatch[k] = body[k] ? String(body[k]) : null;
      } else {
        profilesPatch[k] = normStrOrNull(body[k]);
      }
    }

    if (Object.prototype.hasOwnProperty.call(body, 'click_username') && !profilesPatch.name) {
      profilesPatch.name = normStrOrNull(body.click_username);
    }

    if (Object.keys(profilesPatch).length) {
      const row = { user_code, ...profilesPatch };
      const { error } = await supabase.from('profiles').upsert(row, { onConflict: 'user_code' });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const hasCallNamePayload =
      Object.prototype.hasOwnProperty.call(body, 'user_call_name') ||
      Object.prototype.hasOwnProperty.call(body, 'user_call_suffix') ||
      Object.prototype.hasOwnProperty.call(body, 'user_call_suffix_text') ||
      Object.prototype.hasOwnProperty.call(body, 'name') ||
      Object.prototype.hasOwnProperty.call(body, 'click_username');

    if (hasCallNamePayload) {
      const userCallName =
        normStrOrNull(body.user_call_name) ??
        normStrOrNull(profilesPatch.name) ??
        normStrOrNull(body.name) ??
        normStrOrNull(body.click_username);

      if (userCallName) {
        const userCallSuffix = normalizeCallSuffix(body.user_call_suffix);
        const userCallSuffixText =
          userCallSuffix === 'custom' ? normStrOrNull(body.user_call_suffix_text) : null;
        const now = new Date().toISOString();

        const { error: callNameErr } = await supabase.from('iros_user_profile').upsert(
          {
            user_code,
            user_call_name: userCallName,
            user_call_suffix: userCallSuffix,
            user_call_suffix_text: userCallSuffixText,
            updated_at: now,
          },
          { onConflict: 'user_code' },
        );

        if (callNameErr) {
          console.warn('[mypage/update] call-name upsert skipped:', callNameErr.message);
          const { error: fallbackErr } = await supabase.from('iros_user_profile').upsert(
            {
              user_code,
              user_call_name: userCallName,
              updated_at: now,
            },
            { onConflict: 'user_code' },
          );
          if (fallbackErr) {
            console.warn('[mypage/update] call-name fallback skipped:', fallbackErr.message);
          }
        }
      }
    }

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'unknown' }, { status: 500 });
  }
}
