// file: src/lib/iros/server/handleIrosReply.ts

import type { IrosStyle } from '@/lib/iros/system';
import type { RememberScopeKind } from '@/lib/iros/remember/resolveRememberBundle';
import type { IrosUserProfileRow } from './loadUserProfile';

import { getIrosSupabaseAdmin } from './handleIrosReply.supabase';

import { runGreetingGate, runMicroGate } from './handleIrosReply.gates';
import { buildTurnContext } from './handleIrosReply.context';
import { runOrchestratorTurn } from './handleIrosReply.orchestrator';
import { postProcessReply } from './handleIrosReply.postprocess';
import { runGenericRecallGate } from '@/lib/iros/server/gates/genericRecallGate';

import {
  persistAssistantMessage,
  persistIntentAnchorIfAny,
  persistMemoryStateIfAny,
  persistUnifiedAnalysisIfAny,
  persistQCodeSnapshotIfAny,
} from './handleIrosReply.persist';

// ★ アンカー汚染を防ぐための判定（保存ゲートと同じ基準）
import { isMetaAnchorText } from '@/lib/iros/intentAnchor';

export type HandleIrosReplyInput = {
  conversationId: string;
  text: string;
  hintText?: string;
  mode: string;
  userCode: string;
  tenantId: string;
  rememberScope: RememberScopeKind | null;
  reqOrigin: string;
  authorizationHeader: string | null;
  traceId?: string | null;

  userProfile?: IrosUserProfileRow | null;
  style?: IrosStyle | string | null;

  /** ✅ 会話履歴（Writer/LLMに渡すため） */
  history?: unknown[];
};

export type HandleIrosReplySuccess = {
  ok: true;
  result: any;
  assistantText: string;
  metaForSave: any;
  finalMode: string | null;
};

export type HandleIrosReplyError = {
  ok: false;
  error: 'generation_failed';
  detail: string;
};

export type HandleIrosReplyOutput =
  | HandleIrosReplySuccess
  | HandleIrosReplyError;

const supabase = getIrosSupabaseAdmin();

/* =========================
   History loader
========================= */

async function loadConversationHistory(
  supabase: any,
  conversationId: string,
  limit = 30,
): Promise<unknown[]> {
  try {
    // ✅ まず「新しい順」で limit 件取る（最新文脈を落とさない）
    const { data, error } = await supabase
      .from('iros_messages')
      .select('role, text, content, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('[IROS/History] load failed', { conversationId, error });
      return [];
    }

    // ✅ LLMには「古い→新しい」の順で渡したいので反転
    const rows = (data ?? []).slice().reverse();

    const history = rows.map((m: any) => ({
      role: m?.role,
      content:
        typeof m?.content === 'string' && m.content.trim().length > 0
          ? m.content
          : typeof m?.text === 'string'
            ? m.text
            : '',
    }));

    console.log('[IROS/History] loaded', {
      conversationId,
      limit,
      returned: history.length,
      first: history[0]?.content?.slice?.(0, 40),
      last: history[history.length - 1]?.content?.slice?.(0, 40),
    });

    return history;
  } catch (e) {
    console.error('[IROS/History] unexpected', { conversationId, error: e });
    return [];
  }
}

/* =========================
   Timing helpers
========================= */

function nowNs(): bigint {
  return process.hrtime.bigint();
}
function msSince(startNs: bigint): number {
  const diff = process.hrtime.bigint() - startNs;
  return Number(diff) / 1_000_000;
}
function nowIso(): string {
  return new Date().toISOString();
}

/* =========================
   Micro bypass
========================= */

// ✅ MicroGate をバイパスすべき “文脈参照クエリ” 判定
function shouldBypassMicroGate(userText: string): boolean {
  const s = (userText ?? '').trim();
  if (!s) return false;

  const keywords = [
    '覚えて',
    '覚えてない',
    'なんでしたっけ',
    '何でしたっけ',
    'さっき',
    '先ほど',
    '前に',
    '目標',
    'どれだっけ',
    'どっちだっけ',
    '言った',
  ];

  if (keywords.some((k) => s.includes(k))) return true;
  if (s.endsWith('?') || s.endsWith('？')) return true;

  return false;
}

