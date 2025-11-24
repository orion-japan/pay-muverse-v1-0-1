// src/lib/iros/orchestrator.ts
// Iros Orchestrator — Will Engine（Goal / Priority）+ Continuity Engine 統合版
// - 極小構造のまま「意志の連続性」を追加した v2
// - Unified-like 解析入口 + isFirstTurn 対応版
// - A: 深度スキャン構造化（autoDepthFromDeepScan / autoQFromDeepScan）
// - B: 連続性（前ターンの depth / Q を使った補正）

import {
  type IrosMode,
  type Depth,
  type QCode,
  type IrosMeta,
  type IrosIntentMeta,
  IROS_MODES,
  DEPTH_VALUES,
  QCODE_VALUES,
} from './system';

import { deriveIrosGoal } from './will/goalEngine';
import { deriveIrosPriority } from './will/priorityEngine';

// Continuity Engine（Goal 用）
import {
  applyGoalContinuity,
  type ContinuityContext,
} from './will/continuityEngine';

// Depth/Q 連続性（分離モジュール）
import { applyDepthContinuity, applyQContinuity } from './depthContinuity';

// Unified-like 解析（分離モジュール）
import {
  analyzeUnifiedTurn,
  type UnifiedLikeAnalysis,
} from './unifiedAnalysis';

import { generateIrosReply, type GenerateResult } from './generate';

// ★ I層強制モード（ENV）
//   - true のとき、requestedDepth を優先して depth を固定する
const FORCE_I_LAYER =
  typeof process !== 'undefined' &&
  process.env.IROS_FORCE_I_LAYER === '1';

// ==== Orchestrator に渡す引数 ==== //
export type IrosOrchestratorArgs = {
  conversationId?: string;
  text: string;

  requestedMode?: IrosMode;
  requestedDepth?: Depth;
  requestedQCode?: QCode;

  baseMeta?: Partial<IrosMeta>;

  /** ★ この会話の最初のターンかどうか（reply/route.ts から渡す） */
  isFirstTurn?: boolean;
};

// ==== Orchestrator から返す結果 ==== //
export type IrosOrchestratorResult = {
  content: string;
  meta: IrosMeta;
};

export async function runIrosTurn(
  args: IrosOrchestratorArgs,
): Promise<IrosOrchestratorResult> {
  const {
    conversationId,
    text,
    requestedMode,
    requestedDepth,
    requestedQCode,
    baseMeta,
    isFirstTurn,
  } = args;

  /* =========================================================
     0) Unified-like 解析（Q / Depth の決定をここに集約）
        ─ 後で UnifiedAnalysis LLM に差し替える入口
  ========================================================= */
  const unified = await analyzeUnifiedTurn({
    text,
    requestedDepth,
    requestedQCode,
  });

  const mode = normalizeMode(requestedMode);

  // LLM / ルールベースの生の推定結果
  const rawDepthFromScan: Depth | undefined =
    unified.depth.stage ?? undefined;
  const rawQFromScan: QCode | undefined = unified.q.current ?? undefined;

  /* =========================================================
     A) 深度スキャン + 連続性補正
        - scan結果（autoDepthFromDeepScan / autoQFromDeepScan）
        - 前回の meta.depth / meta.qCode
        - isFirstTurn
        を組み合わせて最終 depth / Q を決定
  ========================================================= */

  // まずは通常の Depth 連続性ロジックを適用
  const depthFromContinuity = normalizeDepth(
    applyDepthContinuity({
      scanDepth: rawDepthFromScan,
      lastDepth: baseMeta?.depth,
      text,
      isFirstTurn: !!isFirstTurn,
    }),
  );

  // ★ I層強制モードのときは requestedDepth をそのまま採用
  let depth: Depth | undefined;
  if (FORCE_I_LAYER && requestedDepth) {
    depth = requestedDepth;
  } else {
    depth = depthFromContinuity;
  }

  const qCode = normalizeQCode(
    applyQContinuity({
      scanQ: rawQFromScan,
      lastQ: baseMeta?.qCode,
      isFirstTurn: !!isFirstTurn,
    }),
  );

  /* =========================================================
     A') 統一：最終決定した depth / qCode を unified にも反映
         - ログ／DB上で resolved と unified がずれないようにする
  ========================================================= */
  const fixedUnified: UnifiedLikeAnalysis = {
    ...unified,
    q: {
      ...unified.q,
      current: qCode ?? unified.q.current,
    },
    depth: {
      ...unified.depth,
      stage: depth ?? unified.depth.stage,
    },
  };

  // ====== 次ターンに残る meta（I層はこのあと上書きする） ======
  let meta: IrosMeta = {
    ...(baseMeta ?? {}),
    mode,
    ...(depth ? { depth } : {}),
    ...(qCode ? { qCode } : {}),
    // unified 結果そのものも meta に残しておく（DB jsonb にそのまま入る想定）
    unified: fixedUnified,
  } as IrosMeta;

  /* =========================================================
     ① Goal Engine：今回の "意志" を生成
  ========================================================= */
  let goal = deriveIrosGoal({
    userText: text,
    lastDepth: baseMeta?.depth,
    lastQ: baseMeta?.qCode,
    requestedDepth,
    requestedQCode,
  });

  /* =========================================================
     ② Continuity Engine：前回の意志を踏まえて補正（Goal 用）
  ========================================================= */
  const continuity: ContinuityContext = {
    lastDepth: baseMeta?.depth,
    lastQ: baseMeta?.qCode,
    userText: text,
  };
  goal = applyGoalContinuity(goal, continuity);

  /* =========================================================
     ③ Priority Engine：Goal の意志に基づき重み計算
  ========================================================= */
  const priority = deriveIrosPriority({
    goal,
    mode,
    depth,
    qCode,
  });

  // ====== ログ ======
  if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
    console.log('[IROS/ORCH v2] runIrosTurn start', {
      conversationId,
      textSample: text.slice(0, 80),
      requestedMode,
      requestedDepth,
      requestedQCode,
      autoDepthFromDeepScan: rawDepthFromScan ?? null,
      autoQFromDeepScan: rawQFromScan ?? null,
      chosenDepth: depth ?? null,
      resolved: { mode, depth: depth ?? null, qCode: qCode ?? null },
      baseMeta,
      goalAfterContinuity: goal,
      priorityWeights: priority.weights,
      isFirstTurn,
      FORCE_I_LAYER,
    });
  }

  /* =========================================================
     ④ LLM：生成（本文 + I層ジャッジ）
  ========================================================= */
  const result: GenerateResult = await generateIrosReply({
    conversationId,
    text,
    meta,
  });

  // I層ジャッジの結果を meta に反映（次ターン以降の「横にあるI層感覚」として保持）
  if (result.intent) {
    const intent: IrosIntentMeta = result.intent;
    meta = {
      ...meta,
      intent,
      intentLayer: intent.layer,
      intentConfidence: intent.confidence ?? null,
      intentReason: intent.reason ?? null,
    };
  }

  /* =========================================================
     ⑤ 最終 meta の統合（Q / Depth / intentSummary を整える）
  ========================================================= */
  meta = buildFinalMeta({
    baseMeta,
    workingMeta: meta,
    goal,
  });

  if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
    console.log('[IROS/ORCH v2] runIrosTurn done', {
      conversationId,
      resolved: {
        mode,
        depth: meta.depth ?? null,
        qCode: meta.qCode ?? null,
      },
      goalKind: goal?.kind ?? null,
      replyLength: result.content.length,
      isFirstTurn,
      intentLayer: meta.intentLayer ?? null,
      intentConfidence: meta.intentConfidence ?? null,
    });
  }

  return {
    content: result.content,
    meta,
  };
}

