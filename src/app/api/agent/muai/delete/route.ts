export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

function json(data: any, init?: number | ResponseInit) {
  const status = typeof init === 'number' ? init : (init as ResponseInit | undefined)?.['status'] ?? 200;
  const headers = new Headers(typeof init === 'number' ? undefined : (init as ResponseInit | undefined)?.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new NextResponse(JSON.stringify(data), { status, headers });
}

type Body = { conversation_id?: string };

export async function DELETE(req: NextRequest) {
  try {
    const auth = await verifyFirebaseAndAuthorize(req);
    if (!auth?.ok) return json({ ok: false, error: 'unauthorized' }, 401);
    const user_code = (auth as any).userCode ?? (auth as any).user_code ?? null;
    if (!user_code) return json({ ok: false, error: 'no_user_code' }, 401);

    // body or query どちらでも受けられるように
    const body = (await req.json().catch(() => ({}))) as Body;
    const url = new URL(req.url);
    const id = body.conversation_id ?? url.searchParams.get('conversation_id') ?? undefined;
    if (!id) return json({ ok: false, error: 'bad_request' }, 400);

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

    // ここもスキーマに合わせて削除 or 論理削除
    const { error } = await supabase
      .from('conversations')
      .delete()
      .eq('id', id)
      .eq('user_code', user_code);

    if (error) {
      console.error('[mu/delete] delete error:', error);
      return json({ ok: false, error: 'delete_failed' }, 500);
    }

    return json({ ok: true, id });
  } catch (e: any) {
    console.error('[mu/delete] error', e);
    return json({ ok: false, error: 'internal_error', detail: String(e?.message || e) }, 500);
  }
}

// 互換: POST でも受ける（クライアントが POST を投げている場合用）
export const POST = DELETE;