/* =========================
   Goal recall gate
========================= */

function isGoalRecallQuestion(s: string): boolean {
  const t = (s ?? '').trim();
  if (!t) return false;

  // 例：「今日の目標なんでしたっけ？」「目標覚えてる？」
  return (
    /(今日|僕|わたし|俺).*(目標).*(なん|何|覚えて|覚えてない|でしたっけ|どれ|\?|\？)/.test(
      t,
    ) ||
    /(目標).*(覚えて|覚えてない|でしたっけ|どれ|\?|\？)/.test(t)
  );
}

const norm = (v: any): string => {
  if (v == null) return '';

  // OpenAI-style content parts: [{ type:'text', text:'...' }, ...]
  if (Array.isArray(v)) {
    const parts = v
      .map((p) => {
        if (typeof p === 'string') return p;
        if (!p) return '';
        if (typeof p === 'object') {
          if (typeof (p as any).text === 'string') return (p as any).text;
          if (typeof (p as any).content === 'string') return (p as any).content;
          if (typeof (p as any).value === 'string') return (p as any).value;
        }
        return '';
      })
      .filter(Boolean)
      .join(' ');
    return parts.replace(/\s+/g, ' ').trim();
  }

  if (typeof v === 'string') return v.replace(/\s+/g, ' ').trim();

  // object -> try common fields; avoid "[object Object]"
  if (typeof v === 'object') {
    const t =
      (typeof (v as any).text === 'string' && (v as any).text) ||
      (typeof (v as any).content === 'string' && (v as any).content) ||
      (typeof (v as any).message === 'string' && (v as any).message) ||
      '';
    return String(t).replace(/\s+/g, ' ').trim();
  }

  return String(v).replace(/\s+/g, ' ').trim();
};


/* =========================
   IntentAnchor sanitize
========================= */

function pickIntentAnchorText(m: any): string {
  // camel: intentAnchor
  const a1 = m?.intentAnchor;
  const t1 =
    (a1?.anchor_text ?? '') ||
    (a1?.anchorText ?? '') ||
    (a1?.text ?? '') ||
    '';

  // snake: intent_anchor
  const a2 = m?.intent_anchor;
  const t2 =
    (a2?.anchor_text ?? '') ||
    (a2?.anchorText ?? '') ||
    (a2?.text ?? '') ||
    '';

  return String(t1 || t2 || '');
}

/**
 * ✅ intentAnchor 汚染防止（統合版）
 * - “状況文/メタ/開発会話” がアンカーとして紛れたら落とす
 * - Row（id/user_id/created_at 等）っぽいものは極力残す
 * - ただし **SUN固定（fixedNorth.key==='SUN' / fixed:true）** は絶対に落とさない
 * - camel/snake 両対応（intentAnchor / intent_anchor）
 */
