// src/app/api/thread/comment/[comment_id]/route.ts
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

export async function DELETE(
  req: NextRequest,
  // ✅ params を Promise として受ける
  context: { params: Promise<{ comment_id: string }> }
) {
  try {
    // まず await で取り出す
    const { comment_id } = await context.params;

    // 1) 認証
    const auth = await verifyFirebaseAndAuthorize(req);
    const user_code = auth.userCode;
    if (!user_code) return json({ ok: false, error: 'unauthorized' }, 401);

    // 2) Supabase (service role)
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    // 3) 対象コメント取得（所有者確認）
    const { data: cmt, error: getErr } = await supabase
      .from('comments')
      .select('comment_id, user_code, post_id, is_deleted')
      .eq('comment_id', comment_id)
      .single();

    if (getErr?.code === 'PGRST116') return json({ ok: false, error: 'not_found' }, 404);
    if (getErr) return json({ ok: false, error: getErr.message }, 500);
    if (!cmt) return json({ ok: false, error: 'not_found' }, 404);

    if (cmt.user_code !== user_code) return json({ ok: false, error: 'forbidden' }, 403);
    if (cmt.is_deleted) return json({ ok: true, already: true }, 200);

    // 4) ソフトデリート & posts.comments_count の調整
    const { error: upErr } = await supabase.rpc('soft_delete_comment_and_decrement', {
      p_comment_id: comment_id,
    });
    if (upErr) return json({ ok: false, error: upErr.message }, 500);

    return json({ ok: true });
  } catch (e: any) {
    return json({ ok: false, error: e?.message ?? 'internal_error' }, 500);
  }
}
