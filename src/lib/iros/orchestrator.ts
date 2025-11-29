// src/lib/iros/orchestrator.ts
// Iros Orchestrator — Will Engine（Goal / Priority）+ Continuity Engine 統合版
// - 極小構造のまま「意志の連続性」を追加した v2
// - Unified-like 解析入口 + isFirstTurn 対応版
// - 解析・Will・Memory・プレゼン系を分割モジュールに委譲

import {
  type IrosMode,
  type Depth,
  type QCode,
  type IrosMeta,
  type TLayer,
  DEPTH_VALUES,
  QCODE_VALUES,
} from './system';

import { generateIrosReply, type GenerateResult } from './generate';

import { clampSelfAcceptance } from './orchestratorMeaning';

// MemoryState 読み書き
import {
  loadBaseMetaFromMemoryState,
  saveMemoryStateFromMeta,
  type LoadStateResult,
} from './orchestratorState';

// 解析フェーズ（Unified / depth / Q / SA / YH / IntentLine / T層）
import {
  runOrchestratorAnalysis,
  type OrchestratorAnalysisResult,
} from './orchestratorAnalysis';

// Will（Goal / Priority）
import {
  computeGoalAndPriority,
  type IrosGoalType,
  type IrosPriorityType,
} from './orchestratorWill';

// 診断ヘッダー除去
import { stripDiagnosticHeader } from './orchestratorPresentation';

// モード決定（mirror / vision / diagnosis）
import { applyModeToMeta } from './orchestratorMode';

// ==== I層強制モード（ENV） ====
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

  /** ★ MemoryState 読み書き用：user_code */
  userCode?: string;
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
    conversationId, // ← いまは未使用（将来拡張用）
    text,
    requestedMode,
    requestedDepth,
    requestedQCode,
    baseMeta,
    isFirstTurn,
    userCode,
  } = args;

  // ----------------------------------------------------------------
  // 1. MemoryState 読み込み（meta ベースのみ使用）
  // ----------------------------------------------------------------
  let loadResult: LoadStateResult | null = null;
  if (userCode) {
    loadResult = await loadBaseMetaFromMemoryState({
      userCode,
      baseMeta,
    });
  }

  // 型の差分を吸収するため any 経由で meta を読む
  const memoryMeta: Partial<IrosMeta> | undefined = loadResult
    ? ((loadResult as any).meta as Partial<IrosMeta> | undefined)
    : undefined;
  const memoryState: unknown = loadResult
    ? (loadResult as any).memoryState ?? null
    : null;

  // ----------------------------------------------------------------
  // 2. baseMeta 構築（ルート引数 + Memory の統合）
  // ----------------------------------------------------------------
  const mergedBaseMeta: Partial<IrosMeta> = {
    ...(memoryMeta || {}),
    ...(baseMeta || {}),
  };

  // depth / qCode の初期値決定
  const initialDepth = determineInitialDepth(
    requestedDepth,
    mergedBaseMeta.depth as Depth | undefined,
  );
  const initialQCode =
    (requestedQCode as QCode | undefined) ??
    (mergedBaseMeta.qCode as QCode | undefined);

  const normalizedDepth = normalizeDepth(initialDepth);
  const normalizedQCode = normalizeQCode(initialQCode);

  // ----------------------------------------------------------------
  // 3. 解析フェーズ（Unified / depth / Q / SA / YH / IntentLine / T層）
  // ----------------------------------------------------------------
  const analysis: OrchestratorAnalysisResult = await runOrchestratorAnalysis({
    text,
    requestedDepth: normalizedDepth,
    requestedQCode: normalizedQCode,
    baseMeta: mergedBaseMeta,
    // memoryState の具体的な型は解析側で定義されているので any 扱い
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    memoryState: memoryState as any,
    isFirstTurn: !!isFirstTurn,
  });

  const {
    depth: resolvedDepth,
    qCode: resolvedQCode,
    selfAcceptanceLine,
    unified,
    yLevel,
    hLevel,
    intentLine,
    tLayerHint,
    hasFutureMemory,
    qTrace,
    tLayerModeActive,
  } = analysis;

  // T層ヒントを T1/T2/T3 のみに正規化
  const normalizedTLayer: TLayer | null =
    tLayerHint === 'T1' || tLayerHint === 'T2' || tLayerHint === 'T3'
      ? (tLayerHint as TLayer)
      : null;

  // ----------------------------------------------------------------
  // 4. meta 初期化（解析結果を反映）
  // ----------------------------------------------------------------
  let meta: IrosMeta = {
    ...(mergedBaseMeta as IrosMeta),
    depth: resolvedDepth ?? normalizedDepth,
    qCode: resolvedQCode ?? normalizedQCode,
    selfAcceptance:
      typeof selfAcceptanceLine === 'number'
        ? clampSelfAcceptance(selfAcceptanceLine)
        : mergedBaseMeta.selfAcceptance ?? null,
    yLevel: typeof yLevel === 'number' ? yLevel : mergedBaseMeta.yLevel ?? null,
    hLevel: typeof hLevel === 'number' ? hLevel : mergedBaseMeta.hLevel ?? null,
    intentLine: intentLine ?? mergedBaseMeta.intentLine ?? null,
    tLayerHint: normalizedTLayer ?? mergedBaseMeta.tLayerHint ?? null,
    hasFutureMemory:
      typeof hasFutureMemory === 'boolean'
        ? hasFutureMemory
        : mergedBaseMeta.hasFutureMemory ?? null,
    unified: unified ?? mergedBaseMeta.unified ?? null,
  };

  if (qTrace) {
    (meta as any).qTrace = qTrace;
  }

  if (tLayerModeActive) {
    (meta as any).tLayerModeActive = true;
  }

