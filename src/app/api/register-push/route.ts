// /src/app/api/register-push/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---- Env 読み込み（ズレ吸収 & ログはマスク）
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY; // ← 両対応
const DEBUG = process.env.DEBUG_PUSH_API === '1';

const mask = (v?: string | null) =>
  !v ? 'undefined' : `${v.slice(0, 4)}…(len:${v.length})`;
const dbg = (...a: any[]) => DEBUG && console.log('[register-push]', ...a);

function getSbAdmin() {
  if (!SUPABASE_URL) throw new Error('env:NEXT_PUBLIC_SUPABASE_URL missing');
  if (!SERVICE_ROLE) throw new Error('env:SUPABASE_SERVICE_ROLE missing');
  return createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false },
  });
}

type Body = {
  user_code?: string;
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
};

function safeJsonParse(text: string): { ok: true; value: any } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

export async function POST(req: NextRequest) {
  try {
    dbg('env', {
      url: SUPABASE_URL ? 'set' : 'undefined',
      sr: mask(SERVICE_ROLE || null),
    });

    // ★ まず text で読む（空body / 壊れたJSON を安全に弾く）
    const raw = await req.text();
    if (!raw || !raw.trim()) {
      dbg('empty body');
      return NextResponse.json(
        { ok: false, error: 'empty body' },
        { status: 400 },
      );
    }

    const parsed = safeJsonParse(raw);
    if (!parsed.ok) {
      console.error('[register-push] invalid json:', parsed.error);
      return NextResponse.json(
        { ok: false, error: 'invalid json', detail: parsed.error },
        { status: 400 },
      );
    }

    const { user_code, endpoint, keys } = (parsed.value ?? {}) as Body;

    dbg('inbound', {
      user_code,
      endpointLen: endpoint?.length,
      hasKeys: !!keys?.p256dh && !!keys?.auth,
    });

    if (!user_code || !endpoint || !keys?.p256dh || !keys?.auth) {
      return NextResponse.json(
        { ok: false, error: 'missing fields', got: { user_code, endpoint, hasKeys: !!keys } },
        { status: 400 },
      );
    }

    const supabase = getSbAdmin();

    const { data, error } = await supabase
      .from('push_subscriptions')
      .upsert(
        {
          user_code: String(user_code),
          endpoint: String(endpoint),
          p256dh: String(keys.p256dh),
          auth: String(keys.auth),
        },
        { onConflict: 'endpoint' }, // endpoint UNIQUE を想定
      )
      .select('endpoint,user_code')
      .single();

    if (error) {
      console.error('[register-push] upsert error:', error);
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    dbg('saved', data);
    return NextResponse.json({ ok: true, saved: data }, { status: 200 });
  } catch (err: any) {
    console.error('[register-push] fatal:', err);
    const msg = String(err?.message ?? err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
