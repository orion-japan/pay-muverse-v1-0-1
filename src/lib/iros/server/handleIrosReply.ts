// file: src/lib/iros/server/handleIrosReply.ts

import { createClient } from '@supabase/supabase-js';
import { updateUserQNowFromMeta } from '@/lib/iros/qSnapshot';

// ★ Qトレース ＋ meta反映
import {
  loadQTraceForUser,
  applyQTraceToMeta,
} from '@/lib/iros/memory.adapter';

// ★ Iros-GIGA 意図アンカー ユーティリティ
import {
  loadIntentAnchorForUser,
  upsertIntentAnchorForUser,
} from '@/lib/iros/intentAnchor';

import { detectQFromText } from '@/lib/iros/q/detectQ';
import { estimateSelfAcceptance } from '@/lib/iros/sa/meter';
import { runIrosTurn } from '@/lib/iros/orchestrator';
import type { QCode, IrosStyle } from '@/lib/iros/system';
import type { RememberScopeKind } from '@/lib/iros/remember/resolveRememberBundle';
import { applyWillDepthDrift } from '@/lib/iros/willEngine';

// ★ 追加：トピック変化モジュール
import {
  detectTopicChangeRequest,
  loadTopicChangeContext,
  formatTopicChangeForPrompt,
} from '@/lib/iros/topicChange';

// ★ 追加：過去状態リコールユーティリティ
import { preparePastStateNoteForTurn } from '@/lib/iros/memoryRecall';

// ★ 追加：v_iros_user_profile の型
import type { IrosUserProfileRow } from './loadUserProfile';

// ★ 追加：Polarity / Stability 計算ロジック
import { computePolarityAndStability } from '@/lib/iros/analysis/polarity';

// ★ 追加：MemoryState（3軸）保存ユーティリティ
import { upsertIrosMemoryState } from '@/lib/iros/memoryState';

// ★ 追加：v_iros_topic_state_latest の型（必要な項目だけ）
type TopicStateLatestRow = {
  topic_key?: string | null;
  topic?: string | null;
  topic_label?: string | null;
  last_used_at?: string | null;
};

// Supabase(Iros内部用)
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

// ★ Iros ユーザープロファイルの style を更新（or 挿入）
async function upsertIrosUserStyle(userCode: string, style: string | null) {
  if (!style) return;

  try {
    const { error } = await supabase
      .from('iros_user_profile') // ← 実際のテーブル名に合わせて変更
      .upsert({
        user_code: userCode,
        style,
        updated_at: new Date().toISOString(),
      });

    if (error) {
      console.error('[IROS/UserProfile] upsert style failed', {
        userCode,
        style,
        error,
      });
    } else {
      console.log('[IROS/UserProfile] upsert style ok', {
        userCode,
        style,
      });
    }
  } catch (e) {
    console.error('[IROS/UserProfile] upsert style unexpected error', {
      userCode,
      style,
      error: e,
    });
  }
}

// ★★★ 追加：user_code → user_id(uuid) を解決するヘルパー
type IrosUserMapRow = {
  user_id: string;
};

async function resolveUserIdFromUserCode(
  userCode: string,
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('iros_user_map')
      .select('user_id')
      .eq('user_code', userCode)
      .maybeSingle();

    if (error) {
      console.error('[IROS/UserMap] failed to resolve user_id from user_code', {
        userCode,
        error,
      });
      return null;
    }

    if (!data) return null;

    const row = data as IrosUserMapRow;
    if (!row.user_id) return null;

    return row.user_id;
  } catch (e) {
    console.error(
      '[IROS/UserMap] unexpected error in resolveUserIdFromUserCode',
      {
        userCode,
        error: e,
      },
    );
    return null;
  }
}

// I層100%モード（ENVベース）
const FORCE_I_LAYER = process.env.IROS_FORCE_I_LAYER === '1';

// ---------- UnifiedAnalysis ロジック ----------

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

