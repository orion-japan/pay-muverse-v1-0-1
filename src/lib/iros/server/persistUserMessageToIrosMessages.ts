// src/lib/iros/server/persistUserMessageToIrosMessages.ts
import type { SupabaseClient } from '@supabase/supabase-js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function persistUserMessageToIrosMessages(args: {
  supabase: SupabaseClient;
  conversationId: string; // ✅ ここは内部uuid（route.ts で解決済み）
  userCode: string;
  content: string;
  meta?: any;
}) {
  const supabase = args.supabase;
  const conversationUuid = String(args.conversationId ?? '').trim();
  const userCode = String(args.userCode ?? '').trim();
  const content = String(args.content ?? '').trimEnd();
  const meta = args.meta ?? null;

  if (!conversationUuid || !userCode) {
    return { ok: false, inserted: false, reason: 'BAD_ARGS' as const };
  }
  if (!UUID_RE.test(conversationUuid)) {
    // route.ts が internal uuid を渡す契約。ここで崩れてたら呼び元が悪い。
    return { ok: false, inserted: false, reason: 'BAD_CONV_UUID' as const };
  }

  // “…”だけ・空は保存しない
  const isEllipsisOnly = (s: string) => {
    const t = String(s ?? '').replace(/\s+/g, '').trim();
    if (!t) return true;
    return /^[\u2026\u22ef\u2025\.\u30fb]+$/.test(t);
  };
  if (isEllipsisOnly(content)) {
    return { ok: true, inserted: false, reason: 'EMPTY_CONTENT' as const };
  }

  // 直近重複ガード（同一convで同一textが連続するのを防ぐ）
  {
    const { data: lastRow, error: lastErr } = await supabase
      .from('iros_messages')
      .select('id,text')
      .eq('conversation_id', conversationUuid)
      .eq('role', 'user')
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!lastErr && lastRow?.text != null && String(lastRow.text) === content) {
      return { ok: true, inserted: false, reason: 'DUPLICATE_SKIP' as const };
    }
  }

  const row = {
    conversation_id: conversationUuid,
    role: 'user',
    content,
    text: content,
    meta,
    user_code: userCode,

    // user投稿では未確定でOK（列が NOT NULL なら null を消して）
    q_code: null,
    depth_stage: null,
  } as const;

  const { error } = await supabase.from('iros_messages').insert([row]);

  if (error) {
    console.error('[IROS/persistUserMessageToIrosMessages] insert error', {
      conversationUuid,
      userCode,
      code: (error as any)?.code ?? null,
      message: (error as any)?.message ?? null,
    });
    return { ok: false, inserted: false, reason: 'DB_ERROR' as const, error };
  }

  return { ok: true, inserted: true, reason: '' as const };
}
