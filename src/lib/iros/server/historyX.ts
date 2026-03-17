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
  if (sa === '無言アクト') return true;

  const reason = String(
    meta?.silencePatchedReason ??
      meta?.extra?.silencePatchedReason ??
      meta?.speechActReason ??
      meta?.speech_act_reason ??
      '',
  ).toUpperCase();

  if (reason.includes('無言アクト')) return true;
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

  // ① metaで明示除外
  if (isHiddenFromHistory(meta)) return true;

  // ② 沈黙系は常に除外
  if (isSilenceLike(content, meta)) return true;

  // ③ cross-conversation は user のみ（assistant遮断）
  if (crossConversation && CROSS_CONV_USER_ONLY && role === 'assistant') {
    return true;
  }

  // ④ cross-conversation の assistant だけ、旧テンプレ汚染を遮断
  //    same-conversation では「流れ」を守るため適用しない
  if (crossConversation && role === 'assistant') {
    if (isBannedAssistantHistoryText(content)) return true;
  }

  return false;
}

/* =========================================================
 * ✅ Phase3: q_code / depth_stage の読み取りを “列優先” に固定
 * - column: q_code / depth_stage を最優先
 * - meta: 古い行の救済だけ
 * ========================================================= */

const pickStr = (v: unknown): string | null => {
  const s = String(v ?? '').trim();
  return s ? s : null;
};

function pickQCode(row: any): string | null {
  // ✅ column first
  const col = pickStr(row?.q_code) ?? pickStr(row?.qCode) ?? null;
  if (col) return col;

  // ✅ meta fallback (old rows)
  const m = row?.meta ?? null;
  return (
    pickStr(m?.q_code) ??
    pickStr(m?.qCode) ??
    pickStr(m?.qcode) ??
    pickStr(m?.unified?.q?.current) ??
    null
  );
}

