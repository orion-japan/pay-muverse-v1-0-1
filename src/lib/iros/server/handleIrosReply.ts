// file: src/lib/iros/server/handleIrosReply.ts

import type { IrosStyle } from '@/lib/iros/system';
import type { RememberScopeKind } from '@/lib/iros/remember/resolveRememberBundle';
import type { IrosUserProfileRow } from './loadUserProfile';

import { getIrosSupabaseAdmin } from './handleIrosReply.supabase';

import { runGreetingGate, runMicroGate } from './handleIrosReply.gates';

import { buildTurnContext } from './handleIrosReply.context';
import { runOrchestratorTurn } from './handleIrosReply.orchestrator';

import { postProcessReply } from './handleIrosReply.postprocess';

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

async function loadConversationHistory(
  supabase: any,
  conversationId: string,
  limit = 30,
): Promise<unknown[]> {
  try {
    const { data, error } = await supabase
      .from('iros_messages')
      .select('role, text, content, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(limit);

    if (error) {
      console.error('[IROS/History] load failed', { conversationId, error });
      return [];
    }

    return (data ?? []).map((m: any) => ({
      role: m?.role,
      content:
        typeof m?.content === 'string'
          ? m.content
          : typeof m?.text === 'string'
            ? m.text
            : '',
    }));
  } catch (e) {
    console.error('[IROS/History] unexpected', { conversationId, error: e });
    return [];
  }
}



/** timing 計測（Node専用。Next runtime=nodejs 前提） */
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

/** intentAnchor のテキストを“どの形でも”拾う（段階的移行に強くする） */
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

  // どちらも無いなら何もしない
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
  | 'PIVOT_ENTER_CENTER' // Q3に入った
  | 'PIVOT_EXIT_CENTER' // Q3から出た
  | 'PIVOT_SHIFT_Q' // Qが変わった（Q3絡み以外含む）
  | 'PIVOT_MOVE_DEPTH' // Qは同じだが depth が動いた
  | 'PIVOT_SHIFT_PHASE' // phase が Inner/Outer で切り替わった
  | 'PIVOT_SHIFT_YH' // y/h が動いた（揺らぎ転換）
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

  // y/h（揺らぎ）: どのキーでも拾う
  const prevY = toNumOrNull(prevMeta?.y_level ?? prevMeta?.yLevel ?? prevMeta?.y);
  const nextY = toNumOrNull(nextMeta?.y_level ?? nextMeta?.yLevel ?? nextMeta?.y);
  const prevH = toNumOrNull(prevMeta?.h_level ?? prevMeta?.hLevel ?? prevMeta?.h);
  const nextH = toNumOrNull(nextMeta?.h_level ?? nextMeta?.hLevel ?? nextMeta?.h);

  // 変化量（y/h は 0.5 以上の変化を転換扱いにする：暫定）
  const yhMoved =
    (prevY !== null && nextY !== null && Math.abs(nextY - prevY) >= 0.5) ||
    (prevH !== null && nextH !== null && Math.abs(nextH - prevH) >= 0.5);

  const qChanged = prevQ !== null && nextQ !== null && prevQ !== nextQ;
  const depthChanged =
    prevDepth !== null && nextDepth !== null && prevDepth !== nextDepth;
  const phaseChanged =
    prevPhase !== null && nextPhase !== null && prevPhase !== nextPhase;

  // strength（暫定）
  const strength: IrosPivot['strength'] =
    (qChanged && (prevQ === 'Q3' || nextQ === 'Q3')) ||
    (depthChanged && phaseChanged)
      ? 'strong'
      : qChanged || depthChanged || phaseChanged || yhMoved
        ? 'mid'
        : 'weak';

  // --- Q3中心の転換点 ---
  if (!qChanged && prevQ === nextQ && prevQ === 'Q3') {
    // Q3内で動いたなら MOVE_DEPTH/PHASE/YH を優先
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

  // --- Qの変化がある場合 ---
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

  // --- Qが同じでも位置が動いた場合 ---
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

export async function handleIrosReply(
  params: HandleIrosReplyInput,
): Promise<HandleIrosReplyOutput> {
  const t0 = nowNs();
  const startedAt = nowIso();

  const t: any = {
    started_at: startedAt,
    finished_at: startedAt,
    total_ms: 0,

    // ステージ別
    gate_ms: 0,
    context_ms: 0,
    orchestrator_ms: 0,
    postprocess_ms: 0,

    // 永続化の内訳
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

    /** ✅ 追加：履歴（Writer/LLMへ） */
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
    // 0) 軽量ゲート（挨拶 / 超短文）
    {
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
      if (gatedGreeting) {
        t.gate_ms = msSince(tg);
        t.finished_at = nowIso();
        t.total_ms = msSince(t0);

        // gate 応答にも timing を乗せる（UI/CSVで確認できる）
        try {
          (gatedGreeting as any).metaForSave =
            (gatedGreeting as any).metaForSave ?? {};
          (gatedGreeting as any).metaForSave.timing = t;
        } catch {}

        return gatedGreeting;
      }

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
      if (gatedMicro) {
        t.gate_ms = msSince(tg);
        t.finished_at = nowIso();
        t.total_ms = msSince(t0);

        try {
          (gatedMicro as any).metaForSave =
            (gatedMicro as any).metaForSave ?? {};
          (gatedMicro as any).metaForSave.timing = t;
        } catch {}

        return gatedMicro;
      }

      t.gate_ms = msSince(tg);
    }

    // ✅ history が来てない場合は DB から補完（LLMに会話の流れを渡す）
    const historyForTurn: unknown[] = Array.isArray(history)
      ? history
      : await loadConversationHistory(supabase, conversationId, 30);

    // 1) 文脈を組み立てる
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

      /** ✅ 履歴を context にも渡す（必要な層が拾えるように） */
      history: historyForTurn,
    });
    t.context_ms = msSince(tc);

    // 2) 司令塔：オーケストレーター呼び出し
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

      /** ✅ Orchestrator / Writer に履歴を渡す */
      history: historyForTurn,
    });
    t.orchestrator_ms = msSince(to);

    // 3) 後処理（WILL drift / Soul failsafe / renderEngine / meta補強）
    const tp = nowNs();
    const out = await (postProcessReply as any)({
      supabase,
      userCode,
      conversationId,
      userText: text,
      effectiveStyle: ctx.effectiveStyle,
      requestedMode: ctx.requestedMode,
      orchResult: orch,

      /** ✅ PostProcess（= Writer 呼び出しが居るならここ）にも履歴 */
      history: historyForTurn,
    });
    t.postprocess_ms = msSince(tp);