function sanitizeIntentAnchorMeta(metaForSave: any): any {
  const m = metaForSave ?? {};

  if (!m.intentAnchor && !m.intent_anchor) return m;

  // ★ SUN固定アンカーは守る（最重要）
  const fixedNorthKey =
    typeof m?.fixedNorth?.key === 'string' ? m.fixedNorth.key : null;

  const fixed1 = Boolean(m?.intentAnchor?.fixed);
  const fixed2 = Boolean(m?.intent_anchor?.fixed);

  if (fixedNorthKey === 'SUN' || fixed1 || fixed2) {
    return m;
  }

  const anchorText = pickIntentAnchorText(m);
  const hasText = Boolean(anchorText && anchorText.trim());

  const aCamel = m.intentAnchor;
  const aSnake = m.intent_anchor;

  const looksLikeRow =
    Boolean(aCamel?.id) ||
    Boolean(aCamel?.user_id) ||
    Boolean(aCamel?.created_at) ||
    Boolean(aCamel?.updated_at) ||
    Boolean(aSnake?.id) ||
    Boolean(aSnake?.user_id) ||
    Boolean(aSnake?.created_at) ||
    Boolean(aSnake?.updated_at);

  // 1) テキストが無い → 捨てる
  if (!hasText) {
    if (m.intentAnchor) delete m.intentAnchor;
    if (m.intent_anchor) delete m.intent_anchor;
    return m;
  }

  // 2) “メタ発話” 判定 → 捨てる
  if (isMetaAnchorText(anchorText)) {
    if (m.intentAnchor) delete m.intentAnchor;
    if (m.intent_anchor) delete m.intent_anchor;
    return m;
  }

  // 3) Rowっぽくないのに、イベント情報も無い → 擬似アンカーとして捨てる
  const ev: string | null =
    m.anchorEventType ??
    m.intentAnchorEventType ??
    m.anchor_event_type ??
    m.intent_anchor_event_type ??
    null;

  const shouldBeRealEvent = ev === 'set' || ev === 'reset';

  if (!looksLikeRow && !shouldBeRealEvent) {
    if (m.intentAnchor) delete m.intentAnchor;
    if (m.intent_anchor) delete m.intent_anchor;
    return m;
  }

  return m;
}

/* =========================================================
   pivot（転換点）算出
========================================================= */

type IrosPivotKind =
  | 'PIVOT_ENTER_CENTER'
  | 'PIVOT_EXIT_CENTER'
  | 'PIVOT_SHIFT_Q'
  | 'PIVOT_MOVE_DEPTH'
  | 'PIVOT_SHIFT_PHASE'
  | 'PIVOT_SHIFT_YH'
  | 'PIVOT_NONE';

type IrosPivot = {
  kind: IrosPivotKind;
  strength: 'weak' | 'mid' | 'strong';
  from?: { q?: string | null; depth?: string | null; phase?: string | null };
  to?: { q?: string | null; depth?: string | null; phase?: string | null };
  reason?: string;
};