// ★ 追加：Supabase(PostgREST)に投げる前に「純粋な JSON」にクリーンアップするヘルパー
function makePostgrestSafePayload<T extends Record<string, any>>(
  payload: T,
): T | null {
  try {
    // JSON.stringify できない値（BigInt, 関数, Symbol, 循環参照など）があるとここで落ちる
    const json = JSON.stringify(payload);
    if (!json) return null;
    return JSON.parse(json) as T;
  } catch (e) {
    console.error(
      '[UnifiedAnalysis] payload JSON serialize failed',
      e,
      payload,
    );
    return null;
  }
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


// ★ 追加：assistant返答から【IROS_STATE_META】の JSON を抜き出すヘルパー
function extractIrosStateMetaFromAssistant(
  text: string | null | undefined,
): any | null {
  if (!text) return null;

  const marker = '【IROS_STATE_META】';
  const idx = text.lastIndexOf(marker);
  if (idx === -1) return null;

  // マーカー以降の部分から JSON ブロックを探す
  const after = text.slice(idx + marker.length);
  const startIdx = after.indexOf('{');
  if (startIdx === -1) return null;

  let depth = 0;
  let endRelIdx = -1;

  for (let i = startIdx; i < after.length; i++) {
    const ch = after[i];
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        endRelIdx = i;
        break;
      }
    }
  }

  if (endRelIdx === -1) return null;

  const jsonStr = after.slice(startIdx, endRelIdx + 1);

  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error(
      '[IROS/StateMeta] failed to parse IROS_STATE_META JSON',
      e,
      jsonStr,
    );
    return null;
  }
}



  // ★ Supabase へ投げる前に、一度 payload を構築
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

  // ★ ここで「JSON として安全な形」にクリーンアップ
  const safeLogPayload = makePostgrestSafePayload(logPayload);

  if (!safeLogPayload) {
    console.error(
      '[UnifiedAnalysis] log insert skipped: payload not JSON-serializable',
    );
  } else {
    const { error: logErr } = await supabase
      .from('unified_resonance_logs')
      .insert(safeLogPayload);

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

  const isSameQ = prev?.last_q === qCode;
  const streak = isSameQ ? (prev?.streak_count ?? 0) + 1 : 1;

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
    .upsert(safeStatePayload);

  if (stateErr) {
    console.error('[UnifiedAnalysis] state upsert failed', stateErr);
    return;
  }
}

// ---------- Q 簡易 fallback 判定ロジック ----------

