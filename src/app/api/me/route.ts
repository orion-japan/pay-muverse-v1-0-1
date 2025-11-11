// src/app/api/me/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

function json(data: any, init?: number | ResponseInit) {
  const status =
    typeof init === 'number' ? init : ((init as ResponseInit | undefined)?.['status'] ?? 200);
  const headers = new Headers(
    typeof init === 'number' ? undefined : (init as ResponseInit | undefined)?.headers,
  );
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new NextResponse(JSON.stringify(data), { status, headers });
}

const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

/** uid → user_code を多表走査で解決 */
async function uidToUserCode(uid: string): Promise<string | null> {
  type Row = { code_value?: string | number | null };
  const cands: Array<{ table: string; codeCol: string; uidCol: string }> = [
    { table: 'users', codeCol: 'user_code', uidCol: 'firebase_uid' },
    { table: 'users', codeCol: 'user_code', uidCol: 'uid' },
    { table: 'profiles', codeCol: 'user_code', uidCol: 'uid' },
    { table: 'public_users', codeCol: 'user_code', uidCol: 'uid' },
  ];

  for (const c of cands) {
    const { data, error } = await sb
      .from(c.table)
      .select(`${c.codeCol} as code_value`)
      .eq(c.uidCol, uid)
      .maybeSingle(); // generic を使わず any で受ける

    if (!error && data) {
      const row = data as unknown as Row;
      const v = row?.code_value;
      if (v !== undefined && v !== null && String(v).trim()) return String(v);
    }
  }
  return null;
}

/** user_code から表示用プロフィール情報を取得（profiles 優先 → users フォールバック） */
async function loadProfileSummary(user_code: string): Promise<{
  id: string;
  name: string;
  user_type: string;
  sofia_credit: number;
}> {
  type PRow = {
    user_code?: string | number | null;
    click_username?: string | null;
    click_type?: string | null;
    sofia_credit?: number | string | null;
    display_name?: string | null; // 予備
  };

  // 1) profiles を優先
  {
    const { data, error } = await sb
      .from('profiles')
      .select('user_code, click_username, click_type, sofia_credit, display_name')
      .eq('user_code', user_code)
      .maybeSingle();

    if (!error && data) {
      const row = (data ?? {}) as unknown as PRow;
      return {
        id: String(row?.user_code ?? user_code),
        name:
          (row?.click_username && row.click_username.trim()) ||
          (row?.display_name && row.display_name.trim()) ||
          'user',
        user_type: (row?.click_type && row.click_type.trim()) || 'member',
        sofia_credit: Number(row?.sofia_credit ?? 0),
      };
    }
  }

  // 2) users にフォールバック
  {
    const { data, error } = await sb
      .from('users')
      .select('user_code, click_username, click_type, sofia_credit')
      .eq('user_code', user_code)
      .maybeSingle();

    if (!error && data) {
      const row = (data ?? {}) as unknown as PRow;
      return {
        id: String(row?.user_code ?? user_code),
        name: (row?.click_username && row.click_username.trim()) || 'user',
        user_type: (row?.click_type && row.click_type.trim()) || 'member',
        sofia_credit: Number(row?.sofia_credit ?? 0),
      };
    }
  }

  // 見つからない場合の最低限
  return { id: String(user_code), name: 'user', user_type: 'member', sofia_credit: 0 };
}

/** GET /api/me */
export async function GET(req: NextRequest) {
  try {
    const auth = await verifyFirebaseAndAuthorize(req);
    if (!auth?.ok) return json({ ok: false, error: 'unauthorized' }, 401);

    // user_code を抽出 or uid→user_code 変換
    let user_code: string | null =
      (auth as any).userCode ?? (auth as any).user_code ?? null;

    if (!user_code) {
      const uid =
        (auth as any).uid ??
        (auth as any).firebase_uid ??
        (auth as any).userId ??
        (auth as any).user_id ??
        null;
      if (uid) user_code = await uidToUserCode(uid);
    }

    if (!user_code) return json({ ok: false, error: 'no_user_code' }, 401);

    const me = await loadProfileSummary(user_code);
    return json({ ok: true, me });
  } catch (e) {
    console.error('[me][GET] fatal', e);
    return json({ ok: false, error: 'internal_error' }, 500);
  }
}