// ★ past state note を meta.extra に載せる（LLMに渡す用）
// - PostProcess 側ですでに注入している場合は二重計算しない
{
  out.metaForSave = out.metaForSave ?? {};
  out.metaForSave.extra = out.metaForSave.extra ?? {};

  const already =
    typeof out.metaForSave.extra.pastStateNoteText === 'string' &&
    out.metaForSave.extra.pastStateNoteText.trim().length > 0;

  if (!already) {
    const { preparePastStateNoteForTurn } = await import('@/lib/iros/memoryRecall');

    const note = await preparePastStateNoteForTurn({
      client: supabase,
      userCode,
      userText: text,
      topicLabel: null,
      limit: 3,
      forceRecentTopicFallback: true,
    });

    out.metaForSave.extra.pastStateNoteText = note?.pastStateNoteText ?? null;
    out.metaForSave.extra.pastStateTriggerKind = note?.triggerKind ?? null;
    out.metaForSave.extra.pastStateKeyword = note?.keyword ?? null;
  }
}


    console.log('[IROS/Reply] pivot inputs', {
      prev: ctx.baseMetaForTurn,
      next: out.metaForSave,
    });

    // ★ timing を meta に注入（これが ops/iros-logs と CSV に乗る）
    out.metaForSave = out.metaForSave ?? {};
    out.metaForSave.timing = t;

    // ★★★★★ 北極星事故を止血（SUN固定は守る）
    try {
      out.metaForSave = sanitizeIntentAnchorMeta(out.metaForSave);
    } catch (e) {
      console.warn('[IROS/Reply] sanitizeIntentAnchorMeta failed', e);
    }

    // ★ rotation 永続化のための最低限の橋渡し
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

        // depth は nextDepth 優先（なければ既存 depth）
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


    // 4) 永続化（順番だけここに残す）
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
      typeof orch?.mode === 'string' ? orch.mode : (ctx.finalMode ?? mode);

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
