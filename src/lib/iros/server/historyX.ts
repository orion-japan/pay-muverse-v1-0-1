// src/lib/iros/server/historyX.ts
// iros — Cross-conversation history utilities (HistoryX)
// - user_code ベースで直近の履歴を拾い、今会話の turnHistory とマージする
// - 目的：会話IDをまたいでも「直近の流れ」を薄く足す（会話の糊）

import type { SupabaseClient } from '@supabase/supabase-js';

export type HistoryXMsg = {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
};

type NormMsgRow = {
  id: string;
  conversation_id: string;
  role: string | null;
  content: string | null;
  created_at: string | null;
};

const normText = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();

const makeKey = (role: unknown, text: unknown) => {
  const r = String(role ?? '').toLowerCase();
  const t = normText(text);
  return `${r}::${t}`;
};

function isRoleUserOrAssistant(role: unknown): role is 'user' | 'assistant' {
  const r = String(role ?? '').toLowerCase();
  return r === 'user' || r === 'assistant';
}

/**
 * ✅ 会話IDを跨いだ「user_code の直近履歴」を取得（DBは desc → 返却は asc）
 */
export async function loadRecentHistoryAcrossConversations(params: {
  supabase: SupabaseClient;
  userCode: string;
  limit?: number;
  excludeConversationId?: string;
}): Promise<HistoryXMsg[]> {
  const { supabase, userCode, limit = 60, excludeConversationId } = params;

  const { data, error } = await supabase
    .from('iros_messages_normalized')
    .select('id, conversation_id, role, content, created_at')
    .eq('user_code', userCode)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.warn('[IROS][HistoryX] load error', { userCode, error });
    return [];
  }

  const rows = (data ?? []) as NormMsgRow[];

  const filtered = rows
    .filter((r) => {
      if (!isRoleUserOrAssistant(r.role)) return false;

      const content = normText(r.content);
      if (!content) return false;

      if (
        excludeConversationId &&
        String(r.conversation_id ?? '') === String(excludeConversationId)
      ) {
        return false;
      }
      return true;
    })
    // DBは desc なので昇順へ（会話として扱いやすい）
    .reverse();

  return filtered.map((r) => ({
    id: String(r.id ?? ''),
    conversation_id: String(r.conversation_id ?? ''),
    role: String(r.role ?? '').toLowerCase() as 'user' | 'assistant',
    content: String(r.content ?? ''),
    created_at: String(r.created_at ?? ''),
  }));
}

/**
 * ✅ dbHistory（跨ぎ） + turnHistory（今会話）を重複排除しながらマージ
 * - dbHistory を先に入れて、その後に turnHistory を追加
 * - 最後に maxTotal で後ろ（新しい方）を残す
 */
export function mergeHistoryForTurn(params: {
  dbHistory: HistoryXMsg[];
  turnHistory: any[];
  maxTotal?: number;
}): any[] {
  const { dbHistory, turnHistory, maxTotal = 80 } = params;

  const normTurn = Array.isArray(turnHistory) ? turnHistory : [];
  const seen = new Set<string>();
  const out: any[] = [];

  // 1) DB履歴（跨ぎ）を先に入れる
  for (const m of dbHistory ?? []) {
    const key = makeKey(m?.role, m?.content);
    if (!key.endsWith('::') && !seen.has(key)) {
      seen.add(key);
      out.push({
        id: m.id,
        conversation_id: m.conversation_id,
        role: m.role,
        content: m.content,
        created_at: m.created_at,
      });
    }
  }

  // 2) 今会話の履歴を後ろへ（content/text/message を吸収）
  for (const m of normTurn) {
    const role = String(m?.role ?? '').toLowerCase();
    if (role !== 'user' && role !== 'assistant') continue;

    const text = m?.content ?? m?.text ?? (m as any)?.message ?? '';
    const key = makeKey(role, text);

    if (!key.endsWith('::') && !seen.has(key)) {
      seen.add(key);
      out.push(m);
    }
  }

  // 3) 多すぎるなら後ろ（新しい方）を残す
  if (out.length > maxTotal) return out.slice(out.length - maxTotal);
  return out;
}
