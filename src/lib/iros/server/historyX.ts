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

/* =========================================================
 * ✅ Silence filtering (History hygiene)
 * - DBに残っていても「履歴」に混ぜない
 * - 目的：LLMが `…。🪔` を参照して劣化しないようにする
 * ========================================================= */

function normalizeDots(s: string): string {
  return (s ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function isSilenceLikeText(text: string): boolean {
  const t = normalizeDots(text);

  if (!t) return true;

  // 代表的な “沈黙” 文字列（UI/ログで混入しやすい）
  const exact = new Set([
    '…',
    '…。',
    '…。🪔',
    '…🪔',
    '...',
    '....',
    '.....',
    '…。',
    '… …',
  ]);
  if (exact.has(t)) return true;

  // ほぼ記号だけ（句読点/絵文字だけ）なら沈黙扱い
  // ※日本語の通常文が誤判定されにくいように「文字」を含むなら false
  const hasLetters = /[A-Za-z0-9\u3040-\u30FF\u4E00-\u9FFF]/.test(t);
  if (!hasLetters) {
    // 記号・絵文字・句読点だけの短文は除外
    if (t.length <= 12) return true;
  }

  return false;
}

function isSilenceMeta(meta: any): boolean {
  if (!meta) return false;

  // 明示フラグ優先
  if (meta?.isSilenceText === true) return true;

  // 既存の沈黙系メタ（ログに出てるやつを拾う）
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

  // 典型パターン
  if (reason.includes('SILENCE')) return true;
  if (reason.includes('NO_LLM') && reason.includes('EMPTY')) return true;

  return false;
}

function isSilenceLike(text: string, meta?: any): boolean {
  if (isSilenceMeta(meta)) return true;
  return isSilenceLikeText(text);
}

/**
 * ✅ DB履歴ソース候補（まず統合ビューを優先）
 * ...
 */
const HISTORY_TABLES = [
  'v_iros_messages',
  'public.v_iros_messages',
  'iros_messages',
  'public.iros_messages',
  'iros_messages_ui',
  'iros_messages_normalized',
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

      const content = normText(r.content ?? r.text);
      if (!content) return false;

      // ✅ ここが追加：沈黙っぽい履歴は “跨ぎ履歴” に入れない
      if (isSilenceLike(content, r.meta)) return false;

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
    const rawText = m?.content ?? m?.text ?? m?.message ?? '';
    const content = normText(rawText);

    // ✅ ここが追加：DB跨ぎ履歴でも沈黙は除外
    if (!content) continue;
    if (isSilenceLike(content, m?.meta)) continue;

    const key = makeKey(m?.role, content);
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

  // 2) 今会話の履歴
  for (const m of normTurn) {
    const role = String(m?.role ?? '').toLowerCase();
    if (role !== 'user' && role !== 'assistant') continue;

    const rawText = m?.content ?? m?.text ?? (m as any)?.message ?? '';
    const text = normText(rawText);
    if (!text) continue;

    // ✅ ここが追加：今会話側でも沈黙は除外（念のため）
    if (isSilenceLike(text, m?.meta)) continue;

    const key = makeKey(role, text);
    if (!key.endsWith('::') && !seen.has(key)) {
      seen.add(key);
      out.push(m);
    }
  }

  if (out.length > maxTotal) return out.slice(out.length - maxTotal);
  return out;
}
