// file: src/lib/iros/server/handleIrosReply.analysis.ts
//
// UnifiedAnalysis を構築・保存し、直近 user message に反映する処理を分離。
// handleIrosReply.ts を「配線（orchestrator）」に戻すための切り出し。

import type { SupabaseClient } from '@supabase/supabase-js';
import { ensureIrosConversationUuid } from './ensureIrosConversationUuid';

import { detectQFromText } from '@/lib/iros/q/detectQ';
import { estimateSelfAcceptance } from '@/lib/iros/sa/meter';
import {
  clampSelfAcceptance,
  makePostgrestSafePayload,
  detectQFallbackFromText,
} from './handleIrosReply.pure';

export type UnifiedAnalysis = {
  q_code: string | null;
  depth_stage: string | null;
  phase: string | null;
  self_acceptance: number | null;
  relation_tone: string | null;
  keywords: string[];
  summary: string | null;
  raw: any;

  /**
   * orchestrator が生成した unified（必要なら保持）
   * ※ save 時に unified.q.current へ fallback を反映するために使う
   */
  unified?: any;
};

export async function buildUnifiedAnalysis(params: {
  userText: string;
  assistantText: string;
  meta: any;
}): Promise<UnifiedAnalysis> {
  const { userText, assistantText, meta } = params;
  const safeMeta = meta ?? {};
  const safeAssistant =
    typeof assistantText === 'string'
      ? assistantText
      : String(assistantText ?? '');

  // orchestrator で整えた unified を最優先で使う
  const unified = safeMeta.unified ?? {};

  const unifiedQ =
    unified && unified.q && typeof unified.q.current === 'string'
      ? unified.q.current
      : null;

  const unifiedDepth =
    unified && unified.depth && typeof unified.depth.stage === 'string'
      ? unified.depth.stage
      : null;

  const unifiedPhase =
    unified && typeof unified.phase === 'string' ? unified.phase : null;

  // ---- Q / Depth / Phase ----
  const qCode = unifiedQ ?? safeMeta.qCode ?? safeMeta.q_code ?? null;
  const depthStage =
    unifiedDepth ?? safeMeta.depth ?? safeMeta.depth_stage ?? null;
  const phase = unifiedPhase ?? safeMeta.phase ?? null;

  // ---- Self Acceptance（0.0〜1.0 スケール）----
  let selfAcceptanceRaw: number | null =
    typeof safeMeta.selfAcceptance === 'number'
      ? safeMeta.selfAcceptance
      : typeof safeMeta.self_acceptance === 'number'
        ? safeMeta.self_acceptance
        : typeof unified?.self_acceptance === 'number'
          ? unified.self_acceptance
          : null;

  // meta/unified に無いときだけ meter.ts v2 で推定
  if (selfAcceptanceRaw == null) {
    try {
      const saResult: any = await estimateSelfAcceptance({
        userText,
        assistantText,
        qCode,
        depthStage,
        phase: phase ?? null,
        historyDigest: null,
        lastSelfAcceptance: null,
      });

      if (typeof saResult === 'number') {
        selfAcceptanceRaw = saResult;
      } else if (saResult && typeof saResult.value === 'number') {
        selfAcceptanceRaw = saResult.value;
      } else if (saResult && typeof saResult.normalized === 'number') {
        selfAcceptanceRaw = saResult.normalized;
      } else if (saResult && typeof saResult.score === 'number') {
        selfAcceptanceRaw = saResult.score;
      }
    } catch (e) {
      console.error(
        '[UnifiedAnalysis] estimateSelfAcceptance fallback failed',
        e,
      );
    }
  }

  const selfAcceptance = clampSelfAcceptance(selfAcceptanceRaw);

  return {
    q_code: qCode,
    depth_stage: depthStage,
    phase,
    self_acceptance: selfAcceptance,
    relation_tone: safeMeta.relation_tone ?? null,
    keywords: Array.isArray(safeMeta.keywords) ? safeMeta.keywords : [],
    summary:
      typeof safeMeta.summary === 'string' && safeMeta.summary.trim().length > 0
        ? safeMeta.summary
        : safeAssistant
          ? safeAssistant.slice(0, 60)
          : null,
    raw: {
      user_text: userText,
      assistant_text: safeAssistant,
      meta: safeMeta,
    },
    unified,
  };
}

