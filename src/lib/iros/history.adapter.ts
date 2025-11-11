// src/lib/iros/history.adapter.ts
// Iros — history I/O adapter（DB）
// - loadHistoryDB(conversationId, limit)
// - saveMessagesDB({ conversationId, userText, assistantText, mode, meta })
//
// 依存：adminClient()（service-role Supabase クライアント）

import { adminClient } from '@/lib/credits/db';

type Role = 'user' | 'assistant';

export async function loadHistoryDB(
  conversationId: string,
  limit = 10,
): Promise<Array<{ role: Role; text: string }>> {
  const cid = String(conversationId ?? '').trim();
  if (!cid) return [];

  const supa = adminClient();
  const { data, error } = await supa
    .from('iros_messages')
    .select('role, text, content')
    .eq('conversation_id', cid)
    .in('role', ['user', 'assistant'])
    .order('created_at', { ascending: true })
    .limit(Math.max(1, Math.min(50, limit)));

  if (error) {
    console.warn('[history.adapter] loadHistoryDB error', error);
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
  conversationId: string;
  userText: string;
  assistantText: string;
  mode?: string;
  meta?: any;
}): Promise<number> {
  const cid = String(args?.conversationId ?? '').trim();
  const userText = String(args?.userText ?? '').trim();
  const assistantText = String(args?.assistantText ?? '').trim();
  const mode = String(args?.mode ?? 'diagnosis');

  if (!cid || !userText || !assistantText) return 0;

  const supa = adminClient();
  const nowIso = new Date().toISOString();
  const nowTs = Date.now();

  const metaAssistant = args?.meta ?? {
    q: null,
    phase: null,
    depth: null,
    confidence: null,
    mode,
  };

  const { error } = await supa.from('iros_messages').insert([
    {
      conversation_id: cid,
      role: 'user',
      text: userText,
      content: userText,
      meta: null,
      created_at: nowIso,
      ts: nowTs,
    },
    {
      conversation_id: cid,
      role: 'assistant',
      text: assistantText,
      content: assistantText,
      meta: metaAssistant,
      created_at: nowIso,
      ts: nowTs,
    },
  ]);

  if (error) {
    console.warn('[history.adapter] saveMessagesDB error', error);
    return 0;
  }

  // トリガで iros_conversations.updated_at が自動更新される想定
  return 2;
}

export default { loadHistoryDB, saveMessagesDB };