/* ========= 最終 meta の統合ヘルパー ========= */

function buildFinalMeta(args: {
  baseMeta?: Partial<IrosMeta>;
  workingMeta: IrosMeta;
  goal: any; // goalEngine の型に依存させず、柔らかく参照
}): IrosMeta {
  const { baseMeta, workingMeta, goal } = args;

  const previousDepth = baseMeta?.depth as Depth | undefined;
  const previousQ = baseMeta?.qCode as QCode | undefined;

  const currentDepth = workingMeta.depth as Depth | undefined;
  const currentQ = workingMeta.qCode as QCode | undefined;

  const goalDepth = goal?.targetDepth as Depth | undefined;
  const goalQ = goal?.targetQ as QCode | undefined;

  const finalDepth: Depth | null =
    currentDepth ?? goalDepth ?? previousDepth ?? null;

  const finalQ: QCode | null = currentQ ?? goalQ ?? previousQ ?? null;

  const originalUnified =
    workingMeta.unified as UnifiedLikeAnalysis | undefined;
  const goalKind = (goal?.kind as string | undefined) ?? null;
  const intentLayer = (workingMeta.intentLayer as string | undefined) ?? null;

  // intentSummary の再構成
  const intentSummary = (() => {
    // もともと unified に LLM由来の intentSummary が入っていれば尊重
    if (originalUnified?.intentSummary) {
      return originalUnified.intentSummary;
    }

    if (intentLayer === 'I3') {
      return '存在理由や生きる意味に触れながら、自分の状態や感情を整理しようとしています。';
    }
    if (intentLayer === 'I2') {
      return 'これからの方向性や選択を見つめ直しながら、自分の状態や感情を整理しようとしています。';
    }
    if (intentLayer === 'I1') {
      return 'いまの自分の在り方や感情を、安全な場所で受け止め直そうとしています。';
    }
    if (goalKind === 'stabilize') {
      return '心の揺れを少し落ち着けながら、自分の状態や感情を整理しようとしています。';
    }
    return '自分の状態や感情の揺れを整理しようとしています。';
  })();

  const nextMeta: IrosMeta = {
    ...workingMeta,
    qCode: finalQ ?? undefined,
    depth: finalDepth ?? undefined,
    unified: {
      q: { current: finalQ ?? null },
      depth: { stage: finalDepth ?? null },
      phase: originalUnified?.phase ?? null,
      intentSummary,
    },
  };

  return nextMeta;
}

/* ========= 最小バリデーション ========= */

function normalizeMode(mode?: IrosMode): IrosMode {
  if (!mode) return 'mirror';
  return IROS_MODES.includes(mode) ? mode : 'mirror';
}

function normalizeDepth(depth?: Depth): Depth | undefined {
  if (!depth) return undefined;
  return DEPTH_VALUES.includes(depth) ? depth : undefined;
}

function normalizeQCode(qCode?: QCode): QCode | undefined {
  if (!qCode) return undefined;
  return QCODE_VALUES.includes(qCode) ? qCode : undefined;
}