export async function saveUnifiedAnalysisInline(
  supabase: SupabaseClient,
  analysis: UnifiedAnalysis,
  context: {
    userCode: string;
    tenantId: string;
    agent: string;
  },
) {
  // 0) まず Q フィールドを決定する（既存優先＋fallback）
  let qCode: string | null = analysis.q_code;

  if (!qCode) {
    const raw = analysis.raw ?? {};
    const userText: string | null =
      typeof raw.user_text === 'string' ? raw.user_text : null;

    if (userText && userText.trim().length > 0) {
      try {
        const detected = await detectQFromText(userText);
        if (detected) qCode = detected;

        // ✅ 追加：unified 側にも反映（未設定の時だけ）
        const u: any = analysis.unified ?? null;
        if (detected && u) {
          const cur =
            u?.q && typeof u.q.current === 'string' ? u.q.current : null;
          if (!cur) {
            u.q = { ...(u.q ?? {}), current: detected };
          }
        }
      } catch (e) {
        console.error(
          '[UnifiedAnalysis] detectQFromText failed, fallback to simple keyword',
          e,
        );

        const fallback = detectQFallbackFromText(userText);
        if (fallback) qCode = fallback;

        // ✅ 追加：fallback でも unified 側に反映（未設定の時だけ）
        const u: any = analysis.unified ?? null;
        if (fallback && u) {
          const cur =
            u?.q && typeof u.q.current === 'string' ? u.q.current : null;
          if (!cur) {
            u.q = { ...(u.q ?? {}), current: fallback };
          }
        }
      }
    }
  }

  analysis.q_code = qCode ?? null;

  // payload
  const logPayload = {
    tenant_id: context.tenantId,
    user_code: context.userCode,
    agent: context.agent,
    q_code: qCode,
    depth_stage: analysis.depth_stage,
    phase: analysis.phase,
    self_acceptance: analysis.self_acceptance,
    relation_tone: analysis.relation_tone,
    keywords: analysis.keywords,
    summary: analysis.summary,
    raw: analysis.raw ?? null,
  };

  const safeLogPayload = makePostgrestSafePayload(logPayload);

  if (!safeLogPayload) {
    console.error(
      '[UnifiedAnalysis] log insert skipped: payload not JSON-serializable',
    );
  } else {
    const { error: logErr } = await supabase
      .from('unified_resonance_logs')
      .insert(safeLogPayload as any);

    if (logErr) {
      console.error('[UnifiedAnalysis] log insert failed', logErr);
      return;
    }
  }

  const { data: prev, error: prevErr } = await supabase
    .from('user_resonance_state')
    .select('*')
    .eq('user_code', context.userCode)
    .eq('tenant_id', context.tenantId)
    .maybeSingle();

  if (prevErr) {
    console.error('[UnifiedAnalysis] state load failed', prevErr);
    return;
  }

  const isSameQ = (prev as any)?.last_q === qCode;
  const streak = isSameQ ? ((prev as any)?.streak_count ?? 0) + 1 : 1;

  const statePayload = {
    user_code: context.userCode,
    tenant_id: context.tenantId,
    last_q: qCode,
    last_depth: analysis.depth_stage,
    last_phase: analysis.phase,
    last_self_acceptance: analysis.self_acceptance,
    streak_q: qCode,
    streak_count: streak,
    updated_at: new Date().toISOString(),
  };

  const safeStatePayload = makePostgrestSafePayload(statePayload);

  if (!safeStatePayload) {
    console.error(
      '[UnifiedAnalysis] state upsert skipped: payload not JSON-serializable',
    );
    return;
  }

  const { error: stateErr } = await supabase
    .from('user_resonance_state')
    .upsert(safeStatePayload as any);

  // ✅ user_resonance_state upsert の直後（関数内）
  if (stateErr) {
    console.error('[IROS][ResonanceState] upsert failed', {
      userCode: context.userCode,
      tenantId: context.tenantId,
      qCode,
      depthStage: analysis.depth_stage,
      phase: analysis.phase,
      message: stateErr.message,
      details: (stateErr as any)?.details,
      hint: (stateErr as any)?.hint,
    });

    throw new Error(`user_resonance_state upsert failed: ${stateErr.message}`);
  }

  console.log('[IROS][ResonanceState] upsert ok', {
    userCode: context.userCode,
    tenantId: context.tenantId,
    qCode,
    depthStage: analysis.depth_stage,
    phase: analysis.phase,
  });
}

export async function applyAnalysisToLastUserMessage(params: {
  supabase: SupabaseClient;
  conversationId: string;
  userCode: string;
  analysis: UnifiedAnalysis;
}) {
  const { supabase, conversationId, userCode, analysis } = params;

  // ✅ conversationId が既に内部uuidなら、そのまま使う
  //    uuidでない場合だけ conversationKey として uuid を解決する
  const rawConv = String(conversationId ?? '').trim();
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  const conversationUuid = UUID_RE.test(rawConv)
    ? rawConv
    : await ensureIrosConversationUuid({
        supabase,
        userCode,
        conversationKey: rawConv,
        agent: null,
      });


  try {
    const { data: row, error: selectErr } = await supabase
      .from('iros_messages')
      .select('id')
      .eq('conversation_id', conversationUuid)
      .eq('role', 'user')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();


    if (selectErr) {
      console.error(
        '[UnifiedAnalysis] failed to load last user message for update',
        {
          conversationId,
          error: selectErr,
        },
      );
      return;
    }

    if (!row || !(row as any).id) {
      console.log(
        '[UnifiedAnalysis] no user message found to update q_code/depth_stage',
        { conversationId },
      );
      return;
    }

    const messageId = (row as { id: string }).id;

    const { error: updateErr } = await supabase
      .from('iros_messages')
      .update({
        q_code: analysis.q_code ?? null,
        depth_stage: analysis.depth_stage ?? null,
      })
      .eq('id', messageId);

    if (updateErr) {
      console.error(
        '[UnifiedAnalysis] failed to update user message q_code/depth_stage',
        {
          conversationId,
          messageId,
          error: updateErr,
        },
      );
      return;
    }

    console.log('[UnifiedAnalysis] user message q_code/depth_stage updated', {
      conversationId,
      messageId,
      q_code: analysis.q_code ?? null,
      depth_stage: analysis.depth_stage ?? null,
    });
  } catch (e) {
    console.error(
      '[UnifiedAnalysis] unexpected error while updating user message',
      {
        conversationId,
        error: e,
      },
    );
  }
}
