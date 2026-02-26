// src/lib/iros/history.adapter.ts
// Iros — history I/O adapter（DB）
//
// ✅ 重要：iros_messages.conversation_id は uuid
// - 外部から渡ってくる conversationId（文字列キー）を、そのまま conversation_id に使うと 22P02 になる
// - 必ず ensureIrosConversationUuid で uuid に正規化してから使う
//
// - loadHistoryDB({ userCode, conversationId, limit })
// - saveMessagesDB({ userCode, conversationId, userText, assistantText, mode, meta })
//
// 依存：adminClient()（service-role Supabase クライアント）

import { adminClient } from '@/lib/credits/db';
import { ensureIrosConversationUuid } from '@/lib/iros/server/ensureIrosConversationUuid';

type Role = 'user' | 'assistant';

function isUuidLike(v: string): boolean {
  // 8-4-4-4-12
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

async function resolveConversationUuid(args: {
  supabase: ReturnType<typeof adminClient>;
  userCode: string;
  conversationId: string;
}): Promise<string> {
  const cid = String(args.conversationId ?? '').trim();
  if (!cid) throw new Error('[history.adapter] empty conversationId');

  // すでに uuid ならそのまま
  if (isUuidLike(cid)) return cid;

  // uuid でなければ、conversation_key として扱って uuid を確定
  const conversationUuid = await ensureIrosConversationUuid({
    supabase: args.supabase as any,
    userCode: String(args.userCode ?? '').trim(),
    conversationKey: cid,
    agent: null,
  });

  return String(conversationUuid);
}

export async function loadHistoryDB(
  args: {
    userCode: string;
    conversationId: string;
    limit?: number;
  },
): Promise<Array<{ role: Role; text: string }>> {
  const userCode = String(args?.userCode ?? '').trim();
  const conversationId = String(args?.conversationId ?? '').trim();
  const limit = typeof args?.limit === 'number' ? args.limit : 10;

  if (!userCode || !conversationId) return [];

  const supa = adminClient();

  let conversationUuid: string;
  try {
    conversationUuid = await resolveConversationUuid({ supabase: supa, userCode, conversationId });
  } catch (e) {
    console.warn('[history.adapter] loadHistoryDB resolveConversationUuid failed', {
      userCode,
      conversationId,
      error: e,
    });
    return [];
  }

  const { data, error } = await supa
    .from('iros_messages')
    .select('role, text, content')
    .eq('conversation_id', conversationUuid)
    .in('role', ['user', 'assistant'])
    .order('created_at', { ascending: true })
    .limit(Math.max(1, Math.min(50, limit)));

  if (error) {
    console.warn('[history.adapter] loadHistoryDB error', {
      userCode,
      conversationId,
      conversationUuid,
      error,
    });
    return [];
  }

  const rows = Array.isArray(data) ? data : [];
  return rows
    .map((r: any) => {
      const role = (r?.role === 'assistant' ? 'assistant' : 'user') as Role;
      const text = String(r?.text ?? r?.content ?? '').trim();
      return { role, text };
    })
    .filter((r) => r.text.length > 0);
}

export async function saveMessagesDB(args: {
  userCode: string;
  conversationId: string;
  userText: string;
  assistantText: string;
  mode?: string;
  meta?: any;
}): Promise<number> {
  const userCode = String(args?.userCode ?? '').trim();
  const conversationId = String(args?.conversationId ?? '').trim();
  const userText = String(args?.userText ?? '').trim();
  const assistantText = String(args?.assistantText ?? '').trim();
  const mode = String(args?.mode ?? 'diagnosis');

  if (!userCode || !conversationId || !userText || !assistantText) return 0;

  const supa = adminClient();

  let conversationUuid: string;
  try {
    conversationUuid = await resolveConversationUuid({ supabase: supa, userCode, conversationId });
  } catch (e) {
    console.warn('[history.adapter] saveMessagesDB resolveConversationUuid failed', {
      userCode,
      conversationId,
      error: e,
    });
    return 0;
  }

  const nowIso = new Date().toISOString();
  const nowTs = Date.now();

  const metaAssistant = args?.meta ?? {
    q: null,
    phase: null,
    depth: null,
    confidence: null,
    mode,
  };

  // ✅ traceId を「ここで」正規化（列 trace_id と meta.extra.traceId を同期）
  const traceIdForRow = (() => {
    const a = String((args as any)?.traceId ?? '').trim();
    if (a) return a;

    const m = (args as any)?.meta;
    if (m && typeof m === 'object') {
      const b = String((m as any)?.traceId ?? '').trim();
      if (b) return b;

      const ex = (m as any)?.extra;
      if (ex && typeof ex === 'object') {
        const c = String((ex as any)?.traceId ?? (ex as any)?.trace_id ?? '').trim();
        if (c) return c;
      }
    }
    return null;
  })();

  // ✅ user 側も meta.extra.traceId を持たせる（ops/iros-logs が meta から拾う経路とも整合）
  const metaUser = traceIdForRow ? { extra: { traceId: traceIdForRow }, mode } : { mode };

  const { error } = await supa.from('iros_messages').insert([
    {
      conversation_id: conversationUuid,
      role: 'user',
      user_code: userCode,
      text: userText,
      content: userText,
      meta: metaUser,
      trace_id: traceIdForRow,
      created_at: nowIso,
      ts: nowTs,
    },
    {
      conversation_id: conversationUuid,
      role: 'assistant',
      user_code: userCode,
      text: assistantText,
      content: assistantText,
      meta: metaAssistant,
      trace_id: traceIdForRow,
      created_at: nowIso,
      ts: nowTs,
    },
  ]);

  if (error) {
    console.warn('[history.adapter] saveMessagesDB error', {
      userCode,
      conversationId,
      conversationUuid,
      error,
    });
    return 0;
  }

  // トリガで iros_conversations.updated_at が自動更新される想定
  return 2;
}

export default { loadHistoryDB, saveMessagesDB };
