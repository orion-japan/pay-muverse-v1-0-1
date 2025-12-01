// file: src/lib/iros/server/handleIrosReply.ts

import { createClient } from '@supabase/supabase-js';
import { updateUserQNowFromMeta } from '@/lib/iros/qSnapshot';
import { loadQTraceForUser, applyQTraceToMeta } from '@/lib/iros/memory.adapter';
import { detectQFromText } from '@/lib/iros/q/detectQ';
import { estimateSelfAcceptance } from '@/lib/iros/sa/meter';
import { runIrosTurn } from '@/lib/iros/orchestrator';
import type { QCode, IrosStyle } from '@/lib/iros/system';
import type { RememberScopeKind } from '@/lib/iros/remember/resolveRememberBundle';

// ★ 追加：トピック変化モジュール
import {
  detectTopicChangeRequest,
  loadTopicChangeContext,
  formatTopicChangeForPrompt,
} from '@/lib/iros/topicChange';

// ★ 追加：v_iros_topic_state_latest の型（必要な項目だけ）
type TopicStateLatestRow = {
  topic_key?: string | null;
  topic?: string | null;
  topic_label?: string | null;
  last_used_at?: string | null;
};

// ★ 追加：v_iros_user_profile の型
import type { IrosUserProfileRow } from './loadUserProfile';

// Supabase（Iros内部用）
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

// I層100%モード（ENVベース）
const FORCE_I_LAYER = process.env.IROS_FORCE_I_LAYER === '1';

// ---------- UnifiedAnalysis ロジック（元 route.ts と同じ） ----------

type UnifiedAnalysis = {
  q_code: string | null;
  depth_stage: string | null;
  phase: string | null;
  self_acceptance: number | null;
  relation_tone: string | null;
  keywords: string[];
  summary: string | null;
  raw: any;
};

function clampSelfAcceptance(value: unknown): number | null {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;

  // 0.0〜1.0 にクランプ
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

async function buildUnifiedAnalysis(params: {
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
    unified &&
    unified.q &&
    typeof unified.q.current === 'string'
      ? unified.q.current
      : null;

  const unifiedDepth =
    unified &&
    unified.depth &&
    typeof unified.depth.stage === 'string'
      ? unified.depth.stage
      : null;

  const unifiedPhase =
    unified && typeof unified.phase === 'string' ? unified.phase : null;

  // ---- Q / Depth / Phase ----
  const qCode =
    unifiedQ ?? safeMeta.qCode ?? safeMeta.q_code ?? null;

  const depthStage =
    unifiedDepth ?? safeMeta.depth ?? safeMeta.depth_stage ?? null;

  const phase =
    unifiedPhase ?? safeMeta.phase ?? null;

  // ---- Self Acceptance（0.0〜1.0 スケール）----
  let selfAcceptanceRaw: number | null =
    typeof safeMeta.selfAcceptance === 'number'
      ? safeMeta.selfAcceptance
      : typeof safeMeta.self_acceptance === 'number'
      ? safeMeta.self_acceptance
      : typeof unified?.self_acceptance === 'number'
      ? unified.self_acceptance
      : null;

  // ★ ここは「保険用」：meta/unified に無いときだけ meter.ts v2 で推定
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
      typeof safeMeta.summary === 'string' &&
      safeMeta.summary.trim().length > 0
        ? safeMeta.summary
        : safeAssistant
        ? safeAssistant.slice(0, 60)
        : null,
    raw: {
      user_text: userText,
      assistant_text: safeAssistant,
      meta: safeMeta,
    },
  };
}

// UnifiedAnalysis を DB に保存（Q推定 + 状態アップデートまで）
async function saveUnifiedAnalysisInline(
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
      (typeof raw.user_text === 'string' ? raw.user_text : null) ?? null;

    if (userText && userText.trim().length > 0) {
      try {
        const detected = await detectQFromText(userText);
        if (detected) {
          qCode = detected;
        }
      } catch (e) {
        console.error(
          '[UnifiedAnalysis] detectQFromText failed, fallback to simple keyword',
          e,
        );
        const fallback = detectQFallbackFromText(userText);
        if (fallback) {
          qCode = fallback;
        }
      }
    }
  }

  analysis.q_code = qCode ?? null;

  const { error: logErr } = await supabase
    .from('unified_resonance_logs')
    .insert({
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
      raw: analysis.raw,
    });

  if (logErr) {
    console.error('[UnifiedAnalysis] log insert failed', logErr);
    return;
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

  const isSameQ = prev?.last_q === qCode;
  const streak = isSameQ ? (prev?.streak_count ?? 0) + 1 : 1;

  const { error: stateErr } = await supabase
    .from('user_resonance_state')
    .upsert({
      user_code: context.userCode,
      tenant_id: context.tenantId,
      last_q: qCode,
      last_depth: analysis.depth_stage,
      last_phase: analysis.phase,
      last_self_acceptance: analysis.self_acceptance,
      streak_q: qCode,
      streak_count: streak,
      updated_at: new Date().toISOString(),
    });

  if (stateErr) {
    console.error('[UnifiedAnalysis] state upsert failed', stateErr);
    return;
  }
}

// ---------- Q 簡易 fallback 判定ロジック（元 route.ts） ----------

function detectQFallbackFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const t = text.trim();
  if (!t) return null;

  const hasAnger =
    /怒|イライラ|腹立|キレそう|むかつ|苛立/.test(t);
  const hasAnxiety =
    /不安|心配|落ち着かない|そわそわ|緊張/.test(t);
  const hasFear =
    /怖い|恐い|恐怖|怯え|トラウマ/.test(t);
  const hasEmptiness =
    /空虚|虚し|むなしい|燃え尽き|やる気が出ない|情熱がわかない/.test(t);
  const hasSuppress =
    /我慢|耐えて|抑えて|無理して|遠慮して/.test(t);

  if (hasAnger) return 'Q2';
  if (hasAnxiety) return 'Q3';
  if (hasFear) return 'Q4';
  if (hasEmptiness) return 'Q5';
  if (hasSuppress) return 'Q1';

  return null;
}

