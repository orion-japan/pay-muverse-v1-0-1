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
import { buildResonanceVector } from '@/lib/iros/language/resonanceVector';
import { renderReply } from '@/lib/iros/language/renderReply';
import { writeQCodeWithEnv } from '@/lib/qcode/qcode-adapter';

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




/* =========================================================
   ヘルパー：assistant返答から【IROS_STATE_META】の JSON を抜き出す
========================================================= */

function extractIrosStateMetaFromAssistant(
  text: string | null | undefined,
): any | null {
  if (!text) return null;

  const marker = '【IROS_STATE_META】';
  const idx = text.lastIndexOf(marker);
  if (idx === -1) return null;

  const after = text.slice(idx + marker.length);

  // JSON の開始位置（最初の { ）を探す
  const startIdx = after.indexOf('{');
  if (startIdx === -1) return null;

  // 文字列リテラル中の { } を誤カウントしない
  let depth = 0;
  let endRelIdx = -1;
  let inString = false;
  let escape = false;

  for (let i = startIdx; i < after.length; i++) {
    const ch = after[i];

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') depth++;
    else if (ch === '}') {
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

/* =========================================================
   Q フォールバック（detectQFromText が落ちた時の最低限）
========================================================= */

// 返り値は "Q1"〜"Q5" or null
function detectQFallbackFromText(
  text: string | null | undefined,
): QCode | null {
  const t = (text ?? '').toLowerCase();

  // Q2: 怒り/攻撃/不満
  if (/怒|ムカ|腹立|イラ|苛立|不満|キレ|許せ|攻撃|文句|憤/.test(t)) {
    return 'Q2';
  }

  // Q4: 恐怖/不安（恐れ寄り）/危機
  if (/怖|恐|不安|心配|怖い|恐い|危険|危機|震え|パニック|怯/.test(t)) {
    return 'Q4';
  }

  // Q3: 不安（安定欲求）/迷い/落ち着かない
  if (/不安|迷|焦|落ち着|モヤ|ぐるぐる|疲|しんど|つら|重い/.test(t)) {
    return 'Q3';
  }

  // Q1: 我慢/抑圧/秩序/耐える
  if (
    /我慢|耐|抑|抑え|ちゃんと|きちんと|ルール|正し|責任|秩序/.test(t)
  ) {
    return 'Q1';
  }

  // Q5: 空虚/虚しさ/燃え尽き/意味の喪失
  if (/空虚|虚|むな|意味ない|無意味|燃え尽|無気力|冷め|空っぽ/.test(t)) {
    return 'Q5';
  }

  return null;
}

/* =========================================================
   型/定義
========================================================= */



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
      .from('iros_user_profile')
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

/* =========================================================
   Final Polish：最後の文章見直し（違和感の除去・整形）
   - renderEngine 後の “最終整形” として使う
========================================================= */

function finalPolishIrosText(
  input: string,
  opts?: {
    style?: string | null;
    qNow?: string | null;
  },
): string {
  if (typeof input !== 'string') return String(input ?? '');
  let t = input;

  // 1) ありがちな違和感フレーズを除去（末尾や単独行に出やすい）
  // 例: 「〜の要素が混ざっていそうです。」が挨拶や短文に混ざると変
  t = t.replace(
    /\n*\s*([^\n]{0,40}の要素が混ざっていそうです。)\s*\n*/g,
    '\n',
  );

  // 2) 連続する同一行（コピペ/レンダ重複）を抑制
  const lines = t.split('\n');
  const compact: string[] = [];
  for (const line of lines) {
    const cur = line.replace(/\s+/g, ' ').trim();
    const prev = compact.length ? compact[compact.length - 1].replace(/\s+/g, ' ').trim() : '';
    if (!cur) {
      // 空行は後でまとめる
      compact.push('');
      continue;
    }
    if (cur === prev) continue; // 完全重複行を除去
    compact.push(line);
  }
  t = compact.join('\n');

  // 3) 改行の整形：空行は最大2つまで
  t = t.replace(/\n{3,}/g, '\n\n');

  // 4) 末尾の空白/改行を除去
  t = t.trim();

  // 5) Q4/Q1のとき、語尾が強すぎる命令形にならないように軽く丸める（保守的）
  const qNow = opts?.qNow ?? null;
  if (qNow === 'Q4' || qNow === 'Q1') {
    t = t
      .replace(/してください。$/g, 'しても大丈夫です。')
      .replace(/しましょう。$/g, 'してみてもいいです。');
  }

  return t;
}


// ★★★ user_code → user_id(uuid) を解決するヘルパー
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
    console.error('[IROS/UserMap] unexpected error in resolveUserIdFromUserCode', {
      userCode,
      error: e,
    });
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
    unified && unified.q && typeof unified.q.current === 'string'
      ? unified.q.current
      : null;

  const unifiedDepth =
    unified && unified.depth && typeof unified.depth.stage === 'string'
      ? unified.depth.stage
      : null;

  const unifiedPhase = unified && typeof unified.phase === 'string'
    ? unified.phase
    : null;

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
      console.error('[UnifiedAnalysis] estimateSelfAcceptance fallback failed', e);
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
  };
}

// Supabase(PostgREST)に投げる前に「純粋な JSON」にクリーンアップ
function makePostgrestSafePayload<T extends Record<string, any>>(
  payload: T,
): T | null {
  try {
    const json = JSON.stringify(payload);
    if (!json) return null;
    return JSON.parse(json) as T;
  } catch (e) {
    console.error('[UnifiedAnalysis] payload JSON serialize failed', e, payload);
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
      typeof raw.user_text === 'string' ? raw.user_text : null;

    if (userText && userText.trim().length > 0) {
      try {
        const detected = await detectQFromText(userText);
        if (detected) qCode = detected;
      } catch (e) {
        console.error(
          '[UnifiedAnalysis] detectQFromText failed, fallback to simple keyword',
          e,
        );
        const fallback = detectQFallbackFromText(userText);
        if (fallback) qCode = fallback;
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
    console.error('[UnifiedAnalysis] log insert skipped: payload not JSON-serializable');
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
    console.error('[UnifiedAnalysis] state upsert skipped: payload not JSON-serializable');
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


// ★ situation_topic を確実に付与（Training/集計/MemoryState の舵取り）
// 優先：meta → snake_case → unified → extra.pastStateNoteText から抽出 → 既定値
function resolveSituationTopicFromMeta(meta: any): string | null {
  const m: any = meta ?? {};
  const unified: any = m?.unified ?? {};
  const note: any = m?.extra?.pastStateNoteText;

  const fromMeta =
    typeof m.situationTopic === 'string' && m.situationTopic.trim().length > 0
      ? m.situationTopic.trim()
      : null;

  const fromSnake =
    typeof m.situation_topic === 'string' && m.situation_topic.trim().length > 0
      ? m.situation_topic.trim()
      : null;

  const fromUnified =
    typeof unified?.situation_topic === 'string' &&
    unified.situation_topic.trim().length > 0
      ? unified.situation_topic.trim()
      : typeof unified?.situation?.topic === 'string' &&
        unified.situation.topic.trim().length > 0
      ? unified.situation.topic.trim()
      : null;

  const fromNote = (() => {
    if (typeof note !== 'string' || note.trim().length === 0) return null;

    const m1 = note.match(/対象トピック:\s*([^\n\r]+)/);
    const m2 = note.match(/対象トピック\s*([^\n\r]+)/);

    const picked =
      m1 && m1[1]
        ? String(m1[1]).trim()
        : m2 && m2[1]
        ? String(m2[1]).trim()
        : null;

    return picked && picked.length > 0 ? picked : null;
  })();

  return fromMeta ?? fromSnake ?? fromUnified ?? fromNote ?? null;
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

  // ★ route.ts から渡すユーザープロファイル
  userProfile?: IrosUserProfileRow | null;

  // ★ Iros の口調スタイル（任意）
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
    const { data: row, error: selectErr } = await supabase
      .from('iros_messages')
      .select('id')
      .eq('conversation_id', conversationId)
      .eq('role', 'user')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (selectErr) {
      console.error('[UnifiedAnalysis] failed to load last user message for update', {
        conversationId,
        error: selectErr,
      });
      return;
    }

    if (!row || !(row as any).id) {
      console.log('[UnifiedAnalysis] no user message found to update q_code/depth_stage', {
        conversationId,
      });
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
      console.error('[UnifiedAnalysis] failed to update user message q_code/depth_stage', {
        conversationId,
        messageId,
        error: updateErr,
      });
      return;
    }

    console.log('[UnifiedAnalysis] user message q_code/depth_stage updated', {
      conversationId,
      messageId,
      q_code: analysis.q_code ?? null,
      depth_stage: analysis.depth_stage ?? null,
    });
  } catch (e) {
    console.error('[UnifiedAnalysis] unexpected error while updating user message', {
      conversationId,
      error: e,
    });
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
    userProfile,
    style,
  } = params;

  console.log('[IROS/Reply] handleIrosReply start', {
    conversationId,
    userCode,
    mode,
    tenantId,
    rememberScope,
    traceId,
    FORCE_I_LAYER,
    style,
  });

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
        console.error('[IROS/Reply] failed to count messages for conversation', {
          conversationId,
          error: msgErr,
        });
      } else {
        isFirstTurn = (messageCount ?? 0) === 0;
      }
    } catch (e) {
      console.error('[IROS/Reply] unexpected error when counting messages', {
        conversationId,
        error: e,
      });
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

    // user_code → user_id(uuid)
    const userId = await resolveUserIdFromUserCode(userCode);

    // 3.0）過去状態ノート生成
    let pastStateNoteText: string | null = null;

    try {
      const recall = await preparePastStateNoteForTurn({
        client: supabase,
        userCode,
        userText: text,
        topicLabel: null,
        limit: 3,
      });

      pastStateNoteText = recall.pastStateNoteText;

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

    // 3.1) effectiveStyle 決定
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

    if (effectiveStyle && typeof effectiveStyle === 'string') {
      await upsertIrosUserStyle(userCode, effectiveStyle);
    }

    // 3.2) Intent Anchor 読み込み
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

// 3.5) topicStateMap（今は未使用）
const topicStateMap: Record<string, any> | null = null;

const extra: any = {};
if (userProfile) extra.userProfile = userProfile;
if (topicStateMap) extra.topicStateMap = topicStateMap;
if (effectiveStyle) extra.styleHint = effectiveStyle;

if (intentAnchorForTurn) {
  // ★ intentAnchor は「保存・表示」では int に揃える（1.5 などを残さない）
  const fixedAnchor: any = { ...intentAnchorForTurn };

  // raw 値（snake/camel 両対応）
  const yRaw = fixedAnchor.y_level ?? fixedAnchor.yLevel;
  const hRaw = fixedAnchor.h_level ?? fixedAnchor.hLevel;

  if (typeof yRaw === 'number') fixedAnchor.y_level = Math.round(yRaw);
  if (typeof hRaw === 'number') fixedAnchor.h_level = Math.round(hRaw);

  // camelCase が混ざると後段でブレるので消しておく（任意だけど推奨）
  delete fixedAnchor.yLevel;
  delete fixedAnchor.hLevel;

  extra.intentAnchor = fixedAnchor;
}


if (pastStateNoteText) {
  extra.pastStateNoteText = pastStateNoteText;
}


    // トピック変化ビュー用
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
            console.log('[IROS/TopicChange] not enough samples for topicChange', {
              userCode,
              topicKey: latestTopic.topicKey,
            });
          }
        } else {
          console.log('[IROS/TopicChange] latest topic not found for user', {
            userCode,
          });
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

    if (effectiveStyle) {
      baseMetaForTurn.style = effectiveStyle as any;
    }
    if (intentAnchorForTurn) {
      baseMetaForTurn.intent_anchor = intentAnchorForTurn;
    }

    if (!FORCE_I_LAYER_LOCAL && baseMetaFromQ.depth) {
      baseMetaForTurn.depth = baseMetaFromQ.depth as any;
    }
    if (baseMetaFromQ.qCode != null) {
      baseMetaForTurn.qCode = baseMetaFromQ.qCode as any;
    }

    if (historyDigest && historyDigest.trim().length > 0) {
      baseMetaForTurn.historyDigest = historyDigest;
    }

    // LLM に渡すテキストは今回のユーザー発言のみ
    const effectiveText = text;

    let requestedQCode: QCode | undefined = undefined;
    try {
      const detected = await detectQFromText(text);
      if (detected) requestedQCode = detected as QCode;
    } catch (e) {
      console.error('[IROS/Reply] detectQFromText failed (orchestrator path)', e);
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
      style: effectiveStyle,
    });

    // WILL（Depth drift）を unified にだけ適用し、meta.depth にも反映
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

// ✅ Qコード保存（統一入口）→ q_code_logs / q_code_timeline_store / user_q_now を一括更新
try {
  const m: any = (result as any)?.meta ?? null;
  const unified: any = m?.unified ?? null;

  const q: any = m?.qCode ?? m?.q_code ?? unified?.q?.current ?? null;
  const stage: any = m?.depth ?? m?.depth_stage ?? unified?.depth?.stage ?? null;

  // layer/polarity は現状 meta から確実に取れてないので安全デフォルト
  const layer: any = 'inner';
  const polarity: any = 'now';

  if (q) {
    await writeQCodeWithEnv({
      user_code: userCode,
      source_type: 'iros',
      intent: requestedMode ?? 'auto',
      q,
      stage,
      layer,
      polarity,
      conversation_id: conversationId,
      created_at: new Date().toISOString(),
      extra: {
        _from: 'handleIrosReply',
      },
    });
  } else {
    console.warn('[IROS/Q] skip writeQCodeWithEnv because q is null');
  }
} catch (e) {
  console.error('[IROS/Q] failed to writeQCodeWithEnv', e);
}


    // assistant 本文抽出
    let assistantText: string =
      result && typeof result === 'object'
        ? (() => {
            const r: any = result;
            if (typeof r.content === 'string' && r.content.trim().length > 0)
              return r.content;
            if (typeof r.text === 'string' && r.text.trim().length > 0)
              return r.text;
            return JSON.stringify(r);
          })()
        : String(result ?? '');

    const metaRaw =
      result && typeof result === 'object' && (result as any).meta
        ? (result as any).meta
        : null;

    const metaForSave =
      metaRaw && typeof metaRaw === 'object'
        ? { ...metaRaw }
        : metaRaw;


// =====================================================
// ★★★ renderEngine（handleIrosReply 内・確定版）
// =====================================================
if (
  process.env.IROS_ENABLE_RENDER_ENGINE === '1' &&
  typeof assistantText === 'string' &&
  assistantText.trim().length > 0 &&
  metaForSave &&
  typeof metaForSave === 'object'
) {
  try {
    const m: any = metaForSave;
    const unified: any = m.unified ?? {};

    const computedSA =
      typeof m.selfAcceptance === 'number'
        ? m.selfAcceptance
        : typeof m.self_acceptance === 'number'
        ? m.self_acceptance
        : typeof unified?.self_acceptance === 'number'
        ? unified.self_acceptance
        : undefined;

    console.log('[IROS/Reply][renderEngine] computed inputs check', {
      computedSA,
      mSelfAcceptance: m.selfAcceptance,
      mSelf_acceptance: m.self_acceptance,
      uSelf_acceptance: unified?.self_acceptance,
      yLevel: m.yLevel,
      hLevel: m.hLevel,
      situationSummary: m.situationSummary,
    });

    // render用：y/h は 0〜3 に丸めた int を優先（DB保存と揃える）
    const yLevelIntForVector =
      typeof m.yLevel === 'number' && Number.isFinite(m.yLevel)
        ? Math.max(0, Math.min(3, Math.round(m.yLevel)))
        : typeof m.y_level === 'number' && Number.isFinite(m.y_level)
        ? Math.max(0, Math.min(3, Math.round(m.y_level)))
        : typeof unified?.yLevel === 'number' && Number.isFinite(unified.yLevel)
        ? Math.max(0, Math.min(3, Math.round(unified.yLevel)))
        : typeof unified?.y_level === 'number' && Number.isFinite(unified.y_level)
        ? Math.max(0, Math.min(3, Math.round(unified.y_level)))
        : undefined;

    const hLevelIntForVector =
      typeof m.hLevel === 'number' && Number.isFinite(m.hLevel)
        ? Math.max(0, Math.min(3, Math.round(m.hLevel)))
        : typeof m.h_level === 'number' && Number.isFinite(m.h_level)
        ? Math.max(0, Math.min(3, Math.round(m.h_level)))
        : typeof unified?.hLevel === 'number' && Number.isFinite(unified.hLevel)
        ? Math.max(0, Math.min(3, Math.round(unified.hLevel)))
        : typeof unified?.h_level === 'number' && Number.isFinite(unified.h_level)
        ? Math.max(0, Math.min(3, Math.round(unified.h_level)))
        : undefined;

    const vector = buildResonanceVector({
      qCode: m.qCode ?? m.q_code ?? unified?.q?.current ?? undefined,
      depth: m.depth ?? m.depth_stage ?? unified?.depth?.stage ?? undefined,
      phase: m.phase ?? unified?.phase ?? undefined,

      // selfAcceptance を埋める
      selfAcceptance:
        typeof m.selfAcceptance === 'number'
          ? m.selfAcceptance
          : typeof m.self_acceptance === 'number'
          ? m.self_acceptance
          : typeof unified?.self_acceptance === 'number'
          ? unified.self_acceptance
          : undefined,

      // render用 y/h は int を優先
      yLevel: yLevelIntForVector,
      hLevel: hLevelIntForVector,

      coreNeedCategory:
        m.coreNeedCategory ?? m.soulNote?.core_need_category ?? undefined,
    } as any);

    // metaForSave 側も int に揃える（下流が直参照してもズレない）
    if (typeof yLevelIntForVector === 'number') {
      m.yLevel = yLevelIntForVector;
      m.y_level = yLevelIntForVector;
    }
    if (typeof hLevelIntForVector === 'number') {
      m.hLevel = hLevelIntForVector;
      m.h_level = hLevelIntForVector;
    }

    // intent_anchor / intentAnchor も int に揃える（1.5 を消す）
    if (m.intent_anchor && typeof m.intent_anchor === 'object') {
      if (typeof yLevelIntForVector === 'number')
        m.intent_anchor.y_level = yLevelIntForVector;
      if (typeof hLevelIntForVector === 'number')
        m.intent_anchor.h_level = hLevelIntForVector;
    }
    if (m.intentAnchor && typeof m.intentAnchor === 'object') {
      if (typeof yLevelIntForVector === 'number')
        m.intentAnchor.y_level = yLevelIntForVector;
      if (typeof hLevelIntForVector === 'number')
        m.intentAnchor.h_level = hLevelIntForVector;
    }


// --- greeting short-circuit (avoid long reply for greetings) ---
const rawInput = String(text ?? '').trim();

// かなり保守的に：短い挨拶だけを対象にする
const isGreetingOnly = (() => {
  const t = rawInput.replace(/\s+/g, '');
  if (!t) return false;

  const greetings = new Set([
    'こんにちは',
    'こんばんは',
    'おはよう',
    'やあ',
    'hi',
    'hello',
  ]);

  // 1〜6文字程度の“挨拶単体”だけショートにする
  return t.length <= 6 && greetings.has(t.toLowerCase());
})();

let renderEngineSkip = false;

if (isGreetingOnly) {
  const name = (metaForSave as any)?.userProfile?.user_call_name ?? 'orion';

  // NOTE: 圧を消す（Sofia寄り：待機・余白）
  const shortReply =
    `🌀 こんにちは、${name}さん。\n\n` +
    `ここにいます。必要なときだけ、そのまま言葉を置いてください。`;

  assistantText = shortReply;
  if (result && typeof result === 'object') {
    (result as any).content = shortReply;
  }

  // ★重要：ショート時は「混ざっていそうです」系の材料を潰す
  const mm: any = metaForSave;
  if (mm && typeof mm === 'object') {
    // UI/後段で拾われがちな候補を全部無効化
    mm.nextStep = null;
    mm.next_step = null;

    if (mm.soulNote && typeof mm.soulNote === 'object') {
      mm.soulNote.core_need = null;
      mm.soulNote.step_phrase = null;
      mm.soulNote.soul_sentence = null;
      mm.soulNote.micro_steps = [];
      mm.soulNote.comfort_phrases = [];
    }

    mm.extra = {
      ...(mm.extra ?? {}),
      renderEngineApplied: true,
      renderEngineShortCircuit: 'greeting_only',
    };
  }

  // try/catch を壊さないため、throw せず “後段をスキップ” にする
  renderEngineSkip = true;
}

// --- renderEngine input tuning (compression + robust Soul pickup) ---
// ※ greeting のときはスキップ
let insightCandidate: string | null = null;
let nextStepFromSoul: string | null = null;
let nextStepCandidate: any = null;
let userWantsEssence = false;
let highDefensiveness = false;
let needsComfort = false;
let comfortPhrases: string[] | null = null;
let soul: any = null;

if (!renderEngineSkip) {
  const rawText = String(text ?? '').trim();
  const isShortUtterance = rawText.length > 0 && rawText.length <= 6;

  // 1) 圧縮スイッチ：短文入力 or 明示キーワードで Essence 扱いにする
  userWantsEssence =
    isShortUtterance ||
    /本質|ズバ|はっきり|ハッキリ|意図|核心|要点|最適化|整理|結論/.test(rawText);

  const qNow = m.qCode ?? m.q_code ?? unified?.q?.current ?? null;

  // Q4 は「不安/恐怖」だけど、Iros的には “守り” なので、過度に攻めない
  highDefensiveness = qNow === 'Q1' || qNow === 'Q4';
  needsComfort = qNow === 'Q3' || qNow === 'Q4' || qNow === 'Q5';

  // 2) Soul を確実に拾う（camel/snake 両対応）
  soul = m.soulNote ?? unified?.soulNote ?? null;

  insightCandidate =
    typeof soul?.core_need === 'string' && soul.core_need.trim().length > 0
      ? soul.core_need.trim()
      : null;

  // micro_steps: micro_steps / microSteps 両対応
  const rawMicroSteps =
    (soul as any)?.micro_steps ?? (soul as any)?.microSteps ?? null;

  const microSteps: string[] | null = Array.isArray(rawMicroSteps)
    ? rawMicroSteps
        .filter((x: any) => typeof x === 'string' && x.trim().length > 0)
        .slice(0, 3)
    : null;

  nextStepFromSoul =
    microSteps && microSteps.length > 0 ? microSteps[0] : null;

  nextStepCandidate =
    nextStepFromSoul ??
    m.nextStep?.text ??
    m.next_step?.text ??
    m.nextStep?.label ??
    m.next_step?.label ??
    null;

  // comfort_phrases: comfort_phrases / comfortPhrases 両対応
  const rawComfort =
    (soul as any)?.comfort_phrases ?? (soul as any)?.comfortPhrases ?? null;

  comfortPhrases =
    needsComfort && Array.isArray(rawComfort)
      ? rawComfort
          .filter((x: any) => typeof x === 'string' && x.trim().length > 0)
          .slice(0, 2)
      : null;

  // 3) comfort は「説明」ではなく「最初の1行」に固定（毎回長くしない）
  if (comfortPhrases && comfortPhrases.length > 0 && typeof assistantText === 'string') {
    const comfortLine = comfortPhrases[0].trim();
    if (comfortLine.length > 0 && !assistantText.startsWith(comfortLine)) {
      assistantText = `${comfortLine}\n\n${assistantText}`;
    }
  }

  const minimalEmoji =
    typeof effectiveStyle === 'string' &&
    (effectiveStyle.includes('biz-formal') || effectiveStyle.includes('biz'));

  const rendered = renderReply(
    vector,
    {
      facts: assistantText,
      insight: insightCandidate,
      nextStep: nextStepCandidate,
      userWantsEssence,
      highDefensiveness,
      seed: String(conversationId),
    },
    {
      minimalEmoji,
      forceExposeInsight: false,
    },
  );

  const renderedText =
    typeof rendered === 'string'
      ? rendered
      : (rendered as any)?.text
      ? String((rendered as any).text)
      : null;

  if (renderedText && renderedText.trim().length > 0) {
    assistantText = renderedText;

    if (result && typeof result === 'object') {
      (result as any).content = renderedText;
    }

    m.extra = {
      ...(m.extra ?? {}),
      renderEngineApplied: true,
      resonanceVector: vector,
      soulApplied: {
        insight: !!(soul?.core_need),
        nextStepFromSoul: !!nextStepFromSoul,
        comfort: !!(comfortPhrases && comfortPhrases.length > 0),
      },
    };
  }
}

// ===== renderEngine try/catch の末尾は、あなたの外側コードにある catch に任せる =====


    // ✅ renderEngine: 最後の整形（任意）
    assistantText = finalPolishIrosText(assistantText, {
      style: typeof effectiveStyle === 'string' ? effectiveStyle : null,
      qNow: String(m.qCode ?? m.q_code ?? unified?.q?.current ?? ''),
    });
  } catch (e) {
    console.warn('[IROS/Reply] renderEngine failed (handleIrosReply)', {
      conversationId,
      userCode,
      error: String(e),
    });
  }
}



// meta を補強
if (metaForSave && typeof metaForSave === 'object') {
  try {
    const m: any = metaForSave;

    // 1) assistantText 内の IROS_STATE_META を meta にマージ（あれば）
    const extracted = extractIrosStateMetaFromAssistant(assistantText);
    if (extracted && typeof extracted === 'object') {
      Object.assign(m, extracted);
    }

    // 2) situationSummary / situationTopic / soulNote.core_need を必ず作る
    try {
      const unified2 = m.unified ?? {};

      if (
        typeof m.situationSummary !== 'string' ||
        m.situationSummary.trim().length === 0
      ) {
        const us = unified2?.situation?.summary;
        if (typeof us === 'string' && us.trim().length > 0) {
          m.situationSummary = us.trim();
        } else {
          const t = String(text ?? '').replace(/\s+/g, ' ').trim();
          m.situationSummary = t.length > 120 ? t.slice(0, 120) + '…' : t;
        }
      }

      if (typeof m.situationTopic !== 'string' || m.situationTopic.trim().length === 0) {
        const resolved = resolveSituationTopicFromMeta(m);

        if (typeof resolved === 'string' && resolved.trim().length > 0) {
          m.situationTopic = resolved.trim();
        } else if (typeof m.topic === 'string' && m.topic.trim().length > 0) {
          m.situationTopic = m.topic.trim();
        } else {
          m.situationTopic = null;
        }
      }

      const existingCoreNeed =
        (m.soulNote &&
          typeof m.soulNote === 'object' &&
          typeof m.soulNote.core_need === 'string')
          ? m.soulNote.core_need
          : (unified2?.soulNote &&
              typeof unified2.soulNote.core_need === 'string')
          ? unified2.soulNote.core_need
          : null;

      if (!existingCoreNeed || existingCoreNeed.trim().length === 0) {
        const fromIntentLine =
          (m.intentLine && typeof m.intentLine.coreNeed === 'string'
            ? m.intentLine.coreNeed
            : null) ??
          (unified2?.intentLine &&
          typeof unified2.intentLine.coreNeed === 'string'
            ? unified2.intentLine.coreNeed
            : null);

        const fromAnchor =
          (m.intent_anchor && typeof m.intent_anchor.text === 'string'
            ? m.intent_anchor.text
            : null) ??
          (unified2?.intent_anchor &&
          typeof unified2.intent_anchor.text === 'string'
            ? unified2.intent_anchor.text
            : null);

        const guessed =
          (fromIntentLine && fromIntentLine.trim().length > 0
            ? fromIntentLine.trim()
            : null) ??
          (fromAnchor && fromAnchor.trim().length > 0
            ? fromAnchor.trim()
            : null);

        if (!m.soulNote || typeof m.soulNote !== 'object') {
          m.soulNote = {};
        }

        if (guessed) {
          m.soulNote.core_need =
            guessed.length > 40 ? guessed.slice(0, 40) + '…' : guessed;
        } else {
          const u = String(text ?? '').trim();
          m.soulNote.core_need =
            /どうすれば|なぜ|理由|本音|意図|核心|要点|はっきり|ハッキリ/.test(u)
              ? '核心をはっきり掴みたいという願い'
              : '安心して進める確かな手応えが欲しいという願い';
        }
      } else {
        if (!m.soulNote || typeof m.soulNote !== 'object') m.soulNote = {};
        m.soulNote.core_need = existingCoreNeed.trim();
      }
    } catch (e) {
      console.error('[IROS/Meta] ensure soulNote/situation failed', e);
    }

    // 3) Polarity/Stability, mirror/i_layer/intent をセット
    const unified = m.unified ?? {};

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

    const modeFromResult: string | undefined =
      typeof (result as any)?.mode === 'string'
        ? (result as any).mode
        : typeof m.mode === 'string'
        ? m.mode
        : undefined;

    if (modeFromResult && modeFromResult.trim().length > 0) {
      m.mirror = modeFromResult.trim();
    }

    const depthForLayer: string | null =
      (m.depth as string | undefined) ??
      (m.depth_stage as string | undefined) ??
      (unified?.depth?.stage as string | undefined) ??
      null;

    if (depthForLayer && depthForLayer.startsWith('I')) {
      m.i_layer = depthForLayer;
    } else {
      m.i_layer = null;
    }

    const ia = m.intent_anchor;
    if (ia && typeof ia.text === 'string') {
      const label = ia.text.trim();
      m.intent = label.length > 40 ? label.slice(0, 40) + '…' : label;
    }
  } catch (e) {
    console.error(
      '[IROS/Reply] metaForSave merge/ensure failed',
      e,
    );
  }
}

// meta.intent_anchor が入っていたら DB に upsert
if (userId && metaForSave && typeof metaForSave === 'object') {
  const ia: any = (metaForSave as any).intent_anchor;
  if (ia && typeof ia.text === 'string' && ia.text.trim().length > 0) {
    try {
      await upsertIntentAnchorForUser(supabase, {
        userId,
        anchorText: ia.text.trim(),
        intentStrength: typeof ia.strength === 'number' ? ia.strength : null,
        yLevel: typeof ia.y_level === 'number' ? ia.y_level : null,
        hLevel: typeof ia.h_level === 'number' ? ia.h_level : null,
      });
      console.log('[IROS/IntentAnchor] upsert from metaForSave', {
        userCode,
        userId,
        anchorText: ia.text.trim(),
      });
    } catch (e) {
      console.error('[IROS/IntentAnchor] failed to upsert from metaForSave', {
        userCode,
        userId,
        error: e,
      });
    }
  }
}

// MemoryState：meta/unified から 3軸状態を iros_memory_state に保存
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

    // Phase
    const phaseRaw: string | null =
      (m.phase as string | undefined) ??
      (unified?.phase as string | undefined) ??
      null;

    let phaseForState: 'Inner' | 'Outer' | null = null;
    if (typeof phaseRaw === 'string' && phaseRaw.trim().length > 0) {
      const p = phaseRaw.trim().toLowerCase();
      if (p === 'inner') phaseForState = 'Inner';
      else if (p === 'outer') phaseForState = 'Outer';
    }

    const selfAcceptanceRawForState: unknown =
      typeof m.selfAcceptance === 'number'
        ? m.selfAcceptance
        : typeof m.self_acceptance === 'number'
          ? m.self_acceptance
          : typeof unified?.self_acceptance === 'number'
            ? unified.self_acceptance
            : null;

    const selfAcceptanceForState = clampSelfAcceptance(selfAcceptanceRawForState);

    // IntentLayer（S/R/C/I/T）
    let intentLayerForState: string | null = null;
    const intentLayerRaw: unknown =
      (m.intentLayer as string | undefined) ??
      (m.intent_layer as string | undefined) ??
      (m.intentLine?.focusLayer as string | undefined) ??
      (m.intent_line?.focusLayer as string | undefined) ??
      (unified?.intentLine?.focusLayer as string | undefined) ??
      (unified?.intent_line?.focusLayer as string | undefined) ??
      null;

    if (typeof intentLayerRaw === 'string' && intentLayerRaw.trim().length > 0) {
      const il = intentLayerRaw.trim().toUpperCase();
      intentLayerForState = ['S', 'R', 'C', 'I', 'T'].includes(il) ? il : intentLayerRaw.trim();
    }

    // IntentConfidence
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

    if (typeof intentConfidenceRaw === 'number' && Number.isFinite(intentConfidenceRaw)) {
      intentConfidenceForState = intentConfidenceRaw;
    }

    // y/h（raw）
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

    if (typeof yLevelRawForState === 'number' && Number.isFinite(yLevelRawForState)) {
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

    if (typeof hLevelRawForState === 'number' && Number.isFinite(hLevelRawForState)) {
      hLevelForState = hLevelRawForState;
    }

    const situationSummaryForState: string | null =
      typeof m.situationSummary === 'string'
        ? m.situationSummary
        : typeof unified?.situation?.summary === 'string'
          ? unified.situation.summary
          : null;

    const situationTopicForState: string | null = (() => {
      const resolved = resolveSituationTopicFromMeta(m);
      return typeof resolved === 'string' && resolved.trim().length > 0 ? resolved.trim() : null;
    })();

    const sentimentLevelForState: string | null =
      typeof m.sentiment_level === 'string'
        ? m.sentiment_level
        : typeof unified?.sentiment_level === 'string'
          ? unified.sentiment_level
          : typeof unified?.sentiment === 'string'
            ? unified.sentiment
            : null;

    // ★ 0〜3 に丸めて integer 化（DB カラムは integer）
    // memoryState.ts と同じ方針で「保存値」も「ログ」も揃える
    const yLevelIntForSave =
      typeof yLevelForState === 'number' && Number.isFinite(yLevelForState)
        ? Math.max(0, Math.min(3, Math.round(yLevelForState)))
        : null;

    const hLevelIntForSave =
      typeof hLevelForState === 'number' && Number.isFinite(hLevelForState)
        ? Math.max(0, Math.min(3, Math.round(hLevelForState)))
        : null;

    console.log('[IROS/MemoryState] upsert from metaForSave (raw)', {
      userCode,
      depthStage: depthStageForState,
      qPrimary,
      phase: phaseForState,
      intentLayer: intentLayerForState,
      yLevelRaw: yLevelForState,
      hLevelRaw: hLevelForState,
      sentiment_level: sentimentLevelForState,
    });

    await upsertIrosMemoryState({
      userCode,
      depthStage: depthStageForState ?? null,
      qPrimary,
      selfAcceptance: selfAcceptanceForState,
      phase: phaseForState,
      intentLayer: intentLayerForState,
      intentConfidence: intentConfidenceForState ?? null,
      yLevel: yLevelIntForSave,
      hLevel: hLevelIntForSave,
      situationSummary: situationSummaryForState ?? null,
      situationTopic: situationTopicForState ?? null,
      sentiment_level: sentimentLevelForState,
    });

    console.log('[IROS/MemoryState] upsert from metaForSave ok', {
      userCode,
      depthStage: depthStageForState,
      qPrimary,
      phase: phaseForState,
      intentLayer: intentLayerForState,
      yLevelRaw: yLevelForState,
      hLevelRaw: hLevelForState,
      yLevel: yLevelIntForSave,
      hLevel: hLevelIntForSave,
      sentiment_level: sentimentLevelForState,
    });
  } catch (e) {
    console.error('[IROS/MemoryState] upsert from metaForSave failed', {
      userCode,
      error: e,
    });
  }
}

// UnifiedAnalysis 保存
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

    await applyAnalysisToLastUserMessage({
      conversationId,
      analysis,
    });
  } catch (e) {
    console.error('[IROS/Reply] failed to save unified analysis', e);
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
    console.error('[IROS/Reply] failed to persist assistant message', e);
  }
}

const finalMode =
  result && typeof result === 'object' && typeof (result as any).mode === 'string'
    ? (result as any).mode
    : mode;

return {
  ok: true,
  result,
  assistantText,
  metaForSave,
  finalMode,
};
} catch (e) {
  console.error('[IROS/Reply] handleIrosReply failed', {
    conversationId,
    userCode,
    error: e,
  });

  return {
    ok: false,
    error: 'generation_failed',
    detail: e instanceof Error ? e.message : String(e),
  };
}
}
