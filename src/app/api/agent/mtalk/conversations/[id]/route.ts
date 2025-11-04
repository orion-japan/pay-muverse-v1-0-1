// src/app/api/agent/mtalk/conversations/[id]/route.ts
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

/** 内部ユーティリティ：対象の種別を判定（'conversations' | 'mirra' | 'none'） */
async function detectKind(
  supabase: any,
  conversation_id: string,
): Promise<'conversations' | 'mirra' | 'none'> {
  // 1) 標準 conversations
  {
    const { data, error } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', conversation_id)
      .maybeSingle();
    if (!error && data?.id) return 'conversations';
  }
  // 2) mirra セッション
  {
    const { data, error } = await supabase
      .from('mtalk_sessions')
      .select('id')
      .eq('id', conversation_id)
      .maybeSingle();
    if (!error && data?.id) return 'mirra';
  }
  return 'none';
}

/** 所有者チェック：conversations or mtalk_sessions の user_code が一致するか */
async function assertOwned(
  supabase: any,
  conversation_id: string,
  user_code: string,
): Promise<void> {
  // conversations を見る
  {
    const { data, error } = await supabase
      .from('conversations')
      .select('id, user_code')
      .eq('id', conversation_id)
      .maybeSingle();

    if (error) throw error;
    if (data) {
      if (data.user_code !== user_code) throw new Error('forbidden');
      return;
    }
  }
  // 無ければ mirra セッションを確認
  {
    const { data, error } = await supabase
      .from('mtalk_sessions')
      .select('id, user_code')
      .eq('id', conversation_id)
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new Error('not_found');
    if (data.user_code !== user_code) throw new Error('forbidden');
  }
}

/** PATCH: タイトル変更 */
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }, // ← Promise に変更（元の構造を維持）
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

    // 所有確認（conversations か mirra かはここでは不問）
    await assertOwned(supabase, id, user_code);

    // どちらのテーブルか判定
    const kind = await detectKind(supabase, id);

    if (kind === 'conversations') {
      // 従来どおり conversations を更新
      const { data, error } = await supabase
        .from('conversations')
        .update({ title })
        .eq('id', id)
        .select('id, title, updated_at')
        .single();
      if (error) throw error;
      return json({ ok: true, conversation: data });
    }

    if (kind === 'mirra') {
      // mirra の場合はオーバーライド表に upsert（タイトル上書き）
      const { error } = await supabase
        .from('mtalk_overrides')
        .upsert({
          session_id: id,
          user_code,
          title,
          archived: false,
          updated_at: new Date().toISOString(),
        })
        .eq('session_id', id);
      if (error) throw error;

      // レスポンスの形は会話更新と似せる
      return json({
        ok: true,
        conversation: { id, title, updated_at: new Date().toISOString() },
      });
    }

    // ここに来るなら対象なし
    return json({ ok: false, error: 'not_found' }, 404);
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (msg === 'not_found') return json({ ok: false, error: 'not_found' }, 404);
    if (msg === 'forbidden') return json({ ok: false, error: 'forbidden' }, 403);
    console.error('[mtalk/conversations PATCH] error', err);
    return json({ ok: false, error: 'internal_error', detail: msg }, 500);
  }
}

/** DELETE: 会話削除（conversations はハード、mirra は論理削除） */
export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }, // ← Promise に変更（元の構造を維持）
) {
  try {
    const auth = await verifyFirebaseAndAuthorize(req);
    if (!auth?.ok) return json({ ok: false, error: 'unauthorized' }, 401);
    const user_code = (auth as any).userCode ?? (auth as any).user_code;
    if (!user_code) return json({ ok: false, error: 'no_user_code' }, 401);

    const { id } = await ctx.params; // ← await で取り出す
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

    await assertOwned(supabase, id, user_code);

    const kind = await detectKind(supabase, id);

    if (kind === 'conversations') {
      // 従来どおり物理削除（関連テーブルはFKのON DELETE CASCADE前提）
      const { error } = await supabase.from('conversations').delete().eq('id', id);
      if (error) throw error;
      return json({ ok: true });
    }

    if (kind === 'mirra') {
      // mirra はアーカイブ（非表示）にする
      const { error } = await supabase
        .from('mtalk_overrides')
        .upsert({
          session_id: id,
          user_code,
          archived: true,
          updated_at: new Date().toISOString(),
        })
        .eq('session_id', id);
      if (error) throw error;
      return json({ ok: true });
    }

    return json({ ok: false, error: 'not_found' }, 404);
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (msg === 'not_found') return json({ ok: false, error: 'not_found' }, 404);
    if (msg === 'forbidden') return json({ ok: false, error: 'forbidden' }, 403);
    console.error('[mtalk/conversations DELETE] error', err);
    return json({ ok: false, error: 'internal_error', detail: msg }, 500);
  }
}
