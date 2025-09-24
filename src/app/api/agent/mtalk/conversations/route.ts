// src/app/api/agent/mtalk/conversations/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

function json(data: any, init?: number | ResponseInit) {
  const status =
    typeof init === 'number' ? init : (init as ResponseInit | undefined)?.['status'] ?? 200;
  const headers = new Headers(
    typeof init === 'number' ? undefined : (init as ResponseInit | undefined)?.headers,
  );
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new NextResponse(JSON.stringify(data), { status, headers });
}

/**
 * mirra の会話一覧:
 * - mtalk_reports に紐づく conversation_id を会話リストとして返す
 * - conversations.title を優先（無ければ生成）
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await verifyFirebaseAndAuthorize(req);
    if (!auth?.ok) return json({ ok: false, error: 'unauthorized' }, 401);
    const user_code = (auth as any).userCode ?? (auth as any).user_code;
    if (!user_code) return json({ ok: false, error: 'no_user_code' }, 401);

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

    // reports 経由で conversation_id を集約し、conversations からタイトルを取得
    const { data: rows, error } = await supabase
      .from('mtalk_reports')
      .select('conversation_id, created_at')
      .eq('user_code', user_code)
      .not('conversation_id', 'is', null)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const ids = Array.from(
      new Set((rows ?? []).map((r: any) => String(r.conversation_id)).filter(Boolean)),
    );

    let items: Array<{ id: string; title: string | null; updated_at: string | null }> = [];
    if (ids.length) {
      const { data: convs, error: convErr } = await supabase
        .from('conversations')
        .select('id, title, updated_at')
        .in('id', ids);

      if (convErr) throw convErr;

      // id の順序は reports の新しい順に寄せる
      const order = new Map(ids.map((id, i) => [id, i]));
      items = (convs ?? [])
        .map((c: any) => ({
          id: c.id,
          title: c.title ?? null,
          updated_at: c.updated_at ?? null,
        }))
        .sort((a, b) => (order.get(a.id)! - order.get(b.id)!));
    }

    return json({ ok: true, items });
  } catch (err: any) {
    console.error('[mtalk/conversations GET] error', err);
    return json({ ok: false, error: 'internal_error', detail: String(err?.message || err) }, 500);
  }
}
