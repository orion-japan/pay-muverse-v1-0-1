// src/lib/iros/server/persistAssistantMessageToIrosMessages.ts
import type { SupabaseClient } from '@supabase/supabase-js';

export async function persistAssistantMessageToIrosMessages(args: {
  supabase: SupabaseClient;
  conversationId: string;
  userCode: string;
  content: string;
  meta: any; // ★ route.ts が組んだ meta を必須にする（single-writer保証鍵）
}) {
  const supabase = args.supabase;
  const conversationId = String(args.conversationId ?? '').trim();
  const userCode = String(args.userCode ?? '').trim();
  const content = String(args.content ?? '').trimEnd();
  const meta = args.meta ?? null;

  // =========================
  // ✅ single-writer guard
  // - route.ts からの呼び出しのみ許可
  // =========================
  const persistedByRoute =
    meta?.extra?.persistedByRoute === true &&
    meta?.extra?.persistAssistantMessage === false;

  if (!persistedByRoute) {
    console.error('[IROS/persistAssistantMessageToIrosMessages] BLOCKED (not route writer)', {
      conversationId,
      userCode,
      hasMeta: Boolean(meta),
      metaExtraKeys: meta?.extra ? Object.keys(meta.extra) : [],
    });

    return {
      ok: false,
      inserted: false,
      blocked: true,
      reason: 'SINGLE_WRITER_GUARD_BLOCKED',
    };
  }

  if (!conversationId || !userCode) {
    return { ok: false, inserted: false, blocked: false, reason: 'BAD_ARGS' };
  }

  // 空本文は保存しない（SILENCE等）
  if (!content || content.trim().length === 0) {
    return { ok: true, inserted: false, blocked: false, reason: 'EMPTY_CONTENT' };
  }

  const row = {
    conversation_id: conversationId,
    role: 'assistant',
    content: content,
    text: content,
    meta: meta,
    user_code: userCode, // ← もし列が無いならここは削除（あなたのschema次第）
  };

  const { error } = await supabase.from('iros_messages').insert([row]);
  if (error) {
    console.error('[IROS/persistAssistantMessageToIrosMessages] insert error', {
      conversationId,
      userCode,
      error,
    });
    return { ok: false, inserted: false, blocked: false, reason: 'DB_ERROR', error };
  }

  return { ok: true, inserted: true, blocked: false };
}
