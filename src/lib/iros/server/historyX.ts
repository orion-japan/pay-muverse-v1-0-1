// src/lib/iros/server/historyX.ts
// iros — Cross-conversation history utilities (HistoryX)

import type { SupabaseClient } from '@supabase/supabase-js';

export type HistoryXMsg = {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;

  q_code?: string | null;
  depth_stage?: string | null;
  meta?: any | null;

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

// ✅ 方針：跨ぎ履歴（Cross-conversation）は user のみを使う（assistant混入＝テンプレ汚染の根）
const CROSS_CONV_USER_ONLY = true;

const normText = (s: unknown) =>
  String(s ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const makeKey = (role: unknown, text: unknown) => {
  const r = String(role ?? '').toLowerCase();
  const t = normText(text);
  return `${r}::${t}`;
};

function isRoleUserOrAssistant(role: unknown): role is 'user' | 'assistant' {
  const r = String(role ?? '').toLowerCase();
  return r === 'user' || r === 'assistant';
}

/* =========================================================
 * ✅ Silence filtering (History hygiene)
 * ========================================================= */

function normalizeDots(s: string): string {
  return normText(s);
}

function isSilenceLikeText(text: string): boolean {
  const t = normalizeDots(text);

  if (!t) return true;

  const exact = new Set([
    '…',
    '…。',
    '…。🪔',
    '…🪔',
    '...',
    '....',
    '.....',
    '… …',
  ]);
  if (exact.has(t)) return true;

  // 文字が無い（記号だけ）なら短いものは沈黙扱い
  const hasLetters = /[A-Za-z0-9\u3040-\u30FF\u4E00-\u9FFF]/.test(t);
  if (!hasLetters) {
    if (t.length <= 12) return true;
  }

  return false;
}

function isSilenceMeta(meta: any): boolean {
  if (!meta) return false;

  if (meta?.isSilenceText === true) return true;
  if (meta?.silencePatched === true) return true;
  if (meta?.speechSkipped === true) return true;

  const sa = String(meta?.speechAct ?? meta?.speech_act ?? '').toUpperCase();
  if (sa === 'SILENCE') return true;

  const reason = String(
    meta?.silencePatchedReason ??
      meta?.extra?.silencePatchedReason ??
      meta?.speechActReason ??
      meta?.speech_act_reason ??
      '',
  ).toUpperCase();

  if (reason.includes('SILENCE')) return true;
  if (reason.includes('NO_LLM') && reason.includes('EMPTY')) return true;

  return false;
}

function isSilenceLike(text: string, meta?: any): boolean {
  if (isSilenceMeta(meta)) return true;
  return isSilenceLikeText(text);
}

/* =========================================================
 * ✅ Old assistant contamination filtering (History stop-bleed)
 * - DBに残っていても「履歴」に混ぜない（旧assistant文を遮断）
 * ========================================================= */

function isHiddenFromHistory(meta: any): boolean {
  return meta?.hiddenFromHistory === true || meta?.hidden_from_history === true;
}

// 旧assistant汚染の「核」だけ最小で持つ（必要に応じて拡張）
const BANNED_ASSISTANT_HISTORY_PATTERNS: RegExp[] = [
  /紙に書き出/,

  // GPT一般論の典型
  /書くことで少し整理/,
  /整理されるかもしれません/,
  /してみるのはどうでしょう/,
  /少しずつ/,
  /進めましょう/,

  // ありがちな助言テンプレ（追加）
  /〜してみてください/,
  /すると良いでしょう/,
  /かもしれません/,
  /おすすめです/,
  /まずは/,
];

function isBannedAssistantHistoryText(text: string): boolean {
  const t = normText(text);
  if (!t) return true;
  for (const re of BANNED_ASSISTANT_HISTORY_PATTERNS) {
    if (re.test(t)) return true;
  }
  return false;
}

function shouldExcludeFromHistory(args: {
  role: 'user' | 'assistant';
  content: string;
  meta?: any;
  crossConversation?: boolean;
}): boolean {
  const { role, content, meta, crossConversation } = args;

  // metaで明示除外
  if (isHiddenFromHistory(meta)) return true;

  // 沈黙系は除外
  if (isSilenceLike(content, meta)) return true;

  // ✅ 跨ぎ履歴は user のみ（テンプレ汚染の根を断つ）
  if (crossConversation && CROSS_CONV_USER_ONLY && role === 'assistant') return true;

  // 旧assistant汚染（念のため）
  if (role === 'assistant' && isBannedAssistantHistoryText(content)) return true;

  return false;
}

/// ✅ DB履歴ソース候補（存在するものだけ / v_iros_messages を最優先）
const HISTORY_TABLES = [
  'v_iros_messages',
  'iros_messages_ui',
  'iros_messages_normalized',
  'iros_messages',
  'public.iros_messages',
] as const;

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

      const role = String(r.role ?? '').toLowerCase() as 'user' | 'assistant';
      const content = normText(r.content ?? r.text);
      if (!content) return false;

      // ✅ ここ：沈黙＋hidden＋（跨ぎはassistant遮断）を適用
      if (
        shouldExcludeFromHistory({
          role,
          content,
          meta: r.meta,
          crossConversation: true,
        })
      ) {
        return false;
      }

      if (
        excludeConversationId &&
        String(r.conversation_id ?? '') === String(excludeConversationId)
      ) {
        return false;
      }
      return true;
    })
    .reverse();

  if (process.env.NODE_ENV !== 'production') {
    console.log('[IROS][HistoryX] loaded', {
      userCode,
      table: picked.table,
      rawCount: rows.length,
      filteredCount: filtered.length,
      excludeConversationId: excludeConversationId ?? null,
      crossConvUserOnly: CROSS_CONV_USER_ONLY,
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

      text: r.text ?? null,
      message: null,
    };
  });
}

