// src/app/api/notification-settings/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  verifyFirebaseAndAuthorize,
  normalizeAuthz,
  SUPABASE_URL,
  SERVICE_ROLE,
} from '@/lib/authz';

/* ---------- helpers ---------- */
function json(data: unknown, init?: number | ResponseInit) {
  const status =
    typeof init === 'number' ? init : ((init as ResponseInit | undefined)?.['status'] ?? 200);
  const headers = new Headers(
    typeof init === 'number' ? undefined : (init as ResponseInit | undefined)?.headers,
  );
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new NextResponse(JSON.stringify(data), { status, headers });
}

const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

/** UID → user_code（複数テーブルを順番に当てる） */
async function uidToUserCode(uid: string): Promise<string | null> {
  const candidates: Array<{ table: string; codeCol: string; uidCol: string }> = [
    { table: 'users', codeCol: 'user_code', uidCol: 'firebase_uid' },
    { table: 'users', codeCol: 'user_code', uidCol: 'uid' },
    { table: 'profiles', codeCol: 'user_code', uidCol: 'uid' },
    { table: 'public_users', codeCol: 'user_code', uidCol: 'uid' },
  ];

  for (const c of candidates) {
    const q = await sb
      .from(c.table)
      .select(c.codeCol)
      .eq(c.uidCol, uid)
      .maybeSingle(); // ← 型引数は付けない（v2 互換）

    if (!q.error && q.data && q.data[c.codeCol]) {
      return String(q.data[c.codeCol]);
    }
  }
  return null;
}

/* ========== GET: 現在の通知設定(consents)を取得 ========== */
export async function GET(req: NextRequest) {
  try {
    const authz = await verifyFirebaseAndAuthorize(req);
    if (!authz.ok) return json({ ok: false, error: authz.error ?? 'unauthorized' }, 401);

    // user_code を確定（authz優先、未知なら UID → user_code フォールバック）
    const { user } = normalizeAuthz(authz);
    let user_code = user?.user_code ?? null;

    if (!user_code && authz.uid) {
      user_code = await uidToUserCode(authz.uid);
    }
    if (!user_code) return json({ ok: false, error: 'no_user_code' }, 401);

    // profiles.consents を取得
    const { data, error } = await sb
      .from('profiles')
      .select('consents')
      .eq('user_code', user_code)
      .maybeSingle(); // ← 型引数を使わない

    if (error) {
      console.error('[notification-settings][GET] select error', error);
      return json({ ok: false, error: 'db_error' }, 500);
    }

    const consents =
      (data && typeof data.consents === 'object' && data.consents !== null ? data.consents : {}) as
        | Record<string, unknown>
        | undefined;

    return json({ ok: true, user_code, consents: consents ?? {} });
  } catch (e: any) {
    console.error('[notification-settings][GET] fatal', e?.message || e);
    return json({ ok: false, error: 'internal_error' }, 500);
  }
}

/* ========== PATCH: consents を部分更新（merge upsert） ==========
   body: { consents: Record<string, unknown> }
*/
export async function PATCH(req: NextRequest) {
  try {
    const authz = await verifyFirebaseAndAuthorize(req);
    if (!authz.ok) return json({ ok: false, error: authz.error ?? 'unauthorized' }, 401);

    const { user } = normalizeAuthz(authz);
    let user_code = user?.user_code ?? null;
    if (!user_code && authz.uid) user_code = await uidToUserCode(authz.uid);
    if (!user_code) return json({ ok: false, error: 'no_user_code' }, 401);

    const body = (await req.json().catch(() => ({}))) as {
      consents?: Record<string, unknown>;
    };
    if (!body?.consents || typeof body.consents !== 'object') {
      return json({ ok: false, error: 'invalid_body' }, 400);
    }

    // 現在の consents を取得
    const cur = await sb
      .from('profiles')
      .select('consents')
      .eq('user_code', user_code)
      .maybeSingle();

    if (cur.error) {
      console.error('[notification-settings][PATCH] read error', cur.error);
      return json({ ok: false, error: 'db_error' }, 500);
    }

    const current =
      cur.data && typeof cur.data.consents === 'object' && cur.data.consents !== null
        ? (cur.data.consents as Record<string, unknown>)
        : {};

    const nextConsents = { ...current, ...body.consents };

    // upsert
    const up = await sb
      .from('profiles')
      .upsert({ user_code, consents: nextConsents }, { onConflict: 'user_code' })
      .select('consents')
      .maybeSingle();

    if (up.error) {
      console.error('[notification-settings][PATCH] upsert error', up.error);
      return json({ ok: false, error: 'db_error' }, 500);
    }

    return json({ ok: true, user_code, consents: up.data?.consents ?? nextConsents });
  } catch (e: any) {
    console.error('[notification-settings][PATCH] fatal', e?.message || e);
    return json({ ok: false, error: 'internal_error' }, 500);
  }
}