// --------------------------------------------------
// 5. モード決定（mirror / vision / diagnosis）
// --------------------------------------------------
meta = applyModeToMeta(text, {
  requestedMode,
  meta,
  isFirstTurn: !!isFirstTurn,
  intentLine,
  tLayerHint: normalizedTLayer,
  forceILayer: FORCE_I_LAYER, // ← ここだけ forceLayer → forceILayer
});

  // ----------------------------------------------------------------
  // 6. Will フェーズ：Goal / Priority の決定
  // ----------------------------------------------------------------
  const { goal, priority } = computeGoalAndPriority({
    text,
    depth: meta.depth,
    qCode: meta.qCode,
    selfAcceptanceLine: meta.selfAcceptance ?? null,
    mode: (meta.mode ?? 'mirror') as IrosMode,
  });

  (meta as any).goal = goal;
  (meta as any).priority = priority;

  // ----------------------------------------------------------------
  // 7. 本文生成（LLM 呼び出し）
  // ----------------------------------------------------------------
  const gen: GenerateResult = await generateIrosReply({
    text,
    meta,
  });

  let content = gen.content;

  // ir診断ヘッダーなどを UI 用に削る
  content = stripDiagnosticHeader(content);

  // ----------------------------------------------------------------
  // 8. MemoryState 保存
  // ----------------------------------------------------------------
  if (userCode) {
    await saveMemoryStateFromMeta({
      userCode,
      meta,
    });
  }

  // ----------------------------------------------------------------
  // 9. Orchestrator 結果として返却
  // ----------------------------------------------------------------
  return {
    content,
    meta,
  };
}

/* ============================================================================
 * 補助：Depth / QCode 正規化
 * ========================================================================== */

function determineInitialDepth(
  requestedDepth?: Depth,
  baseDepth?: Depth,
): Depth | undefined {
  // I層固定モードのときは、I1〜I3 を優先的に使う
  if (FORCE_I_LAYER) {
    if (requestedDepth && requestedDepth.startsWith('I')) return requestedDepth;
    if (baseDepth && baseDepth.startsWith('I')) return baseDepth;
    return 'I2';
  }

  return requestedDepth ?? baseDepth;
}

function normalizeDepth(depth?: Depth): Depth | undefined {
  if (!depth) return undefined;
  return DEPTH_VALUES.includes(depth) ? depth : undefined;
}

function normalizeQCode(qCode?: QCode): QCode | undefined {
  if (!qCode) return undefined;
  return QCODE_VALUES.includes(qCode) ? qCode : undefined;
}