function pickDepthStage(row: any): string | null {
  // ✅ column first
  const col =
    pickStr(row?.depth_stage) ??
    pickStr(row?.depthStage) ??
    pickStr(row?.depthstage) ??
    null;
  if (col) return col;

  // ✅ meta fallback (old rows)
  const m = row?.meta ?? null;
  return (
    pickStr(m?.depth_stage) ??
    pickStr(m?.depthStage) ??
    pickStr(m?.depthstage) ??
    pickStr(m?.unified?.depth?.stage) ??
    null
  );
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

  /**
   * これまでは「跨ぎ履歴」専用で、同一conversationは excludeConversationId で除外していた。
   * Phase1: 同一conversationの直近流れを LLM に見せるため、
   * includeSameConversation=true のときは “同一conversation” も混ぜて返せるようにする。
   */
  excludeConversationId?: string;

  // ✅ Phase1: 同一conversationを含める（デフォルトfalseで既存互換）
  includeSameConversation?: boolean;

  // ✅ Phase1: 同一conversationから取る件数（直近 N）
  sameConversationLimit?: number;

  // ✅ Phase1: cross-conv 側の最大件数（同一conversation優先のため別枠）
  crossConversationLimit?: number;
}): Promise<HistoryXMsg[]> {
  const {
    supabase,
    userCode,
    limit = 60,
    excludeConversationId,
    includeSameConversation = false,
    sameConversationLimit = 8,
    crossConversationLimit = 60,
  } = params;

  // ✅ 取得は広めに。あとで same/cross を分けて切り詰める
  // - includeSameConversation=false の従来挙動では excludeConversationId で除外したい
  // - includeSameConversation=true の場合は “いったん全部取り”、後段で same/cross 分離
  //
  // ⚠️ 重要:
  // - excludeConversationId は「DBで除外するためのID」と「sameConvIdのためのID」を兼ねてしまうと壊れる
  // - includeSameConversation=true のときは DB除外を止める（undefined）一方で、
  //   sameConvId 用の “現在のconversationId” は別で保持しておく
  const currentConversationId = excludeConversationId ? String(excludeConversationId) : null;
  const queryExcludeConversationId = includeSameConversation ? undefined : excludeConversationId;

  const picked = await tryLoadRows({
    supabase,
    userCode,
    limit: Math.max(limit, crossConversationLimit + sameConversationLimit + 20),
    excludeConversationId: queryExcludeConversationId,
  });

  if (!picked.table) {
    console.warn('[IROS][HistoryX] load: no table matched', { userCode, limit });
    return [];
  }

  const rows = picked.rows ?? [];


  // 1) 正規化して role/content を作る
  const normalized = rows
    .map((r) => {
      if (!isRoleUserOrAssistant(r.role)) return null;

      const role = String(r.role ?? '').toLowerCase() as 'user' | 'assistant';
      const content = normText(r.content ?? r.text);
      if (!content) return null;

      const convId = String(r.conversation_id ?? '');
      return { r, role, content, convId };
    })
    .filter(Boolean) as Array<{ r: MsgRow; role: 'user' | 'assistant'; content: string; convId: string }>;

  // 2) same / cross に分離
  const sameConvId = currentConversationId;


  const same = sameConvId
    ? normalized.filter((x) => x.convId === sameConvId)
    : [];

  const cross = sameConvId
    ? normalized.filter((x) => x.convId !== sameConvId)
    : normalized;

  // 3) フィルタ（same は crossConversation=false、cross は true）
  const sameFiltered = same
    .filter((x) => {
      if (
        shouldExcludeFromHistory({
          role: x.role,
          content: x.content,
          meta: (x.r as any)?.meta,
          crossConversation: false,
        })
      ) {
        return false;
      }
      return true;
    })
    // DBは created_at desc で取ってるので、ここも “末尾が最新” になるよう reverse してから slice
    .reverse();

  const crossFiltered = cross
    .filter((x) => {
      if (
        shouldExcludeFromHistory({
          role: x.role,
          content: x.content,
          meta: (x.r as any)?.meta,
          crossConversation: true,
        })
      ) {
        return false;
      }
      return true;
    })
    .reverse();

  // 4) 件数制御（同一conversationを最優先）
  const samePicked =
    includeSameConversation && sameConvId
      ? sameFiltered.slice(Math.max(0, sameFiltered.length - Math.max(1, sameConversationLimit)))
      : [];

  const crossPicked = crossFiltered.slice(
    Math.max(0, crossFiltered.length - Math.max(1, crossConversationLimit)),
  );

  // 5) 返却用に結合
  // ✅ LLMに「直近の流れ」を見せたいので、same を最後に示す（末尾が最新）
  const merged = includeSameConversation ? [...crossPicked, ...samePicked] : crossPicked;

  console.log('[IROS][HistoryX] loaded', {
    userCode,
    table: picked.table,
    rawCount: rows.length,
    normalizedCount: normalized.length,

    includeSameConversation,
    currentConversationId,
    queryExcludeConversationId: queryExcludeConversationId ?? null,

    sameConversationIncluded: Boolean(includeSameConversation && sameConvId),
    sameConvCount: samePicked.length,
    crossConvCount: crossPicked.length,

    crossConvUserOnly: CROSS_CONV_USER_ONLY,
  });

  return merged.map((x) => {
    const r = x.r;
    const content = x.content;

    // ✅ Phase3: 列優先で確定（metaは救済）
    const q = pickQCode(r);
    const ds = pickDepthStage(r);

    return {
      id: String(r.id ?? ''),
      conversation_id: String(r.conversation_id ?? ''),
      role: x.role,
      content,
      created_at: String(r.created_at ?? ''),

      q_code: q,
      depth_stage: ds,
      meta: (r as any)?.meta ?? null,

      text: (r as any)?.text ?? null,
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

      // ✅ Phase3: dbHistory 側も “列優先” で最終確定（meta救済）
      const q = pickQCode(m);
      const ds = pickDepthStage(m);

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
