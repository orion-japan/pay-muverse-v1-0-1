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
  type IrosStyle,         // ★ 追加：口調スタイル
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
  //   - 優先順位: ai_call_name > display_name
  //   - 両方なければ設定しない（LLM側は「あなた」で話す）
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
    forceILayer: FORCE_I_LAYER, // ← ここだけ forceLayer → forceILayer
  });

  // 🔹 Vision Hint 用：
  //  - Vision モードではない
  //  - でも T層ヒント（T1〜T3）が付いている
  // そんなターンでは、フロント側で ✨ を出すために
  // tLayerModeActive を true にしておく
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

  // ir診断ヘッダーなどを UI 用に削る
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

    if (!isIrDiagnosisTurn) {
      // ir診断以外のターンでは何もしない
      if (process.env.DEBUG_IROS_INTENT === '1') {
        console.log('[IROS/PersonIntentState] skip (not ir diagnosis turn)', {
          mode: meta.mode,
        });
      }
    } else {
      // 観測対象ラベルを、今回のユーザー入力テキストから抽出する
      let label = 'self';
      const trimmed = (text || '').trim();

      if (trimmed.startsWith('ir診断')) {
        const rest = trimmed.slice('ir診断'.length).trim(); // 「自分」「上司」など
        if (rest.length > 0) {
          label = rest;
        }
      }

      if (process.env.DEBUG_IROS_INTENT === '1') {
        console.log('[IROS/PersonIntentState] save candidate', {
          userCode,
          label,
          depth: meta.depth,
          qCode: meta.qCode,
          selfAcceptance: meta.selfAcceptance,
        });
      }

      try {
        await savePersonIntentState({
          ownerUserCode: userCode,
          // ひとまず「ir診断で観測した対象」という意味で固定
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
          // intentBand / direction などは IntentLine 型を確認してから後で追加
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


