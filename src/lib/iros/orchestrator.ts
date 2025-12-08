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

// ★ 今日できること？トリガー検出
import { detectActionRequest } from './will/detectActionRequest';

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

/* ============================================================================
 * 任せる系（delegate intent）オーバーライド
 * ========================================================================== */

/**
 * ユーザーが「任せる／決めて／進めて／動かして／動ける形に／選択させないで」
 * などの **決定権の委譲** をしているとき、
 *
 * - goal.kind を 'enableAction' に寄せる
 * - goal.targetDepth / priority.goal.targetDepth を 'C1' に固定
 * - forward 重みを強くし、mirror を下げる
 *
 * ことで、S2 uncover 固定から「行動フェーズ（C1）」へ drift させる。
 */
// 任せる系（delegate intent）オーバーライド
function applyDelegateIntentOverride(params: {
  goal: IrosGoalType;
  priority: IrosPriorityType;
  text: string;
}): { goal: IrosGoalType; priority: IrosPriorityType } {
  const { goal, priority, text } = params;

  const delegatePattern =
    /(任せ|決めて|進めて|導いて|動かして|動ける形|選択させないで)/;

  if (!delegatePattern.test(text)) {
    return { goal, priority };
  }

  // goal を any で柔らかく扱う
  const anyGoal: any = { ...(goal as any) };

  anyGoal.kind = 'enableAction';
  anyGoal.targetDepth = 'C1';

  if (typeof anyGoal.reason !== 'string' || !anyGoal.reason) {
    anyGoal.reason =
      'delegateIntent: ユーザーが決定権を Iros に委ねたため、C1 方向の行動フェーズへ drift';
  }

  // priority も any で扱う
  const anyPriority: any = { ...(priority as any) };
  if (!anyPriority.goal) anyPriority.goal = {};
  if (!anyPriority.weights) anyPriority.weights = {};

  const weights = anyPriority.weights;

  const currentForward =
    typeof weights.forward === 'number' ? weights.forward : 0;
  const currentMirror =
    typeof weights.mirror === 'number' ? weights.mirror : 0.8;

  // 行動寄りへ強制シフト
  weights.forward = Math.max(currentForward, 0.9);
  weights.mirror = Math.min(currentMirror, 0.4);

  anyPriority.goal.targetDepth = 'C1';
  anyPriority.goal.kind = anyGoal.kind;

  const baseDebug: string =
    typeof anyPriority.debugNote === 'string'
      ? anyPriority.debugNote
      : '';
  anyPriority.debugNote = baseDebug
    ? `${baseDebug} +delegateIntent`
    : 'delegateIntent';

  return {
    goal: anyGoal as IrosGoalType,
    priority: anyPriority as IrosPriorityType,
  };
}


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

  // ★ 前回ターンの Goal.kind / uncoverStreak を取得
  const previousGoal: any =
    (mergedBaseMeta as any).goal &&
    typeof (mergedBaseMeta as any).goal === 'object'
      ? (mergedBaseMeta as any).goal
      : null;

  const lastGoalKind: any =
    previousGoal && typeof previousGoal.kind === 'string'
      ? previousGoal.kind
      : null;

  const previousUncoverStreak: number =
    typeof (mergedBaseMeta as any).uncoverStreak === 'number'
      ? (mergedBaseMeta as any).uncoverStreak
      : 0;

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
    depth,
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
    depth: normalizedDepth,
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
    hasFutureMemory,
  };

  // ----------------------------------------------------------------
  // ★ Phase パース＆格納：Unified または baseMeta から採用
  // ----------------------------------------------------------------
  let phase: 'Inner' | 'Outer' | null = null;

  const unifiedPhaseRaw =
    (unified?.phase as string | undefined) ??
    ((mergedBaseMeta as any)?.phase as string | undefined) ??
    null;

  if (typeof unifiedPhaseRaw === 'string') {
    const p = unifiedPhaseRaw.trim().toLowerCase();
    if (p === 'inner') phase = 'Inner';
    else if (p === 'outer') phase = 'Outer';
  }

  (meta as any).phase = phase;


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
  let { goal, priority } = computeGoalAndPriority({
    text,
    depth: meta.depth,
    qCode: meta.qCode,
    selfAcceptanceLine: meta.selfAcceptance ?? null,
    mode: (meta.mode ?? 'mirror') as IrosMode,
    // ★ 追加
    soulNote: (meta as any).soulNote ?? null,
    // ★ 三軸回転用：前回 Goal.kind と uncover 連続カウント
    lastGoalKind,
    previousUncoverStreak,
  });

  // ★ delegate intent（任せる／決めて／進めて／動かして...）のとき、
  //    goal.kind / targetDepth / weights を C1 行動フェーズ寄りに上書き
  ({ goal, priority } = applyDelegateIntentOverride({
    goal: goal ?? null,
    priority: priority ?? null,
    text,
  }));

  // ★ 「今日できること？」など、具体的な一歩を求めるターンなら
  //    forward 重みをブーストして、問い返しより行動提案を優先させる
  const isActionRequest = detectActionRequest(text);

  if (isActionRequest && priority) {
    const anyPriority = priority as any;
    const weights = { ...(anyPriority.weights || {}) };

    const currentForward =
      typeof weights.forward === 'number' ? weights.forward : 0;
    const currentMirror =
      typeof weights.mirror === 'number' ? weights.mirror : 0.8;

    // forward を 0.8 以上に引き上げ、mirror は少しだけ抑える
    weights.forward = Math.max(currentForward, 0.8);
    weights.mirror = Math.min(currentMirror, 0.7);

    anyPriority.weights = weights;

    // debugNote にフラグを追加（ログ確認用）
    const baseDebug: string =
      typeof anyPriority.debugNote === 'string'
        ? anyPriority.debugNote
        : '';
    anyPriority.debugNote = baseDebug
      ? `${baseDebug} +actionRequest`
      : 'actionRequest';

    priority = anyPriority as IrosPriorityType;

    // goal の理由だけ、今日の一歩向きに寄せておく（kind はそのまま）
    if (goal) {
      const anyGoal = goal as any;
      const baseReason: string =
        typeof anyGoal.reason === 'string' ? anyGoal.reason : '';
      if (!baseReason) {
        anyGoal.reason =
          'ユーザーが「今日できること？」と具体的な一歩を求めているため、forward を優先';
      }
      goal = anyGoal as IrosGoalType;
    }
  }

  // ★ uncoverStreak を更新して meta に保存（連続回数）
  const nextUncoverStreak: number =
    goal && (goal as any).kind === 'uncover'
      ? previousUncoverStreak + 1
      : 0;
  (meta as any).uncoverStreak = nextUncoverStreak;

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
  // 10. meta の最終調整：Goal.targetDepth を depth に反映
  // ----------------------------------------------------------------
  // ここまでで meta / goal / priority は確定している前提

  // まず「どの Depth を採用するか」を1本にまとめる
  const resolvedDepth: Depth | null =
    (goal?.targetDepth as Depth | undefined) ??
    (meta.depth as Depth | undefined) ??
    (meta.unified?.depth?.stage as Depth | null) ??
    null;

  // meta を上書きコピー
  let finalMeta: IrosMeta = {
    ...meta,
    depth: resolvedDepth ?? undefined,
  };

  // unified.depth.stage にも同じものを流し込む
  if ((finalMeta as any).unified) {
    const unifiedAny = (finalMeta as any).unified || {};
    const unifiedDepth = unifiedAny.depth || {};

    (finalMeta as any).unified = {
      ...unifiedAny,
      depth: {
        ...unifiedDepth,
        stage:
          resolvedDepth ??
          unifiedDepth.stage ??
          null,
      },
    };
  }

  // 開発時ログ（ここで depth が見えるように）
  if (
    typeof process !== 'undefined' &&
    process.env.NODE_ENV !== 'production'
  ) {
    // eslint-disable-next-line no-console
    console.log('[IROS/Orchestrator] result.meta', {
      depth: finalMeta.depth,
      qCode: finalMeta.qCode,
      goalKind: goal?.kind,
      goalTargetDepth: goal?.targetDepth,
      priorityTargetDepth: priority?.goal?.targetDepth,
      uncoverStreak: (finalMeta as any).uncoverStreak ?? 0,
    });
  }

  // ----------------------------------------------------------------
  // 11. MemoryState 保存（finalMeta ベース）
  // ----------------------------------------------------------------
  if (userCode) {
    await saveMemoryStateFromMeta({
      userCode,
      meta: finalMeta,
    });
  }

  // ----------------------------------------------------------------
  // 11.5 Person Intent Memory 保存（ir診断ターンのみ）
  // ----------------------------------------------------------------
  if (userCode && finalMeta) {
    const anyMeta = finalMeta as any;
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
          qPrimary: finalMeta.qCode ?? null,
          depthStage: finalMeta.depth ?? null,
          phase: finalMeta.phase ?? null,
          tLayerHint: finalMeta.tLayerHint ?? null,
          selfAcceptance:
            typeof finalMeta.selfAcceptance === 'number'
              ? finalMeta.selfAcceptance
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
  // 12. Orchestrator 結果として返却
  // ----------------------------------------------------------------
  return {
    content,
    meta: finalMeta,
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
