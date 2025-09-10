export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  verifyFirebaseAndAuthorize,
  SUPABASE_URL,
  SERVICE_ROLE,
} from '@/lib/authz';

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
 * 履歴一覧
 * GET /api/talk/history?agent=mirra|iros
 *
 * 返却:
 * { ok:true, items:[{ conversation_id, title, updated_at }] }
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await verifyFirebaseAndAuthorize(req);
    if (!auth?.ok) return json({ ok: false, error: 'unauthorized' }, 401);

    const user_code =
      (auth as any).userCode ?? (auth as any).user_code ?? (auth as any).uid ?? null;
    if (!user_code) return json({ ok: false, error: 'no_user_code' }, 401);

    const url = new URL(req.url);
    const agentParam = (url.searchParams.get('agent') ?? 'mirra').toLowerCase();
    const agent = agentParam === 'iros' ? 'iros' : 'mirra';

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

    // mtalk_reports から自分の会話IDを抽出
    // 必要列: conversation_id(uuid), input_text(text), created_at(timestamptz), agent(text), user_code(text)
    const { data, error } = await supabase
      .from('mtalk_reports')
      .select('conversation_id, input_text, created_at')
      .eq('user_code', user_code)
      .eq('agent', agent)
      .not('conversation_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(30);

    if (error) {
      console.error('[talk/history] select error', error);
      return json({ ok: false, error: 'internal_error' }, 500);
    }

    // 同じ conversation_id の重複を潰して一覧に
    const seen = new Set<string>();
    const items = [];
    for (const r of data ?? []) {
      const cid = String(r.conversation_id);
      if (!cid || seen.has(cid)) continue;
      seen.add(cid);
      const title =
        (r.input_text ?? '')
          .split('\n')[0]
          .slice(0, 48) || `${agent} 会話`;
      items.push({
        conversation_id: cid,
        title,
        updated_at: r.created_at,
      });
      if (items.length >= 20) break;
    }

    return json({ ok: true, items });
  } catch (e: any) {
    console.error('[talk/history] fatal', e);
    return json({ ok: false, error: 'internal_error' }, 500);
  }
}
