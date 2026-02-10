// src/lib/iros/server/ensureIrosConversationUuid.ts
// iros — ensure iros_conversations row exists and return its uuid id
//
// 外部の conversationId(string) はそのまま維持しつつ、DBの iros_messages.conversation_id(uuid)
// に入れるための “内部uuid” を確保する。
// - iros_conversations.conversation_key に外部キーを保存
// - DB側には (user_code, conversation_key) の UNIQUE がある（ただし conversation_key IS NOT NULL の部分ユニーク）
//   → upsert の onConflict 指定では拾えないため、insert→reselect の2段で実装する
//
// NOTE:
// - user_key は NOT NULL & defaultなし → user_code と同値で必ず入れる
// - id は gen_random_uuid() default → insertで省略可能

import type { SupabaseClient } from '@supabase/supabase-js';

export async function ensureIrosConversationUuid(params: {
  supabase: SupabaseClient;
  userCode: string;
  conversationKey: string; // 外部の conversationId(string)
  agent?: string | null;
}): Promise<string> {
  const { supabase } = params;
  const userCode = String(params.userCode ?? '').trim();
  const conversationKey = String(params.conversationKey ?? '').trim();
  const agent = params.agent ?? null;

  if (!userCode) throw new Error('[ensureIrosConversationUuid] missing userCode');
  if (!conversationKey) throw new Error('[ensureIrosConversationUuid] missing conversationKey');

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

  // 2) 無ければ insert を試す
  //    - DBには部分ユニーク (user_code, conversation_key) WHERE conversation_key IS NOT NULL がある想定
  //    - ここで競合した場合は「誰かが先に作った」なので、握りつぶして reselect へ
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
      // 競合（unique violation）やRLS等の可能性があるので、ここでは落とさず reselect に回す
      console.warn('[ensureIrosConversationUuid] insert failed, will reselect', {
        userCode,
        conversationKey,
        code: (insErr as any)?.code ?? null,
        message: (insErr as any)?.message ?? null,
      });
    }
  }

  // 3) 再取得（ここで拾えなければ本当におかしい）
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