function detectQFallbackFromText(
  text: string | null | undefined,
): string | null {
  if (!text) return null;
  const t = text.trim();
  if (!t) return null;

  const hasAnger = /怒|イライラ|腹立|キレそう|むかつ|苛立/.test(t);
  const hasAnxiety = /不安|心配|落ち着かない|そわそわ|緊張/.test(t);
  const hasFear = /怖い|恐い|恐怖|怯え|トラウマ/.test(t);
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
   会話履歴ダイジェスト（GPS的な位置ログ用）
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
    console.error(
      '[IROS/TopicChange] unexpected error in resolveLatestTopicKey',
      {
        userCode,
        error: e,
      },
    );
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

// UnifiedAnalysis の結果を「直近の user メッセージ」に反映する
async function applyAnalysisToLastUserMessage(params: {
  conversationId: string;
  analysis: UnifiedAnalysis;
}) {
  const { conversationId, analysis } = params;

  try {
    // 1) 直近の user メッセージ 1件を取得
    const { data: row, error: selectErr } = await supabase
      .from('iros_messages')
      .select('id')
      .eq('conversation_id', conversationId)
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

    // 2) q_code / depth_stage を更新
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

    console.log(
      '[UnifiedAnalysis] user message q_code/depth_stage updated',
      {
        conversationId,
        messageId,
        q_code: analysis.q_code ?? null,
        depth_stage: analysis.depth_stage ?? null,
      },
    );
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
    style, // ★ 追加
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

    // 2) 会話履歴ダイジェスト（GPS的位置情報的に使う）
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

    // ★ user_code → user_id(uuid) を一度だけ解決して、このターンで使い回す
    const userId = await resolveUserIdFromUserCode(userCode);

    // ★★★ 3.0）「過去状態を一緒に見たい」トリガー検知 ＋ カルテ生成
    let pastStateNoteText: string | null = null;
    let hasPastStateNote = false;

    try {
      const recall = await preparePastStateNoteForTurn({
        client: supabase,
        userCode,
        userText: text,
        topicLabel: null, // TODO: topic が取れたらここに渡す
        limit: 3,
      });

      pastStateNoteText = recall.pastStateNoteText;
      hasPastStateNote = recall.hasNote;

      console.log('[IROS/MemoryRecall] pastStateNoteText prepared', {
        userCode,
        hasNote: recall.hasNote,
        triggerKind: recall.triggerKind,
        keyword: recall.keyword ?? null,
      });
    } catch (e) {
      console.warn('[IROS/MemoryRecall] error while preparing pastStateNote', {
        userCode,
        error: e,
      });
    }

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

    // 決まった effectiveStyle を DB にも反映
    if (effectiveStyle && typeof effectiveStyle === 'string') {
      await upsertIrosUserStyle(userCode, effectiveStyle);
    }

    // ★★★ 3.2) user_id(uuid) と Iros-GIGA 意図アンカーを読み込み
    let intentAnchorForTurn: {
      text: string;
      strength: number | null;
      y_level: number | null;
      h_level: number | null;
    } | null = null;

    try {
      if (userId) {
        const anchorRow = await loadIntentAnchorForUser(supabase, userId);
        if (anchorRow) {
          intentAnchorForTurn = {
            text: anchorRow.anchor_text,
            strength: anchorRow.intent_strength ?? null,
            y_level: anchorRow.y_level ?? null,
            h_level: anchorRow.h_level ?? null,
          };
        }
      } else {
        console.log('[IROS/IntentAnchor] user_id not found for userCode', {
          userCode,
        });
      }
    } catch (e) {
      console.error('[IROS/IntentAnchor] failed to load anchor for turn', {
        userCode,
        error: e,
      });
    }

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

    // ★★★ Intent Anchor を extra にも積んでおく（LLM side で参照しやすくする）
    if (intentAnchorForTurn) {
      extra.intentAnchor = intentAnchorForTurn;
    }

    // ★★★ MemoryRecall：過去カルテが取れたら extra に格納（LLM 用の内部メモ）
    if (pastStateNoteText) {
      extra.pastStateNoteText = pastStateNoteText;
    }

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

    // ★★★ Intent Anchor を meta のトップレベルにも載せておく（orchestrator 側からも参照しやすい形）
    if (intentAnchorForTurn) {
      baseMetaForTurn.intent_anchor = intentAnchorForTurn;
    }

    if (!FORCE_I_LAYER_LOCAL && baseMetaFromQ.depth) {
      baseMetaForTurn.depth = baseMetaFromQ.depth as any;
    }
    if (baseMetaFromQ.qCode != null) {
      baseMetaForTurn.qCode = baseMetaFromQ.qCode as any;
    }

    // ★ 履歴ダイジェストは「GPS 的な位置情報」として meta に渡す。
    if (historyDigest && historyDigest.trim().length > 0) {
      baseMetaForTurn.historyDigest = historyDigest;
    }

    // ★★ シンプル構想：LLM に渡すテキストは「今回のユーザー発言」そのものだけ。
    //     以前のような「【これまでの流れ（要約）】〜【今回のユーザー発言】」ラップは廃止。
    const effectiveText = text;

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
      style: effectiveStyle, // ← effectiveStyle をそのまま渡す
    });

    // ★ WILL（Depth drift）を unified にだけ適用し、meta.depth にも反映
    (() => {
      const metaAny: any = (result as any)?.meta ?? null;
      const unifiedBefore: any = metaAny?.unified ?? null;
      if (!unifiedBefore) return;

      const unifiedAfter = applyWillDepthDrift(unifiedBefore);

      const depthAfter: string | undefined =
        (unifiedAfter?.depth?.stage as string | undefined) ??
        (metaAny?.depth as string | undefined);

      (result as any).meta = {
        ...metaAny,
        unified: unifiedAfter,
        depth: depthAfter,
      };

      console.log('[WILL][after]', {
        depthBefore: unifiedBefore?.depth,
        depthAfter: unifiedAfter?.depth,
        depthTopLevel: depthAfter,
      });
    })();

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
    let assistantText: string =
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

      if (metaForSave && typeof metaForSave === 'object') {
        try {
          const m: any = metaForSave;

// ★ assistantText 内の 【IROS_STATE_META】 をパースして meta にマージ
try {
  const match = assistantText.match(
    /【IROS_STATE_META】({[\s\S]*?})/,
  );
  if (match && match[1]) {
    const raw = match[1].trim();
    const payload = JSON.parse(raw);

    if (typeof payload.selfAcceptance === 'number') {
      m.selfAcceptance = payload.selfAcceptance;
    }
    if (typeof payload.yLevel === 'number') {
      m.yLevel = payload.yLevel;
    }
    if (typeof payload.hLevel === 'number') {
      m.hLevel = payload.hLevel;
    }
    if (typeof payload.depth === 'string') {
      m.depth = payload.depth;
    }
    if (typeof payload.qCode === 'string') {
      m.qCode = payload.qCode;
    }
    if (typeof payload.phase === 'string') {
      m.phase = payload.phase;
    }
    if (typeof payload.mode === 'string') {
      m.mode = payload.mode;
    }
    if (typeof payload.tLayerModeActive === 'boolean') {
      m.tLayerModeActive = payload.tLayerModeActive;
    }
    if (typeof payload.tLayerHint === 'string') {
      m.tLayerHint = payload.tLayerHint;
    }
    if (typeof payload.hasFutureMemory === 'boolean') {
      m.hasFutureMemory = payload.hasFutureMemory;
    }
    if (typeof payload.irTargetType === 'string') {
      m.irTargetType = payload.irTargetType;
    }
    if (typeof payload.irTargetText === 'string') {
      m.irTargetText = payload.irTargetText;
    }
    if (typeof payload.pierceMode === 'boolean') {
      m.pierceMode = payload.pierceMode;
    }
    if (typeof payload.pierceReason === 'string') {
      m.pierceReason = payload.pierceReason;
    }
    if (payload.intentLine && typeof payload.intentLine === 'object') {
      m.intentLine = payload.intentLine;
    }
    if (payload.soulNote && typeof payload.soulNote === 'object') {
      m.soulNote = payload.soulNote;
    }

    console.log('[IROS/StateMeta] merged from IROS_STATE_META', {
      phase: m.phase,
      depth: m.depth,
      qCode: m.qCode,
      selfAcceptance: m.selfAcceptance,
      yLevel: m.yLevel,
      hLevel: m.hLevel,
    });

    // ★ メタ JSON 部分を本文から削除しておく（ここが重要）
    assistantText = assistantText
      .replace(/【IROS_STATE_META】({[\s\S]*?})/, '')
      .trim();
  }
} catch (e) {
  console.error(
    '[IROS/StateMeta] failed to parse IROS_STATE_META from assistantText',
    e,
  );
}


          const unified = m.unified ?? {};


          // --- ここは既にある Pol/Stab 用の処理 ---
          const qCodeForPol: string | null =
            (m.qCode as string | undefined) ??
            (m.q_code as string | undefined) ??
            (unified?.q?.current as string | undefined) ??
            null;

          const saForPol: number | null =
            typeof m.selfAcceptance === 'number'
              ? m.selfAcceptance
              : typeof m.self_acceptance === 'number'
              ? m.self_acceptance
              : typeof unified?.self_acceptance === 'number'
              ? unified.self_acceptance
              : null;

          const yLevelRaw =
            m.yLevel ?? m.y_level ?? unified?.yLevel ?? unified?.y_level ?? null;

          let yLevelForPol: number | null = null;
          if (typeof yLevelRaw === 'number') {
            yLevelForPol = yLevelRaw;
          } else if (
            typeof yLevelRaw === 'string' &&
            yLevelRaw.trim() !== '' &&
            !Number.isNaN(Number(yLevelRaw))
          ) {
            yLevelForPol = Number(yLevelRaw);
          }

          const pol = computePolarityAndStability({
            qCode: (qCodeForPol as any) ?? null,
            selfAcceptance: saForPol,
            yLevel: yLevelForPol,
          });

          m.polarityScore = pol.polarityScore;
          m.polarityBand = pol.polarityBand;
          m.stabilityBand = pol.stabilityBand;

          m.polarity_score = pol.polarityScore;
          m.polarity_band = pol.polarityBand;
          m.stability_band = pol.stabilityBand;

          // ============================
          // ★ mirror / I-layer / intent
          // ============================

          // mirror 列 → 実際に使われたモード
          const modeFromResult: string | undefined =
            typeof (result as any)?.mode === 'string'
              ? (result as any).mode
              : typeof m.mode === 'string'
              ? m.mode
              : undefined;

          if (modeFromResult && modeFromResult.trim().length > 0) {
            // ★ meta.mirror に入れる（カラム名 mirror に合わせる）
            m.mirror = modeFromResult.trim();
          }

          // I-layer 列 → depth が I層ならその depth を入れる
          const depthForLayer: string | null =
            (m.depth as string | undefined) ??
            (m.depth_stage as string | undefined) ??
            (unified?.depth?.stage as string | undefined) ??
            null;

          if (depthForLayer && depthForLayer.startsWith('I')) {
            // 例: I1 / I2 / I3
            m.i_layer = depthForLayer;
          } else {
            m.i_layer = null;
          }

          // intent 列 → intent_anchor.text の短い要約
          const ia = m.intent_anchor;
          if (ia && typeof ia.text === 'string') {
            const label = ia.text.trim();
            m.intent =
              label.length > 40 ? label.slice(0, 40) + '…' : label;
          }
        } catch (e) {
          console.error(
            '[IROS/Reply] computePolarityAndStability / mirror / i_layer / intent failed',
            e,
          );
        }
      }


    // ★★★ Iros-GIGA：meta に intent_anchor が入っていたら DB に upsert（初回抽出＆更新）
    if (userId && metaForSave && typeof metaForSave === 'object') {
      const ia: any = (metaForSave as any).intent_anchor;
      // 想定フォーマット：{ text: string, strength?: number, y_level?: number, h_level?: number }
      if (ia && typeof ia.text === 'string' && ia.text.trim().length > 0) {
        try {
          await upsertIntentAnchorForUser(supabase, {
            userId,
            anchorText: ia.text.trim(),
            intentStrength:
              typeof ia.strength === 'number' ? ia.strength : null,
            yLevel: typeof ia.y_level === 'number' ? ia.y_level : null,
            hLevel: typeof ia.h_level === 'number' ? ia.h_level : null,
          });
          console.log('[IROS/IntentAnchor] upsert from metaForSave', {
            userCode,
            userId,
            anchorText: ia.text.trim(),
          });
        } catch (e) {
          console.error(
            '[IROS/IntentAnchor] failed to upsert from metaForSave',
            {
              userCode,
              userId,
              error: e,
            },
          );
        }
      }
    }

    // ★★★ MemoryState：meta / unified から 3軸状態を iros_memory_state に保存
    if (metaForSave && typeof metaForSave === 'object') {
      try {
        const m: any = metaForSave;
        const unified = m.unified ?? {};

        const qPrimary: string | null =
          (m.qCode as string | undefined) ??
          (m.q_code as string | undefined) ??
          (unified?.q?.current as string | undefined) ??
          null;

        const depthStageForState: string | null =
          (m.depth as string | undefined) ??
          (m.depth_stage as string | undefined) ??
          (unified?.depth?.stage as string | undefined) ??
          null;

        // === Phase（Inner/Outer） ===
        const phaseRaw: string | null =
          (m.phase as string | undefined) ??
          (unified?.phase as string | undefined) ??
          null;

        let phaseForState: 'Inner' | 'Outer' | null = null;
        if (typeof phaseRaw === 'string' && phaseRaw.trim().length > 0) {
          const p = phaseRaw.trim().toLowerCase();
          if (p === 'inner') {
            phaseForState = 'Inner';
          } else if (p === 'outer') {
            phaseForState = 'Outer';
          }
        }

        const selfAcceptanceRawForState: unknown =
          typeof m.selfAcceptance === 'number'
            ? m.selfAcceptance
            : typeof m.self_acceptance === 'number'
            ? m.self_acceptance
            : typeof unified?.self_acceptance === 'number'
            ? unified.self_acceptance
            : null;

        const selfAcceptanceForState = clampSelfAcceptance(
          selfAcceptanceRawForState,
        );

        // === IntentLayer（S/R/C/I/T） ===
        let intentLayerForState: string | null = null;

        const intentLayerRaw: unknown =
          // 直接入っているケース
          (m.intentLayer as string | undefined) ??
          (m.intent_layer as string | undefined) ??
          // meta.intentLine / meta.intent_line 経由
          (m.intentLine?.focusLayer as string | undefined) ??
          (m.intent_line?.focusLayer as string | undefined) ??
          // unified.intentLine / unified.intent_line 経由
          (unified?.intentLine?.focusLayer as string | undefined) ??
          (unified?.intent_line?.focusLayer as string | undefined) ??
          null;

        if (
          typeof intentLayerRaw === 'string' &&
          intentLayerRaw.trim().length > 0
        ) {
          const il = intentLayerRaw.trim().toUpperCase();
          // S/R/C/I/T はそのまま、それ以外は一応保存だけしておく
          if (['S', 'R', 'C', 'I', 'T'].includes(il)) {
            intentLayerForState = il;
          } else {
            intentLayerForState = intentLayerRaw.trim();
          }
        }

        // === IntentConfidence（0.0〜1.0想定） ===
        let intentConfidenceForState: number | null = null;
        const intentConfidenceRaw: unknown =
          typeof m.intentConfidence === 'number'
            ? m.intentConfidence
            : typeof m.intent_confidence === 'number'
            ? m.intent_confidence
            : typeof m.intentLine?.confidence === 'number'
            ? m.intentLine.confidence
            : typeof m.intent_line?.confidence === 'number'
            ? m.intent_line.confidence
            : typeof unified?.intentLine?.confidence === 'number'
            ? unified.intentLine.confidence
            : typeof unified?.intent_line?.confidence === 'number'
            ? unified.intent_line.confidence
            : null;

        if (
          typeof intentConfidenceRaw === 'number' &&
          Number.isFinite(intentConfidenceRaw)
        ) {
          intentConfidenceForState = intentConfidenceRaw;
        }

        let yLevelForState: number | null = null;
        const yLevelRawForState: unknown =
          typeof m.yLevel === 'number'
            ? m.yLevel
            : typeof m.y_level === 'number'
            ? m.y_level
            : typeof unified?.yLevel === 'number'
            ? unified.yLevel
            : typeof unified?.y_level === 'number'
            ? unified.y_level
            : null;

        if (
          typeof yLevelRawForState === 'number' &&
          Number.isFinite(yLevelRawForState)
        ) {
          yLevelForState = yLevelRawForState;
        }

        let hLevelForState: number | null = null;
        const hLevelRawForState: unknown =
          typeof m.hLevel === 'number'
            ? m.hLevel
            : typeof m.h_level === 'number'
            ? m.h_level
            : typeof unified?.hLevel === 'number'
            ? unified.hLevel
            : typeof unified?.h_level === 'number'
            ? unified.h_level
            : null;

        if (
          typeof hLevelRawForState === 'number' &&
          Number.isFinite(hLevelRawForState)
        ) {
          hLevelForState = hLevelRawForState;
        }

        const situationSummaryForState: string | null =
          typeof m.situationSummary === 'string'
            ? m.situationSummary
            : typeof unified?.situation?.summary === 'string'
            ? unified.situation.summary
            : null;

        const situationTopicForState: string | null =
          typeof m.situationTopic === 'string'
            ? m.situationTopic
            : typeof unified?.situation?.topic === 'string'
            ? unified.situation.topic
            : null;

        const sentimentLevelForState: string | null =
          typeof m.sentiment_level === 'string'
            ? m.sentiment_level
            : typeof unified?.sentiment_level === 'string'
            ? unified.sentiment_level
            : typeof unified?.sentiment === 'string'
            ? unified.sentiment
            : null;

        await upsertIrosMemoryState({
          userCode,
          depthStage: depthStageForState ?? null,
          qPrimary,
          selfAcceptance: selfAcceptanceForState,
          phase: phaseForState,
          intentLayer: intentLayerForState,
          intentConfidence: intentConfidenceForState,
          yLevel: yLevelForState,
          hLevel: hLevelForState,
          situationSummary: situationSummaryForState,
          situationTopic: situationTopicForState,
          sentiment_level: sentimentLevelForState,
        });

        console.log('[IROS/MemoryState] upsert from metaForSave ok', {
          userCode,
          depthStage: depthStageForState,
          qPrimary,
          phase: phaseForState,
          intentLayer: intentLayerForState,
          yLevel: yLevelForState,
          hLevel: hLevelForState,
          sentiment_level: sentimentLevelForState,
        });
      } catch (e) {
        console.error(
          '[IROS/MemoryState] upsert from metaForSave failed',
          {
            userCode,
            error: e,
          },
        );
      }
    }


    if (assistantText && assistantText.trim().length > 0) {
      try {
        const analysis = await buildUnifiedAnalysis({
          userText: text,
          assistantText,
          meta: metaForSave,
        });

        // ① unified_resonance_logs / user_resonance_state への保存
        await saveUnifiedAnalysisInline(analysis, {
          userCode,
          tenantId,
          agent: 'iros',
        });

        // ② 直近の user メッセージに Q / depth_stage を反映
        await applyAnalysisToLastUserMessage({
          conversationId,
          analysis,
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