function toNumOrNull(v: any): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function computePivot(prevMeta: any, nextMeta: any): IrosPivot {
  const prevQ = prevMeta?.qCode ?? prevMeta?.q_code ?? null;
  const nextQ = nextMeta?.qCode ?? nextMeta?.q_code ?? null;

  const prevDepth = prevMeta?.depth ?? prevMeta?.depth_stage ?? null;
  const nextDepth = nextMeta?.depth ?? nextMeta?.depth_stage ?? null;

  const prevPhase = prevMeta?.phase ?? null;
  const nextPhase = nextMeta?.phase ?? null;

  const prevY = toNumOrNull(prevMeta?.y_level ?? prevMeta?.yLevel ?? prevMeta?.y);
  const nextY = toNumOrNull(nextMeta?.y_level ?? nextMeta?.yLevel ?? nextMeta?.y);
  const prevH = toNumOrNull(prevMeta?.h_level ?? prevMeta?.hLevel ?? prevMeta?.h);
  const nextH = toNumOrNull(nextMeta?.h_level ?? nextMeta?.hLevel ?? nextMeta?.h);

  const yhMoved =
    (prevY !== null && nextY !== null && Math.abs(nextY - prevY) >= 0.5) ||
    (prevH !== null && nextH !== null && Math.abs(nextH - prevH) >= 0.5);

  const qChanged = prevQ !== null && nextQ !== null && prevQ !== nextQ;
  const depthChanged =
    prevDepth !== null && nextDepth !== null && prevDepth !== nextDepth;
  const phaseChanged =
    prevPhase !== null && nextPhase !== null && prevPhase !== nextPhase;

  const strength: IrosPivot['strength'] =
    (qChanged && (prevQ === 'Q3' || nextQ === 'Q3')) ||
    (depthChanged && phaseChanged)
      ? 'strong'
      : qChanged || depthChanged || phaseChanged || yhMoved
        ? 'mid'
        : 'weak';

  if (!qChanged && prevQ === nextQ && prevQ === 'Q3') {
    if (depthChanged) {
      return {
        kind: 'PIVOT_MOVE_DEPTH',
        strength,
        from: { q: prevQ, depth: prevDepth, phase: prevPhase },
        to: { q: nextQ, depth: nextDepth, phase: nextPhase },
        reason: 'Q3中心に滞在したまま depth が動いた',
      };
    }
    if (phaseChanged) {
      return {
        kind: 'PIVOT_SHIFT_PHASE',
        strength,
        from: { q: prevQ, depth: prevDepth, phase: prevPhase },
        to: { q: nextQ, depth: nextDepth, phase: nextPhase },
        reason: 'Q3中心に滞在したまま phase が切り替わった',
      };
    }
    if (yhMoved) {
      return {
        kind: 'PIVOT_SHIFT_YH',
        strength,
        from: { q: prevQ, depth: prevDepth, phase: prevPhase },
        to: { q: nextQ, depth: nextDepth, phase: nextPhase },
        reason: 'Q3中心に滞在したまま y/h（揺らぎ）が変化した',
      };
    }
  }

  if (qChanged) {
    if (nextQ === 'Q3') {
      return {
        kind: 'PIVOT_ENTER_CENTER',
        strength: 'strong',
        from: { q: prevQ, depth: prevDepth, phase: prevPhase },
        to: { q: nextQ, depth: nextDepth, phase: nextPhase },
        reason: 'QがQ3へ遷移（中心に入った）',
      };
    }
    if (prevQ === 'Q3') {
      return {
        kind: 'PIVOT_EXIT_CENTER',
        strength: 'strong',
        from: { q: prevQ, depth: prevDepth, phase: prevPhase },
        to: { q: nextQ, depth: nextDepth, phase: nextPhase },
        reason: 'QがQ3から遷移（中心から出た）',
      };
    }
    return {
      kind: 'PIVOT_SHIFT_Q',
      strength,
      from: { q: prevQ, depth: prevDepth, phase: prevPhase },
      to: { q: nextQ, depth: nextDepth, phase: nextPhase },
      reason: 'Qが変化した',
    };
  }

  if (depthChanged) {
    return {
      kind: 'PIVOT_MOVE_DEPTH',
      strength,
      from: { q: prevQ, depth: prevDepth, phase: prevPhase },
      to: { q: nextQ, depth: nextDepth, phase: nextPhase },
      reason: 'Qは維持されたまま depth が動いた',
    };
  }

  if (phaseChanged) {
    return {
      kind: 'PIVOT_SHIFT_PHASE',
      strength,
      from: { q: prevQ, depth: prevDepth, phase: prevPhase },
      to: { q: nextQ, depth: nextDepth, phase: nextPhase },
      reason: 'Qは維持されたまま phase が切り替わった',
    };
  }

  if (yhMoved) {
    return {
      kind: 'PIVOT_SHIFT_YH',
      strength,
      from: { q: prevQ, depth: prevDepth, phase: prevPhase },
      to: { q: nextQ, depth: nextDepth, phase: nextPhase },
      reason: 'Qは維持されたまま y/h（揺らぎ）が変化した',
    };
  }

  return {
    kind: 'PIVOT_NONE',
    strength: 'weak',
    from: { q: prevQ, depth: prevDepth, phase: prevPhase },
    to: { q: nextQ, depth: nextDepth, phase: nextPhase },
    reason: '明確な転換点なし',
  };
}

/* =========================================================
   main
========================================================= */