/* =========================================================
   会話履歴ダイジェスト
========================================================= */

const MAX_HISTORY_ROWS = 30;
const MAX_HISTORY_CHARS = 4000;

type HistoryRow = {
  role: string | null;
  content: string | null;
  text: string | null;
};

async function buildConversationHistoryDigest(
  conversationId: string,
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('iros_messages')
      .select('role, content, text')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[IROS/History] failed to load messages', {
        conversationId,
        error,
      });
      return null;
    }

    if (!data || data.length === 0) return null;

    const sliced = data.slice(-MAX_HISTORY_ROWS);

    const lines: string[] = [];
    for (const row of sliced as HistoryRow[]) {
      const rawText = (row.content ?? row.text ?? '') || '';
      const trimmed = rawText.replace(/\s+/g, ' ').trim();
      if (!trimmed) continue;

      const isAssistant = row.role === 'assistant';
      const label = isAssistant ? 'Iros' : 'あなた';

      lines.push(`${label}: ${trimmed}`);
    }

    if (lines.length === 0) return null;

    let joined = lines.join('\n');

    if (joined.length > MAX_HISTORY_CHARS) {
      joined = joined.slice(joined.length - MAX_HISTORY_CHARS);
    }

    return joined;
  } catch (e) {
    console.error('[IROS/History] unexpected error', {
      conversationId,
      error: e,
    });
    return null;
  }
}

/* =========================================================
   トピック変化モード：最新トピックの推定
========================================================= */

/**
 * v_iros_topic_state_latest から、このユーザーの「直近で使われたトピック」を 1 件取得。
 * いまのところは last_used_at 降順で 1件だけ見る簡易版。
 */
async function resolveLatestTopicKeyForUser(
  userCode: string,
): Promise<{ topicKey: string; topicLabel: string | null } | null> {
  try {
    const { data, error } = await supabase
      .from('v_iros_topic_state_latest')
      .select('topic_key, topic, topic_label, last_used_at')
      .eq('user_code', userCode)
      .order('last_used_at', { ascending: false })
      .limit(1);

    if (error) {
      console.error('[IROS/TopicChange] failed to load latest topic', {
        userCode,
        error,
      });
      return null;
    }

    const row = (data && data[0]) as TopicStateLatestRow | undefined;
    if (!row) return null;

    const topicKey =
      (row.topic_key && row.topic_key.trim()) ||
      (row.topic && row.topic.trim()) ||
      null;

    if (!topicKey) return null;

    const topicLabel =
      (row.topic_label && row.topic_label.trim()) ||
      (row.topic && row.topic.trim()) ||
      null;

    return { topicKey, topicLabel };
  } catch (e) {
    console.error('[IROS/TopicChange] unexpected error in resolveLatestTopicKey', {
      userCode,
      error: e,
    });
    return null;
  }
}

// ---------- 外部から呼ぶ Iros サーバー本処理 ----------

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

  // ★ 追加：route.ts から渡すユーザープロファイル
  userProfile?: IrosUserProfileRow | null;

  // ★ 追加：Iros の口調スタイル（任意）
  style?: IrosStyle | string | null;
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

