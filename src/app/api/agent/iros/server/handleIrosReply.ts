// file: src/lib/iros/server/handleIrosReply.ts

import { createClient } from '@supabase/supabase-js';
import { updateUserQNowFromMeta } from '@/lib/iros/qSnapshot';
import { loadQTraceForUser, applyQTraceToMeta } from '@/lib/iros/memory.adapter';
import { detectQFromText } from '@/lib/iros/q/detectQ';
import { estimateSelfAcceptance } from '@/lib/iros/sa/meter';
import { runIrosTurn } from '@/lib/iros/orchestrator';
import type { QCode } from '@/lib/iros/system';
import type { RememberScopeKind } from '@/lib/iros/remember/resolveRememberBundle';

// Supabase（Iros内部用）
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

// I層100%モード（ENVベース）
const FORCE_I_LAYER = process.env.IROS_FORCE_I_LAYER === '1';

// ---------- UnifiedAnalysis ロジック（元 route.ts から移動） ----------

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
  // 優先順位：
  // 1) meta.selfAcceptance  (camelCase: orchestrator からの値)
  // 2) safeMeta.self_acceptance（過去互換 or 他ルート）
  // 3) unified.self_acceptance（将来 unified 側で持たせる場合）
  // 4) ★ fallback として「今回の userText から簡易推定」
  let selfAcceptanceRaw: number | null =
    typeof safeMeta.selfAcceptance === 'number'
      ? safeMeta.selfAcceptance
      : typeof safeMeta.self_acceptance === 'number'
      ? safeMeta.self_acceptance
      : typeof unified?.self_acceptance === 'number'
      ? unified.self_acceptance
      : null;

  if (selfAcceptanceRaw == null) {
    try {
      // meter.ts 側は { userText, depthStage, qCode } 形式の入力
      const saResult: any = await estimateSelfAcceptance({
        userText,
        depthStage,
        qCode,
      } as any);

      // 返り値の型バリエーションに全部対応しておく
      if (typeof saResult === 'number') {
        selfAcceptanceRaw = saResult;
      } else if (saResult && typeof saResult.value === 'number') {
        // 現状の meter.ts の形（value を持っている）
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
    // Unified / meta に Q が無い場合のみ、ユーザー発言から推定
    const raw = analysis.raw ?? {};
    const userText: string | null =
      (typeof raw.user_text === 'string' ? raw.user_text : null) ?? null;

    if (userText && userText.trim().length > 0) {
      try {
        // 新Qエンジン：キーワード＋GPT で推定
        const detected = await detectQFromText(userText);
        if (detected) {
          qCode = detected;
        }
      } catch (e) {
        console.error(
          '[UnifiedAnalysis] detectQFromText failed, fallback to simple keyword',
          e,
        );
        // 失敗時だけ簡易版キーワード判定にフォールバック
        const fallback = detectQFallbackFromText(userText);
        if (fallback) {
          qCode = fallback;
        }
      }
    }
  }

  // analysis 自体にも反映しておく（将来 debug 用）
  analysis.q_code = qCode ?? null;

  // 1) unified_resonance_logs へ INSERT
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

  // 2) user_resonance_state を UPSERT（Qストリーク管理）
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

  // ひとまず雑に keyword ベース（将来、専用LLMや detectQ.ts に差し替え可）
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

  // 優先度：怒り(Q2) → 不安(Q3) → 恐怖(Q4) → 空虚(Q5) → 我慢(Q1)
  if (hasAnger) return 'Q2';
  if (hasAnxiety) return 'Q3';
  if (hasFear) return 'Q4';
  if (hasEmptiness) return 'Q5';
  if (hasSuppress) return 'Q1';

  return null;
}

/* =========================================================
   会話履歴ダイジェスト
   - 同じ conversation_id の過去メッセージを読み込み
   - 「あなた:」「Iros:」形式で短くまとめて 1つのテキストにする
========================================================= */

const MAX_HISTORY_ROWS = 30; // 直近何件まで使うか
const MAX_HISTORY_CHARS = 4000; // LLMに渡す履歴部分の最大長

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

    // 末尾から MAX_HISTORY_ROWS 件だけ使う
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

    // 長すぎる場合は先頭から削る（直近メインにする）
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
    rememberScope, // いまはログ用途のみ
    reqOrigin,
    authorizationHeader,
    traceId,
  } = params;

  console.log('[IROS/Reply] handleIrosReply start', {
    conversationId,
    userCode,
    mode,
    tenantId,
    rememberScope,
    traceId,
    FORCE_I_LAYER,
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

    // 2) 会話履歴ダイジェスト（1ターン目でなければ）
    let historyDigest: string | null = null;
    if (!isFirstTurn) {
      historyDigest = await buildConversationHistoryDigest(conversationId);
      console.log('[IROS/History] digest length', {
        conversationId,
        hasDigest: !!historyDigest,
        length: historyDigest?.length ?? 0,
      });
    }

    // 3) Iros メモリ読み込み → Orchestrator 呼び出し
    console.log('[IROS/Memory] loadQTraceForUser start', { userCode });

    // ★ QTrace を読み込む
    const qTrace = await loadQTraceForUser(userCode, { limit: 50 });

    console.log('[IROS/Memory] qTrace', {
      snapshot: qTrace.snapshot,
      counts: qTrace.counts,
      streakQ: qTrace.streakQ,
      streakLength: qTrace.streakLength,
      lastEventAt: qTrace.lastEventAt,
    });

    // QTrace を meta に反映（最新版）
    const baseMetaFromQ = applyQTraceToMeta(
      {
        qCode: undefined,
        depth: undefined,
      },
      qTrace,
    );

    // I層100%モード：ENVフラグでON/OFF
    const FORCE_I_LAYER_LOCAL = FORCE_I_LAYER;

    // I層モードでも mirror ベース
    const requestedMode =
      FORCE_I_LAYER_LOCAL
        ? ('mirror' as any)
        : mode === 'auto'
        ? undefined
        : (mode as any);

    // 深度は I2 に固定（テスト用） or QTrace 由来
    const requestedDepth = FORCE_I_LAYER_LOCAL
      ? ('I2' as any)
      : (baseMetaFromQ.depth as any);

    // baseMeta（orchestrator に渡す初期メタ）
    const baseMetaForTurn: any = {};
    if (!FORCE_I_LAYER_LOCAL && baseMetaFromQ.depth) {
      baseMetaForTurn.depth = baseMetaFromQ.depth as any;
    }
    if (baseMetaFromQ.qCode != null) {
      baseMetaForTurn.qCode = baseMetaFromQ.qCode as any;
    }

    // ★ Self Acceptance を「runIrosTurn の前」に推定して baseMeta に注入
    try {
      const saInput: any = {
        qCode:
          (baseMetaForTurn.qCode as QCode | undefined) ??
          (baseMetaFromQ.qCode as QCode | undefined) ??
          (qTrace.snapshot?.currentQ as QCode | undefined) ??
          null,
        depthStage:
          (baseMetaForTurn.depth as string | undefined) ??
          (baseMetaFromQ.depth as string | undefined) ??
          (qTrace.snapshot?.depthStage as string | undefined) ??
          null,
        phase: undefined,
        hasHistoryDigest: !!historyDigest,
        lastSelfAcceptance: undefined,
        userText: text,
      };

      const saResult: any = await estimateSelfAcceptance(saInput);

      let saValue: number | null = null;
      if (typeof saResult === 'number') {
        saValue = saResult;
      } else if (saResult && typeof saResult.value === 'number') {
        saValue = saResult.value;
      } else if (saResult && typeof saResult.normalized === 'number') {
        saValue = saResult.normalized;
      } else if (saResult && typeof saResult.score === 'number') {
        saValue = saResult.score;
      }

      if (saValue != null && !Number.isNaN(saValue)) {
        baseMetaForTurn.selfAcceptance = saValue;
      }
    } catch (e) {
      console.error(
        '[IROS/Reply] estimateSelfAcceptance for baseMeta failed',
        e,
      );
    }

    // historyDigest を含めた effectiveText を定義
    const effectiveText =
      historyDigest && historyDigest.trim().length > 0
        ? `【これまでの流れ（要約）】\n${historyDigest}\n\n【今回のユーザー発言】\n${text}`
        : text;

    // ★ このターンのユーザー発言から Qコードを推定（Orchestrator 用）
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
      userCode, // ★ ここを追加：MemoryState 読み書き用
    });

    console.log('[IROS/Orchestrator] result.meta', (result as any)?.meta);

    // Qスナップショット更新：user_q_now を（I層含めて）追従させる
    try {
      await updateUserQNowFromMeta(supabase, userCode, (result as any)?.meta);
    } catch (e) {
      console.error(
        '[IROS/Reply] failed to update user_q_now from meta',
        e,
      );
    }

    // assistant の本文を抽出
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
            // content/text が無い場合は JSON 文字列として保存（デバッグ用）
            return JSON.stringify(r);
          })()
        : String(result ?? '');

    // LLM が返した meta を一度受け取り…
    const metaRaw =
      result &&
      typeof result === 'object' &&
      (result as any).meta
        ? (result as any).meta
        : null;

    // Qコードまわりだけいったん無効化せず、そのまま保存・レスポンスに使う
    const metaForSave =
      metaRaw && typeof metaRaw === 'object'
        ? {
            ...metaRaw,
          }
        : metaRaw;

    if (assistantText && assistantText.trim().length > 0) {
      // UnifiedAnalysis を構築して保存（失敗してもチャット自体は続行）
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

      // 従来通り /messages API にも保存
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
