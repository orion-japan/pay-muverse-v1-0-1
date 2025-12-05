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
  type IrosStyle, // ★ 追加：口調スタイル
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

// Vision-Trigger（ビジョンモード 自動遷移）
import {
  detectVisionTrigger,
  logVisionTrigger,
} from './visionTrigger';

import { savePersonIntentState } from './memory/savePersonIntent';

// 🔸 Iros Soul（Silent Advisor）レイヤー
import { shouldUseSoul } from './soul/shouldUseSoul';
import { runIrosSoul } from './soul/runIrosSoul';
import type { IrosSoulInput } from './soul/types';

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

  /** ★ v_iros_user_profile の1行分（任意） */
  userProfile?: Record<string, any> | null;

  /** ★ 口調スタイル（route / handleIrosReply から渡す） */
  style?: IrosStyle | string | null;
};

// ==== Orchestrator から返す結果 ==== //
export type IrosOrchestratorResult = {
  content: string;
  meta: IrosMeta;
};

// src/lib/iros/orchestrator.ts
// Iros Orchestrator — Will Engine（Goal / Priority）+ Continuity Engine 統合版

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
    userProfile,
    style, // ★ 追加
  } = args;

  // ★★ ここにあった「0. 意図の薄いターン（挨拶 / コマンド）」の
  //     早期 return ロジックは削除しました。
  //     すべての入力を通常どおり解析〜Soul〜Will〜generate に通します。

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

  // ★ style の反映：
  //   - 明示指定された style を最優先
  //   - なければ memory / baseMeta 側をそのまま使う
  if (typeof style !== 'undefined' && style !== null) {
    (mergedBaseMeta as any).style = style;
  }

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
    yLevel:
      typeof yLevel === 'number'
        ? yLevel
        : mergedBaseMeta.yLevel ?? null,
    hLevel:
      typeof hLevel === 'number'
        ? hLevel
        : mergedBaseMeta.hLevel ?? null,
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

  // ★ v_iros_user_profile 由来の userProfile を meta に載せる
  //   - Memory 側に既にあれば、今回の userProfile を優先
  if (typeof userProfile !== 'undefined') {
    (meta as any).userProfile = userProfile;
  }

  // ★ ユーザーの「呼び名」を解決して meta.userCallName に載せる
  {
    const profileForName: Record<string, any> | null =
      (typeof userProfile !== 'undefined' && userProfile) ||
      ((meta as any).userProfile as Record<string, any> | null | undefined) ||
      null;

    if (profileForName) {
      const callNameRaw =
        (profileForName.ai_call_name as string | null | undefined) ??
        (profileForName.display_name as string | null | undefined) ??
        null;

      const callName =
        typeof callNameRaw === 'string' && callNameRaw.trim().length > 0
          ? callNameRaw.trim()
          : null;

      if (callName) {
        (meta as any).userCallName = callName;
      }
    }
  }

  // ★ Iros-GIGA：意図アンカー（intent_anchor）を meta に反映
  {
    const unifiedAnchor: any =
      unified && typeof unified === 'object'
        ? (unified as any).intent_anchor ?? null
        : null;

    const baseAnchor: any =
      (mergedBaseMeta as any).intent_anchor ??
      ((meta as any).intent_anchor ?? null);

    const coreNeedText: string | null =
      intentLine && typeof (intentLine as any).coreNeed === 'string'
        ? ((intentLine as any).coreNeed as string)
        : null;

    let anchorTextRaw: string | null = null;
    let strength: number | null = null;
    let y_level: number | null = null;
    let h_level: number | null = null;

    const sourceAnchor: any = unifiedAnchor ?? baseAnchor ?? null;

    if (
      sourceAnchor &&
      typeof sourceAnchor.text === 'string' &&
      sourceAnchor.text.trim().length > 0
    ) {
      anchorTextRaw = sourceAnchor.text.trim();
      strength =
        typeof sourceAnchor.strength === 'number'
          ? sourceAnchor.strength
          : null;
      y_level =
        typeof sourceAnchor.y_level === 'number'
          ? sourceAnchor.y_level
          : typeof yLevel === 'number'
          ? yLevel
          : null;
      h_level =
        typeof sourceAnchor.h_level === 'number'
          ? sourceAnchor.h_level
          : typeof hLevel === 'number'
          ? hLevel
          : null;
    }

    if (anchorTextRaw) {
      const marker = '【今回のユーザー発言】';
      const idx = anchorTextRaw.indexOf(marker);
      if (idx >= 0) {
        anchorTextRaw = anchorTextRaw.slice(idx + marker.length).trim();
      }

      anchorTextRaw = anchorTextRaw.split(/\r?\n/)[0].trim();

      if (
        anchorTextRaw.startsWith('【これまでの流れ') ||
        anchorTextRaw.length > 64
      ) {
        anchorTextRaw = null;
      }
    }

    let finalAnchorText: string | null = null;

    if (coreNeedText && coreNeedText.trim().length > 0) {
      finalAnchorText = coreNeedText.trim();
    } else if (anchorTextRaw && anchorTextRaw.trim().length > 0) {
      finalAnchorText = anchorTextRaw.trim();
    }

    if (finalAnchorText) {
      (meta as any).intent_anchor = {
        text: finalAnchorText,
        strength,
        y_level,
        h_level,
        raw:
          anchorTextRaw && anchorTextRaw !== finalAnchorText
            ? anchorTextRaw
            : undefined,
      };
    }
  }

  // ----------------------------------------------------------------
  // 4.5 Iros Soul レイヤー（Silent Advisor）呼び出し
  // ----------------------------------------------------------------
  let soulNote: any = null;
  try {
    const soulInput: IrosSoulInput = {
      userText: text,
      qCode: meta.qCode ?? null,
      depthStage: meta.depth ?? null,
      phase: meta.phase ?? null,
      selfAcceptance: meta.selfAcceptance ?? null,
      yLevel: meta.yLevel ?? null,
      hLevel: meta.hLevel ?? null,
      situationSummary: null,
      situationTopic: null,
      intentNowLabel:
        intentLine && typeof (intentLine as any).nowLabel === 'string'
          ? (intentLine as any).nowLabel
          : null,
      intentGuidanceHint:
        intentLine && typeof (intentLine as any).guidanceHint === 'string'
          ? (intentLine as any).guidanceHint
          : null,
    };

    if (shouldUseSoul(soulInput)) {
      soulNote = await runIrosSoul(soulInput, {});
    }
  } catch (e) {
    if (process.env.DEBUG_IROS_SOUL === '1') {
      console.error('[IROS/Soul] error', e);
    }
  }

  if (soulNote) {
    (meta as any).soulNote = soulNote;
  }

  // ----------------------------------------------------------------
  // 5. Vision-Trigger 判定（ビジョンモードへの自動ジャンプ）
  // ----------------------------------------------------------------
  const visionResult = detectVisionTrigger({ text, meta });
  if (visionResult.triggered) {
    meta = visionResult.meta;
    logVisionTrigger(visionResult);
  }

  // ----------------------------------------------------------------
  // 6. モード決定（mirror / vision / diagnosis）
  // ----------------------------------------------------------------
  meta = applyModeToMeta(text, {
    requestedMode,
    meta,
    isFirstTurn: !!isFirstTurn,
    intentLine,
    tLayerHint: normalizedTLayer,
    forceILayer: FORCE_I_LAYER,
  });

  if (meta.mode !== 'vision' && meta.tLayerHint) {
    (meta as any).tLayerModeActive = true;
  }

  // ----------------------------------------------------------------
  // 7. Will フェーズ：Goal / Priority の決定
  // ----------------------------------------------------------------
  const { goal, priority } = computeGoalAndPriority({
    text,
    depth: meta.depth,
    qCode: meta.qCode,
    selfAcceptanceLine: meta.selfAcceptance ?? null,
    mode: (meta.mode ?? 'mirror') as IrosMode,
    // ★ 追加
    soulNote: (meta as any).soulNote ?? null,
  });

  (meta as any).goal = goal;
  (meta as any).priority = priority;

  // ----------------------------------------------------------------
  // 8. 本文生成（LLM 呼び出し）
  // ----------------------------------------------------------------
  const gen: GenerateResult = await generateIrosReply({
    text,
    meta,
  });

  let content = gen.content;

  // （テンプレ適用は行わない。LLM と Soul に任せる）
  content = stripDiagnosticHeader(content);

  // ----------------------------------------------------------------
  // 9. MemoryState 保存
  // ----------------------------------------------------------------
  if (userCode) {
    await saveMemoryStateFromMeta({
      userCode,
      meta,
    });
  }

  // ----------------------------------------------------------------
  // 9.5 Person Intent Memory 保存（ir診断ターンのみ）
  // ----------------------------------------------------------------
  if (userCode && meta) {
    const anyMeta = meta as any;
    const isIrDiagnosisTurn = !!anyMeta.isIrDiagnosisTurn;

    if (isIrDiagnosisTurn) {
      let label = 'self';
      const trimmed = (text || '').trim();

      if (trimmed.startsWith('ir診断')) {
        const rest = trimmed.slice('ir診断'.length).trim();
        if (rest.length > 0) {
          label = rest;
        }
      }

      try {
        await savePersonIntentState({
          ownerUserCode: userCode,
          targetType: 'ir-diagnosis',
          targetLabel: label,
          qPrimary: meta.qCode ?? null,
          depthStage: meta.depth ?? null,
          phase: meta.phase ?? null,
          tLayerHint: meta.tLayerHint ?? null,
          selfAcceptance:
            typeof meta.selfAcceptance === 'number'
              ? meta.selfAcceptance
              : null,
        });
      } catch (e) {
        console.error(
          '[IROS/Orchestrator] savePersonIntentState error',
          e,
        );
      }
    }
  }

  // ----------------------------------------------------------------
  // 10. Orchestrator 結果として返却
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