export async function handleIrosReply(
  params: HandleIrosReplyInput,
): Promise<HandleIrosReplyOutput> {
  const {
    conversationId,
    text,
    hintText,
    mode,
    userCode,
    tenantId,
    rememberScope,
    reqOrigin,
    authorizationHeader,
    traceId,
    userProfile, // ★ 追加
    style,       // ★ 追加
  } = params;

  console.log('[IROS/Reply] handleIrosReply start', {
    conversationId,
    userCode,
    mode,
    tenantId,
    rememberScope,
    traceId,
    FORCE_I_LAYER,
    style, // ★ ログ
  });

  // ★ プロファイル確認ログ
  console.log('[IROS/Reply] userProfile for turn', {
    userCode,
    hasProfile: !!userProfile,
    plan_status: userProfile?.plan_status ?? null,
    sofia_credit: userProfile?.sofia_credit ?? null,
  });

  try {
    // 1) isFirstTurn 判定
    let isFirstTurn = false;
    try {
      const { count: messageCount, error: msgErr } = await supabase
        .from('iros_messages')
        .select('id', { count: 'exact', head: true })
        .eq('conversation_id', conversationId);

      if (msgErr) {
        console.error(
          '[IROS/Reply] failed to count messages for conversation',
          {
            conversationId,
            error: msgErr,
          },
        );
      } else {
        isFirstTurn = (messageCount ?? 0) === 0;
      }
    } catch (e) {
      console.error(
        '[IROS/Reply] unexpected error when counting messages',
        {
          conversationId,
          error: e,
        },
      );
    }

    console.log('[IROS/Reply] isFirstTurn', {
      conversationId,
      isFirstTurn,
    });

    // 2) 会話履歴ダイジェスト
    let historyDigest: string | null = null;
    if (!isFirstTurn) {
      historyDigest = await buildConversationHistoryDigest(conversationId);
      console.log('[IROS/History] digest length', {
        conversationId,
        hasDigest: !!historyDigest,
        length: historyDigest?.length ?? 0,
      });
    }

    // 3) Iros メモリ読み込み
    console.log('[IROS/Memory] loadQTraceForUser start', { userCode });

    const qTrace = await loadQTraceForUser(userCode, { limit: 50 });

    console.log('[IROS/Memory] qTrace', {
      snapshot: qTrace.snapshot,
      counts: qTrace.counts,
      streakQ: qTrace.streakQ,
      streakLength: qTrace.streakLength,
      lastEventAt: qTrace.lastEventAt,
    });

    const baseMetaFromQ = applyQTraceToMeta(
      {
        qCode: undefined,
        depth: undefined,
      },
      qTrace,
    );

    const FORCE_I_LAYER_LOCAL = FORCE_I_LAYER;

    // 3.1) このターンで使う「effectiveStyle」を決定
    const styleFromProfile: string | null =
      userProfile && typeof (userProfile as any).style === 'string'
        ? ((userProfile as any).style as string)
        : null;

    const effectiveStyle: IrosStyle | string | null =
      (style && typeof style === 'string' && style.trim().length > 0
        ? style
        : null) ?? styleFromProfile ?? null;

    console.log('[IROS/Reply] effectiveStyle', {
      requestedStyle: style,
      styleFromProfile,
      effectiveStyle,
    });


    const requestedMode =
      FORCE_I_LAYER_LOCAL
        ? ('mirror' as any)
        : mode === 'auto'
        ? undefined
        : (mode as any);

    const requestedDepth = FORCE_I_LAYER_LOCAL
      ? ('I2' as any)
      : (baseMetaFromQ.depth as any);

    // 3.5) トピック別の現在地（optional）
    const topicStateMap: Record<string, any> | null = null;

    // ★ プロファイル + トピック現在地 + トピック変化情報を含めた baseMeta を組み立てる
    const extra: any = {};
    if (userProfile) extra.userProfile = userProfile;
    if (topicStateMap) extra.topicStateMap = topicStateMap;
    if (effectiveStyle) extra.styleHint = effectiveStyle; // ★ style ヒントも入れておく
    // ★ ここで「変化を一緒に見て欲しい」リクエストかどうかを判定し、
    //    直近トピックの前回/今回スナップショットを LLM 用文字列として用意する。
    let topicChangePromptBlock: string | null = null;
    try {
      const wantsTopicChangeView = detectTopicChangeRequest(text);
      if (wantsTopicChangeView) {
        const latestTopic = await resolveLatestTopicKeyForUser(userCode);
        if (latestTopic) {
          const changeCtx = await loadTopicChangeContext({
            client: supabase,
            userCode,
            topicKey: latestTopic.topicKey,
            topicLabel: latestTopic.topicLabel,
            limit: 2,
          });
          if (changeCtx) {
            topicChangePromptBlock = formatTopicChangeForPrompt(changeCtx);
            console.log('[IROS/TopicChange] prepared topicChangePromptBlock', {
              userCode,
              topicKey: latestTopic.topicKey,
            });
          } else {
            console.log(
              '[IROS/TopicChange] not enough samples for topicChange',
              {
                userCode,
                topicKey: latestTopic.topicKey,
              },
            );
          }
        } else {
          console.log(
            '[IROS/TopicChange] latest topic not found for user',
            { userCode },
          );
        }
      }
    } catch (e) {
      console.error('[IROS/TopicChange] prepare failed', {
        userCode,
        error: e,
      });
    }

    if (topicChangePromptBlock) {
      extra.topicChangeRequested = true;
      extra.topicChangePrompt = topicChangePromptBlock;
    }

    const baseMetaForTurn: any = {};
    if (Object.keys(extra).length > 0) {
      baseMetaForTurn.extra = extra;
    }

    // ★ ここで style を meta に直接反映（getSystemPrompt まで届く）
    if (effectiveStyle) {
      baseMetaForTurn.style = effectiveStyle as any;
    }


    if (!FORCE_I_LAYER_LOCAL && baseMetaFromQ.depth) {
      baseMetaForTurn.depth = baseMetaFromQ.depth as any;
    }
    if (baseMetaFromQ.qCode != null) {
      baseMetaForTurn.qCode = baseMetaFromQ.qCode as any;
    }

    const effectiveText =
      historyDigest && historyDigest.trim().length > 0
        ? `【これまでの流れ（要約）】\n${historyDigest}\n\n【今回のユーザー発言】\n${text}`
        : text;

    let requestedQCode: QCode | undefined = undefined;
    try {
      const detected = await detectQFromText(text);
      if (detected) {
        requestedQCode = detected as QCode;
      }
    } catch (e) {
      console.error(
        '[IROS/Reply] detectQFromText failed (orchestrator path)',
        e,
      );
    }

    const result = await runIrosTurn({
      conversationId,
      text: effectiveText,
      requestedMode,
      requestedDepth,
      requestedQCode,
      baseMeta: baseMetaForTurn,
      isFirstTurn,
      userCode,
      userProfile: userProfile ?? null,
      style: effectiveStyle,  // ← ここを修正
    });


    console.log('[IROS/Orchestrator] result.meta', (result as any)?.meta);

    // Qスナップショット更新
    try {
      await updateUserQNowFromMeta(supabase, userCode, (result as any)?.meta);
    } catch (e) {
      console.error(
        '[IROS/Reply] failed to update user_q_now from meta',
        e,
      );
    }

    // assistant 本文抽出
    const assistantText: string =
      result && typeof result === 'object'
        ? (() => {
            const r: any = result;
            if (
              typeof r.content === 'string' &&
              r.content.trim().length > 0
            )
              return r.content;
            if (typeof r.text === 'string' && r.text.trim().length > 0)
              return r.text;
            return JSON.stringify(r);
          })()
        : String(result ?? '');

    const metaRaw =
      result &&
      typeof result === 'object' &&
      (result as any).meta
        ? (result as any).meta
        : null;

    const metaForSave =
      metaRaw && typeof metaRaw === 'object'
        ? {
            ...metaRaw,
          }
        : metaRaw;

    if (assistantText && assistantText.trim().length > 0) {
      try {
        const analysis = await buildUnifiedAnalysis({
          userText: text,
          assistantText,
          meta: metaForSave,
        });

        await saveUnifiedAnalysisInline(analysis, {
          userCode,
          tenantId,
          agent: 'iros',
        });
      } catch (e) {
        console.error(
          '[IROS/Reply] failed to save unified analysis',
          e,
        );
      }

      // /messages API に保存
      try {
        const msgUrl = new URL('/api/agent/iros/messages', reqOrigin);

        await fetch(msgUrl.toString(), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: authorizationHeader ?? '',
            'x-user-code': userCode,
          },
          body: JSON.stringify({
            conversation_id: conversationId,
            role: 'assistant',
            text: assistantText,
            meta: metaForSave,
          }),
        });
      } catch (e) {
        console.error(
          '[IROS/Reply] failed to persist assistant message',
          e,
        );
      }
    }

    const finalMode =
      result &&
      typeof result === 'object' &&
      typeof (result as any).mode === 'string'
        ? (result as any).mode
        : mode;

    return {
      ok: true,
      result,
      assistantText,
      metaForSave,
      finalMode,
    };
  } catch (e: any) {
    console.error(
      '[IROS/Reply] generation_failed (inside handleIrosReply)',
      e,
    );

    return {
      ok: false,
      error: 'generation_failed',
      detail: e?.message ?? String(e),
    };
  }
}
