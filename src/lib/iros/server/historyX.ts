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

  // ✅ Qブレーキ/回転が拾えるように追加
  q_code?: string | null;
  depth_stage?: string | null;
  meta?: any | null;

  // 互換（turnHistory 側に text/message があるケース用）
  text?: string | null;
  message?: string | null;
};

type MsgRow = {
  id: string | null;
  conversation_id: string | null;
  role: string | null;
  content: string | null;
  text: string | null;
  meta: any | null;
  q_code: string | null;
  depth_stage: string | null;
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
 * ✅ DB履歴ソース候補（まず統合ビューを優先）
 * - public.* も混ざる環境があるので両方入れる
 */
const HISTORY_TABLES = [
  'v_iros_messages',
  'public.v_iros_messages',
  'iros_messages',
  'public.iros_messages',
  'iros_messages_ui',
  'iros_messages_normalized',
  'talk_messages',
  'messages',
] as const;

/**
 * ✅ カラム差を吸収する select 候補（上から順に試す）
 */
const SELECT_CANDIDATES = [
  'id,conversation_id,role,content,text,meta,q_code,depth_stage,created_at',
  'id,conversation_id,role,content,text,q_code,depth_stage,created_at',
  'id,conversation_id,role,content,text,created_at',
  'id,conversation_id,role,content,created_at',
  'id,conversation_id,role,text,created_at',
] as const;

async function tryLoadRows(params: {
  supabase: SupabaseClient;
  userCode: string;
  limit: number;
  excludeConversationId?: string;
}): Promise<{ table: string | null; rows: MsgRow[] }> {
  const { supabase, userCode, limit, excludeConversationId } = params;

  for (const table of HISTORY_TABLES) {
    for (const cols of SELECT_CANDIDATES) {
      try {
        // ✅ ここが核心：DBクエリ段階で “今会話ID” を除外する
        let q = (supabase as any)
          .from(table)
          .select(cols)
          .eq('user_code', userCode)
          .order('created_at', { ascending: false })
          .limit(limit);

        if (excludeConversationId) {
          q = q.neq('conversation_id', excludeConversationId);
        }

        const { data, error } = await q;

        if (!error && Array.isArray(data)) {
          return { table, rows: data as MsgRow[] };
        }
      } catch {
        // ignore and try next
      }
    }
  }

  return { table: null, rows: [] };
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

  const picked = await tryLoadRows({
    supabase,
    userCode,
    limit,
    excludeConversationId,
  });

  if (!picked.table) {
    console.warn('[IROS][HistoryX] load: no table matched', { userCode, limit });
    return [];
  }

  const rows = picked.rows ?? [];

  const filtered = rows
    .filter((r) => {
      if (!isRoleUserOrAssistant(r.role)) return false;

      const content = normText(r.content ?? r.text);
      if (!content) return false;

      // ※ exclude はDB側でやってるが、念のため残す（環境差保険）
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

  if (process.env.NODE_ENV !== 'production') {
    console.log('[IROS][HistoryX] loaded', {
      userCode,
      table: picked.table,
      rawCount: rows.length,
      filteredCount: filtered.length,
      excludeConversationId: excludeConversationId ?? null,
    });
  }

  return filtered.map((r) => {
    const content = normText(r.content ?? r.text);
    return {
      id: String(r.id ?? ''),
      conversation_id: String(r.conversation_id ?? ''),
      role: String(r.role ?? '').toLowerCase() as 'user' | 'assistant',
      content,
      created_at: String(r.created_at ?? ''),

      q_code: r.q_code ?? null,
      depth_stage: r.depth_stage ?? null,
      meta: r.meta ?? null,

      // 互換：turnHistory と揃える
      text: r.text ?? null,
    };
  });
}

/**
 * ✅ dbHistory（跨ぎ） + turnHistory（今会話）を重複排除しながらマージ
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

  // 1) DB履歴（跨ぎ）を先に入れる（q_code/depth_stage/meta を保持）
  for (const m of dbHistory ?? []) {
    const key = makeKey(m?.role, m?.content ?? m?.text ?? m?.message ?? '');
    if (!key.endsWith('::') && !seen.has(key)) {
      seen.add(key);

      const q = m.q_code ?? null;
      const ds = m.depth_stage ?? null;

      out.push({
        id: m.id,
        conversation_id: m.conversation_id,
        role: m.role,
        content: m.content,
        text: m.text ?? undefined,
        message: m.message ?? undefined,
        created_at: m.created_at,

        // ✅ 主要フィールド（従来）
        q_code: q,
        depth_stage: ds,
        meta: m.meta ?? null,

        // ✅ 互換エイリアス（ここが本命）
        q,            // /api/agent/iros/messages の OutMsg と同じ名前
        qCode: q,      // もし camelCase を見てる箇所があっても拾える
        depthStage: ds // camelCase 互換
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