export async function handleIrosReply(
  params: HandleIrosReplyInput,
): Promise<HandleIrosReplyOutput> {
  const t0 = nowNs();
  const startedAt = nowIso();

  const t: any = {
    started_at: startedAt,
    finished_at: startedAt,
    total_ms: 0,

    gate_ms: 0,
    context_ms: 0,
    orchestrator_ms: 0,
    postprocess_ms: 0,

    persist_ms: {
      q_snapshot_ms: 0,
      intent_anchor_ms: 0,
      memory_state_ms: 0,
      unified_analysis_ms: 0,
      assistant_message_ms: 0,
      total_ms: 0,
    },
  };

  const {
    conversationId,
    text,
    mode,
    userCode,
    tenantId,
    rememberScope,
    reqOrigin,
    authorizationHeader,
    traceId,
    userProfile,
    style,
    history,
  } = params;

  console.log('[IROS/Reply] handleIrosReply start', {
    conversationId,
    userCode,
    mode,
    tenantId,
    rememberScope,
    traceId,
    style,
    history_len: Array.isArray(history) ? history.length : null,
  });

  try {
    /* ---------------------------
       0) Gates
    ---------------------------- */

    const tg = nowNs();

    const gatedGreeting = await runGreetingGate({
      supabase,
      conversationId,
      userCode,
      text,
      userProfile,
      reqOrigin,
      authorizationHeader,
    });
    if (gatedGreeting) return gatedGreeting;

    const bypassMicro = shouldBypassMicroGate(text);

    if (!bypassMicro) {
      const gatedMicro = await runMicroGate({
        supabase,
        conversationId,
        userCode,
        text,
        userProfile,
        reqOrigin,
        authorizationHeader,
        traceId,
      });
      if (gatedMicro) return gatedMicro;
    } else {
      console.log('[IROS/Gate] bypass micro gate (context recall)', {
        conversationId,
        userCode,
        text,
      });
    }

    t.gate_ms = msSince(tg);

    /* ---------------------------
       1) History (single source of truth for this turn)
    ---------------------------- */

    let historyForTurn: unknown[] = Array.isArray(history)
      ? history
      : await loadConversationHistory(supabase, conversationId, 30);

    /* ---------------------------
       1.2) Cross-conversation history (user_code based)
       - 会話IDをまたいで直近履歴を足す
       - source: iros_messages_normalized（user_code がある）
    ---------------------------- */

    type NormMsgRow = {
      id: string;
      conversation_id: string;
      role: string;
      content: string;
      created_at: string;
    };

    async function loadRecentHistoryAcrossConversations(params: {
      supabase: any; // SupabaseClient (admin)
      userCode: string;
      limit?: number;
      excludeConversationId?: string;
    }): Promise<
      Array<{
        id: string;
        conversation_id: string;
        role: 'user' | 'assistant';
        content: string;
        created_at: string;
      }>
    > {
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

      const filtered = rows.filter((r) => {
        const role = String(r.role ?? '').toLowerCase();
        if (role !== 'user' && role !== 'assistant') return false;
        if (!r.content || !String(r.content).trim()) return false;
        if (
          excludeConversationId &&
          String(r.conversation_id) === String(excludeConversationId)
        )
          return false;
        return true;
      });

      // DBは desc なので昇順へ（会話として扱いやすい）
      filtered.reverse();

      return filtered.map((r) => ({
        id: String(r.id),
        conversation_id: String(r.conversation_id),
        role: String(r.role).toLowerCase() as 'user' | 'assistant',
        content: String(r.content ?? ''),
        created_at: String(r.created_at ?? ''),
      }));
    }

    function mergeHistoryForTurn(params: {
      dbHistory: Array<{
        id: string;
        conversation_id: string;
        role: 'user' | 'assistant';
        content: string;
        created_at: string;
      }>;
      turnHistory: any[];
      maxTotal?: number;
    }): any[] {
      const { dbHistory, turnHistory, maxTotal = 80 } = params;

      const normTurn = Array.isArray(turnHistory) ? turnHistory : [];

      const normText = (s: any) =>
        String(s ?? '').replace(/\s+/g, ' ').trim();

      const makeKey = (role: any, text: any) => {
        const r = String(role ?? '').toLowerCase();
        const t = normText(text);
        return `${r}::${t}`;
      };

      const seen = new Set<string>();
      const out: any[] = [];

      // 1) DB履歴（跨ぎ）を先に入れる
      for (const m of dbHistory) {
        const key = makeKey(m.role, m.content);
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

      // 2) 今会話の履歴を後ろへ
      for (const m of normTurn) {
        const role = String(m?.role ?? '').toLowerCase();
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

    try {
      const dbHistory = await loadRecentHistoryAcrossConversations({
        supabase,
        userCode,
        limit: 60,
        // 今会話もDBにあるなら除外したい場合は有効化
        // excludeConversationId: conversationId,
      });

      historyForTurn = mergeHistoryForTurn({
        dbHistory,
        turnHistory: historyForTurn as any[],
        maxTotal: 80,
      });

      console.log('[IROS][HistoryX] merged', {
        userCode,
        dbCount: dbHistory.length,
        mergedCount: historyForTurn.length,
      });
    } catch (e) {
      console.warn('[IROS][HistoryX] merge failed', e);
    }

/* =========================
   Recall gate (generic)
   - 「昨日のあれ」「この前のあれ」「何だっけ」など
   - LLM無しで履歴から“直近の意味ある文”を返す
========================= */

function isRecallQuestion(s: string): boolean {
  const t = (s ?? '').trim();
  if (!t) return false;

  // 「昨日のあれなんだっけ」「この前のやつ」「前回何だった？」など
  return (
    /(昨日|この前|さっき|前回|先週|先日|前の|あれ|それ|あの|その).*(何|なん|どれ|どっち|だった|だっけ|覚えて|思い出)/.test(
      t,
    ) ||
    /(なんでしたっけ|何でしたっけ|何だっけ|なんだっけ|覚えてる\?|覚えてる？|思い出して)/.test(
      t,
    )
  );
}

/**
 * 履歴から “直近の意味ある user 発話” を拾う（汎用）
 * - recall質問・短すぎる相槌・メタ会話を除外
 * - まずは最短実装（スコアリング無し）
 */
function pickRecallCandidateFromHistory(history: any[]): string | null {
  if (!Array.isArray(history) || history.length === 0) return null;

  const norm = (s: any) => String(s ?? '').replace(/\s+/g, ' ').trim();

  const isQuestionLike = (s: string) => {
    if (!s) return true;
    if (/[？?]$/.test(s)) return true;
    if (
      /なんでしたっけ|何でしたっけ|何だっけ|なんだっけ|どれ|どっち|教えて|思い出|覚えて/.test(
        s,
      )
    )
      return true;
    return false;
  };

  // 目標ラベル/汎用ラベル（= 中身がない）を弾く
  const isLabelLike = (s: string) => {
    const t = s.replace(/[。！!]/g, '').trim();
    if (!t) return true;
    if (t === '今日の目標' || t === '目標') return true;
    if (/^(今日の)?目標(は)?(なに|何)?(ですか)?$/.test(t)) return true;

    // 「昨日のあれ」「この前のやつ」だけ、みたいな中身ゼロ
    if (/^(昨日|この前|さっき|前回|先日|前の)\s*(あれ|それ|やつ|件)\s*$/.test(t))
      return true;
    if (/^(あれ|それ|あの|その)\s*(w|笑)?$/.test(t)) return true;

    return false;
  };

  // “意味ある文”の最低条件（超シンプル）
  const looksMeaningful = (s: string) => {
    if (!s) return false;
    if (isQuestionLike(s)) return false;
    if (isLabelLike(s)) return false;

    // 相槌・短すぎ除外
    if (s.length < 8) return false;

    // 開発ログ・構文っぽいのは除外（誤爆防止）
    if (/^(\$|>|\[authz\]|\[IROS\/|GET \/|POST \/)/.test(s)) return false;
    if (/^(rg |sed |npm |npx |curl )/.test(s)) return false;

    return true;
  };

  // 末尾から user の“意味ある文”を1つ拾う
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (!m) continue;
    const role = String(m.role ?? '').toLowerCase();
    if (role !== 'user') continue;

    const s = norm(m.content ?? m.text ?? (m as any).message ?? '');
    if (looksMeaningful(s)) return s;
  }

  return null;
}

/* ---------------------------
   1.5) Generic recall gate（会話の自然接続）
---------------------------- */

{
  // ✅ recall汚染防止：user発話だけに絞る + recallテンプレ除外
  const recallHistory = (historyForTurn as any[])
    .filter((m) => String(m?.role ?? '').toLowerCase() === 'user')
    .filter((m) => {
      const s = norm(m?.content ?? m?.text ?? (m as any)?.message ?? '');
      if (!s) return false;

      // “recallのrecall” 防止（テンプレ文を履歴候補から排除）
      if (/^たぶんこれのことかな：/.test(s)) return false;
      if (/^たぶんこれのことかな：「/.test(s)) return false;

      return true;
    });

  const recall = runGenericRecallGate({
    text,
    history: recallHistory,
  });

  if (recall) {
    const metaForSave = {
      mode: 'light',
      recallOnly: true,
      recallKind: recall.recallKind,
      skipTraining: true,
      nextStep: null,
      next_step: null,
      timing: t,
    };

    await persistAssistantMessage({
      supabase,
      reqOrigin,
      authorizationHeader,
      conversationId,
      userCode,
      assistantText: recall.assistantText,
      metaForSave,
    });

    t.finished_at = nowIso();
    t.total_ms = msSince(t0);

    return {
      ok: true,
      result: { content: recall.assistantText, meta: metaForSave, mode: 'light' },
      assistantText: recall.assistantText,
      metaForSave,
      finalMode: 'light',
    };
  }
}


    /* ---------------------------
       2) Context
    ---------------------------- */

    const tc = nowNs();
    const ctx = await (buildTurnContext as any)({
      supabase,
      conversationId,
      userCode,
      text,
      mode,
      traceId,
      userProfile,
      requestedStyle: style ?? null,
      history: historyForTurn,
    });
    t.context_ms = msSince(tc);

    /* ---------------------------
       3) Orchestrator
    ---------------------------- */

    const to = nowNs();
    const orch = await (runOrchestratorTurn as any)({
      conversationId,
      userCode,
      text,
      isFirstTurn: ctx.isFirstTurn,
      requestedMode: ctx.requestedMode,
      requestedDepth: ctx.requestedDepth,
      requestedQCode: ctx.requestedQCode,
      baseMetaForTurn: ctx.baseMetaForTurn,
      userProfile: userProfile ?? null,
      effectiveStyle: ctx.effectiveStyle,
      history: historyForTurn,
    });
    t.orchestrator_ms = msSince(to);

    /* ---------------------------
       4) PostProcess
    ---------------------------- */

    const tp = nowNs();
    const out = await (postProcessReply as any)({
      supabase,
      userCode,
      conversationId,
      userText: text,
      effectiveStyle: ctx.effectiveStyle,
      requestedMode: ctx.requestedMode,
      orchResult: orch,
      history: historyForTurn,
    });
    t.postprocess_ms = msSince(tp);

    /* ---------------------------
       4.5) Past state note (二重注入防止)
    ---------------------------- */

    try {
      out.metaForSave = out.metaForSave ?? {};
      out.metaForSave.extra = out.metaForSave.extra ?? {};

      const already =
        typeof out.metaForSave.extra.pastStateNoteText === 'string' &&
        out.metaForSave.extra.pastStateNoteText.trim().length > 0;

      if (!already) {
        const { preparePastStateNoteForTurn } = await import(
          '@/lib/iros/memoryRecall'
        );

        const note = await preparePastStateNoteForTurn({
          client: supabase,
          userCode,
          userText: text,
          topicLabel: null,
          limit: 3,
          forceRecentTopicFallback: true,
        });

        out.metaForSave.extra.pastStateNoteText =
          note?.pastStateNoteText ?? null;
        out.metaForSave.extra.pastStateTriggerKind =
          note?.triggerKind ?? null;
        out.metaForSave.extra.pastStateKeyword = note?.keyword ?? null;
      }
    } catch (e) {
      console.warn('[IROS/Reply] pastStateNote inject failed', e);
    }

    /* ---------------------------
       5) Pivot / Timing / Sanitize / Rotation bridge
    ---------------------------- */

    console.log('[IROS/Reply] pivot inputs', {
      prev: ctx.baseMetaForTurn,
      next: out.metaForSave,
    });

    // pivot はログ用途（必要なら meta に入れてもOK）
    try {
      const pivot = computePivot(ctx.baseMetaForTurn, out.metaForSave);
      out.metaForSave = out.metaForSave ?? {};
      out.metaForSave.pivot = pivot;
    } catch (e) {
      console.warn('[IROS/Reply] computePivot failed', e);
    }

    // timing 注入
    out.metaForSave = out.metaForSave ?? {};
    out.metaForSave.timing = t;

    // SUN固定保護
    try {
      out.metaForSave = sanitizeIntentAnchorMeta(out.metaForSave);
    } catch (e) {
      console.warn('[IROS/Reply] sanitizeIntentAnchorMeta failed', e);
    }

    // rotation bridge（最低限）
    try {
      const m: any = out.metaForSave ?? {};
      const rot =
        m.rotation ??
        m.rotationState ??
        m.spin ??
        (m.will && (m.will.rotation ?? m.will.spin)) ??
        null;

      if (rot) {
        m.spinLoop = rot.spinLoop ?? m.spinLoop ?? null;
        m.descentGate = rot.descentGate ?? m.descentGate ?? null;
        m.depth = rot.nextDepth ?? rot.depth ?? m.depth ?? null;

        m.rotationState = {
          spinLoop: m.spinLoop,
          descentGate: m.descentGate,
          depth: m.depth,
          reason: rot.reason ?? undefined,
        };

        out.metaForSave = m;

        console.log('[IROS/Reply] rotation bridge', {
          spinLoop: m.spinLoop,
          descentGate: m.descentGate,
          depth: m.depth,
        });
      }
    } catch (e) {
      console.warn('[IROS/Reply] rotation bridge failed', e);
    }

    /* ---------------------------
       6) Persist (order fixed)
    ---------------------------- */

    {
      const ts = nowNs();

      const t1 = nowNs();
      await persistQCodeSnapshotIfAny({
        userCode,
        conversationId,
        requestedMode: ctx.requestedMode,
        metaForSave: out.metaForSave,
      });
      t.persist_ms.q_snapshot_ms = msSince(t1);

      const t2 = nowNs();
      await persistIntentAnchorIfAny({
        supabase,
        userCode,
        metaForSave: out.metaForSave,
      });
      t.persist_ms.intent_anchor_ms = msSince(t2);

      const t3 = nowNs();

      await persistMemoryStateIfAny({
        supabase,
        userCode,
        userText: text, // ★追加
        metaForSave: out.metaForSave,
      });
      t.persist_ms.memory_state_ms = msSince(t3);

      const t4 = nowNs();
      await persistUnifiedAnalysisIfAny({
        supabase,
        userCode,
        tenantId,
        userText: text,
        assistantText: out.assistantText,
        metaForSave: out.metaForSave,
        conversationId,
      });
      t.persist_ms.unified_analysis_ms = msSince(t4);

      const t5 = nowNs();
      await persistAssistantMessage({
        supabase,
        reqOrigin,
        authorizationHeader,
        conversationId,
        userCode,
        assistantText: out.assistantText,
        metaForSave: out.metaForSave,
      });
      t.persist_ms.assistant_message_ms = msSince(t5);

      t.persist_ms.total_ms = msSince(ts);
    }

    const finalMode =
      typeof (orch as any)?.mode === 'string'
        ? (orch as any).mode
        : (ctx as any).finalMode ?? mode;

    t.finished_at = nowIso();
    t.total_ms = msSince(t0);

    return {
      ok: true,
      result: orch,
      assistantText: out.assistantText,
      metaForSave: out.metaForSave,
      finalMode,
    };
  } catch (e) {
    console.error('[IROS/Reply] handleIrosReply failed', {
      conversationId,
      userCode,
      error: e,
    });

    t.finished_at = nowIso();
    t.total_ms = msSince(t0);

    return {
      ok: false,
      error: 'generation_failed',
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}
