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

type Body = { conversation_id?: string; title?: string };

export async function PATCH(req: NextRequest) {
  try {
    const auth = await verifyFirebaseAndAuthorize(req);
    if (!auth?.ok) return json({ ok: false, error: 'unauthorized' }, 401);
    const user_code = (auth as any).userCode ?? (auth as any).user_code ?? null;
    if (!user_code) return json({ ok: false, error: 'no_user_code' }, 401);

    const { conversation_id, title } = (await req.json().catch(() => ({}))) as Body;
    if (!conversation_id || !title?.trim()) return json({ ok: false, error: 'bad_request' }, 400);

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

    // ここはあなたのスキーマに合わせてください:
    // 例: conversations(id, user_code, title)
    const { error } = await supabase
      .from('conversations')
      .update({ title: title.trim() })
      .eq('id', conversation_id)
      .eq('user_code', user_code);

    if (error) {
      console.error('[mu/rename] update error:', error);
      return json({ ok: false, error: 'update_failed' }, 500);
    }

    return json({ ok: true, id: conversation_id, title: title.trim() });
  } catch (e: any) {
    console.error('[mu/rename] error', e);
    return json({ ok: false, error: 'internal_error', detail: String(e?.message || e) }, 500);
  }
}

// 互換: POST でも受ける（クライアントが POST を投げている場合用）
export const POST = PATCH;