export function mergeHistoryForTurn(params: {
  dbHistory: HistoryXMsg[];
  turnHistory: any[];
  maxTotal?: number;
}): any[] {
  const { dbHistory, turnHistory, maxTotal = 80 } = params;

  const normTurn = Array.isArray(turnHistory) ? turnHistory : [];
  const seen = new Set<string>();
  const out: any[] = [];

  // 1) DB履歴（跨ぎ）
  for (const m of dbHistory ?? []) {
    const role = String(m?.role ?? '').toLowerCase() as 'user' | 'assistant';
    if (role !== 'user' && role !== 'assistant') continue;

    const rawText = m?.content ?? m?.text ?? m?.message ?? '';
    const content = normText(rawText);
    if (!content) continue;

    // ✅ 跨ぎ履歴：沈黙＋hidden＋assistant遮断（ここが効く）
    if (
      shouldExcludeFromHistory({
        role,
        content,
        meta: m?.meta,
        crossConversation: true,
      })
    ) {
      continue;
    }

    const key = makeKey(role, content);
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

        q_code: q,
        depth_stage: ds,
        meta: m.meta ?? null,

        q,
        qCode: q,
        depthStage: ds,
      });
    }
  }

  // 2) 今会話の履歴（ここは user/assistant どちらも保持：会話の整合性のため）
  for (const m of normTurn) {
    const role = String(m?.role ?? '').toLowerCase() as 'user' | 'assistant';
    if (role !== 'user' && role !== 'assistant') continue;

    const rawText = m?.content ?? m?.text ?? (m as any)?.message ?? '';
    const text = normText(rawText);
    if (!text) continue;

    // ✅ 今会話側でも沈黙＋hidden＋（assistantテンプレ除外）を適用
    if (
      shouldExcludeFromHistory({
        role,
        content: text,
        meta: m?.meta,
        crossConversation: false,
      })
    ) {
      continue;
    }

    const key = makeKey(role, text);
    if (!key.endsWith('::') && !seen.has(key)) {
      seen.add(key);
      out.push(m);
    }
  }

  if (out.length > maxTotal) return out.slice(out.length - maxTotal);
  return out;
}
