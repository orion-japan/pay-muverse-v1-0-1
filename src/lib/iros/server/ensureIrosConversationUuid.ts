// src/lib/iros/server/ensureIrosConversationUuid.ts
// iros — ensure iros_conversations row exists and return its uuid id
//
// ✅重要：conversationKey が uuid-looking の場合
// - “外部キー扱い”して増殖させない
// - 未存在なら insert は絶対にしない（route.ts と同じ方針で拒否）
//
// 非uuidの conversationKey の場合のみ
// (user_code, conversation_key) でマッピング行を確保する。

import type { SupabaseClient } from '@supabase/supabase-js';

function isUuidLike(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

export async function ensureIrosConversationUuid(params: {
  supabase: SupabaseClient;
  userCode: string;
  conversationKey: string; // 外部の conversationId(string)
  agent?: string | null;
}): Promise<string> {
  const supabase = params.supabase;
  const userCode = String(params.userCode ?? '').trim();
  const conversationKey = String(params.conversationKey ?? '').trim();
  const agent = params.agent ?? null;

  if (!userCode) throw new Error('[ensureIrosConversationUuid] missing userCode');
  if (!conversationKey) throw new Error('[ensureIrosConversationUuid] missing conversationKey');

  // ✅ 最重要：uuid-looking は “外部キー” として insert しない
  if (isUuidLike(conversationKey)) {
    const { data: hit, error: hitErr } = await supabase
      .from('iros_conversations')
      .select('id')
      .eq('id', conversationKey)
      .limit(1)
      .maybeSingle();

    if (hitErr) throw new Error(`[ensureIrosConversationUuid] uuid lookup failed: ${hitErr.message}`);
    if (!hit?.id) {
      throw new Error(
        '[ensureIrosConversationUuid] uuid-looking conversationKey not found (refuse to insert by uuid-looking key)',
      );
    }
    return String(hit.id);
  }

  // 1) まず取得（安い）
  {
    const { data, error } = await supabase
      .from('iros_conversations')
      .select('id')
      .eq('user_code', userCode)
      .eq('conversation_key', conversationKey)
      .limit(1)
      .maybeSingle();

    if (!error && data?.id) return String((data as any).id);
  }

  // 2) 無ければ insert を試す（競合は握りつぶして reselect）
  const nowIso = new Date().toISOString();
  const row: any = {
    user_code: userCode,
    user_key: userCode,
    conversation_key: conversationKey,
    updated_at: nowIso,
  };
  if (agent) row.agent = agent;

  {
    const { error: insErr } = await supabase.from('iros_conversations').insert([row]);
    if (insErr) {
      console.warn('[ensureIrosConversationUuid] insert failed, will reselect', {
        userCode,
        conversationKey,
        code: (insErr as any)?.code ?? null,
        message: (insErr as any)?.message ?? null,
      });
    }
  }

  // 3) 再取得
  {
    const { data: data2, error: err2 } = await supabase
      .from('iros_conversations')
      .select('id')
      .eq('user_code', userCode)
      .eq('conversation_key', conversationKey)
      .limit(1)
      .maybeSingle();

    if (err2) throw new Error(`[ensureIrosConversationUuid] reselect failed: ${err2.message}`);
    if (!data2?.id) throw new Error('[ensureIrosConversationUuid] id not found after insert/reselect');

    return String((data2 as any).id);
  }
}
