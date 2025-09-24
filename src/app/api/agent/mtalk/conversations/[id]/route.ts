// src/app/api/agent/mtalk/conversations/[id]/route.ts
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

/** 所有者チェック：conversations.user_code が一致するか */
async function assertOwned(
  supabase: any,
  conversation_id: string,
  user_code: string,
): Promise<void> {
  const { data, error } = await supabase
    .from('conversations')
    .select('id, user_code')
    .eq('id', conversation_id)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error('not_found');
  if (data.user_code !== user_code) throw new Error('forbidden');
}

/** PATCH: タイトル変更 */
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> } // ← Promise に変更
) {
  try {
    const auth = await verifyFirebaseAndAuthorize(req);
    if (!auth?.ok) return json({ ok: false, error: 'unauthorized' }, 401);
    const user_code = (auth as any).userCode ?? (auth as any).user_code;
    if (!user_code) return json({ ok: false, error: 'no_user_code' }, 401);

    const { id } = await ctx.params; // ← await で取り出す
    const body = await req.json().catch(() => ({}));
    const title = String(body?.title ?? '').trim();
    if (!title) return json({ ok: false, error: 'title_required' }, 400);

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
    await assertOwned(supabase, id, user_code);

    const { data, error } = await supabase
      .from('conversations')
      .update({ title })
      .eq('id', id)
      .select('id, title, updated_at')
      .single();

    if (error) throw error;

    return json({ ok: true, conversation: data });
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (msg === 'not_found') return json({ ok: false, error: 'not_found' }, 404);
    if (msg === 'forbidden') return json({ ok: false, error: 'forbidden' }, 403);
    console.error('[mtalk/conversations PATCH] error', err);
    return json({ ok: false, error: 'internal_error', detail: msg }, 500);
  }
}

/** DELETE: 会話削除（ハード削除。必要ならソフト削除に変更可） */
export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> } // ← Promise に変更
) {
  try {
    const auth = await verifyFirebaseAndAuthorize(req);
    if (!auth?.ok) return json({ ok: false, error: 'unauthorized' }, 401);
    const user_code = (auth as any).userCode ?? (auth as any).user_code;
    if (!user_code) return json({ ok: false, error: 'no_user_code' }, 401);

    const { id } = await ctx.params; // ← await で取り出す
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
    await assertOwned(supabase, id, user_code);

    // 付随テーブルの扱いはスキーマに合わせて必要なら先に削除
    // 例: talk_messages / messages など会話に紐づく行がある場合は FK の ON DELETE CASCADE 推奨
    const { error } = await supabase.from('conversations').delete().eq('id', id);
    if (error) throw error;

    return json({ ok: true });
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (msg === 'not_found') return json({ ok: false, error: 'not_found' }, 404);
    if (msg === 'forbidden') return json({ ok: false, error: 'forbidden' }, 403);
    console.error('[mtalk/conversations DELETE] error', err);
    return json({ ok: false, error: 'internal_error', detail: msg }, 500);
  }
}
